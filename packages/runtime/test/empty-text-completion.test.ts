import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { ModelSession, ModelProviderRuntime, ToolDefinition } from "../src/model-loop/types.js";
import { StdioComputerUsePort, type ComputerUsePort } from "../src/computer-use-port.js";
import {
  YishuLoopRuntimeAdapter,
  type YishuLoopRuntimeAdapterOptions,
} from "../src/loop-adapter.js";
import {
  computerActionRequestedPayloadSchema,
  PROTOCOL_VERSION,
  type RuntimeEvent,
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
  toolName?: string;
  isError?: boolean;
  assistantMessageEvent?: { type: string; delta?: string };
};

class FakeModelSession {
  private static nextId = 0;
  readonly sessionId = `empty-text-session-${++FakeModelSession.nextId}`;
  readonly agent: { state: { errorMessage?: string } } = { state: {} };
  promptHandler: (session: FakeModelSession) => Promise<void> = async () => {};
  private readonly listeners = new Set<(event: FakeSessionEvent) => void>();

  subscribe(listener: (event: FakeSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emitSessionEvent(event: FakeSessionEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  getActiveToolNames(): readonly string[] {
    return ["computer_control"];
  }

  setActiveToolsByName(_names: readonly string[]): void {}

  async prompt(
    _text?: string,
    options?: { preflightResult?: (accepted: boolean) => void },
  ): Promise<void> {
    options?.preflightResult?.(true);
    await this.promptHandler(this);
  }

  async abort(): Promise<void> {}
  dispose(): void {}
}

function makeCommand(utterance: string) {
  const command = makeTurnStartCommand();
  command.payload.utterance = utterance;
  return command;
}

async function makeAdapter(
  capturedTools: ToolDefinition[],
  configureSession: (session: FakeModelSession) => void,
  computerUsePort: ComputerUsePort,
): Promise<{ adapter: YishuLoopRuntimeAdapter; workdir: string }> {
  const modelRuntime = {
    getProvider: () => undefined,
    resolveModel: async (provider: string, modelId: string) => ({
      providerId: provider,
      id: modelId,
      name: modelId,
      api: "openai-completions" as const,
      baseUrl: "http://127.0.0.1:8787/v1",
      input: ["text", "image"] as const,
      contextWindow: 128_000,
      maxTokens: 8_192,
    }),
  };
  const options: YishuLoopRuntimeAdapterOptions = {
    modelRuntimePromise: Promise.resolve(modelRuntime as unknown as ModelProviderRuntime),
    interruptionSteerTimeoutMs: 100,
    createSession: (async (sessionOptions: { customTools?: ToolDefinition[] }) => {
      capturedTools.push(...(sessionOptions.customTools ?? []));
      const session = new FakeModelSession();
      configureSession(session);
      return { session: session as unknown as ModelSession };
    }) as NonNullable<YishuLoopRuntimeAdapterOptions["createSession"]>,
  };
  const workdir = await mkdtemp(path.join(tmpdir(), "yishu-empty-text-"));
  const adapter = new YishuLoopRuntimeAdapter(workdir, computerUsePort, options);
  return { adapter, workdir };
}

function cleanupAfter(t: TestContext, adapter: YishuLoopRuntimeAdapter, workdir: string): void {
  t.after(async () => {
    await adapter.dispose();
    await rm(workdir, { recursive: true, force: true });
  });
}

const unusedPort: ComputerUsePort = {
  perform: async () => ({ succeeded: false, verified: false, message: "unused" }),
  resolve: () => false,
  cancelRequest: () => {},
  dispose: () => {},
};

test("empty-text-completion: no text + verified action completes", async (t) => {
  const capturedTools: ToolDefinition[] = [];
  const events: RuntimeEvent[] = [];
  const requested = deferred<RuntimeEvent>();
  const sink = (event: RuntimeEvent): void => {
    events.push(event);
    if (event.type === "computer.action.requested") requested.resolve(event);
  };
  const port = new StdioComputerUsePort(sink, 30_000);
  const { adapter, workdir } = await makeAdapter(capturedTools, (session) => {
    session.promptHandler = async (s) => {
      const tool = capturedTools[0]!;
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
  }, port);
  cleanupAfter(t, adapter, workdir);

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
  const { adapter, workdir } = await makeAdapter([], (session) => {
    session.promptHandler = async () => {
      // Intentionally no text and no tools.
    };
  }, unusedPort);
  cleanupAfter(t, adapter, workdir);

  const events: RuntimeEvent[] = [];
  await adapter.startTurn(makeCommand("你好"), (event) => events.push(event));
  const failed = events.find((event) => event.type === "turn.failed");
  assert.ok(failed);
  assert.equal(failed.payload.code, "pi_turn_failed");
  assert.equal(events.some((event) => event.type === "response.completed"), false);
});
