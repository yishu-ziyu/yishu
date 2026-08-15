/**
 * OpenAI Codex Responses wire adapter (ADR 0014).
 *
 * Talks to `https://chatgpt.com/backend-api/codex/responses` with the
 * subscription OAuth bearer plus `chatgpt-account-id`. Handles the events
 * the loop needs: `response.output_text.delta`,
 * `response.output_item.done` (message / function_call), `response.completed`
 * and stream errors.
 */

import type { AnyToolDefinition, CanonicalMessage, PromptImage, ResolvedModel } from "./types.js";
import { readSseData, type WireToolCall } from "./openai-completions.js";

export type ResponsesStreamPiece =
  | { type: "text_delta"; delta: string }
  | { type: "message_done"; finishReason: string | null; toolCalls: readonly WireToolCall[] };

export type ResponsesMessageDone = Extract<ResponsesStreamPiece, { type: "message_done" }>;

function inputItemFor(item: CanonicalMessage): Record<string, unknown> | undefined {
  switch (item.role) {
    case "user": {
      const content: Array<Record<string, unknown>> = [];
      if (item.text) content.push({ type: "input_text", text: item.text });
      for (const image of item.images ?? []) {
        content.push({
          type: "input_image",
          image_url: `data:${image.mimeType};base64,${image.data}`,
        });
      }
      return { type: "message", role: "user", content };
    }
    case "assistant":
      return item.toolCalls.length > 0
        ? {
          type: "message",
          role: "assistant",
          content: item.text ? [{ type: "output_text", text: item.text }] : [],
          // Function calls are replayed as siblings in the input array.
          siblingCalls: item.toolCalls.map((call) => ({
            type: "function_call",
            call_id: call.id,
            name: call.name,
            arguments: call.argumentsJson,
          })),
        }
        : {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: item.text }],
        };
    case "tool":
      return {
        type: "function_call_output",
        call_id: item.callId,
        output: item.output,
      };
    case "system":
      return undefined;
  }
}

export function buildResponsesBody(
  model: ResolvedModel,
  systemPrompt: string,
  history: readonly CanonicalMessage[],
  activeTools: readonly AnyToolDefinition[],
  transientTail?: { role: "user"; text: string },
): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [];
  for (const item of history) {
    const wire = inputItemFor(item);
    if (!wire) continue;
    const siblingCalls = (wire as { siblingCalls?: Array<Record<string, unknown>> }).siblingCalls;
    delete (wire as { siblingCalls?: unknown }).siblingCalls;
    input.push(wire);
    for (const call of siblingCalls ?? []) input.push(call);
  }
  if (transientTail) {
    input.push({ type: "message", role: "user", content: [{ type: "input_text", text: transientTail.text }] });
  }
  const body: Record<string, unknown> = {
    model: model.id,
    instructions: systemPrompt,
    input,
    stream: true,
    max_output_tokens: model.maxTokens,
  };
  if (activeTools.length > 0) {
    body.tools = activeTools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    }));
  }
  return body;
}

interface ResponsesStreamEvent {
  type?: string;
  delta?: string;
  item?: {
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: { error?: unknown };
  message?: string;
}

export class ResponsesStreamParser {
  private done = false;
  private readonly toolCalls: WireToolCall[] = [];

  push(event: ResponsesStreamEvent): ResponsesStreamPiece | undefined {
    if (this.done) return undefined;
    switch (event.type) {
      case "response.output_text.delta":
        if (typeof event.delta === "string" && event.delta.length > 0) {
          return { type: "text_delta", delta: event.delta };
        }
        return undefined;
      case "response.output_item.done":
        if (event.item?.type === "function_call"
          && typeof event.item.call_id === "string"
          && typeof event.item.name === "string") {
          this.toolCalls.push({
            id: event.item.call_id,
            name: event.item.name,
            argumentsJson: typeof event.item.arguments === "string" ? event.item.arguments : "",
          });
        }
        return undefined;
      case "response.completed":
      case "response.failed":
      case "response.incomplete":
      case "error": {
        this.done = true;
        const finishReason = this.toolCalls.length > 0 ? "tool_calls" : "stop";
        if (event.type === "error" || event.type === "response.failed") {
          const detail = event.message
            ?? (event.response?.error instanceof Error ? event.response.error.message : undefined);
          if (detail) throw new Error(String(detail));
        }
        return { type: "message_done", finishReason, toolCalls: [...this.toolCalls] };
      }
      default:
        return undefined;
    }
  }

  finish(): ResponsesMessageDone {
    if (this.done) return { type: "message_done", finishReason: "stop", toolCalls: [] };
    this.done = true;
    return {
      type: "message_done",
      finishReason: this.toolCalls.length > 0 ? "tool_calls" : "stop",
      toolCalls: [...this.toolCalls],
    };
  }
}

export async function* readResponsesEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ResponsesStreamEvent> {
  for await (const payload of readSseData(body, signal)) {
    if (payload === "[DONE]") return;
    try {
      yield JSON.parse(payload) as ResponsesStreamEvent;
    } catch {
      // Ignore keep-alive or malformed lines.
    }
  }
}
