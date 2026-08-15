/**
 * OpenAI-compatible chat/completions wire adapter (ADR 0014).
 *
 * Covers the local Grok loopback (8787) and xAI. Consumes the streaming
 * SSE shape `choices[0].delta.content` / `delta.tool_calls` /
 * `finish_reason`, which the loopback forwards verbatim.
 */

import type { AnyToolDefinition, CanonicalMessage, PromptImage, ResolvedModel } from "./types.js";

export interface CompletionsRequestBody {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  stream: boolean;
  max_tokens: number;
}

export interface WireToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export type CompletionsStreamPiece =
  | { type: "text_delta"; delta: string }
  | { type: "message_done"; finishReason: string | null; toolCalls: readonly WireToolCall[] };

export type CompletionsMessageDone = Extract<CompletionsStreamPiece, { type: "message_done" }>;

interface AccumulatedToolCall {
  index: number;
  id?: string;
  name?: string;
  argumentBuffer: string;
}

function userContent(text: string, images?: readonly PromptImage[]): unknown {
  if (!images || images.length === 0) return text;
  return [
    { type: "text", text },
    ...images.map((image) => ({
      type: "image_url",
      image_url: { url: `data:${image.mimeType};base64,${image.data}` },
    })),
  ];
}

export interface TransientTailMessage {
  readonly role: "user";
  readonly text: string;
}

export function buildCompletionsBody(
  model: ResolvedModel,
  systemPrompt: string,
  history: readonly CanonicalMessage[],
  activeTools: readonly AnyToolDefinition[],
  transientTail?: TransientTailMessage,
): CompletionsRequestBody {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: systemPrompt },
    ...history.map((item): Record<string, unknown> => {
      switch (item.role) {
        case "user":
          return { role: "user", content: userContent(item.text, item.images) };
        case "assistant":
          return item.toolCalls.length > 0
            ? {
              role: "assistant",
              content: item.text || null,
              tool_calls: item.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.argumentsJson },
              })),
            }
            : { role: "assistant", content: item.text };
        case "tool":
          return {
            role: "tool",
            tool_call_id: item.callId,
            content: item.output,
          };
        case "system":
          return { role: "system", content: item.text };
      }
    }),
    ...(transientTail ? [{ role: "user", content: transientTail.text }] : []),
  ];
  const body: CompletionsRequestBody = {
    model: model.id,
    messages,
    stream: true,
    max_tokens: model.maxTokens,
  };
  if (activeTools.length > 0) {
    body.tools = activeTools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
  return body;
}

/**
 * Incremental SSE consumer. Feed each `data:` payload (without the
 * `data: ` prefix); it emits text deltas and, on `[DONE]` or a terminal
 * chunk, the assembled tool calls.
 */
export class CompletionsStreamParser {
  private text = "";
  private readonly toolCalls = new Map<number, AccumulatedToolCall>();
  private finishReason: string | null = null;
  private done = false;

  push(payload: string): CompletionsStreamPiece | undefined {
    if (this.done) return undefined;
    if (payload === "[DONE]") {
      this.done = true;
      return { type: "message_done", finishReason: this.finishReason, toolCalls: this.snapshot() };
    }
    let chunk: {
      choices?: Array<{
        finish_reason?: string | null;
        delta?: { content?: string | null; tool_calls?: Array<{
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }> };
      }>;
    };
    try {
      chunk = JSON.parse(payload);
    } catch {
      return undefined;
    }
    const choice = chunk.choices?.[0];
    if (!choice) return undefined;
    if (typeof choice.finish_reason === "string") this.finishReason = choice.finish_reason;
    const delta = choice.delta?.content;
    let piece: CompletionsStreamPiece | undefined;
    if (typeof delta === "string" && delta.length > 0) {
      this.text += delta;
      piece = { type: "text_delta", delta };
    }
    for (const call of choice.delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      let accumulated = this.toolCalls.get(index);
      if (!accumulated) {
        accumulated = { index, argumentBuffer: "" };
        this.toolCalls.set(index, accumulated);
      }
      if (call.id) accumulated.id = call.id;
      if (call.function?.name) accumulated.name = call.function.name;
      if (call.function?.arguments) accumulated.argumentBuffer += call.function.arguments;
    }
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      this.done = true;
      return { type: "message_done", finishReason: this.finishReason, toolCalls: this.snapshot() };
    }
    return piece;
  }

  finish(): CompletionsMessageDone {
    if (this.done) return { type: "message_done", finishReason: this.finishReason, toolCalls: [] };
    this.done = true;
    return { type: "message_done", finishReason: this.finishReason, toolCalls: this.snapshot() };
  }

  private snapshot(): readonly WireToolCall[] {
    return [...this.toolCalls.values()]
      .sort((a, b) => a.index - b.index)
      .filter((call): call is AccumulatedToolCall & { id: string; name: string } =>
        Boolean(call.id && call.name))
      .map((call) => ({ id: call.id, name: call.name, argumentsJson: call.argumentBuffer }));
  }
}

/** Reads one SSE stream and yields each data payload string. */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new Error("Model stream aborted");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (line.startsWith("data:")) {
          yield line.slice(5).trimStart();
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
