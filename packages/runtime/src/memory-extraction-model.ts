/**
 * Runtime implementation of the kernel's MemoryExtractionModel port
 * (ADR 0016 #4): one-shot call on the same provider/model the completed
 * turn used, speaking that provider's wire protocol. Completions providers
 * POST /chat/completions; Codex POSTs /codex/responses.
 */

import { minimaxCompletionsExtras } from "./model-loop/openai-completions.js";
import type { ModelProviderRuntime, ResolvedModel } from "./model-loop/types.js";
import {
  buildResponsesBody,
  readResponsesEvents,
  ResponsesStreamParser,
} from "./model-loop/codex-responses.js";
import type {
  MemoryExtractionInput,
  MemoryExtractionOutput,
} from "@yishu/kernel";

const EXTRACTION_SYSTEM_PROMPT = [
  "You extract durable facts about the user from one dialogue turn.",
  "Rules:",
  "- Only stable facts or preferences (e.g. preferred format, long-term constraints, self-described habits).",
  "- Never extract task status, one-off requests, or transient context.",
  "- Never invent or infer beyond what the dialogue literally supports.",
  "- new_facts: short standalone sentences in the user's language, at most 3.",
  "- confirmed_fact_ids: ids from existing_facts this turn re-confirms.",
  'Reply with pure JSON: {"new_facts": string[], "confirmed_fact_ids": string[]}',
].join("\n");

const MAX_EXTRACTION_CHARS = 4000;

function parseExtractionJson(text: string): MemoryExtractionOutput {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("extraction model returned no JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("extraction model returned invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("extraction model returned invalid JSON");
  }
  const record = parsed as Record<string, unknown>;
  const newFacts = Array.isArray(record.new_facts)
    ? record.new_facts.filter((fact: unknown): fact is string =>
        typeof fact === "string" && fact.trim().length > 0)
    : [];
  const confirmed = Array.isArray(record.confirmed_fact_ids)
    ? record.confirmed_fact_ids.filter((fact: unknown): fact is string =>
        typeof fact === "string")
    : [];
  return { newFacts: newFacts.slice(0, 3), confirmedFactIds: confirmed };
}

function userPayload(input: MemoryExtractionInput): string {
  const existing = input.existingFacts.length === 0
    ? "(none)"
    : input.existingFacts.map((f) => `${f.id}: ${f.claim}`).join("\n");
  return [
    `USER SAID: ${input.utterance.slice(0, MAX_EXTRACTION_CHARS)}`,
    `ASSISTANT REPLIED: ${input.replyText.slice(0, MAX_EXTRACTION_CHARS)}`,
    `EXISTING FACTS:\n${existing}`,
  ].join("\n\n");
}

async function extractViaCompletions(
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
          { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
          { role: "user", content: payload },
        ],
        stream: false,
        max_tokens: 512,
        ...minimaxCompletionsExtras(model.id),
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`extraction model call failed (${response.status})`);
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return body.choices?.[0]?.message?.content ?? "";
}

async function extractViaCodexResponses(
  model: ResolvedModel,
  payload: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<string> {
  const body = buildResponsesBody(
    model,
    EXTRACTION_SYSTEM_PROMPT,
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
    throw new Error(`extraction model call failed (${response.status})`);
  }
  if (!response.body) {
    throw new Error("extraction model response has no body");
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

export function createCompletionsExtractionModel(
  providerRuntime: ModelProviderRuntime,
  fetchImpl: typeof fetch = fetch,
): {
  extract: (input: MemoryExtractionInput) => Promise<MemoryExtractionOutput>;
} {
  return {
    async extract(input: MemoryExtractionInput): Promise<MemoryExtractionOutput> {
      const model = await providerRuntime.resolveModel(input.providerId, input.modelId);
      const bearer = await providerRuntime.bearer(model.providerId);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
        ...(await providerRuntime.extraHeaders(model.providerId)),
      };
      const payload = userPayload(input);
      const text = model.api === "codex-responses"
        ? await extractViaCodexResponses(model, payload, headers, fetchImpl)
        : await extractViaCompletions(model, payload, headers, fetchImpl);
      return parseExtractionJson(text);
    },
  };
}
