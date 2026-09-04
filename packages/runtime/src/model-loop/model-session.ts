/**
 * Yishu-owned model-tool loop engine (ADR 0014).
 *
 * One `YishuModelSession` owns an in-memory message history, streams model
 * responses, executes product tools, and supports the atomic steer contract:
 * a steer prompt submitted while a run is streaming is queued and consumed at
 * the next safe assistant/tool boundary; submitted while idle it starts a
 * fresh run. The event surface matches what the loop adapter consumes.
 */

import { randomUUID } from "node:crypto";
import {
  buildCompletionsBody,
  CompletionsStreamParser,
  readSseData,
  type WireToolCall,
} from "./openai-completions.js";
import {
  buildResponsesBody,
  readResponsesEvents,
  ResponsesStreamParser,
} from "./codex-responses.js";
import type {
  AnyToolDefinition,
  CanonicalMessage,
  ModelProviderRuntime,
  PromptImage,
  ModelSession,
  PromptOptions,
  ResolvedModel,
  SessionEvent,
  SessionMessageEnvelope,
} from "./types.js";
import type { TurnContextProviders } from "./turn-context.js";

export const MAX_MODEL_ITERATIONS = 16;
const MAX_HISTORY_MESSAGES = 200;
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 8_000;
const TRANSIENT_RETRY_MAX = 2;
export const FIRST_BYTE_TIMEOUT_MESSAGE = "Model stream timed out waiting for the first byte.";
export const FIRST_BYTE_FALLBACK_SPEECH = "这句我想了太久，换个说法再来一次？";
const FINAL_REPLY_HINT =
  "工具次数已用尽。根据已经打开的页面和搜索结果，直接说出结论。不要再调用工具。";
const ACK_FIRST_HINT =
  "先开口再说。用一句很短的话（一到三个字也可以）应答，然后再调用工具。不要解释这条提醒，不要报工具名。";

export function resolveFirstByteTimeoutMs(
  overrideMs?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (typeof overrideMs === "number" && Number.isFinite(overrideMs) && overrideMs > 0) {
    return overrideMs;
  }
  const raw = env.YISHU_MODEL_FIRST_BYTE_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_FIRST_BYTE_TIMEOUT_MS;
}

export function isModelStallFault(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YISHU_FAULT === "model_stall";
}

export interface YishuModelSessionOptions {
  readonly model: ResolvedModel;
  readonly providerRuntime: ModelProviderRuntime;
  readonly systemPrompt: string;
  readonly customTools: readonly AnyToolDefinition[];
  /** Product-owned context providers (ADR 0015); optional for tests. */
  readonly context?: TurnContextProviders;
  /** Override for tests; production stays at STREAM_FIRST_BYTE_TIMEOUT_MS. */
  readonly streamFirstByteTimeoutMs?: number;
}

type SessionListener = (event: SessionEvent) => void;

interface QueuedSteer {
  message: string;
  released: () => void;
}

export class YishuModelSession implements ModelSession {
  readonly sessionId = randomUUID();
  readonly agent = { state: { errorMessage: null as string | null } };

  private readonly listeners = new Set<SessionListener>();
  private readonly tools = new Map<string, AnyToolDefinition>();
  private activeToolNames: readonly string[];
  private readonly history: CanonicalMessage[] = [];
  /** System prefix actually used on the wire: persona + skills L1 (stable). */
  private readonly effectiveSystemPrompt: string;
  /** Next-call-only status bar text; never persisted into history. */
  private pendingStatusText: string | undefined;
  private runController: AbortController | undefined;
  private running = false;
  private pendingSteer: QueuedSteer | undefined;
  private disposed = false;

  private toolCallCount = 0;
  private lastToolName: string | undefined;
  private lastToolFailed = false;

  constructor(private readonly options: YishuModelSessionOptions) {
    for (const tool of options.customTools) this.tools.set(tool.name, tool);
    this.activeToolNames = [...this.tools.keys()];
    this.effectiveSystemPrompt = options.systemPrompt;
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getActiveToolNames(): readonly string[] {
    return [...this.activeToolNames];
  }

  setActiveToolsByName(names: readonly string[]): void {
    this.activeToolNames = names.filter((name) => this.tools.has(name));
  }

  async prompt(text: string, options: PromptOptions = {}): Promise<void> {
    if (this.disposed) throw new Error("Session is disposed.");
    if (this.running) {
      if (options.streamingBehavior !== "steer") {
        throw new Error("A prompt is already active on this session.");
      }
      await this.queueSteer(text);
      return;
    }
    await this.run(text, options);
  }

  async abort(): Promise<void> {
    const controller = this.runController;
    if (controller) controller.abort();
    this.releasePendingSteer();
  }

  dispose(): void {
    this.disposed = true;
    this.runController?.abort();
    this.releasePendingSteer();
    this.listeners.clear();
  }

  // -----------------------------------------------------------------------
  // Run loop
  // -----------------------------------------------------------------------

  private async queueSteer(message: string): Promise<void> {
    // Exactly one queued steer: a newer steer replaces an older pending one.
    this.releasePendingSteer();
    await new Promise<void>((resolve) => {
      this.pendingSteer = { message, released: resolve };
    });
  }

  private releasePendingSteer(): void {
    const steer = this.pendingSteer;
    this.pendingSteer = undefined;
    steer?.released();
  }

  private async run(initialText: string, options: PromptOptions): Promise<void> {
    const controller = new AbortController();
    this.runController = controller;
    this.running = true;
    let preflightReported = false;
    const reportPreflight = (accepted: boolean): void => {
      if (preflightReported) return;
      preflightReported = true;
      options.preflightResult?.(accepted);
    };
    try {
      // ADR 0015: the product layer owns recall; the engine owns assembly
      // timing. The block leads the first user message of this turn.
      const memoryBlock = await this.options.context?.assembleTurnMemory
        ?.(initialText)
        .catch(() => undefined);
      const firstUserText = memoryBlock ? `${memoryBlock}\n\n${initialText}` : initialText;
      this.history.push({ role: "user", text: firstUserText, ...(options.images ? { images: options.images } : {}) });
      let lastHadTools = false;
      let ackReminderInjected = false;
      let requestSentEmitted = false;
      for (let iteration = 0; iteration < MAX_MODEL_ITERATIONS; iteration += 1) {
        if (controller.signal.aborted) throw abortError(controller.signal);
        const offerTools = iteration < MAX_MODEL_ITERATIONS - 1;
        if (!offerTools) this.pendingStatusText = FINAL_REPLY_HINT;
        const { text, toolCalls } = await this.streamOneMessage(
          controller.signal,
          reportPreflight,
          { offerTools, emitRequestSent: !requestSentEmitted },
        );
        requestSentEmitted = true;
        const runnableCalls = offerTools ? toolCalls : [];
        if (
          !ackReminderInjected
          && offerTools
          && runnableCalls.length > 0
          && text.trim().length === 0
        ) {
          ackReminderInjected = true;
          this.pendingStatusText = ACK_FIRST_HINT;
          continue;
        }
        lastHadTools = runnableCalls.length > 0;
        this.history.push({
          role: "assistant",
          text,
          toolCalls: runnableCalls.map((call) => ({ id: call.id, name: call.name, argumentsJson: call.argumentsJson })),
        });
        if (runnableCalls.length > 0) {
          await this.executeToolCalls(runnableCalls, controller.signal);
          // ADR 0015: refresh the end-of-context status bar after every
          // tool batch; it rides only the next model call.
          await this.refreshStatusBar().catch(() => undefined);
        }
        const steer = this.pendingSteer;
        if (steer) {
          this.pendingSteer = undefined;
          this.history.push({ role: "user", text: steer.message });
          steer.released();
          continue;
        }
        if (runnableCalls.length === 0) break;
        // Tool results are in history; loop back for the model's next reply.
      }
      if (lastHadTools) {
        throw new Error("Model exceeded the tool-call iteration limit without a final reply.");
      }
      this.trimHistory();
      this.emit({
        type: "turn_end",
        message: this.envelope("assistant", ""),
      });
    } catch (error) {
      if (isFirstByteTimeout(controller.signal, error)) {
        this.agent.state.errorMessage = FIRST_BYTE_TIMEOUT_MESSAGE;
        throw new Error(FIRST_BYTE_TIMEOUT_MESSAGE);
      }
      if (!controller.signal.aborted) {
        this.agent.state.errorMessage = error instanceof Error ? error.message : String(error);
      }
      throw controller.signal.aborted ? abortError(controller.signal) : error;
    } finally {
      this.running = false;
      this.runController = undefined;
      this.releasePendingSteer();
    }
  }

  private async refreshStatusBar(): Promise<void> {
    const statusBar = this.options.context?.statusBar;
    if (!statusBar) return;
    const text = await statusBar({
      toolCallCount: this.toolCallCount,
      ...(this.lastToolName !== undefined ? { lastToolName: this.lastToolName } : {}),
      lastToolFailed: this.lastToolFailed,
    });
    this.pendingStatusText = typeof text === "string" && text.length > 0 ? text : undefined;
  }

  private async streamOneMessage(
    signal: AbortSignal,
    reportPreflight: (accepted: boolean) => void,
    options: { offerTools?: boolean; emitRequestSent?: boolean } = {},
  ): Promise<{ text: string; toolCalls: readonly WireToolCall[] }> {
    const { model, providerRuntime } = this.options;
    const activeTools = options.offerTools === false
      ? []
      : this.activeToolNames
        .map((name) => this.tools.get(name))
        .filter((tool): tool is AnyToolDefinition => tool !== undefined);
    const isResponses = model.api === "codex-responses";
    const transientTail = this.pendingStatusText !== undefined
      ? { role: "user" as const, text: this.pendingStatusText }
      : undefined;
    this.pendingStatusText = undefined;
    const body = isResponses
      ? buildResponsesBody(model, this.effectiveSystemPrompt, this.history, activeTools, transientTail)
      : buildCompletionsBody(model, this.effectiveSystemPrompt, this.history, activeTools, transientTail);
    const bearer = await providerRuntime.bearer(model.providerId);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: isResponses ? "text/event-stream" : "application/json",
      authorization: `Bearer ${bearer}`,
      ...(await providerRuntime.extraHeaders(model.providerId)),
      ...(isResponses ? { "OpenAI-Beta": "responses=experimental", originator: "codex_cli_rs" } : {}),
    };
    const url = isResponses ? `${model.baseUrl.replace(/\/$/, "")}/codex/responses` : `${model.baseUrl.replace(/\/$/, "")}/chat/completions`;
    if (options.emitRequestSent) {
      const images = this.history.flatMap((message) => (
        message.role === "user" && message.images ? message.images : []
      ));
      this.emit({
        type: "request_sent",
        imageCount: images.length,
        imageBytes: images.reduce((sum, image) => sum + Buffer.byteLength(image.data, "utf8"), 0),
      });
    }

    const envelope = this.envelope("assistant", "");
    this.emit({ type: "message_start", message: envelope });

    const timeoutMs = resolveFirstByteTimeoutMs(this.options.streamFirstByteTimeoutMs);
    const firstByteTimer = setTimeout(() => {
      if (!this.runController || this.runController.signal.aborted) return;
      if (!sawFirstByte) {
        this.emit({
          type: "message_update",
          message: this.envelope("assistant", FIRST_BYTE_FALLBACK_SPEECH),
          assistantMessageEvent: { type: "text_delta", delta: FIRST_BYTE_FALLBACK_SPEECH },
        });
      }
      this.runController.abort(new Error(FIRST_BYTE_TIMEOUT_MESSAGE));
    }, timeoutMs);
    let sawFirstByte = false;
    const noteFirstByte = (): void => {
      if (sawFirstByte) return;
      sawFirstByte = true;
      clearTimeout(firstByteTimer);
    };

    let text = "";
    const completionsParser = isResponses ? undefined : new CompletionsStreamParser();
    const responsesParser = isResponses ? new ResponsesStreamParser() : undefined;
    let toolCalls: readonly WireToolCall[] = [];
    let streamDone = false;
    let sseFirstByteEmitted = false;
    const emitSseFirstByte = (): void => {
      if (sseFirstByteEmitted) return;
      sseFirstByteEmitted = true;
      this.emit({ type: "sse_first_byte" });
    };
    const emitReasoning = (delta: string): void => {
      if (delta.length === 0) return;
      this.emit({ type: "reasoning_delta", delta });
    };
    try {
      const response = await this.fetchWithRetry(url, body as Record<string, unknown>, headers, signal, isResponses);
      if (!response.ok) {
        reportPreflight(false);
        const summary = await response.text().catch(() => "");
        throw new Error(`Model request failed (${response.status}${summary ? `: ${summary.slice(0, 200)}` : ""}).`);
      }
      reportPreflight(true);
      if (!response.body) throw new Error("Model response has no body.");

      if (isResponses && responsesParser) {
        for await (const event of readResponsesEvents(response.body, signal, emitSseFirstByte)) {
          noteFirstByte();
          const piece = responsesParser.push(event);
          if (piece?.type === "text_delta") {
            text += piece.delta;
            this.emit({
              type: "message_update",
              message: this.envelope("assistant", text),
              assistantMessageEvent: { type: "text_delta", delta: piece.delta },
            });
          } else if (piece?.type === "message_done") {
            toolCalls = piece.toolCalls;
            streamDone = true;
            break;
          }
        }
        if (!streamDone) {
          const piece = responsesParser.finish();
          toolCalls = piece.toolCalls;
        }
      } else if (completionsParser) {
        for await (const payload of readSseData(response.body, signal, emitSseFirstByte)) {
          noteFirstByte();
          const piece = completionsParser.push(payload);
          emitReasoning(completionsParser.takeReasoningDelta());
          if (piece?.type === "text_delta") {
            text += piece.delta;
            this.emit({
              type: "message_update",
              message: this.envelope("assistant", text),
              assistantMessageEvent: { type: "text_delta", delta: piece.delta },
            });
          } else if (piece?.type === "message_done") {
            if (piece.trailingText) {
              text += piece.trailingText;
              this.emit({
                type: "message_update",
                message: this.envelope("assistant", text),
                assistantMessageEvent: { type: "text_delta", delta: piece.trailingText },
              });
            }
            toolCalls = piece.toolCalls;
            streamDone = true;
            break;
          }
        }
        if (!streamDone) {
          const piece = completionsParser.finish();
          emitReasoning(completionsParser.takeReasoningDelta());
          toolCalls = piece.toolCalls;
        }
      }
    } finally {
      clearTimeout(firstByteTimer);
    }

    this.emit({ type: "message_end", message: this.envelope("assistant", text) });
    return { text, toolCalls };
  }

  private async fetchWithRetry(
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    signal: AbortSignal,
    isResponses: boolean,
  ): Promise<Response> {
    if (isModelStallFault()) {
      await new Promise<never>((_, reject) => {
        const fail = (): void => reject(new Error("Model run aborted"));
        if (signal.aborted) {
          fail();
          return;
        }
        signal.addEventListener("abort", fail, { once: true });
      });
    }
    let lastError: unknown;
    for (let attempt = 0; attempt <= TRANSIENT_RETRY_MAX; attempt += 1) {
      if (signal.aborted) throw new Error("Model run aborted");
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: isResponses
            ? AbortSignal.any?.([signal]) ?? signal
            : signal,
        });
        if (response.status >= 500 || response.status === 429) {
          if (attempt < TRANSIENT_RETRY_MAX) {
            await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
            continue;
          }
        }
        return response;
      } catch (error) {
        if (signal.aborted) throw new Error("Model run aborted");
        lastError = error;
        if (attempt >= TRANSIENT_RETRY_MAX) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Model request failed.");
  }

  private async executeToolCalls(toolCalls: readonly WireToolCall[], signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError(signal);
    type Slot = {
      call: WireToolCall;
      output: string;
      isError: boolean;
      ran: boolean;
      images?: PromptImage[];
    };
    const slots: Slot[] = toolCalls.map((call) => ({
      call,
      output: "",
      isError: false,
      ran: false,
    }));

    const runSlot = async (slot: Slot): Promise<void> => {
      const { call } = slot;
      const tool = this.tools.get(call.name);
      this.toolCallCount += 1;
      slot.ran = true;
      this.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name });
      if (!tool) {
        slot.isError = true;
        slot.output = `Unknown tool: ${call.name}`;
        this.emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, isError: true });
        return;
      }
      let params: unknown;
      try {
        params = call.argumentsJson ? JSON.parse(call.argumentsJson) : {};
      } catch {
        params = {};
      }
      try {
        const result = await tool.execute(call.id, params, signal);
        slot.output = result.content.map((part) => part.text).join("\n");
        if (result.images && result.images.length > 0) slot.images = [...result.images];
      } catch (error) {
        slot.isError = true;
        slot.output = error instanceof Error ? error.message : String(error);
      }
      this.emit({
        type: "tool_execution_end",
        toolCallId: call.id,
        toolName: call.name,
        isError: slot.isError,
      });
    };

    let sequentialTail = Promise.resolve();
    const running: Array<Promise<void>> = [];
    for (const slot of slots) {
      const mode = this.tools.get(slot.call.name)?.executionMode ?? "sequential";
      if (mode === "parallel") {
        running.push(runSlot(slot));
        continue;
      }
      const next = sequentialTail.then(async () => {
        if (signal.aborted) throw abortError(signal);
        await runSlot(slot);
      });
      sequentialTail = next.then(() => undefined, () => undefined);
      running.push(next);
    }

    const settled = await Promise.allSettled(running);
    for (const slot of slots) {
      if (!slot.ran) continue;
      this.history.push({
        role: "tool",
        callId: slot.call.id,
        toolName: slot.call.name,
        output: slot.output,
        isError: slot.isError,
      });
      this.lastToolName = slot.call.name;
      this.lastToolFailed = slot.isError;
    }
    const recapture = slots.flatMap((slot) => slot.images ?? []).slice(0, 1);
    if (recapture.length > 0) {
      this.history.push({
        role: "user",
        text: "Fresh observation after the last action. Use these numberedTargets. Do not reuse the earlier screenshot.",
        images: recapture,
      });
    }
    if (signal.aborted) throw abortError(signal);
    const rejected = settled.find((result) => result.status === "rejected");
    if (rejected && rejected.status === "rejected") throw rejected.reason;
  }

  private trimHistory(): void {
    while (this.history.length > MAX_HISTORY_MESSAGES) {
      this.history.shift();
    }
  }

  private envelope(role: string, content: string): SessionMessageEnvelope {
    return {
      role,
      timestamp: Date.now(),
      responseId: `resp_${randomUUID()}`,
      provider: this.options.model.providerId,
      model: this.options.model.id,
      content,
    };
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener failures must never break the loop.
      }
    }
  }
}

function abortError(signal: AbortSignal): Error {
  if (isFirstByteTimeout(signal)) return new Error(FIRST_BYTE_TIMEOUT_MESSAGE);
  return new Error("Model run aborted");
}

function isFirstByteTimeout(signal: AbortSignal, error?: unknown): boolean {
  const reason = signal.reason;
  if (reason instanceof Error && reason.message === FIRST_BYTE_TIMEOUT_MESSAGE) return true;
  return isFirstByteTimeoutError(error);
}

export function isFirstByteTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message === FIRST_BYTE_TIMEOUT_MESSAGE;
}

export interface CreateSessionOptions {
  readonly model: ResolvedModel;
  readonly providerRuntime: ModelProviderRuntime;
  readonly systemPrompt: string;
  readonly customTools: readonly AnyToolDefinition[];
  readonly context?: TurnContextProviders;
  readonly streamFirstByteTimeoutMs?: number;
}

function formatSkillCatalog(entries: readonly {
  readonly name: string;
  readonly description: string;
}[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((entry) => `- ${entry.name}: ${entry.description}`);
  return `\n\n## Verified skills available\nEach entry lists when to use the skill. Load a skill's full instructions only when the user's request matches its description; otherwise do not mention it.\n${lines.join("\n")}`;
}

export async function createYishuAgentSession(
  options: CreateSessionOptions,
): Promise<{ session: ModelSession }> {
  // ADR 0015: the skill L1 catalog is part of the stable system prefix for
  // this session's lifetime. Promotion invalidates the session cache instead
  // of mutating a live prefix.
  const catalog = await options.context?.skillCatalog?.().catch(() => undefined);
  const systemPrompt = catalog && catalog.length > 0
    ? options.systemPrompt + formatSkillCatalog(catalog)
    : options.systemPrompt;
  return { session: new YishuModelSession({ ...options, systemPrompt }) };
}
