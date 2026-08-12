import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type {
  AgentSession,
  ModelRuntime,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  StdioComputerUsePort,
  type ComputerUsePort,
} from "../src/computer-use-port.js";
import {
  PiRuntimeAdapter,
  type PiRuntimeAdapterOptions,
} from "../src/pi-runtime-adapter.js";
import { attachConversationHistory } from "../src/context-prompt.js";
import {
  computerActionRequestedPayloadSchema,
  LOCAL_GROK_BASE_URL,
  LOCAL_GROK_PROVIDER,
  PROTOCOL_VERSION,
  type ComputerActionMethod,
  type ComputerActionResultCode,
  type ComputerActionStatus,
  type RuntimeEvent,
  type TurnStartCommand,
} from "../src/protocol.js";
import { makeTurnStartCommand } from "./fixtures.js";

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
  assistantMessageEvent?: { type: string; delta?: string };
  toolName?: string;
  isError?: boolean;
};

/**
 * The fake session implements exactly the surface PiRuntimeAdapter consumes:
 * sessionId, subscribe, prompt, abort, steer, dispose, and agent.state.
 */
class FakeAgentSession {
  private static nextId = 0;
  readonly sessionId = `fake-pi-session-${++FakeAgentSession.nextId}`;
  readonly agent: { state: { errorMessage?: string } } = { state: {} };
  readonly prompts: { text: string; images: unknown[] }[] = [];
  readonly promptStarted = deferred();
  abortCount = 0;
  abortBarrier?: Promise<void>;
  disposed = false;
  disposeCount = 0;
  promptHandler: (session: FakeAgentSession) => Promise<void> = async (session) => {
    session.emitTextDelta("收到。");
  };
  private readonly abortGate = deferred();
  private readonly listeners = new Set<(event: FakeSessionEvent) => void>();

  subscribe(listener: (event: FakeSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emitSessionEvent(event: FakeSessionEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  emitTextDelta(delta: string): void {
    this.emitSessionEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta },
    });
  }

  waitUntilAborted(): Promise<void> {
    return this.abortGate.promise;
  }

  async prompt(text: string, options?: { images?: unknown[] }): Promise<void> {
    this.prompts.push({ text, images: options?.images ?? [] });
    this.promptStarted.resolve();
    await this.promptHandler(this);
  }

  async steer(): Promise<void> {}

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
  readonly adapterOptions: PiRuntimeAdapterOptions;
  readonly sessions: FakeAgentSession[];
  readonly registeredProviderIds: string[];
  readonly capturedTools: FakeTool[];
  configureSession(session: FakeAgentSession): void;
  waitForNextSession(): Promise<FakeAgentSession>;
}

function createFakePiHarness(): FakePiHarness {
  const sessions: FakeAgentSession[] = [];
  const registeredProviderIds: string[] = [];
  const capturedTools: FakeTool[] = [];
  const sessionWaiters: Array<(session: FakeAgentSession) => void> = [];
  const modelRuntime = {
    getProvider: (_providerId: string) => undefined,
    registerProvider: (providerId: string) => {
      registeredProviderIds.push(providerId);
    },
    getModel: (provider: string, modelId: string) => ({ provider, id: modelId }),
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
      modelRuntimePromise: Promise.resolve(modelRuntime as unknown as ModelRuntime),
      createSession: (async (options: { customTools?: FakeTool[] }) => {
        const session = new FakeAgentSession();
        sessions.push(session);
        capturedTools.push(...(options.customTools ?? []));
        harness.configureSession(session);
        for (const waiter of sessionWaiters.splice(0)) {
          waiter(session);
        }
        return { session: session as unknown as AgentSession };
      }) as NonNullable<PiRuntimeAdapterOptions["createSession"]>,
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
): Promise<{ adapter: PiRuntimeAdapter; workdir: string }> {
  const workdir = await mkdtemp(path.join(tmpdir(), "yishu-pi-adapter-test-"));
  const adapter = new PiRuntimeAdapter(workdir, computerUsePort, harness.adapterOptions);
  return { adapter, workdir };
}

function cleanupAfter(t: TestContext, adapter: PiRuntimeAdapter, workdir: string): void {
  t.after(async () => {
    await adapter.dispose();
    await rm(workdir, { recursive: true, force: true });
  });
}

function makeCommand(utterance?: string, conversationId?: string): TurnStartCommand {
  const command = makeTurnStartCommand();
  if (utterance !== undefined) command.payload.utterance = utterance;
  if (conversationId !== undefined) command.payload.conversationId = conversationId;
  return command;
}

function eventTypes(events: readonly RuntimeEvent[]): string[] {
  return events.map((event) => event.type);
}

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
  assert.equal(prompt.images.length, 1);
  assert.deepEqual(prompt.images[0], {
    type: "image",
    data: "c2NyZWVu",
    mimeType: "image/jpeg",
  });

  const started = events.find((event) => event.type === "turn.started");
  assert.ok(started);
  assert.equal(started.payload.runtime, "pi");
  assert.equal(started.payload.capabilityProfile, "conversation");
  assert.equal(started.payload.sessionId, session.sessionId);
  assert.equal(started.payload.provider, LOCAL_GROK_PROVIDER);
  assert.equal(started.payload.model, "grok-4.5");
  assert.equal(started.payload.baseUrl, LOCAL_GROK_BASE_URL);

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
  assert.equal(completed.payload.text, "点好了。");
  assert.equal(completed.payload.verified, true);
  assert.equal(completed.payload.verifier, "macos-accessibility-result");
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
  assert.equal(completed.payload.text, "已经点击，但界面结果还没确认。");
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
  assert.equal(completed.payload.text, "这次没点成功。");
  assert.equal(completed.payload.verified, false);
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
  assert.deepEqual(
    harness.registeredProviderIds,
    [LOCAL_GROK_PROVIDER],
    "the local provider registers once per model id",
  );
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
