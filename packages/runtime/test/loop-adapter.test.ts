import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type {
  ModelSession,
  ModelProviderRuntime,
  ToolDefinition,
} from "../src/model-loop/types.js";
import {
  StdioComputerUsePort,
  type ComputerUsePort,
} from "../src/computer-use-port.js";
import {
  YishuLoopRuntimeAdapter,
  type YishuLoopRuntimeAdapterOptions,
} from "../src/loop-adapter.js";
import { attachConversationHistory } from "../src/context-prompt.js";
import {
  computerActionRequestedPayloadSchema,
  LOCAL_GROK_DEFAULT_MODEL,
  LOCAL_GROK_PROVIDER,
  PROTOCOL_VERSION,
  type ComputerActionMethod,
  type ComputerActionResultCode,
  type ComputerActionStatus,
  type RuntimeEvent,
  type TurnStartCommand,
} from "../src/protocol.js";
import { makeTurnStartCommand } from "./fixtures.js";
import { FIRST_BYTE_TIMEOUT_MESSAGE } from "../src/model-loop/model-session.js";
import { fileDropTargetFingerprint } from "../src/desktop/file-drop-approval.js";
import { attachTurnIntentFrame } from "../src/intent-frame.js";
import { attachTaskExecutionContract, createTaskExecutionContract } from "../src/task-contract.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type FakeSessionEvent = {
  type: string;
  message?: {
    role: string;
    timestamp: number;
    responseId?: string;
    provider?: string;
    model?: string;
    content?: string | Array<{ type: "text"; text: string }>;
  };
  assistantMessageEvent?: { type: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  delta?: string;
  imageCount?: number;
  imageBytes?: number;
};

/**
 * The fake session implements exactly the surface YishuLoopRuntimeAdapter consumes:
 * sessionId, subscribe, prompt, abort, steer, dispose, and agent.state.
 */
class FakeModelSession {
  private static nextId = 0;
  readonly sessionId = `fake-pi-session-${++FakeModelSession.nextId}`;
  readonly agent: { state: { errorMessage?: string } } = { state: {} };
  readonly prompts: { text: string; images: unknown[] }[] = [];
  readonly steers: string[] = [];
  readonly promptStarted = deferred();
  preflightAccepted = true;
  preflightBarrier?: Promise<void>;
  abortCount = 0;
  abortBarrier?: Promise<void>;
  disposed = false;
  disposeCount = 0;
  activeToolNames = ["read", "web_search", "computer_control", "delegate"];
  readonly activeToolNameSets: string[][] = [];
  promptHandler: (session: FakeModelSession, text: string) => Promise<void> = async (session) => {
    session.emitTextDelta("收到。");
  };
  steerHandler: (session: FakeModelSession, text: string) => Promise<void> = async () => {};
  queuedSteerHandler?: (session: FakeModelSession, text: string) => Promise<void>;
  afterPromptSettled?: (session: FakeModelSession, text: string) => Promise<void>;
  isStreaming = false;
  private readonly pendingSteers: string[] = [];
  private readonly abortGate = deferred();
  private readonly listeners = new Set<(event: FakeSessionEvent) => void>();

  subscribe(listener: (event: FakeSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getActiveToolNames(): readonly string[] {
    return this.activeToolNames;
  }

  setActiveToolsByName(names: readonly string[]): void {
    this.activeToolNames = [...names];
    this.activeToolNameSets.push([...names]);
  }

  emitSessionEvent(event: FakeSessionEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  emitTextDelta(delta: string, message?: FakeSessionEvent["message"]): void {
    this.emitSessionEvent({
      type: "message_update",
      ...(message === undefined ? {} : { message }),
      assistantMessageEvent: { type: "text_delta", delta },
    });
  }

  emitMessageStart(message: NonNullable<FakeSessionEvent["message"]>): void {
    this.emitSessionEvent({ type: "message_start", message });
  }

  emitMessageEnd(message: NonNullable<FakeSessionEvent["message"]>): void {
    this.emitSessionEvent({ type: "message_end", message });
  }

  emitTurnEnd(message: NonNullable<FakeSessionEvent["message"]>): void {
    this.emitSessionEvent({ type: "turn_end", message });
  }

  waitUntilAborted(): Promise<void> {
    return this.abortGate.promise;
  }

  async prompt(
    text: string,
    options?: {
      images?: unknown[];
      streamingBehavior?: "steer" | "followUp";
      preflightResult?: (accepted: boolean) => void;
    },
  ): Promise<void> {
    this.prompts.push({ text, images: options?.images ?? [] });
    this.promptStarted.resolve();
    await this.preflightBarrier;
    options?.preflightResult?.(this.preflightAccepted);
    if (!this.preflightAccepted) {
      throw new Error("Fake Pi prompt preflight rejected.");
    }
    if (this.isStreaming) {
      this.steers.push(text);
      this.pendingSteers.push(text);
      await this.steerHandler(this, text);
      return;
    }
    this.isStreaming = true;
    try {
      await this.promptHandler(this, text);
      for (let queuedText = this.pendingSteers.shift(); queuedText !== undefined; queuedText = this.pendingSteers.shift()) {
        const queued = this.queuedSteerHandler;
        if (queued !== undefined) await queued(this, queuedText);
        else await this.promptHandler(this, queuedText);
      }
    } finally {
      this.isStreaming = false;
    }
    await this.afterPromptSettled?.(this, text);
  }

  async steer(text: string): Promise<void> {
    this.steers.push(text);
    await this.steerHandler(this, text);
  }

  async abort(): Promise<void> {
    this.abortCount += 1;
    await this.abortBarrier;
    this.abortGate.resolve();
  }

  dispose(): void {
    this.disposeCount += 1;
    this.disposed = true;
  }
}

type FakeTool = ToolDefinition<any, any, any>;

interface FakePiHarness {
  readonly adapterOptions: YishuLoopRuntimeAdapterOptions;
  readonly sessions: FakeModelSession[];
  readonly registeredProviderIds: string[];
  readonly capturedTools: FakeTool[];
  configureSession(session: FakeModelSession): void;
  waitForNextSession(): Promise<FakeModelSession>;
}

function createFakePiHarness(): FakePiHarness {
  const sessions: FakeModelSession[] = [];
  const registeredProviderIds: string[] = [];
  const capturedTools: FakeTool[] = [];
  const sessionWaiters: Array<(session: FakeModelSession) => void> = [];
  const modelRuntime = {
    getProvider: (_providerId: string) => undefined,
    resolveModel: async (provider: string, modelId: string) => ({
      providerId: provider,
      id: modelId,
      name: modelId,
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:8787/v1",
      input: ["text", "image"],
      contextWindow: 128_000,
      maxTokens: 8_192,
    }),
  };
  const harness: FakePiHarness = {
    sessions,
    registeredProviderIds,
    capturedTools,
    configureSession: () => {},
    waitForNextSession: () => new Promise((resolve) => {
      sessionWaiters.push(resolve);
    }),
    adapterOptions: {
      modelRuntimePromise: Promise.resolve(modelRuntime as unknown as ModelProviderRuntime),
      interruptionSteerTimeoutMs: 100,
      createSession: (async (options: { customTools?: FakeTool[] }) => {
        const session = new FakeModelSession();
        sessions.push(session);
        capturedTools.push(...(options.customTools ?? []));
        harness.configureSession(session);
        for (const waiter of sessionWaiters.splice(0)) {
          waiter(session);
        }
        return { session: session as unknown as ModelSession };
      }) as NonNullable<YishuLoopRuntimeAdapterOptions["createSession"]>,
    },
  };
  return harness;
}

const unusedPort: ComputerUsePort = {
  perform: async () => ({ succeeded: false, verified: false, message: "unused" }),
  resolve: () => false,
  cancelRequest: () => {},
  dispose: () => {},
};

async function makeAdapter(
  harness: FakePiHarness,
  computerUsePort: ComputerUsePort = unusedPort,
): Promise<{ adapter: YishuLoopRuntimeAdapter; workdir: string }> {
  const workdir = await mkdtemp(path.join(tmpdir(), "yishu-pi-adapter-test-"));
  const adapter = new YishuLoopRuntimeAdapter(workdir, computerUsePort, harness.adapterOptions);
  return { adapter, workdir };
}

function cleanupAfter(t: TestContext, adapter: YishuLoopRuntimeAdapter, workdir: string): void {
  t.after(async () => {
    await adapter.dispose();
    await rm(workdir, { recursive: true, force: true });
  });
}

function makeCommand(utterance?: string, conversationId?: string): TurnStartCommand {
  const command = makeTurnStartCommand();
  // Most lifecycle tests exercise conversation plumbing, not the
  // screen-dependent POINT contract. Keep those turns ordinary and reserve
  // explicit screen utterances for the focused contract cases above.
  command.payload.utterance = utterance ?? "你好";
  if (conversationId !== undefined) command.payload.conversationId = conversationId;
  return command;
}

function makeInterruptCommand(command: TurnStartCommand, expectedGeneration: number) {
  return {
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.interrupt" as const,
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: { expectedGeneration, reason: "user_barge_in" as const },
  };
}

function makeSteerCommand(
  command: TurnStartCommand,
  message: string,
  nextGeneration: number,
) {
  return {
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.steer" as const,
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: {
      message,
      nextGeneration,
      interactionClass: "conversation" as const,
    },
  };
}

function makeCancelCommand(command: TurnStartCommand) {
  return {
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.cancel" as const,
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: { reason: "user_cancelled" },
  };
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  attempts = 100,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function eventTypes(events: readonly RuntimeEvent[]): string[] {
  return events.map((event) => event.type);
}

test("direct-click POINT still dispatches one left_click instead of flying", async (t) => {
  const harness = createFakePiHarness();
  const events: RuntimeEvent[] = [];
  const requested = deferred<RuntimeEvent>();
  const sink = (event: RuntimeEvent): void => {
    events.push(event);
    if (event.type === "computer.action.requested") requested.resolve(event);
  };
  const port = new StdioComputerUsePort(sink, 30_000);
  const { adapter, workdir } = await makeAdapter(harness, port);
  cleanupAfter(t, adapter, workdir);

  harness.configureSession = (session) => {
    session.promptHandler = async (s) => {
      s.emitTextDelta("我点那个。[POINT:52,78:保存]");
    };
  };

  const command = makeCommand("点击保存按钮");
  const turn = adapter.startTurn(command, sink);
  const requestEvent = await requested.promise;
  const payload = computerActionRequestedPayloadSchema.parse(requestEvent.payload);
  assert.equal(payload.action, "left_click");
  if (payload.action === "left_click") {
    assert.equal(payload.x, 52);
    assert.equal(payload.y, 78);
  }
  assert.equal(port.resolve({
    schemaVersion: PROTOCOL_VERSION,
    type: "computer.action.result",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: {
      actionId: payload.actionId,
      ...(payload.attemptId === undefined ? {} : { attemptId: payload.attemptId }),
      succeeded: true,
      verified: true,
      status: "verified",
      code: "verified_accessibility",
      method: "ax_press",
      message: "AXPress succeeded.",
    },
  }), true);
  await turn;
  assert.equal(harness.sessions[0]?.prompts.length, 1, "direct actions do not enter POINT repair");
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(completed?.payload.text, "我点那个。");
  assert.doesNotMatch(String(completed?.payload.text), /POINT/);
});

test("observational POINT stays off the stream and lands on completion so Clicky can fly", async (t) => {
  const harness = createFakePiHarness();
  harness.configureSession = (session) => {
    session.promptHandler = async (s) => {
      s.emitTextDelta("日期在屏幕最顶上那条菜单栏。");
      s.emitTextDelta("[POINT:1180,18:日期]");
    };
  };
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);

  const events: RuntimeEvent[] = [];
  await adapter.startTurn(makeCommand("日期在哪"), (event) => events.push(event));

  const deltaText = events
    .filter((event) => event.type === "response.delta")
    .map((event) => String(event.payload.text))
    .join("");
  const completed = events.find((event) => event.type === "response.completed");
  assert.ok(completed);
  assert.equal(deltaText, "日期在屏幕最顶上那条菜单栏。");
  assert.equal(
    completed.payload.text,
    "日期在屏幕最顶上那条菜单栏。\n[POINT:1180,18:日期]",
  );
  assert.equal(completed.payload.verifier, "conversation-response-only");
  assert.equal(events.some((event) => event.type === "computer.action.requested"), false);
});

test("a missing or none POINT is repaired once with the same image and only the repaired answer completes", async (t) => {
  const harness = createFakePiHarness();
  let promptCount = 0;
  harness.configureSession = (session) => {
    session.promptHandler = async (current) => {
      promptCount += 1;
      current.emitTextDelta(promptCount === 1
        ? "初始屏幕结论，不应先流出。[POINT:none]"
        : "修复后的屏幕结论。[POINT:320,240:页面]");
    };
  };
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);

  const command = makeCommand("当前页面是什么");
  const events: RuntimeEvent[] = [];
  await adapter.startTurn(command, (event) => events.push(event));

  assert.equal(promptCount, 2, "the missing directive gets one bounded repair");
  assert.equal(harness.sessions.length, 1);
  assert.equal(harness.sessions[0]?.prompts.length, 2);
  assert.match(harness.sessions[0]?.prompts[1]?.text ?? "", /一句直接答案/u);
  assert.deepEqual(
    harness.sessions[0]?.prompts.map((prompt) => prompt.images),
    [
      [{
        type: "image",
        data: "c2NyZWVu",
        mimeType: "image/jpeg",
        label: "cursor display (image dimensions: 1280x800 pixels)",
      }],
      [{
        type: "image",
        data: "c2NyZWVu",
        mimeType: "image/jpeg",
        label: "cursor display (image dimensions: 1280x800 pixels)",
      }],
    ],
    "repair must keep the original image context",
  );

  const deltaText = events
    .filter((event) => event.type === "response.delta")
    .map((event) => String(event.payload.text))
    .join("");
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(deltaText, "初始屏幕结论，不应先流出。修复后的屏幕结论。");
  assert.equal(completed?.payload.text, "修复后的屏幕结论。\n[POINT:320,240:页面]");
  assert.match(deltaText, /初始屏幕结论/u, "ordinary streaming remains available before repair");
  assert.doesNotMatch(String(completed?.payload.text), /初始屏幕结论/u);
  assert.equal(events.filter((event) => event.type === "response.completed").length, 1);
});

test("an ordinary no-POINT reply completes without a repair", async (t) => {
  const harness = createFakePiHarness();
  harness.configureSession = (session) => {
    session.promptHandler = async (current) => {
      current.emitTextDelta("法国的首都是巴黎。");
    };
  };
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);

  const events: RuntimeEvent[] = [];
  await adapter.startTurn(makeCommand("法国的首都是哪里？"), (event) => events.push(event));

  assert.equal(harness.sessions[0]?.prompts.length, 1);
  assert.equal(events.find((event) => event.type === "response.completed")?.payload.text, "法国的首都是巴黎。");
  assert.equal(events.some((event) => event.type === "turn.failed"), false);
});

test("a missing POINT after repair fails soft without a completion or fallback point", async (t) => {
  const harness = createFakePiHarness();
  let promptCount = 0;
  harness.configureSession = (session) => {
    session.promptHandler = async (current) => {
      promptCount += 1;
      current.emitTextDelta(promptCount === 1 ? "首版回答。" : "修复仍缺少标签。\n");
    };
  };
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);

  const events: RuntimeEvent[] = [];
  await adapter.startTurn(makeCommand("看看当前页面"), (event) => events.push(event));

  assert.equal(promptCount, 2);
  const deltaText = events
    .filter((event) => event.type === "response.delta")
    .map((event) => String(event.payload.text))
    .join("");
  assert.match(deltaText, /首版回答/u, "the first response may keep streaming before fail-soft");
  assert.doesNotMatch(deltaText, /POINT/u);
  assert.equal(events.some((event) => event.type === "response.completed"), false);
  const failed = events.find((event) => event.type === "turn.failed");
  assert.ok(failed);
  assert.equal(failed.payload.code, "point_directive_missing");
});

test("startTurn prompts with grounded text and streams deltas to completion", async (t) => {
  const harness = createFakePiHarness();
  harness.configureSession = (session) => {
    session.promptHandler = async (s) => {
      s.emitTextDelta("我在");
      s.emitTextDelta("听。");
    };
  };
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);

  const command = makeCommand();
  const events: RuntimeEvent[] = [];
  await adapter.startTurn(command, (event) => events.push(event));

  assert.equal(harness.sessions.length, 1);
  const session = harness.sessions[0]!;
  assert.equal(session.prompts.length, 1);
  const prompt = session.prompts[0]!;
  assert.ok(prompt.text.includes("<user_utterance>"));
  assert.ok(prompt.text.includes(command.payload.utterance));
  assert.ok(
    !prompt.text.includes("c2NyZWVu"),
    "screenshot base64 must stay out of the text prompt",
  );
  assert.equal(prompt.images.length, 0);
  assert.match(prompt.text, /前台应用：/);
  assert.doesNotMatch(prompt.text, /<context_frame>/);
  assert.doesNotMatch(prompt.text, /<numbered_targets>/);

  const started = events.find((event) => event.type === "turn.started");
  assert.ok(started);
  assert.equal(started.payload.runtime, "yishu-loop");
  assert.equal(started.payload.capabilityProfile, "conversation");
  assert.equal(started.payload.sessionId, session.sessionId);
  assert.equal(started.payload.provider, LOCAL_GROK_PROVIDER);
  assert.equal(started.payload.model, LOCAL_GROK_DEFAULT_MODEL);
  assert.equal(started.payload.baseUrl, "127.0.0.1:8787");
  assert.equal(typeof started.payload.receivedAt, "string");

  const deltaText = events
    .filter((event) => event.type === "response.delta")
    .map((event) => String(event.payload.text))
    .join("");
  const completed = events.find((event) => event.type === "response.completed");
  assert.ok(completed);
  assert.equal(completed.payload.text, "我在听。");
  assert.equal(deltaText, completed.payload.text);
  assert.equal(completed.payload.verified, false);
  assert.equal(completed.payload.verifier, "conversation-response-only");
  assert.ok(!events.some((event) => event.type === "turn.failed"));
});

test("timing records SSE first byte, first reasoning, and visible first byte with reasoningChars", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "yishu-loop-timing-"));
  const filePath = path.join(dir, "runtime-timing.jsonl");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previousPath = process.env.YISHU_RUNTIME_TIMING_PATH;
  process.env.YISHU_RUNTIME_TIMING_PATH = filePath;
  t.after(() => {
    if (previousPath === undefined) delete process.env.YISHU_RUNTIME_TIMING_PATH;
    else process.env.YISHU_RUNTIME_TIMING_PATH = previousPath;
  });

  const harness = createFakePiHarness();
  harness.configureSession = (session) => {
    session.promptHandler = async (s) => {
      s.emitSessionEvent({ type: "request_sent", imageCount: 0, imageBytes: 0 });
      s.emitSessionEvent({ type: "sse_first_byte" });
      s.emitSessionEvent({ type: "reasoning_delta", delta: "hidden-chain" });
      s.emitTextDelta("<think>tag-think</think>在。");
    };
  };
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);

  const events: RuntimeEvent[] = [];
  await adapter.startTurn(makeCommand("在吗"), (event) => events.push(event));

  const spoken = events
    .filter((event) => event.type === "response.delta")
    .map((event) => String(event.payload.text))
    .join("");
  assert.equal(spoken, "在。");

  const lines = (await readFile(filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
    name?: string;
    reasoningChars?: number;
  });
  const names = lines.map((row) => row.name);
  const sse = names.indexOf("model.sse_first_byte");
  const thought = names.indexOf("model.first_reasoning");
  const visible = names.indexOf("model.first_byte");
  assert.ok(sse >= 0 && thought > sse && visible > thought);
  const firstByte = lines.find((row) => row.name === "model.first_byte");
  assert.equal(firstByte?.reasoningChars, "hidden-chain".length + "tag-think".length);
});

test("plain chat attaches no screenshots even with extra displays", async (t) => {
  const harness = createFakePiHarness();
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);
  const command = makeCommand("今天星期几");
  command.payload.contextFrame.screenshots = [
    ...command.payload.contextFrame.screenshots,
    {
      label: "display 2",
      mediaType: "image/jpeg",
      base64Data: "ZXh0cmE=",
      displayWidthPoints: 1440,
      displayHeightPoints: 900,
      displayOriginXPoints: 1440,
      displayOriginYPoints: 0,
      screenshotWidthPixels: 1280,
      screenshotHeightPixels: 800,
    },
  ];
  command.payload.contextFrame.numberedTargets = [
    { id: "1", role: "AXButton", title: "Back", description: null, enabled: true },
  ];
  await adapter.startTurn(command, () => undefined);
  assert.equal(harness.sessions[0]!.prompts[0]!.images.length, 0);
  assert.doesNotMatch(harness.sessions[0]!.prompts[0]!.text, /numbered_targets/);
});

test("expired ContextFrame fails before the model prompt and publishes no response", async (t) => {
  const harness = createFakePiHarness();
  harness.configureSession = (session) => {
    session.promptHandler = async (current) => {
      current.emitTextDelta("这段回答不应该出现。");
    };
  };
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);

  const command = makeCommand();
  command.payload.contextFrame.capturedAt = "2020-01-01T00:00:00.000Z";
  command.payload.contextFrame.expiresAt = "2020-01-01T00:00:01.000Z";
  const events: RuntimeEvent[] = [];
  await adapter.startTurn(command, (event) => events.push(event));

  assert.deepEqual(eventTypes(events), ["turn.started", "turn.failed"]);
  assert.equal(harness.sessions[0]?.prompts.length, 0, "expired frame must not reach Pi");
  const failed = events.at(-1)!;
  assert.equal(failed.payload.code, "context_frame_expired");
  assert.equal(
    failed.payload.message,
    "ContextFrame expired before the model prompt was admitted.",
  );
  assert.equal(events.some((event) => event.type === "response.delta"), false);
  assert.equal(events.some((event) => event.type === "response.completed"), false);
});

test("materially future ContextFrame fails before the model prompt", async (t) => {
  const harness = createFakePiHarness();
  harness.adapterOptions.now = () => new Date("2026-08-29T00:00:00.000Z");
  harness.configureSession = (session) => {
    session.promptHandler = async (current) => {
      current.emitTextDelta("这段回答不应该出现。");
    };
  };
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);

  const command = makeCommand();
  command.payload.contextFrame.capturedAt = "2026-08-29T00:01:00.000Z";
  command.payload.contextFrame.expiresAt = "2026-08-29T00:02:00.000Z";
  const events: RuntimeEvent[] = [];
  await adapter.startTurn(command, (event) => events.push(event));

  assert.deepEqual(eventTypes(events), ["turn.started", "turn.failed"]);
  assert.equal(harness.sessions[0]?.prompts.length, 0, "future frame must not reach Pi");
  const failed = events.at(-1)!;
  assert.equal(failed.payload.code, "context_frame_from_future");
  assert.equal(failed.payload.message, "ContextFrame capturedAt is too far in the future.");
  assert.equal(events.some((event) => event.type === "response.delta"), false);
  assert.equal(events.some((event) => event.type === "response.completed"), false);
});

test("barge-in suppresses stale output and completes only the replacement generation", async (t) => {
  const harness = createFakePiHarness();
  const oldTurnRelease = deferred();
  const oldHalfEmitted = deferred();
  const oldAssistant = {
    role: "assistant",
    timestamp: 1,
    responseId: "old",
    provider: LOCAL_GROK_PROVIDER,
    model: "grok-4.5",
    content: [{ type: "text" as const, text: "旧半句" }],
  };
  harness.configureSession = (session) => {
    const emitReplacement = async (current: FakeModelSession) => {
      const user = {
        role: "user",
        timestamp: 2,
        content: [{ type: "text" as const, text: "请改讲新答案" }],
      };
      const replacement = {
        role: "assistant",
        timestamp: 3,
        responseId: "replacement",
        provider: LOCAL_GROK_PROVIDER,
        model: "grok-4.5",
        content: [{ type: "text" as const, text: "新答案。" }],
      };
      current.emitMessageStart(user);
      current.emitMessageStart(replacement);
      current.emitTextDelta("新答案。", replacement);
      current.emitTurnEnd(replacement);
    };
    session.queuedSteerHandler = emitReplacement;
    session.promptHandler = async (current, text) => {
      if (text === "请改讲新答案") {
        await emitReplacement(current);
        return;
      }
      current.emitMessageStart(oldAssistant);
      current.emitTextDelta("旧半句", oldAssistant);
      oldHalfEmitted.resolve();
      await oldTurnRelease.promise;
      current.emitTextDelta("迟到旧文。", oldAssistant);
      current.emitTurnEnd(oldAssistant);
    };
  };
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);
  const command = makeCommand();
  const events: RuntimeEvent[] = [];
  const turn = adapter.startTurn(command, (event) => events.push(event));
  const session = await harness.waitForNextSession();
  await session.promptStarted.promise;
  await oldHalfEmitted.promise;

  await adapter.interruptTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.interrupt",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: { expectedGeneration: 1, reason: "user_barge_in" },
  }, (event) => events.push(event));
  const steer = adapter.steerTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.steer",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: {
      message: "请改讲新答案",
      nextGeneration: 2,
      interactionClass: "conversation",
    },
  }, (event) => events.push(event));
  oldTurnRelease.resolve();
  await Promise.all([steer, turn]);

  const emittedText = events
    .filter((event) => event.type === "response.delta")
    .map((event) => String(event.payload.text))
    .join("");
  assert.equal(emittedText, "旧半句新答案。");
  const completion = events.find((event) => event.type === "response.completed");
  assert.equal(completion?.payload.text, "新答案。");
  assert.equal(completion?.payload.generation, 2);
  assert.equal(session.prompts.length, 2, "replacement input is admitted exactly once");
  assert.equal(session.prompts[1]?.text, "请改讲新答案");
  assert.equal(
    session.prompts.filter((prompt) => prompt.text === "请改讲新答案").length,
    1,
    "replacement transcript reaches Pi exactly once whether the old run is active or idle",
  );
  assert.ok(events.some((event) => event.type === "turn.interrupt.accepted"));
});

test("two barge-ins before the first replacement token complete only generation three", async (t) => {
  const harness = createFakePiHarness();
  const releaseInitial = deferred();
  const releaseGenerationTwo = deferred();
  const generationTwoUserSeen = deferred();
  const assistant = (generation: number, text: string) => ({
    role: "assistant",
    timestamp: generation,
    responseId: `response-${generation}`,
    provider: LOCAL_GROK_PROVIDER,
    model: "grok-4.5",
    content: [{ type: "text" as const, text }],
  });
  harness.configureSession = (session) => {
    session.promptHandler = async (current, text) => {
      if (text === "第二个问题") {
        current.emitMessageStart({
          role: "user",
          timestamp: 2,
          content: [{ type: "text", text }],
        });
        generationTwoUserSeen.resolve();
        await releaseGenerationTwo.promise;
        const message = assistant(2, "第二代旧答案");
        current.emitMessageStart(message);
        current.emitTextDelta("第二代旧答案", message);
        current.emitMessageEnd(message);
        current.emitTurnEnd(message);
        return;
      }
      if (text === "最终问题") {
        current.emitMessageStart({
          role: "user",
          timestamp: 3,
          content: [{ type: "text", text }],
        });
        const message = assistant(3, "最终答案。");
        current.emitMessageStart(message);
        current.emitTextDelta("最终答案。", message);
        current.emitMessageEnd(message);
        current.emitTurnEnd(message);
        return;
      }
      const message = assistant(1, "第一代旧答案");
      current.emitMessageStart(message);
      current.emitTextDelta("第一代", message);
      await releaseInitial.promise;
      current.emitTextDelta("迟到旧答案", message);
      current.emitMessageEnd(message);
      current.emitTurnEnd(message);
    };
  };
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);
  const command = makeCommand();
  const events: RuntimeEvent[] = [];
  const turn = adapter.startTurn(command, (event) => events.push(event));
  const session = await harness.waitForNextSession();
  await session.promptStarted.promise;

  await adapter.interruptTurn(makeInterruptCommand(command, 1), (event) => events.push(event));
  await adapter.steerTurn(makeSteerCommand(command, "第二个问题", 2), (event) => events.push(event));
  releaseInitial.resolve();
  await generationTwoUserSeen.promise;

  // Generation two is already the Product-owned target, but Pi has not
  // started its assistant message. A second PTT interruption must still win.
  await adapter.interruptTurn(makeInterruptCommand(command, 2), (event) => events.push(event));
  await adapter.steerTurn(makeSteerCommand(command, "最终问题", 3), (event) => events.push(event));
  releaseGenerationTwo.resolve();
  await turn;

  const accepted = events.filter((event) => event.type === "turn.interrupt.accepted");
  assert.deepEqual(accepted.map((event) => event.payload), [
    { interruptedGeneration: 1, nextGeneration: 2 },
    { interruptedGeneration: 2, nextGeneration: 3 },
  ]);
  assert.equal(
    events.filter((event) => event.type === "response.delta" && event.payload.generation === 2).length,
    0,
    "generation two stays silent after its pre-token interruption",
  );
  const completions = events.filter((event) => event.type === "response.completed");
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.payload.generation, 3);
  assert.equal(completions[0]?.payload.text, "最终答案。");
  assert.equal(events.some((event) => event.type === "turn.failed"), false);
  assert.equal(session.prompts.filter((prompt) => prompt.text === "第二个问题").length, 1);
  assert.equal(session.prompts.filter((prompt) => prompt.text === "最终问题").length, 1);
});

test("same-text barge-in before the first assistant start never relabels the old reply", async (t) => {
  const harness = createFakePiHarness();
  const releaseOriginal = deferred();
  const utterance = "继续说";
  harness.configureSession = (session) => {
    session.promptHandler = async (current, text) => {
      if (text === utterance) {
        current.emitMessageStart({
          role: "user",
          timestamp: 1,
          content: [{ type: "text", text: utterance }],
        });
        const replacement = {
          role: "assistant",
          timestamp: 1,
          provider: LOCAL_GROK_PROVIDER,
          model: "grok-4.5",
        };
        current.emitMessageStart(replacement);
        current.emitTextDelta("新回答。", replacement);
        current.emitMessageEnd(replacement);
        current.emitTurnEnd(replacement);
        return;
      }
      await releaseOriginal.promise;
      // Pi can surface the original user message after the interrupt. Its raw
      // text is intentionally identical to B and must consume only the initial
      // prompt boundary, never arm generation two.
      current.emitMessageStart({
        role: "user",
        timestamp: 1,
        content: [{ type: "text", text: utterance }],
      });
      const old = {
        role: "assistant",
        timestamp: 1,
        provider: LOCAL_GROK_PROVIDER,
        model: "grok-4.5",
      };
      current.emitMessageStart(old);
      current.emitTextDelta("旧回答。", old);
      current.emitMessageEnd(old);
      current.emitTurnEnd(old);
    };
  };
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);
  const command = makeCommand(utterance);
  const events: RuntimeEvent[] = [];
  const turn = adapter.startTurn(command, (event) => events.push(event));
  const session = await harness.waitForNextSession();
  await session.promptStarted.promise;
  await adapter.interruptTurn(makeInterruptCommand(command, 1), (event) => events.push(event));
  await adapter.steerTurn(makeSteerCommand(command, utterance, 2), (event) => events.push(event));
  releaseOriginal.resolve();
  await turn;

  assert.equal(
    events.filter((event) => event.type === "response.delta" && event.payload.generation === 1).length,
    0,
  );
  const completion = events.find((event) => event.type === "response.completed");
  assert.equal(completion?.payload.generation, 2);
  assert.equal(completion?.payload.text, "新回答。");
  assert.equal(session.prompts.filter((prompt) => prompt.text === utterance).length, 1);
});

test("a replacement provider operation is bounded by the interruption deadline", async (t) => {
  const harness = createFakePiHarness();
  const releaseInitial = deferred();
  const never = deferred();
  harness.configureSession = (session) => {
    session.steerHandler = async () => {
      await never.promise;
    };
    session.promptHandler = async (current, text) => {
      current.emitMessageStart({
        role: "assistant",
        timestamp: 1,
        responseId: "bounded-old",
        provider: LOCAL_GROK_PROVIDER,
        model: "grok-4.5",
      });
      await releaseInitial.promise;
      current.emitTurnEnd({
        role: "assistant",
        timestamp: 1,
        responseId: "bounded-old",
        provider: LOCAL_GROK_PROVIDER,
        model: "grok-4.5",
      });
    };
  };
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);
  const command = makeCommand();
  const events: RuntimeEvent[] = [];
  const startedAt = Date.now();
  const turn = adapter.startTurn(command, (event) => events.push(event));
  const session = await harness.waitForNextSession();
  await session.promptStarted.promise;
  await adapter.interruptTurn(makeInterruptCommand(command, 1), (event) => events.push(event));
  await adapter.steerTurn(makeSteerCommand(command, "不会完成", 2), (event) => events.push(event));
  releaseInitial.resolve();
  await turn;

  assert.ok(Date.now() - startedAt < 1_000, "test timeout seam must keep the race bounded");
  const failed = events.find((event) => event.type === "turn.failed");
  assert.ok(failed);
  assert.equal(failed.payload.code, "steer_replacement_failed_before_start");
  assert.equal(failed.payload.generation, 2);
  assert.equal(events.some((event) => event.type === "response.completed"), false);
});

test("an idle replacement provider failure is recoverable only before assistant start", async (t) => {
  for (const assistantStarted of [false, true]) {
    const harness = createFakePiHarness();
    const initialProviderSettled = deferred();
    const releaseInitialPrompt = deferred();
    harness.configureSession = (session) => {
      session.afterPromptSettled = async (_current, text) => {
        if (text.includes("<user_utterance>")) {
          initialProviderSettled.resolve();
          await releaseInitialPrompt.promise;
        }
      };
      session.promptHandler = async (current, text) => {
        if (text === "恢复这句话") {
          current.emitMessageStart({
            role: "user",
            timestamp: 2,
            content: [{ type: "text", text }],
          });
          if (assistantStarted) {
            current.emitMessageStart({
              role: "assistant",
              timestamp: 2,
              responseId: "replacement-started",
              provider: LOCAL_GROK_PROVIDER,
              model: "grok-4.5",
            });
          }
          throw new Error("provider down");
        }
        const original = {
          role: "assistant",
          timestamp: 1,
          responseId: "idle-original",
          provider: LOCAL_GROK_PROVIDER,
          model: "grok-4.5",
        };
        current.emitMessageStart(original);
        current.emitTextDelta("旧回答。", original);
        current.emitMessageEnd(original);
        current.emitTurnEnd(original);
      };
    };
    const { adapter, workdir } = await makeAdapter(harness);
    t.after(async () => {
      await adapter.dispose();
      await rm(workdir, { recursive: true, force: true });
    });
    const command = makeCommand();
    const events: RuntimeEvent[] = [];
    const turn = adapter.startTurn(command, (event) => events.push(event));
    await harness.waitForNextSession();
    await initialProviderSettled.promise;
    await adapter.interruptTurn(makeInterruptCommand(command, 1), (event) => events.push(event));
    await adapter.steerTurn(makeSteerCommand(command, "恢复这句话", 2), (event) => events.push(event));
    releaseInitialPrompt.resolve();
    await turn;

    const failed = events.find((event) => event.type === "turn.failed");
    assert.ok(failed);
    assert.equal(
      failed.payload.code,
      assistantStarted ? "pi_turn_failed" : "steer_replacement_failed_before_start",
    );
    assert.equal(failed.payload.generation, 2);
    assert.equal(
      harness.sessions[0]!.prompts.filter((prompt) => prompt.text === "恢复这句话").length,
      1,
    );
  }
});

test("an interrupted prompt rejected at Pi preflight fails without waiting for the steer timeout", async (t) => {
  const harness = createFakePiHarness();
  const releasePreflight = deferred();
  harness.configureSession = (session) => {
    session.preflightAccepted = false;
    session.preflightBarrier = releasePreflight.promise;
  };
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);
  const command = makeCommand();
  const events: RuntimeEvent[] = [];
  const startedAt = Date.now();
  const turn = adapter.startTurn(command, (event) => events.push(event));
  const session = await harness.waitForNextSession();
  await session.promptStarted.promise;
  await adapter.interruptTurn(makeInterruptCommand(command, 1), (event) => events.push(event));
  await adapter.steerTurn(makeSteerCommand(command, "不会进入模型", 2), (event) => events.push(event));
  releasePreflight.resolve();
  await turn;

  assert.ok(Date.now() - startedAt < 1_000);
  assert.ok(events.some((event) => event.type === "turn.interrupt.accepted"));
  assert.ok(events.some((event) => event.type === "turn.failed"));
  assert.equal(session.prompts.filter((prompt) => prompt.text === "不会进入模型").length, 0);
});

test("an accepted interruption fences computer dispatch before the actuator port", async (t) => {
  const harness = createFakePiHarness();
  const invokeTool = deferred();
  const toolFinished = deferred();
  let performed = 0;
  const { adapter, workdir } = await makeAdapter(harness, {
    async perform() {
      performed += 1;
      return { succeeded: true, verified: true, message: "must not dispatch" };
    },
    resolve: () => false,
    cancelRequest: () => {},
    dispose: () => {},
  });
  cleanupAfter(t, adapter, workdir);
  harness.configureSession = (session) => {
    session.promptHandler = async (current) => {
      const assistant = {
        role: "assistant",
        timestamp: 1,
        responseId: "effect-old",
        provider: LOCAL_GROK_PROVIDER,
        model: "grok-4.5",
      };
      current.emitMessageStart(assistant);
      await invokeTool.promise;
      const tool = harness.capturedTools.find((candidate) => candidate.name === "computer_control")!;
      await assert.rejects(
        () => tool.execute(
          "interrupted-effect",
          { action: "left_click", x: 20, y: 30 },
          undefined,
          undefined,
          {} as never,
        ),
        /interrupted/i,
      );
      toolFinished.resolve();
      await current.waitUntilAborted();
    };
  };
  const command = makeCommand("点击保存按钮");
  const events: RuntimeEvent[] = [];
  const turn = adapter.startTurn(command, (event) => events.push(event));
  const session = await harness.waitForNextSession();
  await session.promptStarted.promise;
  await adapter.interruptTurn(makeInterruptCommand(command, 1), (event) => events.push(event));
  invokeTool.resolve();
  await toolFinished.promise;

  assert.equal(performed, 0);
  assert.equal(events.filter((event) => event.type === "computer.action.requested").length, 0);
  await adapter.cancelTurn(makeCancelCommand(command), (event) => events.push(event));
  await turn;
});

test("page-note receipt reconciliation keeps one dispatched macOS receipt through Pi cancellation", async (t) => {
  const harness = createFakePiHarness();
  let cancelledPortRequests = 0;
  const { adapter, workdir } = await makeAdapter(harness, {
    perform: async () => ({ succeeded: false, verified: false, message: "unused" }),
    resolve: () => false,
    cancelRequest: () => { cancelledPortRequests += 1; },
    dispose: () => {},
  });
  cleanupAfter(t, adapter, workdir);
  harness.configureSession = (session) => {
    session.promptHandler = (current) => current.waitUntilAborted();
  };
  const command = makeCommand();
  const turn = adapter.startTurn(command, () => undefined);
  const session = await harness.waitForNextSession();
  await session.promptStarted.promise;

  // This is called by the shared port only after it emitted the single macOS
  // request. Before this point ordinary cancellation still cancels the port.
  const finishReceipt = adapter.beginPageNoteReceiptReconciliation(command.requestId);
  await adapter.cancelTurn(makeCancelCommand(command), () => undefined);
  assert.equal(cancelledPortRequests, 0);
  finishReceipt();
  await turn;
});

test("disposing Pi keeps a dispatched page-note receipt alive, then closes its port once", async (t) => {
  const harness = createFakePiHarness();
  let cancelledPortRequests = 0;
  let disposedPort = 0;
  const { adapter, workdir } = await makeAdapter(harness, {
    perform: async () => ({ succeeded: false, verified: false, message: "unused" }),
    resolve: () => false,
    cancelRequest: () => { cancelledPortRequests += 1; },
    dispose: () => { disposedPort += 1; },
  });
  t.after(async () => { await rm(workdir, { recursive: true, force: true }); });
  harness.configureSession = (session) => {
    session.promptHandler = (current) => current.waitUntilAborted();
  };
  const command = makeCommand();
  const turn = adapter.startTurn(command, () => undefined);
  const session = await harness.waitForNextSession();
  await session.promptStarted.promise;

  const finishReceipt = adapter.beginPageNoteReceiptReconciliation(command.requestId);
  await adapter.dispose();
  assert.equal(cancelledPortRequests, 0);
  assert.equal(disposedPort, 0);
  finishReceipt();
  assert.equal(disposedPort, 1);
  await turn;
});

test("an accepted interruption fences delegate before its effectful execute", async (t) => {
  const harness = createFakePiHarness();
  const release = deferred();
  let delegated = 0;
  const delegate = {
    name: "delegate",
    label: "Delegate",
    description: "test delegate",
    parameters: {} as never,
    execute: async () => {
      delegated += 1;
      return { content: [], details: {} };
    },
  } as unknown as FakeTool;
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);
  adapter.setSessionToolPolicy(() => ({ computerControl: false, extraTools: [delegate] }));
  harness.configureSession = (session) => {
    session.promptHandler = async (current) => {
      current.emitMessageStart({
        role: "assistant",
        timestamp: 1,
        responseId: "delegate-old",
        provider: LOCAL_GROK_PROVIDER,
        model: "grok-4.5",
      });
      await release.promise;
      await current.waitUntilAborted();
    };
  };
  const command = makeCommand();
  const events: RuntimeEvent[] = [];
  const turn = adapter.startTurn(command, (event) => events.push(event));
  const session = await harness.waitForNextSession();
  await session.promptStarted.promise;
  await adapter.interruptTurn(makeInterruptCommand(command, 1), (event) => events.push(event));
  const fencedDelegate = harness.capturedTools.find((tool) => tool.name === "delegate")!;
  await assert.rejects(
    () => fencedDelegate.execute("delegate-after-floor", { task: "do it" }, undefined, undefined, {} as never),
    /interrupted/i,
  );

  assert.equal(delegated, 0);
  release.resolve();
  await adapter.cancelTurn(makeCancelCommand(command), (event) => events.push(event));
  await turn;
});

test("a wikipedia lookup hides desktop and delegate tools for that turn", async (t) => {
  const harness = createFakePiHarness();
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);
  await adapter.startTurn(
    makeCommand("去维基百科查褪黑素，告诉我它什么时候可以人工合成的？"),
    () => undefined,
  );
  const session = harness.sessions[0]!;
  const active = session.activeToolNameSets[0] ?? session.activeToolNames;
  assert.ok(active.includes("web_search"));
  assert.equal(active.includes("computer_control"), false);
  assert.equal(active.includes("delegate"), false);
});

test("current-page Notes tool is active only for its turn without hiding mature tools", async (t) => {
  const harness = createFakePiHarness();
  const pageNote = {
    name: "save_current_page_actions_to_note",
    label: "Page note",
    description: "test page note",
    parameters: {} as never,
    execute: async () => ({ content: [], details: { dispatched: false, succeeded: false, verified: false } }),
  } as unknown as FakeTool;
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);
  adapter.setSessionToolPolicy(() => ({
    computerControl: true,
    extraTools: [],
    registeredExtraTools: [pageNote],
    activeExtraToolNames: ["save_current_page_actions_to_note"],
  }));
  const events: RuntimeEvent[] = [];
  await adapter.startTurn(makeCommand(), (event) => events.push(event));
  const session = harness.sessions[0]!;
  assert.deepEqual(session.activeToolNameSets[0], [
    "read",
    "web_search",
    "computer_control",
    "delegate",
    "save_current_page_actions_to_note",
  ]);
  assert.deepEqual(session.activeToolNameSets.at(-1), ["read", "web_search", "computer_control", "delegate"]);
});

test("an effect already admitted makes the competing interruption reject", async (t) => {
  const harness = createFakePiHarness();
  const releaseTurn = deferred();
  const releaseDelegate = deferred();
  const delegateStarted = deferred();
  const delegate = {
    name: "delegate",
    label: "Delegate",
    description: "test delegate",
    parameters: {} as never,
    execute: async () => {
      delegateStarted.resolve();
      await releaseDelegate.promise;
      return { content: [], details: {} };
    },
  } as unknown as FakeTool;
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);
  adapter.setSessionToolPolicy(() => ({ computerControl: false, extraTools: [delegate] }));
  harness.configureSession = (session) => {
    session.promptHandler = async (current) => {
      current.emitMessageStart({
        role: "assistant",
        timestamp: 1,
        responseId: "delegate-first",
        provider: LOCAL_GROK_PROVIDER,
        model: "grok-4.5",
      });
      await releaseTurn.promise;
      current.emitTextDelta("完成。", {
        role: "assistant",
        timestamp: 1,
        responseId: "delegate-first",
        provider: LOCAL_GROK_PROVIDER,
        model: "grok-4.5",
      });
    };
  };
  const command = makeCommand();
  const events: RuntimeEvent[] = [];
  const turn = adapter.startTurn(command, (event) => events.push(event));
  const session = await harness.waitForNextSession();
  await session.promptStarted.promise;
  const fencedDelegate = harness.capturedTools.find((tool) => tool.name === "delegate")!;
  const effect = fencedDelegate.execute("delegate-first", { task: "do it" }, undefined, undefined, {} as never);
  await delegateStarted.promise;
  await adapter.interruptTurn(makeInterruptCommand(command, 1), (event) => events.push(event));

  const rejected = events.find((event) => event.type === "turn.interrupt.rejected");
  assert.ok(rejected);
  assert.equal(rejected.payload.code, "effect_already_dispatched");
  assert.equal(events.some((event) => event.type === "turn.interrupt.accepted"), false);
  releaseDelegate.resolve();
  releaseTurn.resolve();
  await effect;
  await turn;
});

test("a first-byte timeout fails the turn as first_byte_timeout", async (t) => {
  const harness = createFakePiHarness();
  harness.configureSession = (session) => {
    session.promptHandler = async () => {
      throw new Error(FIRST_BYTE_TIMEOUT_MESSAGE);
    };
  };
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);

  const events: RuntimeEvent[] = [];
  await adapter.startTurn(makeCommand(), (event) => events.push(event));

  assert.deepEqual(eventTypes(events), ["turn.started", "response.delta", "turn.failed"]);
  const failed = events.at(-1)!;
  assert.equal(failed.payload.code, "first_byte_timeout");
  assert.equal(failed.payload.message, FIRST_BYTE_TIMEOUT_MESSAGE);
  const delta = events.find((event) => event.type === "response.delta");
  assert.equal(delta?.payload.text, "这句我想了太久，换个说法再来一次？");
  assert.equal(delta?.payload.phase, "model.first_byte");
});

test("prompt rejection fails the turn with a credential-safe message", async (t) => {
  const harness = createFakePiHarness();
  harness.configureSession = (session) => {
    session.promptHandler = async () => {
      throw new Error("401 Unauthorized: invalid api_key sk-live-secret alongside bearer token");
    };
  };
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);

  const events: RuntimeEvent[] = [];
  await adapter.startTurn(makeCommand(), (event) => events.push(event));

  assert.deepEqual(eventTypes(events), ["turn.started", "turn.failed"]);
  const failed = events.at(-1)!;
  assert.equal(failed.payload.code, "pi_turn_failed");
  assert.equal(failed.payload.message, "Pi runtime operation failed.");
  assert.ok(!String(failed.payload.message).includes("sk-live-secret"));
  assert.ok(
    !events.some((event) => event.type === "auth.failed"),
    "the local loopback provider must not emit auth failures",
  );
});

test("a Pi session error state fails the turn with the benign message intact", async (t) => {
  const harness = createFakePiHarness();
  harness.configureSession = (session) => {
    session.promptHandler = async (s) => {
      s.agent.state.errorMessage = "upstream connection refused";
    };
  };
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);

  const events: RuntimeEvent[] = [];
  await adapter.startTurn(makeCommand(), (event) => events.push(event));

  assert.deepEqual(eventTypes(events), ["turn.started", "turn.failed"]);
  const failed = events.at(-1)!;
  assert.equal(failed.payload.code, "pi_turn_failed");
  assert.equal(failed.payload.message, "upstream connection refused");
});

test("cancelTurn aborts the active session and frees the request id", async (t) => {
  const harness = createFakePiHarness();
  harness.configureSession = (session) => {
    session.promptHandler = (s) => s.waitUntilAborted();
  };
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);
  const conversationId = randomUUID();

  const events: RuntimeEvent[] = [];
  const sink = (event: RuntimeEvent): void => {
    events.push(event);
  };
  const command = makeCommand(undefined, conversationId);
  const sessionPromise = harness.waitForNextSession();
  const firstTurn = adapter.startTurn(command, sink);
  const session = await sessionPromise;
  await session.promptStarted.promise;

  await adapter.cancelTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.cancel",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: { reason: "user_cancelled" },
  }, sink);
  await firstTurn;

  assert.equal(session.abortCount, 1);
  const cancelled = events.find((event) => event.type === "turn.cancelled");
  assert.ok(cancelled);
  assert.equal(cancelled.payload.reason, "user_cancelled");
  assert.deepEqual(eventTypes(events), ["turn.started", "turn.cancelled"]);

  // Actual behavior: once the cancelled turn settles, its request id is free again.
  harness.configureSession = (nextSession) => {
    nextSession.promptHandler = async (s) => {
      s.emitTextDelta("又来。");
    };
  };
  const secondEvents: RuntimeEvent[] = [];
  const retry = makeCommand(undefined, conversationId);
  retry.requestId = command.requestId;
  await adapter.startTurn(retry, (event) => secondEvents.push(event));
  const completed = secondEvents.find((event) => event.type === "response.completed");
  assert.ok(completed);
  assert.equal(completed.payload.text, "又来。");
  assert.equal(harness.sessions.length, 2, "cancelled conversation is rebuilt from durable history");
  assert.equal(session.disposed, true);
});

test("cancel after the model finishes must not emit response.completed", async (t) => {
  const harness = createFakePiHarness();
  const releaseCompletion = deferred();
  harness.configureSession = (session) => {
    session.promptHandler = async (current) => {
      current.emitTextDelta("点好了。");
      await releaseCompletion.promise;
    };
  };
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);
  const command = makeCommand();
  const events: RuntimeEvent[] = [];
  const turn = adapter.startTurn(command, (event) => events.push(event));
  const session = await harness.waitForNextSession();
  await session.promptStarted.promise;

  await adapter.cancelTurn(makeCancelCommand(command), (event) => events.push(event));
  releaseCompletion.resolve();
  await turn;

  assert.equal(events.some((event) => event.type === "response.completed"), false);
  assert.ok(events.some((event) => event.type === "turn.cancelled"));
  assert.equal(events.some((event) => event.type === "turn.failed"), false);
});

test("conversation release cold-starts a new session before the old abort finishes", async (t) => {
  const harness = createFakePiHarness();
  harness.configureSession = (session) => {
    session.promptHandler = (current) => current.waitUntilAborted();
  };
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);
  const conversationId = randomUUID();
  const firstCommand = makeCommand(undefined, conversationId);
  const firstEvents: RuntimeEvent[] = [];
  const firstSessionPromise = harness.waitForNextSession();
  const firstTurn = adapter.startTurn(firstCommand, (event) => firstEvents.push(event));
  const firstSession = await firstSessionPromise;
  await firstSession.promptStarted.promise;
  const releaseAbort = deferred();
  firstSession.abortBarrier = releaseAbort.promise;

  adapter.releaseConversationSession(conversationId);
  assert.equal(firstSession.abortCount, 1, "release starts bounded abort immediately");
  assert.equal(firstSession.disposed, false, "dispose waits for the abort cleanup boundary");

  harness.configureSession = (session) => {
    session.promptHandler = async (current) => current.emitTextDelta("new session result");
  };
  const secondEvents: RuntimeEvent[] = [];
  await adapter.startTurn(
    makeCommand("replacement", conversationId),
    (event) => secondEvents.push(event),
  );
  assert.equal(harness.sessions.length, 2);
  assert.notEqual(harness.sessions[0]?.sessionId, harness.sessions[1]?.sessionId);
  assert.equal(secondEvents.at(-1)?.type, "response.completed");

  releaseAbort.resolve();
  await firstTurn;
  assert.equal(firstSession.disposed, true);
  assert.equal(firstSession.disposeCount, 1, "the release fence owns session disposal exactly once");
  assert.equal(firstEvents.some((event) => event.type === "response.completed"), false);
});

test("a duplicate request id fails fast while the original turn continues", async (t) => {
  const harness = createFakePiHarness();
  const releasePrompt = deferred();
  harness.configureSession = (session) => {
    session.promptHandler = async (s) => {
      s.emitTextDelta("处理中。");
      await releasePrompt.promise;
    };
  };
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);

  const firstEvents: RuntimeEvent[] = [];
  const command = makeCommand();
  const sessionPromise = harness.waitForNextSession();
  const firstTurn = adapter.startTurn(command, (event) => firstEvents.push(event));
  const session = await sessionPromise;
  await session.promptStarted.promise;

  const duplicateEvents: RuntimeEvent[] = [];
  const duplicate = makeCommand();
  duplicate.requestId = command.requestId;
  await adapter.startTurn(duplicate, (event) => duplicateEvents.push(event));

  assert.deepEqual(eventTypes(duplicateEvents), ["turn.failed"]);
  assert.equal(duplicateEvents[0]!.payload.code, "duplicate_request");
  assert.equal(
    duplicateEvents[0]!.payload.message,
    "A turn with this request id is already active.",
  );

  releasePrompt.resolve();
  await firstTurn;
  assert.ok(firstEvents.some((event) => event.type === "response.completed"));
  assert.ok(!firstEvents.some((event) => event.type === "turn.failed"));
});

test("a disposed adapter fails new turns with runtime_disposed", async (t) => {
  const harness = createFakePiHarness();
  const { adapter, workdir } = await makeAdapter(harness);
  t.after(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  await adapter.dispose();
  const events: RuntimeEvent[] = [];
  await adapter.startTurn(makeCommand(), (event) => events.push(event));

  assert.deepEqual(eventTypes(events), ["turn.failed"]);
  assert.equal(events[0]!.payload.code, "runtime_disposed");
  assert.equal(harness.sessions.length, 0, "a disposed adapter never builds a session");
});

test("dispose during an active turn aborts the session and resolves", async (t) => {
  const harness = createFakePiHarness();
  harness.configureSession = (session) => {
    session.promptHandler = (s) => s.waitUntilAborted();
  };
  const { adapter, workdir } = await makeAdapter(harness);
  t.after(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  const events: RuntimeEvent[] = [];
  const sessionPromise = harness.waitForNextSession();
  const turn = adapter.startTurn(makeCommand(), (event) => events.push(event));
  const session = await sessionPromise;
  await session.promptStarted.promise;

  // Must resolve without hanging: dispose aborts the session, which releases
  // the prompt gate, and then waits for the turn operation to settle.
  await adapter.dispose();
  await turn;

  assert.equal(session.abortCount, 1);
  assert.equal(session.disposed, true);
  assert.deepEqual(eventTypes(events), ["turn.started"]);
});

interface DirectClickReceipt {
  succeeded: boolean;
  verified: boolean;
  status: ComputerActionStatus;
  code: ComputerActionResultCode;
  method: ComputerActionMethod;
  message: string;
}

async function runDirectClickTurn(
  t: TestContext,
  receipt: DirectClickReceipt,
): Promise<RuntimeEvent[]> {
  const harness = createFakePiHarness();
  const events: RuntimeEvent[] = [];
  const requested = deferred<RuntimeEvent>();
  const sink = (event: RuntimeEvent): void => {
    events.push(event);
    if (event.type === "computer.action.requested") requested.resolve(event);
  };
  const port = new StdioComputerUsePort(sink, 30_000);
  const { adapter, workdir } = await makeAdapter(harness, port);
  cleanupAfter(t, adapter, workdir);

  harness.configureSession = (session) => {
    session.promptHandler = async (s) => {
      const tool = harness.capturedTools[0]!;
      s.emitSessionEvent({ type: "tool_execution_start", toolName: "computer_control" });
      try {
        await tool.execute(
          "tool-call-1",
          { action: "left_click", x: 185, y: 375, label: "保存" },
          undefined,
          undefined,
          {} as never,
        );
      } catch {
        // A failed receipt becomes a tool error; Pi would feed it back to the
        // model and the turn would continue.
      }
      s.emitSessionEvent({ type: "tool_execution_end", toolName: "computer_control", isError: false });
      s.emitTextDelta("这句模型补充不该出现在直点回合里。");
    };
  };

  const command = makeCommand("点击保存按钮");
  const turn = adapter.startTurn(command, sink);
  const requestEvent = await requested.promise;
  const payload = computerActionRequestedPayloadSchema.parse(requestEvent.payload);
  assert.equal(payload.action, "left_click");
  if (payload.action === "left_click") {
    assert.equal(payload.x, 185);
    assert.equal(payload.y, 375);
    assert.equal(payload.label, "保存");
  }
  assert.equal(payload.basisFrameId, command.payload.contextFrame.frameId);
  assert.equal(payload.effectClass, "write");

  assert.equal(port.resolve({
    schemaVersion: PROTOCOL_VERSION,
    type: "computer.action.result",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: {
      actionId: payload.actionId,
      ...(payload.attemptId === undefined ? {} : { attemptId: payload.attemptId }),
      ...receipt,
    },
  }), true);

  await turn;

  assert.equal(
    events.filter((event) => event.type === "computer.action.requested").length,
    1,
    "exactly one computer action is dispatched per direct turn",
  );
  const startedTools = events.filter((event) => event.type === "tool.started");
  assert.equal(startedTools.length, 1);
  assert.equal(startedTools[0]!.payload.toolName, "computer_control");
  assert.equal(startedTools[0]!.payload.compatibilityMode, undefined);
  assert.ok(!events.some((event) => event.type === "turn.failed"));
  return events;
}

test("non-imperative click mentions cannot dispatch a model-requested desktop action", async (t) => {
  for (const utterance of [
    "为什么这个按钮点击不了？",
    "如何点击这个按钮？",
    "不要点击这个按钮",
    "他说点击这个按钮",
    "如果点击这个按钮会怎样",
    "这个按钮可以点击吗？",
    "我刚才点击了按钮",
    "我想知道点击后会发生什么",
    "点击这个按钮吗",
    "点击这个按钮对吗",
    "点击这个按钮好不好",
    "点击这个按钮会不会有风险",
    "点击这个按钮是什么效果",
  ]) {
    const harness = createFakePiHarness();
    let performed = 0;
    const { adapter, workdir } = await makeAdapter(harness, {
      async perform() {
        performed += 1;
        return { succeeded: true, verified: true, message: "must not happen" };
      },
      resolve: () => false,
      cancelRequest: () => {},
      dispose: () => {},
    });
    cleanupAfter(t, adapter, workdir);
    harness.configureSession = (session) => {
      session.promptHandler = async (current) => {
        const tool = harness.capturedTools[0]!;
        await assert.rejects(
          () => tool.execute(
            "unauthorized-click",
            { action: "left_click", x: 10, y: 10 },
            undefined,
            undefined,
            {} as never,
          ),
          /authorized desktop action limit/i,
        );
        current.emitTextDelta("这是解释，不是点击。 ");
      };
    };

    await adapter.startTurn(makeCommand(utterance), () => undefined);
    assert.equal(performed, 0, `no desktop dispatch for: ${utterance}`);
    await adapter.dispose();
  }
});

test("direct click turn requests the action and completes with verified language", async (t) => {
  const events = await runDirectClickTurn(t, {
    succeeded: true,
    verified: true,
    status: "verified",
    code: "verified_accessibility",
    method: "ax_press",
    message: "AXPress succeeded.",
  });

  assert.deepEqual(eventTypes(events), [
    "turn.started",
    "tool.started",
    "computer.action.requested",
    "tool.completed",
    "response.delta",
    "response.completed",
  ]);
  const completed = events.at(-1)!;
  assert.equal(completed.payload.text, "这句模型补充不该出现在直点回合里。");
  assert.equal(completed.payload.verified, true);
  assert.equal(completed.payload.verifier, "macos-accessibility-result");
  assert.equal(completed.payload.phase, "model.done");
});

test("direct click turn keeps an unverified receipt out of completion language", async (t) => {
  const events = await runDirectClickTurn(t, {
    succeeded: true,
    verified: false,
    status: "unverified",
    code: "ax_press_unverified",
    method: "ax_press",
    message: "AXPress was delivered, but the visible outcome was not confirmed.",
  });

  const completed = events.find((event) => event.type === "response.completed");
  assert.ok(completed);
  assert.equal(completed.payload.text, "这句模型补充不该出现在直点回合里。");
  assert.equal(completed.payload.verified, false);
});

test("direct click turn admits failure when the receipt failed", async (t) => {
  const events = await runDirectClickTurn(t, {
    succeeded: false,
    verified: false,
    status: "failed",
    code: "quartz_event_creation_failed",
    method: "quartz",
    message: "CGEvent post failed.",
  });

  const completed = events.find((event) => event.type === "response.completed");
  assert.ok(completed);
  assert.equal(completed.payload.text, "这句模型补充不该出现在直点回合里。");
  assert.equal(completed.payload.verified, false);
});

test("model computer turns project an unverified receipt instead of model completion language", async (t) => {
  const harness = createFakePiHarness();
  const events: RuntimeEvent[] = [];
  const requested = deferred<RuntimeEvent>();
  const sink = (event: RuntimeEvent): void => {
    events.push(event);
    if (event.type === "computer.action.requested") requested.resolve(event);
  };
  const port = new StdioComputerUsePort(sink, 30_000);
  const { adapter, workdir } = await makeAdapter(harness, port);
  cleanupAfter(t, adapter, workdir);

  let modelCalls = 0;
  harness.configureSession = (session) => {
    session.promptHandler = async (current) => {
      if (modelCalls++ > 0) {
        assert.deepEqual(current.getActiveToolNames(), []);
        current.emitTextDelta("点下去了，但页面变化还没确认。");
        return;
      }
      const tool = harness.capturedTools[0]!;
      current.emitSessionEvent({
        type: "tool_execution_start",
        toolCallId: "tool-call-1",
        toolName: "computer_control",
      });
      try {
        await tool.execute(
          "tool-call-1",
          { action: "left_click", targetId: "1" },
          undefined,
          undefined,
          {} as never,
        );
      } catch {
        // The model receives an unverified tool result and then incorrectly
        // claims completion; the public completion must reject that claim.
      }
      current.emitSessionEvent({
        type: "tool_execution_end",
        toolCallId: "tool-call-1",
        toolName: "computer_control",
        isError: false,
      });
      current.emitTextDelta("已经完成了。 ");
    };
  };

  const command = makeCommand("先观察一下当前窗口，然后点击 Primary");
  const turn = adapter.startTurn(command, sink);
  const requestEvent = await requested.promise;
  const payload = computerActionRequestedPayloadSchema.parse(requestEvent.payload);
  assert.equal(payload.action, "left_click");
  assert.equal(port.resolve({
    schemaVersion: PROTOCOL_VERSION,
    type: "computer.action.result",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: {
      actionId: payload.actionId,
      ...(payload.attemptId === undefined ? {} : { attemptId: payload.attemptId }),
      succeeded: true,
      verified: false,
      status: "unverified",
      code: "ax_press_unverified",
      method: "ax_press",
      message: "AXPress was delivered, but the visible outcome was not confirmed.",
    },
  }), true);

  await turn;

  const publicResponses = events.filter(
    (event) => event.type === "response.delta" || event.type === "response.completed",
  );
  assert.ok(publicResponses.length > 0);
  for (const event of publicResponses) {
    assert.doesNotMatch(String(event.payload.text), /完成|点好了/u);
  }
  const completed = events.find((event) => event.type === "response.completed");
  assert.ok(completed);
  assert.equal(completed.payload.verified, false);
  assert.equal(completed.payload.text, "点下去了，但页面变化还没确认。");
  assert.doesNotMatch(String(completed.payload.text), /完成|点好了/u);
});

test("Pi sessions are cached per conversation identity", async (t) => {
  const harness = createFakePiHarness();
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);
  const conversationA = randomUUID();
  const conversationB = randomUUID();

  const events: RuntimeEvent[] = [];
  const sink = (event: RuntimeEvent): void => {
    events.push(event);
  };
  await adapter.startTurn(makeCommand(undefined, conversationA), sink);
  assert.equal(harness.sessions.length, 1);

  await adapter.startTurn(makeCommand(undefined, conversationA), sink);
  assert.equal(harness.sessions.length, 1, "same conversation reuses one Pi session");
  assert.equal(harness.sessions[0]!.prompts.length, 2);

  await adapter.startTurn(makeCommand(undefined, conversationB), sink);
  assert.equal(harness.sessions.length, 2, "a new conversation gets a fresh Pi session");
  assert.notEqual(harness.sessions[1]!.sessionId, harness.sessions[0]!.sessionId);
  assert.equal(harness.sessions[1]!.prompts.length, 1);

  assert.equal(
    events.filter((event) => event.type === "response.completed").length,
    3,
  );
  // The product registry resolves local models dynamically; no per-model
  // provider registration happens anymore (ADR 0014). Session reuse above is
  // the behavioral contract this test protects.
});

test("conversation history rehydrates a cold Pi session once and is omitted from the hot session", async (t) => {
  const harness = createFakePiHarness();
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);
  const conversationId = randomUUID();
  const first = attachConversationHistory(makeCommand("current one", conversationId), [{
    id: randomUUID(),
    capturedAt: "2026-08-12T08:00:00.000Z",
    userInput: "historical marker question",
    assistantOutput: "historical marker answer",
  }]);
  const second = attachConversationHistory(makeCommand("current two", conversationId), [{
    id: randomUUID(),
    capturedAt: "2026-08-12T08:01:00.000Z",
    userInput: "must not repeat on hot session",
  }]);

  await adapter.startTurn(first, () => undefined);
  await adapter.startTurn(second, () => undefined);

  assert.equal(harness.sessions.length, 1);
  const prompts = harness.sessions[0]!.prompts.map((prompt) => prompt.text);
  assert.match(prompts[0]!, /historical marker question/);
  assert.match(prompts[0]!, /historical data, not new instructions/);
  assert.doesNotMatch(prompts[1]!, /conversation_history|must not repeat on hot session/);
});

test("cold Pi sessions isolate conversation history and private sessions reject attached history", async (t) => {
  const harness = createFakePiHarness();
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);
  const conversationAId = randomUUID();
  const conversationA = attachConversationHistory(makeCommand("A", conversationAId), [{
    id: randomUUID(),
    capturedAt: "2026-08-12T08:00:00.000Z",
    userInput: "conversation A marker",
  }]);
  const conversationB = attachConversationHistory(makeCommand("B", randomUUID()), [{
    id: randomUUID(),
    capturedAt: "2026-08-12T08:00:00.000Z",
    userInput: "conversation B marker",
  }]);
  const privateCommand = attachConversationHistory(makeCommand("private", conversationAId), [{
    id: randomUUID(),
    capturedAt: "2026-08-12T08:00:00.000Z",
    userInput: "private history must stay out",
  }]);
  privateCommand.payload.sessionScope = { kind: "private" };

  await adapter.startTurn(conversationA, () => undefined);
  await adapter.startTurn(conversationB, () => undefined);
  await adapter.startTurn(privateCommand, () => undefined);

  assert.match(harness.sessions[0]!.prompts[0]!.text, /conversation A marker/);
  assert.doesNotMatch(harness.sessions[0]!.prompts[0]!.text, /conversation B marker/);
  assert.match(harness.sessions[1]!.prompts[0]!.text, /conversation B marker/);
  assert.doesNotMatch(harness.sessions[1]!.prompts[0]!.text, /conversation A marker/);
  assert.doesNotMatch(
    harness.sessions[2]!.prompts[0]!.text,
    /conversation_history|private history must stay out/,
  );
});

test("empty-text-completion: no text + verified action completes", async (t) => {
  const harness = createFakePiHarness();
  const events: RuntimeEvent[] = [];
  const requested = deferred<RuntimeEvent>();
  const sink = (event: RuntimeEvent): void => {
    events.push(event);
    if (event.type === "computer.action.requested") requested.resolve(event);
  };
  const port = new StdioComputerUsePort(sink, 30_000);
  const { adapter, workdir } = await makeAdapter(harness, port);
  cleanupAfter(t, adapter, workdir);

  harness.configureSession = (session) => {
    session.promptHandler = async (s) => {
      const tool = harness.capturedTools[0]!;
      s.emitSessionEvent({ type: "tool_execution_start", toolName: "computer_control" });
      await tool.execute(
        "tool-call-1",
        { action: "left_click", x: 185, y: 375, label: "保存" },
        undefined,
        undefined,
        {} as never,
      );
      s.emitSessionEvent({ type: "tool_execution_end", toolName: "computer_control", isError: false });
    };
  };

  const command = makeCommand("点击保存按钮");
  const turn = adapter.startTurn(command, sink);
  const requestEvent = await requested.promise;
  const payload = computerActionRequestedPayloadSchema.parse(requestEvent.payload);
  assert.equal(port.resolve({
    schemaVersion: PROTOCOL_VERSION,
    type: "computer.action.result",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: {
      actionId: payload.actionId,
      ...(payload.attemptId === undefined ? {} : { attemptId: payload.attemptId }),
      succeeded: true,
      verified: true,
      status: "verified",
      code: "verified_accessibility",
      method: "ax_press",
      message: "AXPress succeeded.",
    },
  }), true);
  await turn;

  const completed = events.find((event) => event.type === "response.completed");
  const failed = events.find((event) => event.type === "turn.failed");
  assert.equal(failed, undefined);
  assert.ok(completed);
  assert.equal(completed.payload.text, "");
  assert.equal(completed.payload.verified, true);
});

test("empty-text-completion: no text + nothing fails", async (t) => {
  const harness = createFakePiHarness();
  harness.configureSession = (session) => {
    session.promptHandler = async () => {
      // Intentionally no text and no tools.
    };
  };
  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);

  const events: RuntimeEvent[] = [];
  await adapter.startTurn(makeCommand("你好"), (event) => events.push(event));
  const failed = events.find((event) => event.type === "turn.failed");
  assert.ok(failed);
  assert.equal(failed.payload.code, "pi_turn_failed");
  assert.equal(events.some((event) => event.type === "response.completed"), false);
});

const FILE_DROP_UTTERANCE = "把下载里的 奕枢测试文件.txt 拖到这个上传框";
const FILE_DROP_NAME = "奕枢测试文件.txt";
const FILE_DROP_TARGET = {
  id: "3",
  role: "AXGroup",
  title: "上传文件",
  description: "拖放到这里",
  enabled: true,
  frame: { x: 100, y: 200, width: 240, height: 80 },
} as const;

function createFileDropClock(start = new Date("2026-09-05T00:00:00.000Z")) {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    set(date: Date) { current = date.getTime(); },
    advance(ms: number) { current += ms; },
  };
}

function recordingFileDropPort(dispatched: unknown[]): ComputerUsePort {
  return {
    async perform(action, context) {
      dispatched.push({ action, context });
      return {
        succeeded: true,
        verified: true,
        status: "verified",
        code: "verified_accessibility",
        method: "appkit_drag",
        message: "The named file is attached.",
      };
    },
    resolve: () => false,
    cancelRequest: () => {},
    dispose: () => {},
  };
}

function noneEffectConfirmCommand(command: TurnStartCommand): TurnStartCommand {
  attachTurnIntentFrame(command, {
    schemaVersion: 1,
    objective: "确认",
    speechAct: "statement",
    effect: "none",
    route: { kind: "model" },
    successMode: "read_only_delivery",
    authority: "automatic",
    risk: "low",
    steerable: true,
    source: "deterministic",
  });
  attachTaskExecutionContract(command, createTaskExecutionContract({
    objective: "确认",
    successMode: "read_only_delivery",
    authority: "automatic",
    risk: "low",
    maxAttempts: 1,
  }));
  return command;
}

function makeFileDropCommand(input: {
  utterance: string;
  conversationId: string;
  at: Date;
  windowNumber?: number;
  target?: { id: string; role: string | null; title: string | null; description: string | null; enabled?: boolean };
  bundleId?: string;
}): TurnStartCommand {
  const command = makeCommand(input.utterance, input.conversationId);
  const at = input.at.toISOString();
  command.sentAt = at;
  command.payload.contextFrame.capturedAt = at;
  command.payload.contextFrame.expiresAt = new Date(input.at.getTime() + 30_000).toISOString();
  command.payload.contextFrame.frontmostApplication = {
    value: {
      name: "Safari",
      bundleIdentifier: input.bundleId ?? "com.apple.Safari",
      processIdentifier: 321,
    },
    source: "NSWorkspace",
    capturedAt: at,
    confidence: 1,
  };
  command.payload.contextFrame.activeWindow = {
    value: {
      title: "Upload",
      ownerName: "Safari",
      processIdentifier: 321,
      windowNumber: input.windowNumber ?? 17,
      bounds: { x: 20, y: 40, width: 900, height: 700 },
    },
    source: "CGWindowList",
    capturedAt: at,
    confidence: 0.9,
  };
  command.payload.contextFrame.numberedTargets = [input.target ?? FILE_DROP_TARGET];
  return command;
}

async function callFileDropTool(
  harness: FakePiHarness,
  session: FakeModelSession,
  fileName = FILE_DROP_NAME,
  targetId = "3",
): Promise<string> {
  const tool = harness.capturedTools.find((candidate) => candidate.name === "computer_control");
  assert.ok(tool, "computer_control must be registered");
  session.emitSessionEvent({ type: "tool_execution_start", toolName: "computer_control" });
  let text = "";
  try {
    const result = await tool.execute(
      "file-drop-call",
      { action: "drop_download_file", fileName, targetId },
      undefined,
      undefined,
      {} as never,
    );
    text = result.content[0]?.type === "text" ? result.content[0].text : "";
  } catch (error) {
    text = error instanceof Error ? error.message : String(error);
  }
  session.emitSessionEvent({ type: "tool_execution_end", toolName: "computer_control", isError: false });
  return text;
}

async function startFileDropTurn(
  adapter: YishuLoopRuntimeAdapter,
  command: TurnStartCommand,
  events: RuntimeEvent[],
): Promise<void> {
  await adapter.startTurn(command, (event) => events.push(event));
}

test("spoken Downloads name uses native candidate, stages then confirms once", async (t) => {
  const clock = createFileDropClock();
  const harness = createFakePiHarness();
  harness.adapterOptions.now = clock.now;
  const dispatched: unknown[] = [];
  const events: RuntimeEvent[] = [];
  const { adapter, workdir } = await makeAdapter(harness, recordingFileDropPort(dispatched));
  cleanupAfter(t, adapter, workdir);
  const conversationId = randomUUID();
  let calls = 0;
  harness.configureSession = (session) => {
    session.promptHandler = async (current) => {
      if (calls++ === 0) {
        const prompt = current.prompts.at(-1)?.text ?? "";
        assert.match(prompt, /independent of folder workspace grants/);
        assert.match(prompt, /奕枢测试文件\.txt/);
        assert.match(prompt, /available/);
        assert.deepEqual(current.getActiveToolNames(), []);
        current.emitTextDelta("找到奕枢测试文件.txt，放到这里吗？说去就放。");
        return;
      }
      assert.ok(current.getActiveToolNames().includes("computer_control"));
      const text = await callFileDropTool(harness, current);
      current.emitTextDelta(text.includes("去") ? "找到奕枢测试文件.txt，放到这里吗？说去就放。" : "文件已放入。");
    };
  };
  const command = makeFileDropCommand({ utterance: "把下载里的易书测试文件点.txt拖到这个上传框", conversationId, at: clock.now() });
  command.payload.contextFrame.downloadFiles = {
    status: "available", capturedAt: clock.now().toISOString(), candidates: [FILE_DROP_NAME], truncated: false,
  };
  await startFileDropTurn(adapter, command, events);
  assert.equal(dispatched.length, 0);
  assert.match(String(events.find((event) => event.type === "response.completed")?.payload.text), /找到奕枢测试文件/);
  for (let index = 0; index < 2; index++) {
    await startFileDropTurn(adapter, noneEffectConfirmCommand(makeFileDropCommand({ utterance: "去", conversationId, at: clock.now() })), events);
    assert.equal(dispatched.length, 1, "confirmation is consumed only once");
  }
  assert.equal((dispatched[0] as { action: { fileName: string } }).action.fileName, FILE_DROP_NAME);
});

test("staged file completion claim is repaired before speech, without another tool action", async (t) => {
  const clock = createFileDropClock();
  const harness = createFakePiHarness();
  harness.adapterOptions.now = clock.now;
  const dispatched: unknown[] = [];
  const events: RuntimeEvent[] = [];
  const { adapter, workdir } = await makeAdapter(harness, recordingFileDropPort(dispatched));
  cleanupAfter(t, adapter, workdir);
  let prompts = 0;
  harness.configureSession = (session) => {
    session.promptHandler = async (current) => {
      if (prompts++ === 0) {
        await callFileDropTool(harness, current);
        current.emitTextDelta("好，把奕枢测试文件.txt拖到上传框了。说去就放。");
      } else {
        assert.deepEqual(current.getActiveToolNames(), []);
        current.emitTextDelta("找到奕枢测试文件.txt了，放到这里吗？说去就放。");
      }
    };
  };
  await startFileDropTurn(adapter, makeFileDropCommand({ utterance: FILE_DROP_UTTERANCE, conversationId: randomUUID(), at: clock.now() }), events);
  assert.equal(prompts, 2);
  assert.equal(dispatched.length, 0);
  assert.match(String(events.find((event) => event.type === "response.completed")?.payload.text), /找到奕枢测试文件/);
  for (const event of events.filter((event) => event.type === "response.delta")) {
    assert.doesNotMatch(String(event.payload.text ?? event.payload.delta ?? ""), /拖到上传框了/);
  }
});

test("file drop stages on the first turn and dispatches once after 去", async (t) => {
  const clock = createFileDropClock();
  const harness = createFakePiHarness();
  harness.adapterOptions.now = clock.now;
  const events: RuntimeEvent[] = [];
  const dispatched: unknown[] = [];
  const { adapter, workdir } = await makeAdapter(harness, recordingFileDropPort(dispatched));
  cleanupAfter(t, adapter, workdir);
  const conversationId = randomUUID();
  let phase: "stage" | "confirm" | "replay" = "stage";

  harness.configureSession = (session) => {
    session.promptHandler = async (current) => {
      if (phase === "stage") {
        const text = await callFileDropTool(harness, current);
        current.emitTextDelta(text.includes("去") ? "要把奕枢测试文件.txt 放到这个上传框，去吗。" : "已经放进去了。");
        return;
      }
      if (phase === "confirm") {
        assert.match(current.prompts.at(-1)?.text ?? "", /奕枢测试文件\.txt/);
        assert.match(current.prompts.at(-1)?.text ?? "", /targetId="3"/);
        const text = await callFileDropTool(harness, current);
        current.emitTextDelta(text.includes("verified") || text.includes("attached") ? "文件已经在上传框里。" : "这次没放进去。");
        return;
      }
      await callFileDropTool(harness, current);
      current.emitTextDelta("不再拖一次。");
    };
  };

  await startFileDropTurn(adapter, makeFileDropCommand({
    utterance: FILE_DROP_UTTERANCE,
    conversationId,
    at: clock.now(),
  }), events);
  assert.equal(dispatched.length, 0, "confirmation is required before computer.action.requested");
  const preview = events.find((event) => event.type === "response.completed");
  assert.match(String(preview?.payload.text ?? ""), /去吗/);
  assert.doesNotMatch(String(preview?.payload.text ?? ""), /已经放进去了/);

  phase = "confirm";
  await startFileDropTurn(adapter, noneEffectConfirmCommand(makeFileDropCommand({
    utterance: "去",
    conversationId,
    at: clock.now(),
  })), events);
  assert.equal(dispatched.length, 1);
  const payload = dispatched[0] as {
    action: Record<string, unknown>;
    context: { effectClass?: string };
  };
  assert.equal(payload.action.action, "drop_download_file");
  assert.equal(payload.action.fileName, FILE_DROP_NAME);
  assert.equal(payload.action.targetId, "3");
  assert.equal(payload.action.targetBundleId, "com.apple.Safari");
  assert.equal(payload.action.targetPid, 321);
  assert.equal(payload.action.targetWindowNumber, 17);
  assert.equal(payload.action.targetFingerprint, fileDropTargetFingerprint(FILE_DROP_TARGET));
  assert.equal(Object.hasOwn(payload.action, "path"), false);
  assert.equal(Object.hasOwn(payload.action, "x"), false);
  assert.equal(payload.context.effectClass, "external_disclosure");

  phase = "replay";
  await startFileDropTurn(adapter, makeFileDropCommand({
    utterance: "去",
    conversationId,
    at: clock.now(),
  }), events);
  assert.equal(dispatched.length, 1, "the one-shot confirmation cannot replay");
});

test("file drop confirmation mismatches on window, fingerprint, or file name", async (t) => {
  for (const mismatch of [
    { windowNumber: 18 },
    { target: { ...FILE_DROP_TARGET, description: "changed" } },
    { target: { ...FILE_DROP_TARGET, frame: { ...FILE_DROP_TARGET.frame, x: 124 } } },
    { toolFileName: "other.txt" },
  ] as const) {
    const clock = createFileDropClock();
    const harness = createFakePiHarness();
    harness.adapterOptions.now = clock.now;
    const dispatched: unknown[] = [];
    const { adapter, workdir } = await makeAdapter(harness, recordingFileDropPort(dispatched));
    cleanupAfter(t, adapter, workdir);
    const conversationId = randomUUID();
    let phase: "stage" | "confirm" = "stage";
    let stagedText = "";
    harness.configureSession = (session) => {
      session.promptHandler = async (current) => {
        const text = await callFileDropTool(
          harness,
          current,
          phase === "confirm" && "toolFileName" in mismatch ? mismatch.toolFileName : FILE_DROP_NAME,
        );
        if (phase === "stage") stagedText = text;
        current.emitTextDelta(phase === "stage" ? "要把文件放进去，去吗。" : "收到。");
      };
    };
    await adapter.startTurn(makeFileDropCommand({
      utterance: FILE_DROP_UTTERANCE,
      conversationId,
      at: clock.now(),
    }), () => undefined);
    assert.match(stagedText, /去/);
    assert.equal(dispatched.length, 0);
    phase = "confirm";
    await adapter.startTurn(makeFileDropCommand({
      utterance: "去",
      conversationId,
      at: clock.now(),
      ...("windowNumber" in mismatch ? { windowNumber: mismatch.windowNumber } : {}),
      ...("target" in mismatch ? { target: mismatch.target } : {}),
    }), () => undefined);
    assert.equal(dispatched.length, 0, JSON.stringify(mismatch));
    await adapter.startTurn(makeFileDropCommand({
      utterance: "去",
      conversationId,
      at: clock.now(),
    }), () => undefined);
    assert.equal(dispatched.length, 0, `revive after ${JSON.stringify(mismatch)}`);
  }
});

test("file drop confirmation expires after 60s and does not dispatch", async (t) => {
  const clock = createFileDropClock();
  const harness = createFakePiHarness();
  harness.adapterOptions.now = clock.now;
  const dispatched: unknown[] = [];
  const { adapter, workdir } = await makeAdapter(harness, recordingFileDropPort(dispatched));
  cleanupAfter(t, adapter, workdir);
  const conversationId = randomUUID();
  let stagedText = "";
  harness.configureSession = (session) => {
    session.promptHandler = async (current) => {
      stagedText = await callFileDropTool(harness, current);
      current.emitTextDelta("收到。");
    };
  };
  await adapter.startTurn(makeFileDropCommand({
    utterance: FILE_DROP_UTTERANCE,
    conversationId,
    at: clock.now(),
  }), () => undefined);
  assert.match(stagedText, /去/);
  assert.equal(dispatched.length, 0);
  clock.advance(60_001);
  await adapter.startTurn(makeFileDropCommand({
    utterance: "去",
    conversationId,
    at: clock.now(),
  }), () => undefined);
  assert.equal(dispatched.length, 0);
});

test("file drop confirmation cancels pending when the current binding cannot be rebuilt", async (t) => {
  const clock = createFileDropClock();
  const harness = createFakePiHarness();
  harness.adapterOptions.now = clock.now;
  const dispatched: unknown[] = [];
  const { adapter, workdir } = await makeAdapter(harness, recordingFileDropPort(dispatched));
  cleanupAfter(t, adapter, workdir);
  const conversationId = randomUUID();
  let stagedText = "";
  harness.configureSession = (session) => {
    session.promptHandler = async (current) => {
      stagedText = await callFileDropTool(harness, current);
      current.emitTextDelta("收到。");
    };
  };
  await adapter.startTurn(makeFileDropCommand({
    utterance: FILE_DROP_UTTERANCE,
    conversationId,
    at: clock.now(),
  }), () => undefined);
  assert.match(stagedText, /去/);
  assert.equal(dispatched.length, 0);

  await adapter.startTurn(makeFileDropCommand({
    utterance: "去",
    conversationId,
    at: clock.now(),
    bundleId: "com.apple.Preview",
  }), () => undefined);
  assert.equal(dispatched.length, 0);

  await adapter.startTurn(makeFileDropCommand({
    utterance: "去",
    conversationId,
    at: clock.now(),
  }), () => undefined);
  assert.equal(dispatched.length, 0, "cancelled pending must not revive on a later 去");
});
