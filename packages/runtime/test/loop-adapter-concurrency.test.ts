// Concurrency contract for YishuLoopRuntimeAdapter (ADR 0009, RFC v2 §2.1–2.2):
// one adapter may run independent executions for distinct conversationIds
// in parallel while sessions, events, cancel, and disposal stay isolated.
// The fake harness below mirrors pi-runtime-adapter.test.ts and is
// intentionally self-contained.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type {
  ModelSession,
  ModelProviderRuntime,
} from "../src/model-loop/types.js";
import type { ComputerUsePort } from "../src/computer-use-port.js";
import {
  YishuLoopRuntimeAdapter,
  type YishuLoopRuntimeAdapterOptions,
} from "../src/loop-adapter.js";
import {
  PROTOCOL_VERSION,
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
};

class FakeModelSession {
  private static nextId = 0;
  readonly sessionId = `concurrency-session-${++FakeModelSession.nextId}`;
  readonly agent: { state: { errorMessage?: string } } = { state: {} };
  readonly promptStarted = deferred();
  abortCount = 0;
  promptHandler: (session: FakeModelSession) => Promise<void> = async () => {};
  private readonly abortGate = deferred();
  private aborted = false;
  private readonly listeners = new Set<(event: FakeSessionEvent) => void>();

  subscribe(listener: (event: FakeSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emitTextDelta(delta: string): void {
    for (const listener of [...this.listeners]) {
      listener({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta },
      });
    }
  }

  async prompt(): Promise<void> {
    this.promptStarted.resolve();
    // Real ModelSession.abort() settles an in-flight prompt; mirror that so
    // the adapter's cancelled-path checks run instead of hanging forever.
    await Promise.race([this.promptHandler(this), this.abortGate.promise]);
  }

  async steer(): Promise<void> {}

  async abort(): Promise<void> {
    this.abortCount += 1;
    if (!this.aborted) {
      this.aborted = true;
      this.abortGate.resolve();
    }
  }

  dispose(): void {}
}

interface FakeHarness {
  readonly adapterOptions: YishuLoopRuntimeAdapterOptions;
  readonly sessions: FakeModelSession[];
  waitForNextSession(): Promise<FakeModelSession>;
}

function createFakeHarness(): FakeHarness {
  const sessions: FakeModelSession[] = [];
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
  return {
    sessions,
    waitForNextSession: () => new Promise((resolve) => {
      sessionWaiters.push(resolve);
    }),
    adapterOptions: {
      modelRuntimePromise: Promise.resolve(modelRuntime as unknown as ModelProviderRuntime),
      createSession: (async () => {
        const session = new FakeModelSession();
        sessions.push(session);
        for (const waiter of sessionWaiters.splice(0)) {
          waiter(session);
        }
        return { session: session as unknown as ModelSession };
      }) as NonNullable<YishuLoopRuntimeAdapterOptions["createSession"]>,
    },
  };
}

const unusedPort: ComputerUsePort = {
  perform: async () => ({ succeeded: false, verified: false, message: "unused" }),
  resolve: () => false,
  cancelRequest: () => {},
  dispose: () => {},
};

async function makeAdapter(
  harness: FakeHarness,
): Promise<{ adapter: YishuLoopRuntimeAdapter; workdir: string }> {
  const workdir = await mkdtemp(path.join(tmpdir(), "yishu-adapter-concurrency-"));
  const adapter = new YishuLoopRuntimeAdapter(workdir, unusedPort, harness.adapterOptions);
  return { adapter, workdir };
}

function cleanupAfter(t: TestContext, adapter: YishuLoopRuntimeAdapter, workdir: string): void {
  t.after(async () => {
    await adapter.dispose();
    await rm(workdir, { recursive: true, force: true });
  });
}

function makeCommand(conversationId: string, requestId: string): TurnStartCommand {
  const command = makeTurnStartCommand();
  command.requestId = requestId;
  command.payload.conversationId = conversationId;
  return command;
}

function assertEventOwnership(
  events: readonly RuntimeEvent[],
  requestId: string,
  label: string,
): void {
  for (const event of events) {
    assert.equal(
      event.requestId,
      requestId,
      `${label}: event ${event.type} leaked across requestIds`,
    );
  }
}

test("concurrent turns keep sessions, events, and completion isolated", async (t) => {
  const harness = createFakeHarness();
  const gateA = deferred();
  const gateB = deferred();
  // Sessions are created in turn-start order: conv-a first, conv-b second.
  harness.adapterOptions.createSession = (async () => {
    const session = new FakeModelSession();
    harness.sessions.push(session);
    const gate = harness.sessions.length === 1 ? gateA : gateB;
    const tag = harness.sessions.length === 1 ? "A" : "B";
    session.promptHandler = async (s) => {
      await gate.promise;
      s.emitTextDelta(`reply-from-${tag}[POINT:10,20:${tag}]`);
    };
    return { session: session as unknown as ModelSession };
  }) as NonNullable<YishuLoopRuntimeAdapterOptions["createSession"]>;

  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);

  const commandA = makeCommand("conv-a", "req-a");
  const commandB = makeCommand("conv-b", "req-b");
  const eventsA: RuntimeEvent[] = [];
  const eventsB: RuntimeEvent[] = [];

  const turnA = adapter.startTurn(commandA, (event) => eventsA.push(event));
  const sessionA = await waitForSessionAt(harness.sessions, 0);
  await sessionA.promptStarted.promise;

  // A has not completed (gateA still pending) — start B now.
  const turnB = adapter.startTurn(commandB, (event) => eventsB.push(event));
  const sessionB = await waitForSessionAt(harness.sessions, 1);
  await sessionB.promptStarted.promise;

  // Distinct session objects and identities.
  assert.equal(harness.sessions.length, 2);
  assert.notEqual(sessionA, sessionB);
  assert.notEqual(sessionA.sessionId, sessionB.sessionId);

  // B completes first, independently of A.
  gateB.resolve();
  await turnB;
  const completedB = eventsB.find((event) => event.type === "response.completed");
  assert.ok(completedB, "B must complete while A is still gated");
  assert.equal(completedB.requestId, "req-b");
  assert.equal(completedB.payload.text, "reply-from-B\n[POINT:10,20:B]");
  assert.ok(
    !eventsA.some((event) => event.type === "response.completed"),
    "A must still be running when B completed",
  );

  // A completes afterwards, independently.
  gateA.resolve();
  await turnA;
  const completedA = eventsA.find((event) => event.type === "response.completed");
  assert.ok(completedA);
  assert.equal(completedA.requestId, "req-a");
  assert.equal(completedA.payload.text, "reply-from-A\n[POINT:10,20:A]");

  // Every emitted event belongs to its own requestId; no cross-talk.
  assertEventOwnership(eventsA, "req-a", "A");
  assertEventOwnership(eventsB, "req-b", "B");
  assert.ok(!completedA.payload.text.includes("reply-from-B"));
  assert.ok(!completedB.payload.text.includes("reply-from-A"));
});

test("cancelling one turn leaves a concurrently running turn intact", async (t) => {
  const harness = createFakeHarness();
  const gateA = deferred();
  const gateB = deferred();
  harness.adapterOptions.createSession = (async () => {
    const session = new FakeModelSession();
    harness.sessions.push(session);
    if (harness.sessions.length === 1) {
      session.promptHandler = () => gateA.promise;
    } else {
      session.promptHandler = async (s) => {
        await gateB.promise;
        s.emitTextDelta("B-survived[POINT:10,20:B]");
      };
    }
    return { session: session as unknown as ModelSession };
  }) as NonNullable<YishuLoopRuntimeAdapterOptions["createSession"]>;

  const { adapter, workdir } = await makeAdapter(harness);
  cleanupAfter(t, adapter, workdir);

  const commandA = makeCommand("conv-a", "req-a");
  const commandB = makeCommand("conv-b", "req-b");
  const eventsA: RuntimeEvent[] = [];
  const eventsB: RuntimeEvent[] = [];

  const turnA = adapter.startTurn(commandA, (event) => eventsA.push(event));
  const sessionA = await waitForSessionAt(harness.sessions, 0);
  await sessionA.promptStarted.promise;
  const turnB = adapter.startTurn(commandB, (event) => eventsB.push(event));
  const sessionB = await waitForSessionAt(harness.sessions, 1);
  await sessionB.promptStarted.promise;

  await adapter.cancelTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.cancel",
    requestId: "req-a",
    traceId: commandA.traceId,
    sentAt: new Date().toISOString(),
    payload: { reason: "spike_cancel_a" },
  }, (event) => eventsA.push(event));
  gateA.resolve();
  await turnA;

  assert.ok(sessionA.abortCount >= 1, "cancel A must abort session A");
  assert.ok(
    eventsA.some(
      (event) => event.type === "turn.cancelled" && event.requestId === "req-a",
    ),
    "A must observe its own turn.cancelled",
  );
  assert.ok(
    !eventsA.some((event) => event.type === "response.completed"),
    "cancelled A must not complete",
  );

  // B is untouched and completes normally.
  assert.equal(sessionB.abortCount, 0, "cancel A must not abort session B");
  assert.ok(
    !eventsB.some((event) => event.type === "turn.cancelled"),
    "B must not observe cancellation",
  );
  gateB.resolve();
  await turnB;
  const completedB = eventsB.find((event) => event.type === "response.completed");
  assert.ok(completedB, "B must complete after A was cancelled");
  assert.equal(completedB.payload.text, "B-survived\n[POINT:10,20:B]");

  assertEventOwnership(eventsA, "req-a", "A");
  assertEventOwnership(eventsB, "req-b", "B");
});

test("dispose aborts every in-flight session and stops event flow", async (t) => {
  const harness = createFakeHarness();
  const gates: Deferred<void>[] = [];
  harness.adapterOptions.createSession = (async () => {
    const session = new FakeModelSession();
    harness.sessions.push(session);
    const gate = deferred();
    gates.push(gate);
    session.promptHandler = () => gate.promise;
    return { session: session as unknown as ModelSession };
  }) as NonNullable<YishuLoopRuntimeAdapterOptions["createSession"]>;

  const { adapter, workdir } = await makeAdapter(harness);
  t.after(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  const eventsA: RuntimeEvent[] = [];
  const eventsB: RuntimeEvent[] = [];
  const turnA = adapter.startTurn(makeCommand("conv-a", "req-a"), (event) => eventsA.push(event));
  const sessionA = await waitForSessionAt(harness.sessions, 0);
  await sessionA.promptStarted.promise;
  const turnB = adapter.startTurn(makeCommand("conv-b", "req-b"), (event) => eventsB.push(event));
  const sessionB = await waitForSessionAt(harness.sessions, 1);
  await sessionB.promptStarted.promise;

  await adapter.dispose();
  for (const gate of gates) gate.resolve();
  await Promise.all([turnA, turnB]);

  assert.ok(sessionA.abortCount >= 1, "dispose must abort session A");
  assert.ok(sessionB.abortCount >= 1, "dispose must abort session B");
  assert.ok(
    !eventsA.some((event) => event.type === "response.completed" || event.type === "turn.failed"),
    "disposed A must not reach a normal terminal event",
  );
  assert.ok(
    !eventsB.some((event) => event.type === "response.completed" || event.type === "turn.failed"),
    "disposed B must not reach a normal terminal event",
  );
});

async function waitForSessionAt(
  sessions: FakeModelSession[],
  index: number,
): Promise<FakeModelSession> {
  while (sessions.length <= index) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return sessions[index]!;
}
