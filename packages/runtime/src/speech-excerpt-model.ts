/**
 * One-shot spoken excerpt on the same provider/model the completed turn used.
 * Mirrors memory extraction's wire (completions vs Codex responses).
 * Input is the scrubbed visible reply, never chain-of-thought.
 */

import type { ModelProviderRuntime, ResolvedModel } from "./model-loop/types.js";
import {
  buildResponsesBody,
  readResponsesEvents,
  ResponsesStreamParser,
} from "./model-loop/codex-responses.js";

export interface SpeechExcerptInput {
  providerId: string;
  modelId: string;
  visibleText: string;
}

export interface SpeechExcerptModel {
  excerpt(input: SpeechExcerptInput): Promise<string>;
}

const EXCERPT_SYSTEM_PROMPT = [
  "You write a short spoken reply for a voice assistant.",
  "Rules:",
  "- Use only the visible assistant reply below. Never invent facts.",
  "- At most two spoken sentences.",
  "- Conversational, in the same language as the reply.",
  "- If the text restates a request, announces that work is finished, or lists sources, ignore that wrapper.",
  "- Speak only the finding a person would hear.",
  "- No URLs, no tool names, no markdown, no lists, no chain-of-thought.",
  "- Do not quote the request. Do not announce that you finished.",
  "Reply with plain text only.",
].join("\n");

const MAX_VISIBLE_CHARS = 8000;
const MAX_SPOKEN_SENTENCES = 2;
const WALL_CHARACTER_LIMIT = 80;
const SENTENCE_BOUNDARY = /[。！？；.!?\n]/;

export function clipSpokenSentences(
  text: string,
  maxSentences = MAX_SPOKEN_SENTENCES,
): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  let count = 0;
  let end = 0;
  for (let index = 0; index < trimmed.length && count < maxSentences; index += 1) {
    if (SENTENCE_BOUNDARY.test(trimmed[index] ?? "")) {
      count += 1;
      end = index + 1;
    }
  }
  if (count === 0) {
    if (trimmed.length > WALL_CHARACTER_LIMIT) {
      throw new Error("excerpt is not spoken sentences");
    }
    return trimmed;
  }
  return trimmed.slice(0, end).trim();
}

async function excerptViaCompletions(
  model: ResolvedModel,
  payload: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(
    `${model.baseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model.id,
        messages: [
          { role: "system", content: EXCERPT_SYSTEM_PROMPT },
          { role: "user", content: payload },
        ],
        stream: false,
        max_tokens: 256,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`excerpt model call failed (${response.status})`);
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return body.choices?.[0]?.message?.content ?? "";
}

async function excerptViaCodexResponses(
  model: ResolvedModel,
  payload: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<string> {
  const body = buildResponsesBody(
    model,
    EXCERPT_SYSTEM_PROMPT,
    [{ role: "user", text: payload }],
    [],
  );
  const response = await fetchImpl(
    `${model.baseUrl.replace(/\/$/, "")}/codex/responses`,
    {
      method: "POST",
      headers: {
        ...headers,
        accept: "text/event-stream",
        "OpenAI-Beta": "responses=experimental",
        originator: "codex_cli_rs",
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(`excerpt model call failed (${response.status})`);
  }
  if (!response.body) {
    throw new Error("excerpt model response has no body");
  }
  const parser = new ResponsesStreamParser();
  let text = "";
  for await (const event of readResponsesEvents(response.body)) {
    const piece = parser.push(event);
    if (piece?.type === "text_delta") text += piece.delta;
    if (piece?.type === "message_done") break;
  }
  return text;
}

export function createSpeechExcerptModel(
  providerRuntime: ModelProviderRuntime,
  fetchImpl: typeof fetch = fetch,
): SpeechExcerptModel {
  return {
    async excerpt(input: SpeechExcerptInput): Promise<string> {
      const visibleText = input.visibleText.trim().slice(0, MAX_VISIBLE_CHARS);
      if (!visibleText) {
        throw new Error("excerpt input is empty");
      }
      const model = await providerRuntime.resolveModel(input.providerId, input.modelId);
      const bearer = await providerRuntime.bearer(model.providerId);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
        ...(await providerRuntime.extraHeaders(model.providerId)),
      };
      const payload = `VISIBLE REPLY:\n${visibleText}`;
      const text = model.api === "codex-responses"
        ? await excerptViaCodexResponses(model, payload, headers, fetchImpl)
        : await excerptViaCompletions(model, payload, headers, fetchImpl);
      const spoken = clipSpokenSentences(text);
      if (!spoken) {
        throw new Error("excerpt model returned no spoken sentences");
      }
      return spoken;
    },
  };
}
