import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createYishuKernel } from "@yishu/kernel";
import { MockAgentRuntime } from "../src/mock-runtime.js";
import { ProductKernelRuntime } from "../src/product-kernel-runtime.js";
import { ComputerActionError, type ComputerUsePort } from "../src/computer-use-port.js";
import {
  PROTOCOL_VERSION,
  runtimeEvent,
  type RuntimeEvent,
  type TurnCancelCommand,
  type TurnInterruptCommand,
  type TurnStartCommand,
  type TurnSteerCommand,
} from "../src/protocol.js";
import type { AgentRuntime, RuntimeEventSink } from "../src/runtime-port.js";
import { buildGroundedPrompt } from "../src/context-prompt.js";
import { contextFrameToTrailSource } from "../src/trail-source.js";
import { makeTurnStartCommand } from "./fixtures.js";

function makeCommand(utterance: string, overrides?: Partial<TurnStartCommand["payload"]["contextFrame"]>): TurnStartCommand {
  const base = makeTurnStartCommand();
  return {
    ...base,
    payload: {
      ...base.payload,
      utterance,
      contextFrame: {
        ...base.payload.contextFrame,
        ...overrides,
        frameId: randomUUID(),
        capturedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    },
  };
}

function waitForGateOrAbort(gate: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => finish();
    signal?.addEventListener("abort", onAbort, { once: true });
    void gate.then(finish, fail);
  });
}

async function resolvesWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout waiting for: ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("product kernel short-circuits remember on voice utterance", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const events: RuntimeEvent[] = [];

  await runtime.startTurn(makeCommand("记住：这个项目准备基于 Pi"), (e) => {
    events.push(e);
  });

  assert.ok(events.some((e) => e.type === "product.action.completed"));
  assert.ok(events.some((e) => e.type === "response.completed"));
  const completed = events.find((e) => e.type === "response.completed");
  assert.match(String((completed?.payload as { text?: string })?.text ?? ""), /记住/);
  assert.equal((await kernel.store.searchMemory("Pi")).length, 1);
});

test("project turns overwrite ambient global memory scope and stay isolated", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const projectA = {
    kind: "project" as const,
    projectId: "11111111-1111-4111-8111-111111111111",
    projectLabel: "项目 A",
  };
  const projectB = {
    kind: "project" as const,
    projectId: "22222222-2222-4222-8222-222222222222",
    projectLabel: "项目 B",
  };
  const commandA = makeCommand("记住：发布策略使用蓝色通道");
  commandA.payload.conversationId = randomUUID();
  commandA.payload.sessionScope = projectA;
  const commandB = makeCommand("记住：发布策略使用绿色通道");
  commandB.payload.conversationId = randomUUID();
  commandB.payload.sessionScope = projectB;

  await runtime.startTurn(commandA, () => undefined);
  await runtime.startTurn(commandB, () => undefined);

  assert.equal((await kernel.store.searchMemory("发布策略", { scope: `project:${projectA.projectId}` })).length, 1);
  assert.equal((await kernel.store.searchMemory("发布策略", { scope: `project:${projectB.projectId}` })).length, 1);
  assert.equal((await kernel.store.searchMemory("发布策略", { scope: "global" })).length, 0);
  assert.deepEqual((await kernel.store.getConversation(commandA.payload.conversationId))?.sessionScope, projectA);
  assert.deepEqual((await kernel.store.getConversation(commandB.payload.conversationId))?.sessionScope, projectB);
});

test("same-trace product-action retries are idempotent before a second write", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const command = makeCommand("记住：同一个 request 只能写一次");
  const firstEvents: RuntimeEvent[] = [];
  const first = runtime.startTurn(command, (event) => firstEvents.push(event));
  const retryEvents: RuntimeEvent[] = [];

  await runtime.startTurn(command, (event) => retryEvents.push(event));
  await first;

  assert.deepEqual(retryEvents, []);
  assert.equal(firstEvents.filter((event) => event.type === "response.completed").length, 1);
  assert.equal((await kernel.store.getConversationTurn(command.requestId))?.status, "completed");
  assert.equal((await kernel.store.searchMemory("只能写一次")).length, 1);
});

test("ordinary utterances still reach the inner mock runtime", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const events: RuntimeEvent[] = [];

  await runtime.startTurn(makeCommand("这个按钮为什么是灰色的？"), (e) => {
    events.push(e);
  });

  assert.ok(!events.some((e) => e.type === "product.action.completed"));
  assert.ok(events.some((e) => e.type === "response.completed"));
  // Trail still received the frame.
  assert.ok(kernel.trail.size({ kind: "personal" }) >= 1);
  assert.deepEqual(await kernel.store.listTasks(), []);
});

test("Finder Back uses one typed port request, preserves the trail, and never starts Pi", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const actions: Array<{ action: unknown; context: unknown }> = [];
  const port: ComputerUsePort = {
    async perform(action, context) {
      actions.push({ action, context });
      return {
        succeeded: true,
        verified: true,
        status: "verified",
        code: "verified_accessibility",
        method: "ax_press",
        message: "Finder returned to the expected location.",
        evidence: "target_app=Finder;press_count=1",
      };
    },
    resolve: () => false,
    cancelRequest: () => {},
    dispose: () => {},
  };
  let innerStarts = 0;
  const inner: AgentRuntime = {
    async startTurn() { innerStarts += 1; },
    async steerTurn() {},
    async cancelTurn() {},
    async dispose() {},
  };
  const runtime = new ProductKernelRuntime(inner, kernel, port);
  const command = makeCommand("点击左上角的返回按钮");
  command.payload.contextFrame.frontmostApplication = {
    value: {
      name: "Finder",
      bundleIdentifier: "com.apple.finder",
      processIdentifier: 4242,
    },
    source: "NSWorkspace",
    capturedAt: command.payload.contextFrame.capturedAt,
    confidence: 1,
  };
  const events: RuntimeEvent[] = [];

  await runtime.startTurn(command, (event) => events.push(event));

  assert.equal(innerStarts, 0);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0]?.action, {
    action: "finder_history_back",
    x: 0,
    y: 0,
    targetBundleId: "com.apple.finder",
    targetPid: 4242,
  });
  const context = actions[0]?.context as { requestId?: string; traceId?: string; intentId?: string; attemptId?: string; basisFrameId?: string; effectClass?: string };
  assert.equal(context.requestId, command.requestId);
  assert.equal(context.traceId, command.traceId);
  assert.equal(context.basisFrameId, command.payload.contextFrame.frameId);
  assert.ok(context.intentId);
  assert.ok(context.attemptId);
  assert.equal(context.effectClass, "navigation");
  assert.ok(kernel.trail.size({ kind: "personal" }) >= 1);
  assert.ok(events.some((event) => event.type === "product.action.completed"));
  assert.equal(events.find((event) => event.type === "response.completed")?.payload.verified, true);
  assert.match(String(events.find((event) => event.type === "response.completed")?.payload.text), /回到/);
});

test("unverified Finder Back is reported without a second dispatch or completion claim", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  let dispatches = 0;
  const port: ComputerUsePort = {
    async perform() {
      dispatches += 1;
      return {
        succeeded: true,
        verified: false,
        status: "unverified",
        code: "ax_press_unverified",
        method: "ax_press",
        message: "Finder Back was delivered but not verified.",
        evidence: "target_app=Finder;press_count=1",
      };
    },
    resolve: () => false,
    cancelRequest: () => {},
    dispose: () => {},
  };
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel, port);
  const command = makeCommand("点击返回按钮");
  command.payload.contextFrame.frontmostApplication = {
    value: {
      name: "Finder",
      bundleIdentifier: "com.apple.finder",
      processIdentifier: 4242,
    },
    source: "NSWorkspace",
    capturedAt: command.payload.contextFrame.capturedAt,
    confidence: 1,
  };
  const events: RuntimeEvent[] = [];

  await runtime.startTurn(command, (event) => events.push(event));

  assert.equal(dispatches, 1);
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(completed?.payload.verified, false);
  assert.match(String(completed?.payload.text), /不会重复点击/);
  const productReceipt = events.find((event) => event.type === "product.action.completed");
  assert.equal(productReceipt?.payload.status, "failed");
  assert.equal(productReceipt?.payload.succeeded, true);
  assert.equal(productReceipt?.payload.verified, false);
  assert.equal("evidence" in (productReceipt?.payload ?? {}), false);
});

test("an explicit Notes request creates once, requires read-back, and never starts Pi", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const actions: Array<{ action: unknown; context: unknown }> = [];
  const port: ComputerUsePort = {
    async perform(action, context) {
      actions.push({ action, context });
      return {
        succeeded: true,
        verified: true,
        status: "verified",
        code: "verified_accessibility",
        method: "native_command",
        message: "The exact created note was read back.",
        evidence: "created_note_read_back=true",
      };
    },
    resolve: () => false,
    cancelRequest: () => {},
    dispose: () => {},
  };
  let innerStarts = 0;
  const inner: AgentRuntime = {
    async startTurn() { innerStarts += 1; },
    async steerTurn() {},
    async cancelTurn() {},
    async dispose() {},
  };
  const runtime = new ProductKernelRuntime(inner, kernel, port);
  const content = "周五演示只讲插话和主动回访";
  const command = makeCommand(`奕枢，把「${content}」写进备忘录。`);
  const events: RuntimeEvent[] = [];

  await runtime.startTurn(command, (event) => events.push(event));

  assert.equal(innerStarts, 0);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0]?.action, {
    action: "create_note",
    x: 0,
    y: 0,
    content,
    title: content,
    targetBundleId: "com.apple.Notes",
  });
  const context = actions[0]?.context as {
    requestId?: string;
    traceId?: string;
    intentId?: string;
    attemptId?: string;
    basisFrameId?: string;
    effectClass?: string;
  };
  assert.equal(context.requestId, command.requestId);
  assert.equal(context.traceId, command.traceId);
  assert.equal(context.basisFrameId, command.payload.contextFrame.frameId);
  assert.equal(context.effectClass, "write");
  assert.ok(context.intentId);
  assert.ok(context.attemptId);
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(completed?.payload.verified, true);
  assert.match(String(completed?.payload.text), /备忘录/);
  const safeReceipt = events.find((event) => event.type === "product.action.completed");
  assert.equal(safeReceipt?.payload.status, "verified");
  assert.equal(JSON.stringify(safeReceipt?.payload).includes(content), false);
});

test("a Notes delivery timeout is treated as possibly committed and is never retried", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  let dispatches = 0;
  const port: ComputerUsePort = {
    async perform(_action, context) {
      dispatches += 1;
      throw new ComputerActionError("Timed out after dispatch.", {
        status: "failed",
        code: "timeout",
        method: "unknown",
        attemptId: context.attemptId,
      });
    },
    resolve: () => false,
    cancelRequest: () => {},
    dispose: () => {},
  };
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel, port);
  const content = "只写一次";
  const command = makeCommand(`把「${content}」写进备忘录`);
  const events: RuntimeEvent[] = [];

  await runtime.startTurn(command, (event) => events.push(event));

  assert.equal(dispatches, 1);
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(completed?.payload.verified, false);
  assert.match(String(completed?.payload.text), /可能已经新建/);
  assert.match(String(completed?.payload.text), /不会重复/);
  const safeReceipt = events.find((event) => event.type === "product.action.completed");
  assert.equal(safeReceipt?.payload.status, "failed");
  assert.equal(safeReceipt?.payload.succeeded, true);
  assert.equal(safeReceipt?.payload.code, "timeout");
  assert.equal(JSON.stringify(safeReceipt?.payload).includes(content), false);
});

test("cancelling after a Notes dispatch waits for one receipt and records a committed effect", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  let dispatches = 0;
  let release!: () => void;
  let markDispatched!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const dispatched = new Promise<void>((resolve) => { markDispatched = resolve; });
  const port: ComputerUsePort = {
    async perform(_action, _context, signal) {
      dispatches += 1;
      assert.equal(signal, undefined);
      markDispatched();
      await gate;
      return {
        succeeded: true,
        verified: true,
        status: "verified",
        code: "verified_accessibility",
        method: "native_command",
        message: "The exact created note was read back.",
      };
    },
    resolve: () => false,
    cancelRequest: () => {},
    dispose: () => {},
  };
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel, port);
  const command = makeCommand("把「取消后也只能写一次」写进备忘录");
  command.payload.conversationId = randomUUID();
  const visible: RuntimeEvent[] = [];
  const start = runtime.startTurn(command, (event) => visible.push(event));
  await dispatched;

  await runtime.cancelTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.cancel",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: { reason: "user_cancelled" },
  }, () => undefined);
  release();
  await start;

  assert.equal(dispatches, 1);
  const turns = await kernel.store.listConversationTurns(command.payload.conversationId);
  assert.equal(turns[0]?.status, "failed");
  const events = await kernel.store.listConversationEvents(command.payload.conversationId);
  assert.equal(events.filter((event) => event.type === "action.completed").length, 1);
  assert.ok(events.some((event) =>
    event.type === "turn.failed"
      && event.payload.code === "action_committed_after_cancel"));
  assert.ok(!events.some((event) => event.type === "turn.cancelled"));
  assert.ok(!visible.some((event) => event.type === "response.completed"));
});

class ScriptedExecutionRuntime implements AgentRuntime {
  constructor(
    private readonly verified: boolean,
    private readonly terminal: "completed" | "failed" = "completed",
    private readonly progressEvents = 1,
  ) {}

  async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
    emit(runtimeEvent("turn.started", command.requestId, command.traceId, {
      runtime: "scripted",
    }));
    emit(runtimeEvent("tool.started", command.requestId, command.traceId, {
      toolName: "computer_control",
      secretArgument: "must-not-be-persisted",
    }));
    for (let index = 0; index < this.progressEvents; index += 1) {
      emit(runtimeEvent("tool.completed", command.requestId, command.traceId, {
        toolName: `safe_tool_${index}`,
        isError: false,
        rawOutput: "private tool output must-not-be-persisted",
      }));
    }
    if (this.terminal === "failed") {
      emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
        code: "scripted_failure",
        message: "private failure details must-not-be-persisted",
      }));
      return;
    }
    emit(runtimeEvent("response.completed", command.requestId, command.traceId, {
      text: "private assistant response must-not-be-persisted",
      verified: this.verified,
      verifier: "scripted",
    }));
    emit(runtimeEvent("runtime.status", command.requestId, command.traceId, {
      status: "late_summary_after_completion",
    }));
  }

  async steerTurn(_command: TurnSteerCommand, _emit: RuntimeEventSink): Promise<void> {}
  async cancelTurn(_command: TurnCancelCommand, _emit: RuntimeEventSink): Promise<void> {}
  async dispose(): Promise<void> {}
}

test("private turns execute live but leave no ledger, task, trail, or memory", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const inner = new ScriptedExecutionRuntime(true);
  const runtime = new ProductKernelRuntime(inner, kernel);
  const privateTurn = makeCommand("执行一个私密操作");
  privateTurn.payload.conversationId = randomUUID();
  privateTurn.payload.sessionScope = { kind: "private" };
  const visible: RuntimeEvent[] = [];

  await runtime.startTurn(privateTurn, (event) => visible.push(event));

  assert.ok(visible.some((event) => event.type === "response.completed"));
  assert.deepEqual(kernel.store.getSnapshot().conversations, []);
  assert.deepEqual(kernel.store.getSnapshot().turns, []);
  assert.deepEqual(kernel.store.getSnapshot().events, []);
  assert.deepEqual(await kernel.store.listTasks(), []);
  assert.deepEqual(await kernel.store.listSuggestions(), []);
  assert.equal(kernel.trail.size({ kind: "private" }), 0);

  const privateRemember = makeCommand("记住：这条私密信息不能留下");
  privateRemember.payload.conversationId = randomUUID();
  privateRemember.payload.sessionScope = { kind: "private" };
  const blocked: RuntimeEvent[] = [];
  await runtime.startTurn(privateRemember, (event) => blocked.push(event));
  assert.equal((await kernel.store.searchMemory("私密信息")).length, 0);
  assert.match(String(blocked.find((event) => event.type === "response.completed")?.payload.text), /私密会话/);
});

test("executable turns record and settle suggestions for the mind loop", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(new ScriptedExecutionRuntime(true), kernel);
  const first = makeCommand("点一下提交按钮");
  first.payload.conversationId = randomUUID();
  await runtime.startTurn(first, () => undefined);

  let suggestions = await kernel.store.listSuggestions();
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.patternKey, "tool-computer-control");
  assert.equal(suggestions[0]?.status, "succeeded");
  assert.equal(suggestions[0]?.taskId, first.requestId);

  // One success is not enough to rewrite mind.
  assert.equal((await kernel.store.getMind()).markdown.trim(), "");

  const second = makeCommand("再点一次确认");
  second.payload.conversationId = randomUUID();
  await runtime.startTurn(second, () => undefined);
  suggestions = await kernel.store.listSuggestions();
  assert.equal(suggestions.length, 2);
  assert.ok(suggestions.every((item) => item.status === "succeeded"));

  const mind = await kernel.store.getMind();
  assert.match(mind.markdown, /tool-computer-control|What you've learned/);
  await runtime.dispose();
});

test("executable turns with explicit negative verification settle suggestions as failed", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(new ScriptedExecutionRuntime(false), kernel);
  const command = makeCommand("点一下不确定的按钮");
  command.payload.conversationId = randomUUID();
  await runtime.startTurn(command, () => undefined);
  const suggestions = await kernel.store.listSuggestions();
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.status, "failed");
  await runtime.dispose();
});

test("one conversation id cannot be replayed under another project scope", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const conversationId = randomUUID();
  const first = makeCommand("项目 A 的普通问题");
  first.payload.conversationId = conversationId;
  first.payload.sessionScope = {
    kind: "project",
    projectId: "11111111-1111-4111-8111-111111111111",
  };
  await runtime.startTurn(first, () => undefined);

  const conflicting = makeCommand("项目 B 的普通问题");
  conflicting.payload.conversationId = conversationId;
  conflicting.payload.sessionScope = {
    kind: "project",
    projectId: "22222222-2222-4222-8222-222222222222",
  };
  const visible: RuntimeEvent[] = [];
  await runtime.startTurn(conflicting, (event) => visible.push(event));

  assert.equal(visible[0]?.type, "turn.failed");
  assert.equal(visible[0]?.payload.code, "request_reuse_conflict");
  assert.equal((await kernel.store.listConversationTurns(conversationId)).length, 1);
});

test("untrusted runtime verified bits cannot complete external-effect TaskTruth", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(
    new ScriptedExecutionRuntime(true, "completed", 70),
    kernel,
  );
  const command = makeCommand(`  打开 Safari\n${"并验证 ".repeat(40)}  `);
  const projectScope = {
    kind: "project" as const,
    projectId: "33333333-3333-4333-8333-333333333333",
  };
  command.payload.sessionScope = projectScope;

  await runtime.startTurn(command, () => undefined);

  const [task] = await kernel.store.listTasks();
  assert.equal(task?.id, command.requestId);
  assert.equal(task?.status, "blocked");
  assert.deepEqual(task?.sessionScope, projectScope);
  assert.equal((await kernel.store.listTasks({ sessionScope: { kind: "personal" } })).length, 0);
  assert.ok((task?.title.length ?? 0) <= 160);
  assert.ok(!task?.title.includes("\n"));
  assert.ok((task?.evidence.length ?? 0) <= 64);
  const persisted = JSON.stringify(task);
  assert.doesNotMatch(persisted, /must-not-be-persisted|private assistant response/);
  assert.match(persisted, /tool\.started/);
  assert.match(persisted, /response\.completed/);
});

test("unverified execution completion remains blocked", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(
    new ScriptedExecutionRuntime(false),
    kernel,
  );

  await runtime.startTurn(makeCommand("执行并验证这个操作"), () => undefined);

  assert.equal((await kernel.store.listTasks())[0]?.status, "blocked");
});

test("failed execution turn persists failed TaskTruth", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(
    new ScriptedExecutionRuntime(false, "failed"),
    kernel,
  );

  await runtime.startTurn(makeCommand("执行会失败的操作"), () => undefined);

  assert.equal((await kernel.store.listTasks())[0]?.status, "failed");
});

class CancelRaceRuntime implements AgentRuntime {
  private releaseStart!: () => void;
  private markExecutionStarted!: () => void;
  readonly executionStarted = new Promise<void>((resolve) => {
    this.markExecutionStarted = resolve;
  });
  private readonly release = new Promise<void>((resolve) => {
    this.releaseStart = resolve;
  });

  async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
    emit(runtimeEvent("tool.started", command.requestId, command.traceId, {
      toolName: "computer_control",
    }));
    this.markExecutionStarted();
    await this.release;
    emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
      code: "late_failure_after_cancel",
    }));
  }

  async cancelTurn(command: TurnCancelCommand, emit: RuntimeEventSink): Promise<void> {
    emit(runtimeEvent("turn.cancelled", command.requestId, command.traceId, {
      reason: command.payload.reason ?? "user_cancelled",
    }));
    this.releaseStart();
  }

  async steerTurn(_command: TurnSteerCommand, _emit: RuntimeEventSink): Promise<void> {}
  async dispose(): Promise<void> {}
}

test("cancelled TaskTruth is not overwritten by a late runtime failure", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const inner = new CancelRaceRuntime();
  const runtime = new ProductKernelRuntime(inner, kernel);
  const command = makeCommand("取消这个正在执行的操作");
  const start = runtime.startTurn(command, () => undefined);
  await inner.executionStarted;

  const duplicateEvents: RuntimeEvent[] = [];
  const conflictingTraceId = randomUUID();
  await runtime.startTurn({ ...command, traceId: conflictingTraceId }, (event) => duplicateEvents.push(event));
  assert.equal(duplicateEvents[0]?.type, "turn.failed");
  assert.equal(duplicateEvents[0]?.payload.code, "duplicate_request");
  assert.equal(duplicateEvents[0]?.traceId, conflictingTraceId);

  await runtime.cancelTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.cancel",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: { reason: "user_cancelled" },
  }, () => undefined);
  await start;

  assert.equal((await kernel.store.listTasks())[0]?.status, "cancelled");
});

class HungCancelRuntime implements AgentRuntime {
  private releaseStart!: () => void;
  private markExecutionStarted!: () => void;
  readonly executionStarted = new Promise<void>((resolve) => {
    this.markExecutionStarted = resolve;
  });
  private readonly releaseGate = new Promise<void>((resolve) => {
    this.releaseStart = resolve;
  });
  lateCancelEmit: RuntimeEventSink | undefined;

  async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
    emit(runtimeEvent("tool.started", command.requestId, command.traceId, {
      toolName: "hung_cancel_test",
    }));
    this.markExecutionStarted();
    await this.releaseGate;
    emit(runtimeEvent("response.completed", command.requestId, command.traceId, {
      text: "late completion after cancellation",
      verified: true,
    }));
  }

  async cancelTurn(_command: TurnCancelCommand, emit: RuntimeEventSink): Promise<void> {
    this.lateCancelEmit = emit;
    await new Promise<void>(() => undefined);
  }

  release(): void {
    this.releaseStart();
  }

  async steerTurn(_command: TurnSteerCommand, _emit: RuntimeEventSink): Promise<void> {}
  async dispose(): Promise<void> {
    this.releaseStart();
  }
}

test("cancel persists and emits before a hung inner cancel times out; late events stay ignored", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const inner = new HungCancelRuntime();
  const runtime = new ProductKernelRuntime(inner, kernel);
  const command = makeCommand("停止这个卡住的操作");
  command.payload.conversationId = randomUUID();
  const visible: RuntimeEvent[] = [];
  let markCancelledVisible!: () => void;
  const cancelledVisible = new Promise<void>((resolve) => {
    markCancelledVisible = resolve;
  });
  const start = runtime.startTurn(command, (event) => {
    visible.push(event);
    if (event.type === "turn.cancelled") markCancelledVisible();
  });
  await inner.executionStarted;

  const cancel = runtime.cancelTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.cancel",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: { reason: "user_cancelled" },
  }, () => undefined);

  await resolvesWithin(cancelledVisible, 1_000, "durable visible cancellation");
  assert.equal((await kernel.store.getConversationTurn(command.requestId))?.status, "cancelled");
  assert.equal(
    (await kernel.store.listTasks()).find((task) => task.id === command.requestId)?.status,
    "cancelled",
  );
  await resolvesWithin(cancel, 3_000, "hung inner cancellation");

  inner.lateCancelEmit?.(runtimeEvent(
    "response.completed",
    command.requestId,
    command.traceId,
    { text: "late cancel callback", verified: true },
  ));
  inner.release();
  await start;
  assert.equal(visible.filter((event) => event.type === "turn.cancelled").length, 1);
  assert.equal(visible.some((event) => event.type === "response.completed"), false);
});

test("unknown turn cancellation is also bounded when the inner runtime hangs", async () => {
  const inner = new HungCancelRuntime();
  const runtime = new ProductKernelRuntime(
    inner,
    createYishuKernel({ storeBackend: "memory" }),
  );
  const command = makeCommand("取消未知 turn");

  await resolvesWithin(runtime.cancelTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.cancel",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: { reason: "user_cancelled" },
  }, () => undefined), 3_000, "unknown hung inner cancellation");
});

class DelayedExecutionAfterCancelRuntime implements AgentRuntime {
  private releaseStart!: () => void;
  private readonly release = new Promise<void>((resolve) => {
    this.releaseStart = resolve;
  });

  async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
    await this.release;
    emit(runtimeEvent("tool.started", command.requestId, command.traceId, {
      toolName: "late_tool",
    }));
    emit(runtimeEvent("response.completed", command.requestId, command.traceId, {
      text: "late completion",
      verified: true,
    }));
  }

  async cancelTurn(command: TurnCancelCommand, emit: RuntimeEventSink): Promise<void> {
    emit(runtimeEvent("turn.cancelled", command.requestId, command.traceId, {
      reason: command.payload.reason ?? "user_cancelled",
    }));
    this.releaseStart();
  }

  async steerTurn(_command: TurnSteerCommand, _emit: RuntimeEventSink): Promise<void> {}
  async dispose(): Promise<void> {
    this.releaseStart();
  }
}

test("pre-execution cancellation blocks delayed events from manufacturing a task", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const inner = new DelayedExecutionAfterCancelRuntime();
  const runtime = new ProductKernelRuntime(inner, kernel);
  const command = makeCommand("取消初始化中的执行");
  const start = runtime.startTurn(command, () => undefined);

  await runtime.cancelTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.cancel",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: { reason: "user_cancelled" },
  }, () => undefined);
  await start;

  assert.deepEqual(await kernel.store.listTasks(), []);
  const cancelledTurn = (await kernel.store.getConversationTurn(command.requestId));
  assert.ok(cancelledTurn === null || cancelledTurn.status === "cancelled");
});

test("active cancellation requires the exact turn trace", async () => {
  class TraceBoundRuntime implements AgentRuntime {
    starts = 0;
    cancels = 0;
    private release!: () => void;
    private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });
    private markReady!: () => void;
    readonly ready = new Promise<void>((resolve) => { this.markReady = resolve; });

    async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
      this.starts += 1;
      emit(runtimeEvent("turn.started", command.requestId, command.traceId, {
        runtime: "trace-bound",
        generation: 1,
      }));
      this.markReady();
      await this.gate;
    }
    async interruptTurn(): Promise<void> {}
    async steerTurn(): Promise<void> {}
    async cancelTurn(): Promise<void> {
      this.cancels += 1;
      this.release();
    }
    async dispose(): Promise<void> { this.release(); }
  }

  const kernel = createYishuKernel({ storeBackend: "memory" });
  const inner = new TraceBoundRuntime();
  const runtime = new ProductKernelRuntime(inner, kernel);
  const command = makeCommand("trace 必须精确匹配");
  const visible: RuntimeEvent[] = [];
  const start = runtime.startTurn(command, (event) => visible.push(event));
  await inner.ready;

  const retryVisible: RuntimeEvent[] = [];
  await runtime.startTurn(command, (event) => retryVisible.push(event));
  assert.equal(inner.starts, 1);
  assert.deepEqual(retryVisible, []);
  assert.equal(visible.some((event) => event.type === "turn.cancelled"), false);

  await runtime.cancelTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.cancel",
    requestId: command.requestId,
    traceId: randomUUID(),
    sentAt: new Date().toISOString(),
    payload: { reason: "wrong_trace" },
  }, () => undefined);
  assert.equal(inner.cancels, 0);
  assert.equal(visible.some((event) => event.type === "turn.cancelled"), false);
  assert.equal((await kernel.store.getConversationTurn(command.requestId))?.status, "open");

  await runtime.cancelTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.cancel",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: { reason: "correct_trace" },
  }, () => undefined);
  await start;

  assert.equal(inner.cancels, 1);
  assert.equal(inner.starts, 1);
  assert.deepEqual(retryVisible, []);
  assert.equal(visible.filter((event) => event.type === "turn.cancelled").length, 1);
  assert.equal((await kernel.store.getConversationTurn(command.requestId))?.status, "cancelled");
});

test("cancel tombstones a replacement still waiting for conversation admission", async () => {
  class AdmissionRuntime implements AgentRuntime {
    readonly starts: string[] = [];
    private firstRequestId?: string;
    private releaseFirst!: () => void;
    private readonly firstGate = new Promise<void>((resolve) => { this.releaseFirst = resolve; });
    private markFirstStarted!: () => void;
    readonly firstStarted = new Promise<void>((resolve) => { this.markFirstStarted = resolve; });
    private markFirstCancel!: () => void;
    readonly firstCancelStarted = new Promise<void>((resolve) => { this.markFirstCancel = resolve; });

    async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
      this.starts.push(command.requestId);
      emit(runtimeEvent("turn.started", command.requestId, command.traceId, {
        runtime: "admission",
        generation: 1,
      }));
      if (this.firstRequestId === undefined) {
        this.firstRequestId = command.requestId;
        this.markFirstStarted();
        await this.firstGate;
        return;
      }
      emit(runtimeEvent("response.completed", command.requestId, command.traceId, {
        text: "replacement completed",
        verified: false,
        generation: 1,
      }));
    }

    async interruptTurn(): Promise<void> {}
    async steerTurn(): Promise<void> {}
    async cancelTurn(command: TurnCancelCommand): Promise<void> {
      if (command.requestId === this.firstRequestId) {
        this.markFirstCancel();
        await this.firstGate;
      }
    }
    release(): void { this.releaseFirst(); }
    async dispose(): Promise<void> { this.releaseFirst(); }
  }

  const kernel = createYishuKernel({ storeBackend: "memory" });
  const inner = new AdmissionRuntime();
  const runtime = new ProductKernelRuntime(inner, kernel);
  const conversationId = randomUUID();
  const first = makeCommand("第一轮");
  first.payload.conversationId = conversationId;
  const replacement = makeCommand("替换第一轮");
  replacement.payload.conversationId = conversationId;
  const cancelledReplacement = makeCommand("取消这个等待中的替换");
  cancelledReplacement.payload.conversationId = conversationId;
  const cancelledVisible: RuntimeEvent[] = [];

  const firstRun = runtime.startTurn(first, () => undefined);
  await inner.firstStarted;
  const replacementRun = runtime.startTurn(replacement, () => undefined);
  await inner.firstCancelStarted;
  const cancelledRun = runtime.startTurn(cancelledReplacement, (event) => cancelledVisible.push(event));
  const retryPendingVisible: RuntimeEvent[] = [];
  await runtime.startTurn(cancelledReplacement, (event) => retryPendingVisible.push(event));
  assert.deepEqual(retryPendingVisible, []);
  assert.equal(inner.starts.includes(cancelledReplacement.requestId), false);

  const duplicatePending = {
    ...cancelledReplacement,
    traceId: randomUUID(),
    payload: {
      ...cancelledReplacement.payload,
      conversationId: randomUUID(),
    },
  };
  const duplicateVisible: RuntimeEvent[] = [];
  await runtime.startTurn(duplicatePending, (event) => duplicateVisible.push(event));
  assert.equal(duplicateVisible[0]?.type, "turn.failed");
  assert.equal(duplicateVisible[0]?.payload.code, "duplicate_request");

  await resolvesWithin(runtime.cancelTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.cancel",
    requestId: cancelledReplacement.requestId,
    traceId: duplicatePending.traceId,
    sentAt: new Date().toISOString(),
    payload: { reason: "wrong_trace" },
  }, () => undefined), 500, "wrong-trace pending cancellation ignored");
  assert.equal(inner.starts.includes(cancelledReplacement.requestId), false);
  assert.equal(await kernel.store.getConversationTurn(cancelledReplacement.requestId), null);

  await resolvesWithin(runtime.cancelTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.cancel",
    requestId: cancelledReplacement.requestId,
    traceId: cancelledReplacement.traceId,
    sentAt: new Date().toISOString(),
    payload: { reason: "user_cancelled" },
  }, () => undefined), 500, "pending replacement tombstone");
  inner.release();
  await Promise.all([firstRun, replacementRun, cancelledRun]);

  assert.equal(inner.starts.includes(cancelledReplacement.requestId), false);
  assert.equal(
    (await kernel.store.getConversationTurn(cancelledReplacement.requestId))?.status,
    "cancelled",
  );
  assert.equal(cancelledVisible.filter((event) => event.type === "turn.cancelled").length, 1);
});

class DisposeSettledRuntime implements AgentRuntime {
  private releaseStart!: () => void;
  private readonly release = new Promise<void>((resolve) => {
    this.releaseStart = resolve;
  });
  private markStarted!: () => void;
  readonly executionStarted = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
    emit(runtimeEvent("tool.started", command.requestId, command.traceId, {
      toolName: "dispose_test",
    }));
    this.markStarted();
    await this.release;
    emit(runtimeEvent("response.completed", command.requestId, command.traceId, {
      text: "settled before dispose returns",
      verified: true,
    }));
  }

  async steerTurn(_command: TurnSteerCommand, _emit: RuntimeEventSink): Promise<void> {}
  async cancelTurn(_command: TurnCancelCommand, _emit: RuntimeEventSink): Promise<void> {}
  async dispose(): Promise<void> {
    this.releaseStart();
  }
}

test("dispose durably cancels active producers and ignores their late completion", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const inner = new DisposeSettledRuntime();
  const runtime = new ProductKernelRuntime(inner, kernel);
  const command = makeCommand("完成后再关闭 runtime");
  const visible: RuntimeEvent[] = [];
  const start = runtime.startTurn(command, (event) => visible.push(event));

  await inner.executionStarted;
  await runtime.dispose();
  await start;

  assert.equal((await kernel.store.listTasks())[0]?.status, "cancelled");
  assert.equal((await kernel.store.listConversationTurns(command.requestId))[0]?.status, "cancelled");
  assert.equal(visible.some((event) => event.type === "response.completed"), false);
});

test("trail.observe appends without a full turn", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const frame = makeTurnStartCommand().payload.contextFrame;
  const events: RuntimeEvent[] = [];

  await runtime.observeTrail(
    {
      schemaVersion: PROTOCOL_VERSION,
      type: "trail.observe",
      requestId: randomUUID(),
      traceId: randomUUID(),
      sentAt: new Date().toISOString(),
      payload: { contextFrame: { ...frame, screenshots: [] } },
    },
    (e) => events.push(e),
  );

  assert.equal(kernel.trail.size({ kind: "personal" }), 1);
  assert.equal(events[0]?.type, "trail.appended");
});

function contextObservation(
  bundleIdentifier: string,
  sessionScope: TurnStartCommand["payload"]["sessionScope"] = { kind: "personal" },
) {
  const command = makeCommand("observation");
  command.payload.contextFrame.frontmostApplication = {
    value: {
      name: bundleIdentifier,
      bundleIdentifier,
      processIdentifier: 42,
    },
    source: "test",
    capturedAt: command.payload.contextFrame.capturedAt,
    confidence: 1,
  };
  return {
    schemaVersion: PROTOCOL_VERSION,
    type: "trail.observe" as const,
    requestId: randomUUID(),
    traceId: randomUUID(),
    sentAt: new Date().toISOString(),
    payload: {
      contextFrame: { ...command.payload.contextFrame, screenshots: [] },
      sessionScope,
    },
  };
}

test("context reminder arms on departure, fires exactly once on return, and lists after restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yishu-context-watch-runtime-"));
  const sqlitePath = path.join(root, "watch.sqlite");
  const conversationId = randomUUID();
  let innerStarts = 0;
  const inner: AgentRuntime = {
    async startTurn() { innerStarts += 1; },
    async steerTurn() {},
    async cancelTurn() {},
    async dispose() {},
  };

  try {
    const kernel1 = createYishuKernel({ storeBackend: "sqlite", sqlitePath });
    const runtime1 = new ProductKernelRuntime(inner, kernel1);
    const presence: Array<Record<string, unknown>> = [];
    runtime1.setTaskPresenceSink((update) => presence.push(update));
    const create = makeCommand("我下次切回这个应用时，提醒我提交报销。");
    create.payload.conversationId = conversationId;
    create.payload.contextFrame.frontmostApplication = {
      value: { name: "Mail", bundleIdentifier: "com.apple.mail", processIdentifier: 42 },
      source: "test",
      capturedAt: create.payload.contextFrame.capturedAt,
      confidence: 1,
    };
    await runtime1.startTurn(create, () => undefined);
    assert.equal(innerStarts, 0, "the explicit reminder is a product action, not a Pi turn");
    assert.equal(presence[0]?.status, "running");
    assert.equal(presence[0]?.watchState, "waiting_for_departure");

    await runtime1.observeTrail(contextObservation("com.apple.mail"), () => undefined);
    assert.equal(presence.length, 1, "continuous target samples do not arm or fire");
    await runtime1.observeTrail(contextObservation("com.apple.finder"), () => undefined);
    assert.equal((await kernel1.store.listActiveContextWatches({ kind: "personal" }))[0]?.state, "armed");
    assert.equal(presence.at(-1)?.watchState, "armed");
    await runtime1.dispose();
    (kernel1.store as { close?: () => void }).close?.();

    const kernel2 = createYishuKernel({ storeBackend: "sqlite", sqlitePath });
    const runtime2 = new ProductKernelRuntime(new MockAgentRuntime(), kernel2);
    const recoveredPresence: Array<Record<string, unknown>> = [];
    runtime2.setTaskPresenceSink((update) => recoveredPresence.push(update));
    // Submit adjacent return samples without awaiting the first. Serialized
    // evaluation plus store CAS must still announce the recovered watch once.
    const firstReturn = runtime2.observeTrail(contextObservation("com.apple.mail"), () => undefined);
    const duplicateReturn = runtime2.observeTrail(contextObservation("com.apple.mail"), () => undefined);
    await Promise.all([firstReturn, duplicateReturn]);
    assert.equal(recoveredPresence.filter((event) => event.status === "done").length, 1);
    assert.equal(recoveredPresence[0]?.summary, "提醒：提交报销");
    assert.equal(recoveredPresence[0]?.watchState, "fired");
    const restored = await runtime2.listTasks(conversationId);
    assert.equal(restored.length, 1);
    assert.equal(restored[0]?.taskKind, "context_reminder");
    assert.equal(restored[0]?.watchState, "fired");
    assert.equal(restored[0]?.status, "done");
    assert.equal(restored[0]?.summary, "提醒：提交报销");
    await runtime2.dispose();
    (kernel2.store as { close?: () => void }).close?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context reminder cancel is durable and private or cross-scope observations cannot trigger it", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const conversationId = randomUUID();
  const project = { kind: "project" as const, projectId: randomUUID(), projectLabel: "A" };
  const create = makeCommand("我下次切回这个应用时，提醒我提交报销。");
  create.payload.conversationId = conversationId;
  create.payload.sessionScope = project;
  create.payload.contextFrame.frontmostApplication = {
    value: { name: "Mail", bundleIdentifier: "com.apple.mail", processIdentifier: 42 },
    source: "test",
    capturedAt: create.payload.contextFrame.capturedAt,
    confidence: 1,
  };
  await runtime.startTurn(create, () => undefined);
  const task = (await runtime.listTasks(conversationId))[0]!;

  await runtime.observeTrail(contextObservation("com.apple.finder", { kind: "personal" }), () => undefined);
  await runtime.observeTrail(contextObservation("com.apple.mail", { kind: "private" }), () => undefined);
  assert.equal((await kernel.store.listTasks({ sessionScope: project }))[0]?.status, "running");

  const accepted = await runtime.cancelTask({
    schemaVersion: PROTOCOL_VERSION,
    type: "task.cancel",
    requestId: randomUUID(),
    traceId: randomUUID(),
    sentAt: new Date().toISOString(),
    payload: { taskId: task.taskId, mainConversationId: conversationId },
  });
  assert.equal(accepted, true);
  await runtime.observeTrail(contextObservation("com.apple.finder", project), () => undefined);
  await runtime.observeTrail(contextObservation("com.apple.mail", project), () => undefined);
  assert.equal((await runtime.listTasks(conversationId))[0]?.status, "cancelled");
  assert.equal((await runtime.listTasks(conversationId))[0]?.watchState, "cancelled");
  await runtime.dispose();
});

test("a replacement turn evicts and cancels the prior conversation before starting inner", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const conversationId = randomUUID();
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const order: string[] = [];
  let starts = 0;
  const inner: AgentRuntime & { releaseConversationSession(id: string): void } = {
    async startTurn(command, emit) {
      starts += 1;
      order.push(`start:${starts}`);
      emit(runtimeEvent("turn.started", command.requestId, command.traceId, {}));
      if (starts === 1) {
        markFirstStarted();
        await firstGate;
        return;
      }
      emit(runtimeEvent("response.completed", command.requestId, command.traceId, {
        text: "replacement complete",
      }));
    },
    async steerTurn() {},
    async cancelTurn() {
      order.push("cancel:1");
      releaseFirst();
    },
    releaseConversationSession(id) {
      assert.equal(id, conversationId);
      order.push("release:1");
    },
    async dispose() { releaseFirst(); },
  };
  const runtime = new ProductKernelRuntime(inner, kernel);
  const first = makeCommand("第一个长回合");
  first.payload.conversationId = conversationId;
  const second = makeCommand("取代上一个回合");
  second.payload.conversationId = conversationId;
  const firstEvents: RuntimeEvent[] = [];
  const secondEvents: RuntimeEvent[] = [];

  const firstOperation = runtime.startTurn(first, (event) => firstEvents.push(event));
  await firstStarted;
  const secondOperation = runtime.startTurn(second, (event) => secondEvents.push(event));
  await Promise.all([firstOperation, secondOperation]);

  assert.deepEqual(order, ["start:1", "release:1", "cancel:1", "start:2"]);
  assert.equal(firstEvents.at(-1)?.type, "turn.cancelled");
  assert.equal(secondEvents.at(-1)?.type, "response.completed");
  assert.equal((await kernel.store.getConversationTurn(first.requestId))?.status, "cancelled");
  assert.equal((await kernel.store.getConversationTurn(second.requestId))?.status, "completed");
  await runtime.dispose();
});

test("remember_how promotes multi-app trail after replay verify", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const t0 = Date.now();

  // Seed trail via observe
  const seed = (appName: string, title: string, offsetMs: number) => {
    const cmd = makeCommand("x");
    runtime.observeTrail(
      {
        schemaVersion: PROTOCOL_VERSION,
        type: "trail.observe",
        requestId: randomUUID(),
        traceId: randomUUID(),
        sentAt: new Date(t0 + offsetMs).toISOString(),
        payload: {
          contextFrame: {
            ...cmd.payload.contextFrame,
            frameId: randomUUID(),
            capturedAt: new Date(t0 + offsetMs).toISOString(),
            expiresAt: new Date(t0 + offsetMs + 60_000).toISOString(),
            frontmostApplication: {
              value: {
                name: appName,
                bundleIdentifier: "test",
                processIdentifier: 1,
              },
              source: "test",
              capturedAt: new Date(t0 + offsetMs).toISOString(),
              confidence: 1,
            },
            activeWindow: {
              value: {
                title,
                ownerName: appName,
                processIdentifier: 1,
                bounds: null,
              },
              source: "test",
              capturedAt: new Date(t0 + offsetMs).toISOString(),
              confidence: 1,
            },
            screenshots: [],
          },
        },
      },
      () => undefined,
    );
  };

  seed("Chrome", "github.com/yishu", 0);
  seed("Chrome", "branch main", 30_000);
  seed("Codex", "yishu session", 60_000);

  const events: RuntimeEvent[] = [];
  await runtime.startTurn(makeCommand("记住刚才这个流程"), (e) => events.push(e));

  assert.ok(events.some((e) => e.type === "product.action.completed"));
  const skills = await kernel.store.listVerifiedSkills();
  const candidates = await kernel.store.listSkillCandidates();
  // Either promoted or candidate kept - multi-app trail should usually promote.
  assert.ok(skills.length + candidates.length >= 1);
});

test("durable conversation projection keeps one turn truth and drops deltas/secrets", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const command = makeCommand("请解释这个按钮");
  const conversationId = randomUUID();
  command.payload.conversationId = conversationId;
  const events: RuntimeEvent[] = [];

  await runtime.startTurn(command, (event) => events.push(event));

  const turns = await kernel.store.listConversationTurns(conversationId);
  const ledgerEvents = await kernel.store.listConversationEvents(conversationId);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.id, command.requestId);
  assert.equal(turns[0]?.status, "completed");
  assert.equal(turns[0]?.traceId, command.traceId);
  assert.deepEqual(ledgerEvents.slice(0, 2).map((event) => event.type), ["turn.started", "turn.user_input"]);
  assert.ok(ledgerEvents.some((event) => event.type === "turn.user_input"));
  assert.ok(ledgerEvents.some((event) => event.type === "turn.assistant_output"));
  assert.ok(ledgerEvents.some((event) => event.type === "turn.completed"));
  assert.ok(!ledgerEvents.some((event) => event.type === "response.delta"));
  assert.doesNotMatch(JSON.stringify(ledgerEvents), /c2NyZWVu|base64|screenshot/i);
  assert.ok(events.every((event) => event.conversationId === conversationId));
});

test("product actions use the same conversation ledger and safe action receipt", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const command = makeCommand("记住：不要把私密参数写入账本");
  command.payload.conversationId = randomUUID();
  await runtime.startTurn(command, () => undefined);

  const events = await kernel.store.listConversationEvents(command.payload.conversationId);
  assert.ok(events.some((event) => event.type === "action.completed"));
  assert.ok(events.some((event) => event.type === "turn.completed"));
  const action = events.find((event) => event.type === "action.completed");
  assert.equal("output" in (action?.payload ?? {}), false);
  assert.equal("message" in (action?.payload ?? {}), false);
  assert.doesNotMatch(JSON.stringify(action), /capsuleJson|screenshot|base64/i);
});

test("live share_context action receipt exposes only capsule metadata", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const command = makeCommand("把当前上下文交给 Codex；private diagnosis=SECRET_VISIBLE");
  command.payload.conversationId = randomUUID();
  const visible: RuntimeEvent[] = [];

  await runtime.startTurn(command, (event) => visible.push(event));

  const action = visible.find((event) => event.type === "product.action.completed");
  assert.ok(action);
  const serialized = JSON.stringify(action);
  assert.doesNotMatch(serialized, /result\.json|capsuleJson|selectedText|userIntent|private diagnosis|SECRET_VISIBLE/i);
  assert.equal(typeof action.payload.capsuleId, "string");
  assert.equal(typeof action.payload.expiresAt, "string");
  assert.equal(typeof action.payload.trailEntryCount, "number");
  assert.equal("output" in action.payload, false);
  assert.equal("capsule" in action.payload, false);
});

test("terminal live events allowlist failure code and sanitize visible completion text", async () => {
  class MaliciousTerminalRuntime implements AgentRuntime {
    constructor(private readonly failed: boolean) {}

    async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
      if (this.failed) {
        emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
          code: "password=SECRET_VISIBLE",
          message: "private diagnosis password=SECRET_VISIBLE",
          details: { selectedText: "secret diagnosis" },
        }));
        return;
      }
      emit(runtimeEvent("response.completed", command.requestId, command.traceId, {
        text: "可见结果 password=SECRET_VISIBLE",
        verified: true,
        verifier: "private verifier",
        details: { selectedText: "secret diagnosis" },
      }));
    }

    async steerTurn(_command: TurnSteerCommand, _emit: RuntimeEventSink): Promise<void> {}
    async cancelTurn(_command: TurnCancelCommand, _emit: RuntimeEventSink): Promise<void> {}
    async dispose(): Promise<void> {}
  }

  const kernel = createYishuKernel({ storeBackend: "memory" });
  const failedRuntime = new ProductKernelRuntime(new MaliciousTerminalRuntime(true), kernel);
  const failedCommand = makeCommand("恶意失败终态");
  failedCommand.payload.conversationId = randomUUID();
  const failedVisible: RuntimeEvent[] = [];
  await failedRuntime.startTurn(failedCommand, (event) => failedVisible.push(event));
  assert.doesNotMatch(JSON.stringify(failedVisible), /SECRET_VISIBLE|private diagnosis|selectedText|message/);
  assert.deepEqual(
    failedVisible.find((event) => event.type === "turn.failed")?.payload,
    { code: "runtime_operation_failed", generation: 1 },
  );

  const completedRuntime = new ProductKernelRuntime(new MaliciousTerminalRuntime(false), kernel);
  const completedCommand = makeCommand("恶意完成终态");
  completedCommand.payload.conversationId = randomUUID();
  const completedVisible: RuntimeEvent[] = [];
  await completedRuntime.startTurn(completedCommand, (event) => completedVisible.push(event));
  const completed = completedVisible.find((event) => event.type === "response.completed");
  assert.ok(completed);
  assert.doesNotMatch(JSON.stringify(completed), /SECRET_VISIBLE|private verifier|selectedText|details/);
  assert.match(String(completed.payload.text), /\[redacted\]/);
  assert.deepEqual(Object.keys(completed.payload).sort(), ["generation", "text", "verified"]);
});

test("cancelling a product action closes the gate before a slow registry result can speak success", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const originalInvoke = kernel.registry.invoke.bind(kernel.registry);
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const invoked = new Promise<void>((resolve) => { markStarted = resolve; });
  (kernel.registry as unknown as {
    invoke: typeof kernel.registry.invoke;
  }).invoke = async (...args: Parameters<typeof kernel.registry.invoke>) => {
    markStarted();
    await waitForGateOrAbort(gate, args[1].signal);
    return originalInvoke(...args);
  };

  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const command = makeCommand("记住：这个动作会被取消");
  command.payload.conversationId = randomUUID();
  const visible: RuntimeEvent[] = [];
  const start = runtime.startTurn(command, (event) => visible.push(event));
  await invoked;
  await runtime.cancelTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.cancel",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: { reason: "user_cancelled" },
  }, () => undefined);
  release();
  await start;

  const turns = await kernel.store.listConversationTurns(command.payload.conversationId);
  const ledgerEvents = await kernel.store.listConversationEvents(command.payload.conversationId);
  assert.equal(turns[0]?.status, "cancelled");
  assert.ok(ledgerEvents.some((event) => event.type === "turn.cancelled"));
  assert.ok(!ledgerEvents.some((event) => event.type === "action.completed"));
  assert.ok(!visible.some((event) => event.type === "response.completed"));
  assert.equal((await kernel.store.searchMemory("这个动作会被取消")).length, 0);
});

test("a stop after a product action commits records the receipt and fails the turn truthfully", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const originalInvoke = kernel.registry.invoke.bind(kernel.registry);
  let markReceiptReady!: () => void;
  const receiptReady = new Promise<void>((resolve) => { markReceiptReady = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  (kernel.registry as unknown as {
    invoke: typeof kernel.registry.invoke;
  }).invoke = async (...args: Parameters<typeof kernel.registry.invoke>) => {
    const receipt = await originalInvoke(...args);
    // The remember action has already committed the MemoryClaim by the time
    // its receipt resolves.  Hold that receipt so cancel can race the return
    // path without erasing the real side effect.
    markReceiptReady();
    await waitForGateOrAbort(gate, args[1].signal);
    return receipt;
  };

  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const command = makeCommand("记住：这个动作已经提交");
  command.payload.conversationId = randomUUID();
  const visible: RuntimeEvent[] = [];
  const start = runtime.startTurn(command, (event) => visible.push(event));
  await receiptReady;
  assert.equal((await kernel.store.searchMemory("这个动作已经提交")).length, 1);

  await runtime.cancelTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.cancel",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: { reason: "user_cancelled" },
  }, () => undefined);
  // The abort signal releases the wrapped receipt; keep this explicit for a
  // wrapper that may later choose to ignore signals.
  release();
  await start;

  const turns = await kernel.store.listConversationTurns(command.payload.conversationId);
  const ledgerEvents = await kernel.store.listConversationEvents(command.payload.conversationId);
  assert.equal(turns[0]?.status, "failed");
  const action = ledgerEvents.find((event) => event.type === "action.completed");
  assert.ok(action);
  assert.equal(action.payload.status, "verified");
  const failed = ledgerEvents.find((event) => event.type === "turn.failed");
  assert.equal(failed?.payload.code, "action_committed_after_cancel");
  assert.ok(!ledgerEvents.some((event) => event.type === "turn.cancelled"));
  assert.ok(!visible.some((event) => event.type === "response.completed"));
  assert.ok(visible.some((event) => event.type === "product.action.completed"));
  assert.ok(visible.some((event) => event.type === "turn.failed" && event.payload.code === "action_committed_after_cancel"));
  assert.equal((await kernel.store.searchMemory("这个动作已经提交")).length, 1);
});

test("a registry cancelled receipt becomes a cancelled turn without action success events", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const originalInvoke = kernel.registry.invoke.bind(kernel.registry);
  (kernel.registry as unknown as {
    invoke: typeof kernel.registry.invoke;
  }).invoke = async (...args: Parameters<typeof kernel.registry.invoke>) => {
    const controller = new AbortController();
    controller.abort("internal cancellation detail must not escape");
    return originalInvoke(args[0], { ...args[1], signal: controller.signal }, args[2]);
  };

  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const command = makeCommand("记住：内部取消也不能写入");
  command.payload.conversationId = randomUUID();
  const visible: RuntimeEvent[] = [];
  await runtime.startTurn(command, (event) => visible.push(event));

  const turns = await kernel.store.listConversationTurns(command.payload.conversationId);
  const events = await kernel.store.listConversationEvents(command.payload.conversationId);
  assert.equal(turns[0]?.status, "cancelled");
  assert.ok(events.some((event) => event.type === "turn.cancelled"));
  assert.ok(!events.some((event) => event.type === "action.completed"));
  assert.ok(!visible.some((event) => event.type === "response.completed"));
  assert.equal((await kernel.store.searchMemory("内部取消也不能写入")).length, 0);
});

test("dispose aborts an active product action before waiting for turn operations", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const originalInvoke = kernel.registry.invoke.bind(kernel.registry);
  let markStarted!: () => void;
  const invoked = new Promise<void>((resolve) => { markStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  (kernel.registry as unknown as {
    invoke: typeof kernel.registry.invoke;
  }).invoke = async (...args: Parameters<typeof kernel.registry.invoke>) => {
    markStarted();
    await waitForGateOrAbort(gate, args[1].signal);
    return originalInvoke(...args);
  };

  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const command = makeCommand("记住：dispose 时不能落记忆");
  command.payload.conversationId = randomUUID();
  const visible: RuntimeEvent[] = [];
  const start = runtime.startTurn(command, (event) => visible.push(event));
  await invoked;

  await runtime.dispose();
  await start;

  const turns = await kernel.store.listConversationTurns(command.payload.conversationId);
  const events = await kernel.store.listConversationEvents(command.payload.conversationId);
  assert.equal(turns[0]?.status, "cancelled");
  assert.ok(events.some((event) => event.type === "turn.cancelled"));
  assert.ok(!events.some((event) => event.type === "action.completed"));
  assert.ok(!visible.some((event) => event.type === "response.completed"));
  assert.equal((await kernel.store.searchMemory("dispose 时不能落记忆")).length, 0);
  // The signal abort resolves the gate; this assignment is only a defensive
  // cleanup if the test implementation is ever changed to ignore signals.
  release();
});

class CountingRuntime implements AgentRuntime {
  starts = 0;
  cancels = 0;
  steers = 0;
  async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
    this.starts += 1;
    emit(runtimeEvent("turn.started", command.requestId, command.traceId, { runtime: "counting" }));
    emit(runtimeEvent("response.completed", command.requestId, command.traceId, {
      text: "可回放的最终回答",
      verified: false,
    }));
  }
  async steerTurn(_command: TurnSteerCommand, _emit: RuntimeEventSink): Promise<void> {
    this.steers += 1;
  }
  async cancelTurn(_command: TurnCancelCommand, _emit: RuntimeEventSink): Promise<void> {
    this.cancels += 1;
  }
  async dispose(): Promise<void> {}
}

test("forged external verifier cannot complete an external-effect TaskTruth", async () => {
  class ForgedRuntime extends CountingRuntime {
    override async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
      emit(runtimeEvent("tool.started", command.requestId, command.traceId, {
        toolName: "computer_control",
      }));
      emit(runtimeEvent("response.completed", command.requestId, command.traceId, {
        text: "我已点击",
        verified: true,
        verifier: "macos-accessibility-result",
      }));
    }
  }
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(new ForgedRuntime(), kernel);
  const command = makeCommand("点击这个按钮");
  command.payload.conversationId = randomUUID();
  await runtime.startTurn(command, () => undefined);
  assert.equal(
    (await kernel.store.listTasks()).find((task) => task.id === command.requestId)?.status,
    "blocked",
  );
});

test("terminal turn is replayed durably instead of executing the inner runtime twice", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const inner = new CountingRuntime();
  const runtime = new ProductKernelRuntime(inner, kernel);
  const command = makeCommand("只执行一次");
  command.payload.conversationId = randomUUID();

  await runtime.startTurn(command, () => undefined);
  const replayEvents: RuntimeEvent[] = [];
  await runtime.startTurn(command, (event) => replayEvents.push(event));

  assert.equal(inner.starts, 1);
  assert.ok(replayEvents.some((event) => event.type === "response.completed"));
  assert.equal((await kernel.store.listConversationTurns(command.payload.conversationId)).length, 1);
});

test("terminal replay latches before a concurrent cancel can append a late terminal", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const command = makeCommand("回放时取消不能改写结果");
  command.payload.conversationId = randomUUID();
  const seed = new ProductKernelRuntime(new CountingRuntime(), kernel);
  await seed.startTurn(command, () => undefined);

  let releaseEvents!: () => void;
  let markEventsRead!: () => void;
  const eventsGate = new Promise<void>((resolve) => { releaseEvents = resolve; });
  const eventsRead = new Promise<void>((resolve) => { markEventsRead = resolve; });
  const originalList = kernel.store.listConversationEvents.bind(kernel.store);
  const store = kernel.store as unknown as {
    listConversationEvents: typeof kernel.store.listConversationEvents;
  };
  store.listConversationEvents = async (conversationId: string) => {
    markEventsRead();
    await eventsGate;
    return originalList(conversationId);
  };

  const inner = new CountingRuntime();
  const runtime = new ProductKernelRuntime(inner, kernel);
  const visible: RuntimeEvent[] = [];
  const replay = runtime.startTurn(command, (event) => visible.push(event));
  await eventsRead;
  const cancel = runtime.cancelTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.cancel",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: { reason: "late_cancel" },
  }, () => undefined);

  releaseEvents();
  store.listConversationEvents = originalList;
  await Promise.all([replay, cancel]);

  const ledgerEvents = await originalList(command.payload.conversationId);
  assert.equal(inner.starts, 0);
  assert.equal(inner.cancels, 0);
  assert.equal(ledgerEvents.filter((event) => event.type === "turn.cancelled").length, 0);
  assert.equal(
    visible.filter((event) => ["response.completed", "turn.cancelled", "turn.failed"].includes(event.type)).length,
    1,
  );
  assert.equal(visible.find((event) => event.type === "response.completed")?.payload.replayed, true);
});

test("terminal replay latches before a concurrent steer can append input or call inner", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const command = makeCommand("回放时转向不能改写结果");
  command.payload.conversationId = randomUUID();
  const seed = new ProductKernelRuntime(new CountingRuntime(), kernel);
  await seed.startTurn(command, () => undefined);

  let releaseEvents!: () => void;
  let markEventsRead!: () => void;
  const eventsGate = new Promise<void>((resolve) => { releaseEvents = resolve; });
  const eventsRead = new Promise<void>((resolve) => { markEventsRead = resolve; });
  const originalList = kernel.store.listConversationEvents.bind(kernel.store);
  const store = kernel.store as unknown as {
    listConversationEvents: typeof kernel.store.listConversationEvents;
  };
  store.listConversationEvents = async (conversationId: string) => {
    markEventsRead();
    await eventsGate;
    return originalList(conversationId);
  };

  const inner = new CountingRuntime();
  const runtime = new ProductKernelRuntime(inner, kernel);
  const visible: RuntimeEvent[] = [];
  const replay = runtime.startTurn(command, (event) => visible.push(event));
  await eventsRead;
  const steer = runtime.steerTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.steer",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: {
      message: "late steer",
      nextGeneration: 2,
      interactionClass: "conversation",
    },
  }, () => undefined);

  releaseEvents();
  store.listConversationEvents = originalList;
  await Promise.all([replay, steer]);

  const ledgerEvents = await originalList(command.payload.conversationId);
  assert.equal(inner.starts, 0);
  assert.equal(inner.steers, 0);
  assert.equal(
    ledgerEvents.some((event) => event.type === "turn.user_input" && event.payload.channel === "steer"),
    false,
  );
  assert.equal(
    visible.filter((event) => ["response.completed", "turn.cancelled", "turn.failed"].includes(event.type)).length,
    1,
  );
  assert.equal(visible.find((event) => event.type === "response.completed")?.payload.replayed, true);
});

test("open turn recovery fails closed and never re-enters the inner runtime", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const conversationId = randomUUID();
  const command = makeCommand("恢复这个遗留 turn");
  command.payload.conversationId = conversationId;
  await kernel.store.upsertConversation({ id: conversationId, status: "active" });
  await kernel.store.upsertConversationTurn({
    id: command.requestId,
    conversationId,
    status: "open",
    traceId: command.traceId,
    userInput: command.payload.utterance,
  });
  const inner = new CountingRuntime();
  const runtime = new ProductKernelRuntime(inner, kernel);
  const events: RuntimeEvent[] = [];

  await runtime.startTurn(command, (event) => events.push(event));

  assert.equal(inner.starts, 0);
  assert.equal((await kernel.store.listConversationTurns(conversationId))[0]?.status, "failed");
  assert.equal(events.find((event) => event.type === "turn.failed")?.payload.code, "recovery_required");
});

test("a failed initial ledger write blocks the inner runtime and emits no private error", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const inner = new CountingRuntime();
  (kernel.store as unknown as {
    upsertConversation: (input: unknown) => Promise<unknown>;
  }).upsertConversation = async () => {
    throw new Error("provider password=private-secret");
  };
  const runtime = new ProductKernelRuntime(inner, kernel);
  const command = makeCommand("账本写入失败时不能执行");
  command.payload.conversationId = randomUUID();
  const events: RuntimeEvent[] = [];

  await runtime.startTurn(command, (event) => events.push(event));

  assert.equal(inner.starts, 0);
  assert.equal(events.find((event) => event.type === "turn.failed")?.payload.code, "conversation_ledger_unavailable");
  assert.doesNotMatch(JSON.stringify(events), /private-secret|password/);
});

test("TaskTruth flush failure downgrades a pending completion before it is spoken", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  (kernel.taskTruth as unknown as { flush: () => Promise<void> }).flush = async () => {
    throw new Error("private task persistence failure");
  };
  const runtime = new ProductKernelRuntime(new CountingRuntime(), kernel);
  const command = makeCommand("任务状态写不进去");
  command.payload.conversationId = randomUUID();
  const visible: RuntimeEvent[] = [];

  await runtime.startTurn(command, (event) => visible.push(event));

  assert.ok(!visible.some((event) => event.type === "response.completed"));
  assert.equal(visible.find((event) => event.type === "turn.failed")?.payload.code, "task_truth_unavailable");
  assert.equal((await kernel.store.listConversationTurns(command.payload.conversationId))[0]?.status, "failed");
});

test("event projection is idempotent, ordered, and excludes tool parameters", async () => {
  class DuplicateEventRuntime implements AgentRuntime {
    async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
      const started = runtimeEvent("tool.started", command.requestId, command.traceId, {
        toolName: "password=SECRET",
        secretArgument: "do-not-store",
      });
      emit(started);
      emit(started);
      emit(runtimeEvent("runtime.status", command.requestId, command.traceId, {
        status: "token=SECRET",
      }));
      emit(runtimeEvent("response.delta", command.requestId, command.traceId, {
        text: "stream only",
      }));
      emit(runtimeEvent("response.completed", command.requestId, command.traceId, {
        text: "最后结果",
        verified: true,
      }));
    }
    async steerTurn(_command: TurnSteerCommand, _emit: RuntimeEventSink): Promise<void> {}
    async cancelTurn(_command: TurnCancelCommand, _emit: RuntimeEventSink): Promise<void> {}
    async dispose(): Promise<void> {}
  }

  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(new DuplicateEventRuntime(), kernel);
  const command = makeCommand("投影安全事件");
  command.payload.conversationId = randomUUID();
  const visible: RuntimeEvent[] = [];
  await runtime.startTurn(command, (event) => visible.push(event));

  const ledgerEvents = await kernel.store.listConversationEvents(command.payload.conversationId);
  assert.equal(ledgerEvents.filter((event) => event.type === "tool.started").length, 1);
  assert.ok(!ledgerEvents.some((event) => event.type === "response.delta"));
  assert.doesNotMatch(JSON.stringify(ledgerEvents), /do-not-store|secretArgument|SECRET/);
  assert.equal(
    ledgerEvents.find((event) => event.type === "tool.started")?.payload.toolName,
    "redacted",
  );
  assert.doesNotMatch(JSON.stringify(visible), /do-not-store|SECRET|secretArgument/);
  const visibleTool = visible.find((event) => event.type === "tool.started");
  assert.equal(visibleTool?.payload.toolName, "redacted");
  const visibleStatus = visible.find((event) => event.type === "runtime.status");
  assert.equal(visibleStatus?.payload.status, "unknown");
  assert.deepEqual(
    ledgerEvents.map((event) => event.sequence),
    [...ledgerEvents].map((event) => event.sequence).sort((a, b) => a - b),
  );
});

test("steer is recorded as a user-visible event on the same turn", async () => {
  class WaitingRuntime implements AgentRuntime {
    private release!: () => void;
    private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });
    async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
      emit(runtimeEvent("turn.started", command.requestId, command.traceId, {
        runtime: "waiting",
        generation: 1,
      }));
      await this.gate;
      emit(runtimeEvent("response.delta", command.requestId, command.traceId, {
        text: "收到转向",
        generation: 2,
      }));
      emit(runtimeEvent("response.completed", command.requestId, command.traceId, {
        text: "收到转向",
        verified: false,
        generation: 2,
      }));
    }
    async interruptTurn(command: TurnInterruptCommand, emit: RuntimeEventSink): Promise<void> {
      emit(runtimeEvent("turn.interrupt.accepted", command.requestId, command.traceId, {
        interruptedGeneration: 1,
        nextGeneration: 2,
      }));
    }
    async steerTurn(command: TurnSteerCommand, emit: RuntimeEventSink): Promise<void> {
      emit(runtimeEvent("runtime.status", command.requestId, command.traceId, {
        status: "steering_received",
        generation: 2,
      }));
      this.release();
    }
    async cancelTurn(_command: TurnCancelCommand, _emit: RuntimeEventSink): Promise<void> {}
    async dispose(): Promise<void> { this.release(); }
  }

  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(new WaitingRuntime(), kernel);
  const command = makeCommand("先解释第一步是什么");
  command.payload.conversationId = randomUUID();
  const start = runtime.startTurn(command, () => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const interruptEvents: RuntimeEvent[] = [];
  await runtime.interruptTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.interrupt",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: { expectedGeneration: 1, reason: "user_barge_in" },
  }, (event) => interruptEvents.push(event));
  assert.equal(interruptEvents[0]?.type, "turn.interrupt.accepted");
  await runtime.steerTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.steer",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: {
      message: "改成解释第二步",
      nextGeneration: 2,
      interactionClass: "conversation",
    },
  }, () => undefined);
  await start;

  const ledgerEvents = await kernel.store.listConversationEvents(command.payload.conversationId);
  assert.ok(ledgerEvents.some((event) => event.type === "turn.user_input" && event.payload.channel === "steer"));
  assert.equal(
    (await kernel.store.getConversationTurn(command.requestId))?.userInput,
    "改成解释第二步",
  );
});

class FencedBargeInRuntime implements AgentRuntime {
  readonly ready: Promise<void>;
  private markReady!: () => void;
  private readonly finished: Promise<void>;
  protected finish!: () => void;
  protected turnEmit?: RuntimeEventSink;
  private command?: TurnStartCommand;
  generation = 1;
  effectDispatches = 0;
  steers = 0;

  constructor(private readonly completeOnGeneration: number = 2) {
    this.ready = new Promise<void>((resolve) => { this.markReady = resolve; });
    this.finished = new Promise<void>((resolve) => { this.finish = resolve; });
  }

  async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
    this.command = command;
    this.turnEmit = emit;
    emit(runtimeEvent("turn.started", command.requestId, command.traceId, {
      runtime: "fenced-barge-in",
      generation: 1,
    }));
    this.markReady();
    await this.finished;
  }

  async interruptTurn(command: TurnInterruptCommand, emit: RuntimeEventSink): Promise<void> {
    if (this.effectDispatches > 0) {
      emit(runtimeEvent("turn.interrupt.rejected", command.requestId, command.traceId, {
        generation: this.generation,
        code: "effect_already_dispatched",
      }));
      return;
    }
    if (command.payload.expectedGeneration !== this.generation) {
      emit(runtimeEvent("turn.interrupt.rejected", command.requestId, command.traceId, {
        generation: this.generation,
        code: "generation_mismatch",
      }));
      return;
    }
    const interruptedGeneration = this.generation;
    this.generation += 1;
    emit(runtimeEvent("turn.interrupt.accepted", command.requestId, command.traceId, {
      interruptedGeneration,
      nextGeneration: this.generation,
    }));
  }

  emitOldGenerationAfterFloor(): void {
    if (!this.command || !this.turnEmit) throw new Error("turn not ready");
    this.turnEmit(runtimeEvent("response.delta", this.command.requestId, this.command.traceId, {
      text: "OLD_DELTA",
      generation: 1,
    }));
    this.turnEmit(runtimeEvent("tool.started", this.command.requestId, this.command.traceId, {
      toolName: "delegate_task",
      generation: 1,
    }));
    this.turnEmit(runtimeEvent("computer.action.requested", this.command.requestId, this.command.traceId, {
      actionId: randomUUID(),
      action: "left_click",
      x: 10,
      y: 10,
      generation: 1,
    }));
    this.turnEmit(runtimeEvent("response.completed", this.command.requestId, this.command.traceId, {
      text: "OLD_FINAL",
      verified: false,
      generation: 1,
    }));
  }

  tryDispatchEffect(): void {
    // Mirrors the Pi pre-dispatch floor: replacement conversational
    // generations never inherit desktop-effect authority.
    if (this.generation !== 1 || !this.command || !this.turnEmit) return;
    this.effectDispatches += 1;
    this.turnEmit(runtimeEvent("tool.started", this.command.requestId, this.command.traceId, {
      toolName: "computer_control",
      generation: 1,
    }));
  }

  async steerTurn(command: TurnSteerCommand, emit: RuntimeEventSink): Promise<void> {
    this.steers += 1;
    emit(runtimeEvent("runtime.status", command.requestId, command.traceId, {
      status: "steering_received",
      generation: command.payload.nextGeneration,
    }));
    this.turnEmit?.(runtimeEvent("response.delta", command.requestId, command.traceId, {
      text: `NEW_${command.payload.nextGeneration}`,
      generation: command.payload.nextGeneration,
    }));
    if (command.payload.nextGeneration === this.completeOnGeneration) {
      this.turnEmit?.(runtimeEvent("response.completed", command.requestId, command.traceId, {
        text: `NEW_FINAL_${command.payload.nextGeneration}`,
        verified: false,
        generation: command.payload.nextGeneration,
      }));
      this.finish();
    }
  }

  async cancelTurn(): Promise<void> { this.finish(); }
  async dispose(): Promise<void> { this.finish(); }
}

function interruptCommand(command: TurnStartCommand, generation: number): TurnInterruptCommand {
  return {
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.interrupt",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: { expectedGeneration: generation, reason: "user_barge_in" },
  };
}

function steerCommand(command: TurnStartCommand, generation: number, message: string): TurnSteerCommand {
  return {
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.steer",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: { message, nextGeneration: generation, interactionClass: "conversation" },
  };
}

test("accepted barge-in drops every old generation output and admits one durable steer", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const inner = new FencedBargeInRuntime();
  const runtime = new ProductKernelRuntime(inner, kernel);
  const command = makeCommand("先解释旧问题");
  command.payload.conversationId = randomUUID();
  const visible: RuntimeEvent[] = [];
  const start = runtime.startTurn(command, (event) => visible.push(event));
  await inner.ready;

  const acknowledgements: RuntimeEvent[] = [];
  await runtime.interruptTurn(interruptCommand(command, 1), (event) => acknowledgements.push(event));
  inner.emitOldGenerationAfterFloor();
  await Promise.all([
    runtime.steerTurn(steerCommand(command, 2, "解释新问题"), () => undefined),
    runtime.steerTurn(steerCommand(command, 2, "重复新问题"), (event) => acknowledgements.push(event)),
  ]);
  await start;

  assert.equal(acknowledgements[0]?.type, "turn.interrupt.accepted");
  assert.ok(acknowledgements.some((event) =>
    event.type === "turn.interrupt.rejected" && event.payload.code === "duplicate_steer"));
  assert.equal(inner.steers, 1);
  assert.equal(inner.effectDispatches, 0);
  assert.doesNotMatch(JSON.stringify(visible), /OLD_DELTA|OLD_FINAL|computer\.action\.requested|delegate_task/);
  assert.equal(visible.find((event) => event.type === "response.completed")?.payload.text, "NEW_FINAL_2");
  const ledgerEvents = await kernel.store.listConversationEvents(command.payload.conversationId);
  assert.equal(ledgerEvents.filter((event) =>
    event.type === "turn.user_input" && event.payload.channel === "steer").length, 1);
  assert.equal((await kernel.store.getConversationTurn(command.requestId))?.userInput, "解释新问题");
});

test("replacement failure before assistant start keeps its safe code and current generation", async () => {
  class ReplacementFailureRuntime extends FencedBargeInRuntime {
    override async steerTurn(command: TurnSteerCommand): Promise<void> {
      // Pi owns this terminal on the original startTurn sink. It deliberately
      // contains hostile provider text to prove Product only forwards the
      // controlled code and current generation.
      this.turnEmit?.(runtimeEvent("turn.failed", command.requestId, command.traceId, {
        code: "steer_replacement_failed_before_start",
        message: "provider transcript SECRET must not cross",
        generation: command.payload.nextGeneration,
      }));
      this.finish();
    }
  }

  const kernel = createYishuKernel({ storeBackend: "memory" });
  const inner = new ReplacementFailureRuntime();
  const runtime = new ProductKernelRuntime(inner, kernel);
  const command = makeCommand("问题 A");
  command.payload.conversationId = randomUUID();
  const visible: RuntimeEvent[] = [];
  const start = runtime.startTurn(command, (event) => visible.push(event));
  await inner.ready;
  await runtime.interruptTurn(interruptCommand(command, 1), () => undefined);
  await runtime.steerTurn(steerCommand(command, 2, "问题 B"), () => undefined);
  await start;

  const failure = visible.find((event) => event.type === "turn.failed");
  assert.deepEqual(failure?.payload, {
    code: "steer_replacement_failed_before_start",
    generation: 2,
  });
  assert.doesNotMatch(JSON.stringify(visible), /SECRET|provider transcript/);
  assert.equal((await kernel.store.getConversationTurn(command.requestId))?.status, "failed");
  const ledgerEvents = await kernel.store.listConversationEvents(command.payload.conversationId);
  assert.equal(ledgerEvents.filter((event) => event.type === "turn.failed").length, 1);
  assert.equal(
    ledgerEvents.find((event) => event.type === "turn.failed")?.payload.code,
    "steer_replacement_failed_before_start",
  );
  assert.equal(inner.steers, 0, "Product must not retry the failed replacement");
});

test("effect dispatch and interrupt race has exactly one safe winner", async () => {
  const actionFirstKernel = createYishuKernel({ storeBackend: "memory" });
  const actionFirstInner = new FencedBargeInRuntime();
  const actionFirst = new ProductKernelRuntime(actionFirstInner, actionFirstKernel);
  const actionCommand = makeCommand("解释一下，然后也许继续");
  const actionStart = actionFirst.startTurn(actionCommand, () => undefined);
  await actionFirstInner.ready;
  actionFirstInner.tryDispatchEffect();
  const rejected: RuntimeEvent[] = [];
  await actionFirst.interruptTurn(interruptCommand(actionCommand, 1), (event) => rejected.push(event));
  assert.equal(actionFirstInner.effectDispatches, 1);
  assert.equal(rejected[0]?.payload.code, "effect_started");
  await actionFirst.cancelTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.cancel",
    requestId: actionCommand.requestId,
    traceId: actionCommand.traceId,
    sentAt: new Date().toISOString(),
    payload: { reason: "test_cleanup" },
  }, () => undefined);
  await actionStart;

  const interruptFirstKernel = createYishuKernel({ storeBackend: "memory" });
  const interruptFirstInner = new FencedBargeInRuntime();
  const interruptFirst = new ProductKernelRuntime(interruptFirstInner, interruptFirstKernel);
  const interruptCommandInput = makeCommand("继续解释另一个问题");
  const interruptStart = interruptFirst.startTurn(interruptCommandInput, () => undefined);
  await interruptFirstInner.ready;
  const accepted: RuntimeEvent[] = [];
  await interruptFirst.interruptTurn(interruptCommand(interruptCommandInput, 1), (event) => accepted.push(event));
  interruptFirstInner.tryDispatchEffect();
  assert.equal(accepted[0]?.type, "turn.interrupt.accepted");
  assert.equal(interruptFirstInner.effectDispatches, 0);
  await interruptFirst.steerTurn(steerCommand(interruptCommandInput, 2, "安全的新问题"), () => undefined);
  await interruptStart;
});

test("one Product turn supports consecutive generation 1 to 2 to 3 barge-ins", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const inner = new FencedBargeInRuntime(3);
  const runtime = new ProductKernelRuntime(inner, kernel);
  const command = makeCommand("问题一");
  command.payload.conversationId = randomUUID();
  const visible: RuntimeEvent[] = [];
  const start = runtime.startTurn(command, (event) => visible.push(event));
  await inner.ready;
  const acks: RuntimeEvent[] = [];
  await runtime.interruptTurn(interruptCommand(command, 1), (event) => acks.push(event));
  await runtime.steerTurn(steerCommand(command, 2, "问题二"), () => undefined);
  await runtime.interruptTurn(interruptCommand(command, 2), (event) => acks.push(event));
  await runtime.steerTurn(steerCommand(command, 3, "问题三"), () => undefined);
  await start;

  assert.deepEqual(acks.map((event) => event.payload.nextGeneration), [2, 3]);
  assert.equal(inner.steers, 2);
  assert.equal(visible.find((event) => event.type === "response.completed")?.payload.generation, 3);
  assert.equal((await kernel.store.getConversationTurn(command.requestId))?.userInput, "问题三");

  const capturing = new CapturingRuntime();
  const restarted = new ProductKernelRuntime(capturing, kernel);
  const followup = makeCommand("问题四");
  followup.payload.conversationId = command.payload.conversationId;
  await restarted.startTurn(followup, () => undefined);
  const attached = capturing.lastCommand as ContinuityAttachedCommand;
  assert.deepEqual(attached.payload.__yishuConversationHistory?.map((turn) => turn.userInput), [
    "问题三",
  ]);
});

class SupersedeAwaitingSteerRuntime implements AgentRuntime {
  readonly starts: string[] = [];
  maxConcurrentStarts = 0;
  private concurrentStarts = 0;
  private firstRequestId?: string;
  private releaseFirst!: () => void;
  private readonly firstGate = new Promise<void>((resolve) => { this.releaseFirst = resolve; });
  private markFirstReady!: () => void;
  readonly firstReady = new Promise<void>((resolve) => { this.markFirstReady = resolve; });
  private markFirstFinished!: () => void;
  private readonly firstFinished = new Promise<void>((resolve) => { this.markFirstFinished = resolve; });

  async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
    this.starts.push(command.requestId);
    this.concurrentStarts += 1;
    this.maxConcurrentStarts = Math.max(this.maxConcurrentStarts, this.concurrentStarts);
    emit(runtimeEvent("turn.started", command.requestId, command.traceId, {
      runtime: "supersede-awaiting-steer",
      generation: 1,
    }));
    try {
      if (this.firstRequestId === undefined) {
        this.firstRequestId = command.requestId;
        this.markFirstReady();
        await this.firstGate;
        return;
      }
      emit(runtimeEvent("response.completed", command.requestId, command.traceId, {
        text: "replacement only",
        verified: false,
        generation: 1,
      }));
    } finally {
      this.concurrentStarts -= 1;
      if (command.requestId === this.firstRequestId) this.markFirstFinished();
    }
  }

  async interruptTurn(command: TurnInterruptCommand, emit: RuntimeEventSink): Promise<void> {
    emit(runtimeEvent("turn.interrupt.accepted", command.requestId, command.traceId, {
      interruptedGeneration: 1,
      nextGeneration: 2,
    }));
  }

  async steerTurn(): Promise<void> {}

  async cancelTurn(command: TurnCancelCommand): Promise<void> {
    if (command.requestId !== this.firstRequestId) return;
    this.releaseFirst();
    await this.firstFinished;
  }

  async dispose(): Promise<void> { this.releaseFirst(); }
}

test("supersede closes an accepted turn that is still awaiting steer", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const inner = new SupersedeAwaitingSteerRuntime();
  const runtime = new ProductKernelRuntime(inner, kernel);
  const conversationId = randomUUID();
  const first = makeCommand("问题 A");
  first.payload.conversationId = conversationId;
  const replacement = makeCommand("问题 B");
  replacement.payload.conversationId = conversationId;
  const firstVisible: RuntimeEvent[] = [];
  const replacementVisible: RuntimeEvent[] = [];

  const firstRun = runtime.startTurn(first, (event) => firstVisible.push(event));
  await inner.firstReady;
  const interruptEvents: RuntimeEvent[] = [];
  await runtime.interruptTurn(interruptCommand(first, 1), (event) => interruptEvents.push(event));
  assert.equal(interruptEvents[0]?.type, "turn.interrupt.accepted");

  const replacementRun = runtime.startTurn(replacement, (event) => replacementVisible.push(event));
  await Promise.all([firstRun, replacementRun]);

  assert.equal((await kernel.store.getConversationTurn(first.requestId))?.status, "cancelled");
  assert.equal((await kernel.store.getConversationTurn(replacement.requestId))?.status, "completed");
  assert.equal(firstVisible.filter((event) => event.type === "turn.cancelled").length, 1);
  assert.equal(replacementVisible.filter((event) => event.type === "response.completed").length, 1);
  assert.deepEqual(inner.starts, [first.requestId, replacement.requestId]);
  assert.equal(inner.maxConcurrentStarts, 1);

  // Replaying A proves its active gate was removed and cannot start inner a
  // second time after the supersede terminal became durable.
  await runtime.startTurn(first, () => undefined);
  assert.deepEqual(inner.starts, [first.requestId, replacement.requestId]);
});

test("watchdog cancellation closes an accepted turn that never receives steer", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const inner = new SupersedeAwaitingSteerRuntime();
  const runtime = new ProductKernelRuntime(inner, kernel);
  const command = makeCommand("等待语音转录");
  const visible: RuntimeEvent[] = [];
  const start = runtime.startTurn(command, (event) => visible.push(event));
  await inner.firstReady;
  await runtime.interruptTurn(interruptCommand(command, 1), () => undefined);

  await resolvesWithin(runtime.cancelTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.cancel",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: { reason: "interrupt_steer_timeout" },
  }, () => undefined), 500, "watchdog cancellation while awaiting steer");
  await start;

  assert.equal((await kernel.store.getConversationTurn(command.requestId))?.status, "cancelled");
  assert.equal(visible.filter((event) => event.type === "turn.cancelled").length, 1);
  assert.equal(visible.some((event) => event.type === "response.completed"), false);
});

test("legacy turns fall back to request id as conversation id and enrich events", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const command = makeCommand("旧客户端请求");
  const events: RuntimeEvent[] = [];
  await runtime.startTurn(command, (event) => events.push(event));

  const turns = await kernel.store.listConversationTurns(command.requestId);
  assert.equal(turns[0]?.id, command.requestId);
  assert.ok(events.every((event) => event.conversationId === command.requestId));
});

test("SQLite ledger survives runtime restart, preserves turn order, and replays old turns", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yishu-runtime-ledger-"));
  const sqlitePath = path.join(root, "ledger.sqlite");
  const conversationId = randomUUID();
  const projectScope = {
    kind: "project" as const,
    projectId: "44444444-4444-4444-8444-444444444444",
    projectLabel: "SQLite 项目",
  };
  const command1 = makeCommand("第一轮持久对话");
  command1.payload.conversationId = conversationId;
  command1.payload.sessionScope = projectScope;
  const command2 = makeCommand("第二轮持久对话");
  command2.payload.conversationId = conversationId;
  command2.payload.sessionScope = projectScope;

  try {
    const kernel1 = createYishuKernel({ storeBackend: "sqlite", sqlitePath });
    const runtime1 = new ProductKernelRuntime(new CountingRuntime(), kernel1);
    await runtime1.startTurn(command1, () => undefined);
    await runtime1.dispose();
    (kernel1.store as { close?: () => void }).close?.();

    const kernel2 = createYishuKernel({ storeBackend: "sqlite", sqlitePath });
    const runtime2 = new ProductKernelRuntime(new CountingRuntime(), kernel2);
    await runtime2.startTurn(command2, () => undefined);
    await runtime2.dispose();
    (kernel2.store as { close?: () => void }).close?.();

    const kernel3 = createYishuKernel({ storeBackend: "sqlite", sqlitePath });
    const replayInner = new CountingRuntime();
    const runtime3 = new ProductKernelRuntime(replayInner, kernel3);
    const replayEvents: RuntimeEvent[] = [];
    await runtime3.startTurn(command1, (event) => replayEvents.push(event));

    const turns = await kernel3.store.listConversationTurns(conversationId);
    assert.deepEqual(turns.map((turn) => turn.sequence), [0, 1]);
    assert.equal(turns[0]?.assistantOutput, "可回放的最终回答");
    assert.equal(turns[1]?.assistantOutput, "可回放的最终回答");
    assert.ok(turns.every((turn) => JSON.stringify(turn.sessionScope) === JSON.stringify(projectScope)));
    assert.deepEqual((await kernel3.store.getConversation(conversationId))?.sessionScope, projectScope);
    assert.equal(replayInner.starts, 0);
    assert.ok(replayEvents.some((event) => event.type === "response.completed"));
    const events = await kernel3.store.listConversationEvents(conversationId);
    assert.ok(events.some((event) => event.type === "turn.assistant_output"));
    assert.ok(!events.some((event) => event.type === "response.delta"));
    (kernel3.store as { close?: () => void }).close?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("history.list returns personal rows only, newest first, with open restore", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);

  const olderId = randomUUID();
  const newerId = randomUUID();
  const projectId = "55555555-5555-4555-8555-555555555555";
  const projectConversationId = randomUUID();

  await kernel.store.upsertConversation({
    id: olderId,
    createdAt: "2026-08-08T04:00:00.000Z",
    updatedAt: "2026-08-08T04:00:00.000Z",
    sessionScope: { kind: "personal" },
    title: "旧对话标题",
  });
  await kernel.store.upsertConversationTurn({
    id: randomUUID(),
    conversationId: olderId,
    userInput: "旧话题",
    assistantOutput: "旧回复",
    status: "completed",
    sessionScope: { kind: "personal" },
  });
  await kernel.store.upsertConversation({
    id: olderId,
    updatedAt: "2026-08-08T04:00:05.000Z",
    sessionScope: { kind: "personal" },
  });

  await kernel.store.upsertConversation({
    id: newerId,
    createdAt: "2026-08-08T05:00:00.000Z",
    updatedAt: "2026-08-08T05:10:00.000Z",
    sessionScope: { kind: "personal" },
  });
  await kernel.store.upsertConversationTurn({
    id: randomUUID(),
    conversationId: newerId,
    userInput: "新话题",
    assistantOutput: "新回复",
    status: "completed",
    sessionScope: { kind: "personal" },
  });

  await kernel.store.upsertConversation({
    id: projectConversationId,
    createdAt: "2026-08-08T06:00:00.000Z",
    updatedAt: "2026-08-08T06:00:00.000Z",
    sessionScope: { kind: "project", projectId, projectLabel: "项目A" },
    title: "项目对话",
  });

  const listRequestId = randomUUID();
  const listEvents: RuntimeEvent[] = [];
  await runtime.listHistory({
    schemaVersion: PROTOCOL_VERSION,
    type: "history.list",
    requestId: listRequestId,
    traceId: randomUUID(),
    sentAt: new Date().toISOString(),
    payload: { sessionScope: { kind: "personal" }, limit: 30 },
  }, (event) => listEvents.push(event));

  const listed = listEvents.find((event) => event.type === "history.listed");
  assert.ok(listed);
  const items = (listed?.payload as { items?: Array<{ id: string; title: string; summary: string }> })?.items ?? [];
  assert.deepEqual(items.map((item) => item.id), [newerId, olderId]);
  assert.equal(items.some((item) => item.id === projectConversationId), false);
  assert.ok((items[0]?.title.length ?? 0) > 0);
  assert.ok((items[0]?.summary.length ?? 0) > 0);

  const openRequestId = randomUUID();
  const openEvents: RuntimeEvent[] = [];
  await runtime.openHistory({
    schemaVersion: PROTOCOL_VERSION,
    type: "history.open",
    requestId: openRequestId,
    traceId: randomUUID(),
    sentAt: new Date().toISOString(),
    payload: { conversationId: olderId, sessionScope: { kind: "personal" } },
  }, (event) => openEvents.push(event));

  const opened = openEvents.find((event) => event.type === "history.opened");
  assert.ok(opened);
  assert.equal(opened?.conversationId, olderId);
  const turns = (opened?.payload as {
    turns?: Array<{ userInput?: string; assistantOutput?: string }>;
  })?.turns ?? [];
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.userInput, "旧话题");
  assert.equal(turns[0]?.assistantOutput, "旧回复");

  const mismatchEvents: RuntimeEvent[] = [];
  await runtime.openHistory({
    schemaVersion: PROTOCOL_VERSION,
    type: "history.open",
    requestId: randomUUID(),
    traceId: randomUUID(),
    sentAt: new Date().toISOString(),
    payload: {
      conversationId: projectConversationId,
      sessionScope: { kind: "personal" },
    },
  }, (event) => mismatchEvents.push(event));
  assert.ok(mismatchEvents.some((event) => event.type === "history.failed"));
  const failed = mismatchEvents.find((event) => event.type === "history.failed");
  assert.equal((failed?.payload as { code?: string })?.code, "scope_mismatch");
});

test("history.delete archives personal row, hides from list, and rejects open", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const keepId = randomUUID();
  const deleteId = randomUUID();

  await kernel.store.upsertConversation({
    id: keepId,
    sessionScope: { kind: "personal" },
    title: "保留对话",
  });
  await kernel.store.upsertConversationTurn({
    id: randomUUID(),
    conversationId: keepId,
    userInput: "保留",
    assistantOutput: "还在",
    status: "completed",
    sessionScope: { kind: "personal" },
  });
  await kernel.store.upsertConversation({
    id: deleteId,
    sessionScope: { kind: "personal" },
    title: "待删对话",
  });
  await kernel.store.upsertConversationTurn({
    id: randomUUID(),
    conversationId: deleteId,
    userInput: "要删",
    assistantOutput: "会归档",
    status: "completed",
    sessionScope: { kind: "personal" },
  });

  const deleteEvents: RuntimeEvent[] = [];
  await runtime.deleteHistory({
    schemaVersion: PROTOCOL_VERSION,
    type: "history.delete",
    requestId: randomUUID(),
    traceId: randomUUID(),
    sentAt: new Date().toISOString(),
    payload: { conversationId: deleteId, sessionScope: { kind: "personal" } },
  }, (event) => deleteEvents.push(event));

  const deleted = deleteEvents.find((event) => event.type === "history.deleted");
  assert.ok(deleted);
  assert.equal((deleted?.payload as { conversationId?: string })?.conversationId, deleteId);
  assert.equal((deleted?.payload as { status?: string })?.status, "archived");

  // Soft-delete: row still readable via get, status archived, body turns remain.
  const archived = await kernel.store.getConversation(deleteId);
  assert.equal(archived?.status, "archived");
  const turns = await kernel.store.listConversationTurns(deleteId);
  assert.equal(turns.length, 1);

  const listEvents: RuntimeEvent[] = [];
  await runtime.listHistory({
    schemaVersion: PROTOCOL_VERSION,
    type: "history.list",
    requestId: randomUUID(),
    traceId: randomUUID(),
    sentAt: new Date().toISOString(),
    payload: { sessionScope: { kind: "personal" }, limit: 30 },
  }, (event) => listEvents.push(event));
  const listed = listEvents.find((event) => event.type === "history.listed");
  const items = (listed?.payload as { items?: Array<{ id: string }> })?.items ?? [];
  assert.deepEqual(items.map((item) => item.id), [keepId]);

  const openEvents: RuntimeEvent[] = [];
  await runtime.openHistory({
    schemaVersion: PROTOCOL_VERSION,
    type: "history.open",
    requestId: randomUUID(),
    traceId: randomUUID(),
    sentAt: new Date().toISOString(),
    payload: { conversationId: deleteId, sessionScope: { kind: "personal" } },
  }, (event) => openEvents.push(event));
  const openFailed = openEvents.find((event) => event.type === "history.failed");
  assert.equal((openFailed?.payload as { code?: string })?.code, "conversation_archived");

  // Idempotent second delete
  const again: RuntimeEvent[] = [];
  await runtime.deleteHistory({
    schemaVersion: PROTOCOL_VERSION,
    type: "history.delete",
    requestId: randomUUID(),
    traceId: randomUUID(),
    sentAt: new Date().toISOString(),
    payload: { conversationId: deleteId, sessionScope: { kind: "personal" } },
  }, (event) => again.push(event));
  assert.ok(again.some((event) => event.type === "history.deleted"));

  // Project cannot be deleted via personal path
  const projectId = "66666666-6666-4666-8666-666666666666";
  const projectConversationId = randomUUID();
  await kernel.store.upsertConversation({
    id: projectConversationId,
    sessionScope: { kind: "project", projectId, projectLabel: "项目" },
    title: "项目",
  });
  const projectEvents: RuntimeEvent[] = [];
  await runtime.deleteHistory({
    schemaVersion: PROTOCOL_VERSION,
    type: "history.delete",
    requestId: randomUUID(),
    traceId: randomUUID(),
    sentAt: new Date().toISOString(),
    payload: {
      conversationId: projectConversationId,
      sessionScope: { kind: "personal" },
    },
  }, (event) => projectEvents.push(event));
  assert.ok(projectEvents.some((event) => event.type === "history.failed"));
  const projectStill = await kernel.store.getConversation(projectConversationId);
  assert.equal(projectStill?.status, "active");
});

test("memory.list returns personal only; memory.forget hard-deletes and rejects project", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const now = new Date().toISOString();
  const personal = await kernel.store.addMemory({
    claim: "验收用个人偏好：回答先给结论",
    source: "conversation",
    capturedAt: now,
    scope: "personal",
    confidence: 0.95,
    lastConfirmedAt: now,
    supersedes: null,
    tags: [],
  });
  const projectId = "77777777-7777-4777-8777-777777777777";
  const project = await kernel.store.addMemory({
    claim: "项目记忆",
    source: "conversation",
    capturedAt: now,
    scope: `project:${projectId}`,
    confidence: 0.9,
    lastConfirmedAt: now,
    supersedes: null,
    tags: [],
  });

  const listEvents: RuntimeEvent[] = [];
  await runtime.listMemories({
    schemaVersion: PROTOCOL_VERSION,
    type: "memory.list",
    requestId: randomUUID(),
    traceId: randomUUID(),
    sentAt: new Date().toISOString(),
    payload: { sessionScope: { kind: "personal" }, limit: 50 },
  }, (event) => listEvents.push(event));
  const listed = listEvents.find((event) => event.type === "memory.listed");
  const items = (listed?.payload as { items?: Array<{ id: string; summary: string }> })?.items ?? [];
  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, personal.id);
  assert.match(items[0]?.summary ?? "", /回答先给结论/);

  const projectList: RuntimeEvent[] = [];
  await runtime.listMemories({
    schemaVersion: PROTOCOL_VERSION,
    type: "memory.list",
    requestId: randomUUID(),
    traceId: randomUUID(),
    sentAt: new Date().toISOString(),
    payload: {
      sessionScope: { kind: "project", projectId, projectLabel: "P" },
      limit: 50,
    },
  }, (event) => projectList.push(event));
  assert.ok(projectList.some((event) => event.type === "memory.failed"));

  const forgetEvents: RuntimeEvent[] = [];
  await runtime.forgetMemory({
    schemaVersion: PROTOCOL_VERSION,
    type: "memory.forget",
    requestId: randomUUID(),
    traceId: randomUUID(),
    sentAt: new Date().toISOString(),
    payload: { memoryId: personal.id, sessionScope: { kind: "personal" } },
  }, (event) => forgetEvents.push(event));
  assert.ok(forgetEvents.some((event) => event.type === "memory.forgotten"));
  assert.equal(
    (await kernel.store.searchMemory("", { scope: "personal" })).length,
    0,
  );
  assert.equal(
    kernel.store.getSnapshot().memories.some((m) => m.id === personal.id),
    false,
  );

  // Stable re-forget
  const again: RuntimeEvent[] = [];
  await runtime.forgetMemory({
    schemaVersion: PROTOCOL_VERSION,
    type: "memory.forget",
    requestId: randomUUID(),
    traceId: randomUUID(),
    sentAt: new Date().toISOString(),
    payload: { memoryId: personal.id, sessionScope: { kind: "personal" } },
  }, (event) => again.push(event));
  const againPayload = again.find((e) => e.type === "memory.forgotten")
    ?.payload as { alreadyGone?: boolean } | undefined;
  assert.equal(againPayload?.alreadyGone, true);

  // Cannot forget project via personal path
  const projectForget: RuntimeEvent[] = [];
  await runtime.forgetMemory({
    schemaVersion: PROTOCOL_VERSION,
    type: "memory.forget",
    requestId: randomUUID(),
    traceId: randomUUID(),
    sentAt: new Date().toISOString(),
    payload: { memoryId: project.id, sessionScope: { kind: "personal" } },
  }, (event) => projectForget.push(event));
  assert.ok(projectForget.some((event) => event.type === "memory.failed"));
  assert.equal(
    (await kernel.store.searchMemory("", { scope: `project:${projectId}` })).length,
    1,
  );
});

class CapturingRuntime implements AgentRuntime {
  lastCommand: TurnStartCommand | undefined;

  async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
    this.lastCommand = command;
    emit(runtimeEvent("turn.started", command.requestId, command.traceId, { runtime: "capture" }));
    emit(runtimeEvent("response.completed", command.requestId, command.traceId, {
      text: `echo:${command.payload.utterance}`,
      verified: true,
    }));
  }

  async steerTurn(): Promise<void> {}
  async cancelTurn(command: TurnCancelCommand, emit: RuntimeEventSink): Promise<void> {
    emit(runtimeEvent("turn.cancelled", command.requestId, command.traceId, {
      reason: command.payload.reason ?? "user_cancelled",
    }));
  }
  async dispose(): Promise<void> {}
}

test("ordinary personal turn recalls related memory, emits memory.used, injects prompt", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const now = "2026-08-08T12:00:00.000Z";
  const memory = await kernel.store.addMemory({
    claim: "验收回答先给结论",
    source: "conversation",
    capturedAt: now,
    scope: "personal",
    confidence: 0.95,
    lastConfirmedAt: now,
    supersedes: null,
    tags: ["style"],
  });

  const capturing = new CapturingRuntime();
  const runtime = new ProductKernelRuntime(capturing, kernel);
  const events: RuntimeEvent[] = [];
  const command = makeCommand("我希望你怎么回答？");
  command.payload.conversationId = randomUUID();
  command.payload.sessionScope = { kind: "personal" };

  await runtime.startTurn(command, (event) => events.push(event));

  const used = events.find((event) => event.type === "memory.used");
  assert.ok(used, "memory.used must fire when a related claim is applied");
  assert.equal(used?.payload.count, 1);
  assert.equal(used?.payload.memoryId1, memory.id);
  assert.match(String(used?.payload.summary1 ?? ""), /验收回答先给结论/);
  assert.equal(used?.payload.source1, "conversation");
  assert.equal(used?.payload.capturedAt1, now);
  assert.equal(used?.payload.scope1, "personal");

  const attached = capturing.lastCommand as TurnStartCommand & {
    payload: { __yishuRecalledMemories?: Array<{ id: string; claim: string }> };
  };
  assert.equal(attached.payload.__yishuRecalledMemories?.length, 1);
  assert.equal(attached.payload.__yishuRecalledMemories?.[0]?.id, memory.id);
  // User-visible utterance is unchanged (ledger / history must not swallow memory block).
  assert.equal(attached.payload.utterance, "我希望你怎么回答？");
});

test("unrelated ordinary turn does not emit memory.used", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const now = "2026-08-08T12:00:00.000Z";
  await kernel.store.addMemory({
    claim: "验收回答先给结论",
    source: "conversation",
    capturedAt: now,
    scope: "personal",
    confidence: 0.95,
    lastConfirmedAt: now,
    supersedes: null,
    tags: [],
  });
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const events: RuntimeEvent[] = [];
  const command = makeCommand("今天北京的天气怎么样？");
  command.payload.conversationId = randomUUID();
  command.payload.sessionScope = { kind: "personal" };
  await runtime.startTurn(command, (event) => events.push(event));
  assert.ok(!events.some((event) => event.type === "memory.used"));
  assert.ok(events.some((event) => event.type === "response.completed"));
});

test("private sessions never read or write long-term memory", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const now = "2026-08-08T12:00:00.000Z";
  await kernel.store.addMemory({
    claim: "验收回答先给结论",
    source: "conversation",
    capturedAt: now,
    scope: "personal",
    confidence: 0.95,
    lastConfirmedAt: now,
    supersedes: null,
    tags: [],
  });
  const capturing = new CapturingRuntime();
  const runtime = new ProductKernelRuntime(capturing, kernel);
  const events: RuntimeEvent[] = [];
  const command = makeCommand("我希望你怎么回答？");
  command.payload.conversationId = randomUUID();
  command.payload.sessionScope = { kind: "private" };
  await runtime.startTurn(command, (event) => events.push(event));
  assert.ok(!events.some((event) => event.type === "memory.used"));
  const attached = capturing.lastCommand as TurnStartCommand & {
    payload: { __yishuRecalledMemories?: unknown[] };
  };
  assert.equal(attached.payload.__yishuRecalledMemories, undefined);
});

test("project scope does not read personal memories", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const now = "2026-08-08T12:00:00.000Z";
  await kernel.store.addMemory({
    claim: "验收回答先给结论",
    source: "conversation",
    capturedAt: now,
    scope: "personal",
    confidence: 0.95,
    lastConfirmedAt: now,
    supersedes: null,
    tags: [],
  });
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const events: RuntimeEvent[] = [];
  const command = makeCommand("我希望你怎么回答？");
  command.payload.conversationId = randomUUID();
  command.payload.sessionScope = {
    kind: "project",
    projectId: "33333333-3333-4333-8333-333333333333",
    projectLabel: "隔离项目",
  };
  await runtime.startTurn(command, (event) => events.push(event));
  assert.ok(!events.some((event) => event.type === "memory.used"));
});

test("retired memory is not recalled on ordinary turns", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const now = "2026-08-08T12:00:00.000Z";
  const memory = await kernel.store.addMemory({
    claim: "验收回答先给结论",
    source: "conversation",
    capturedAt: now,
    scope: "personal",
    confidence: 0.95,
    lastConfirmedAt: now,
    supersedes: null,
    tags: [],
  });
  await kernel.store.retireMemory(memory.id);
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const events: RuntimeEvent[] = [];
  const command = makeCommand("我希望你怎么回答？");
  command.payload.conversationId = randomUUID();
  command.payload.sessionScope = { kind: "personal" };
  await runtime.startTurn(command, (event) => events.push(event));
  assert.ok(!events.some((event) => event.type === "memory.used"));
});

test("memory search failure degrades without faking memory.used", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const original = kernel.store.searchMemory.bind(kernel.store);
  kernel.store.searchMemory = async () => {
    throw new Error("simulated search failure");
  };
  try {
    const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
    const events: RuntimeEvent[] = [];
    const command = makeCommand("我希望你怎么回答？");
    command.payload.conversationId = randomUUID();
    command.payload.sessionScope = { kind: "personal" };
    await runtime.startTurn(command, (event) => events.push(event));
    assert.ok(!events.some((event) => event.type === "memory.used"));
    assert.ok(events.some((event) => event.type === "response.completed"));
  } finally {
    kernel.store.searchMemory = original;
  }
});

test("remember speech only after durable verify success", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel);
  const events: RuntimeEvent[] = [];
  const command = makeCommand("请记住：验收回答先给结论");
  command.payload.conversationId = randomUUID();
  command.payload.sessionScope = { kind: "personal" };
  await runtime.startTurn(command, (event) => events.push(event));
  const completed = events.find((event) => event.type === "response.completed");
  assert.match(String(completed?.payload.text ?? ""), /好，我记住了/);
  const hits = await kernel.store.searchMemory("验收回答先给结论", { scope: "personal" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.source, "conversation");
  assert.equal(hits[0]?.scope, "personal");
});

type MindAttachedCommand = TurnStartCommand & {
  payload: { __yishuRecalledMindLessons?: string[] };
};

type ContinuityAttachedCommand = TurnStartCommand & {
  payload: {
    __yishuConversationHistory?: Array<{
      id: string;
      userInput?: string;
      assistantOutput?: string;
    }>;
    __yishuRecentContextTrail?: Array<{
      frameId: string;
      appName: string | null;
      windowTitle: string | null;
    }>;
    __yishuRecalledBehaviorRules?: Array<{
      id: string;
      rule: string;
      scope: string;
    }>;
  };
};

test("ordinary turn attaches only same-scope completed history, recent prior trail, and Learning rules", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const conversationId = randomUUID();
  const otherConversationId = randomUUID();
  const personal = { kind: "personal" } as const;
  await kernel.store.upsertConversation({ id: conversationId, sessionScope: personal });
  await kernel.store.upsertConversationTurn({
    id: randomUUID(),
    conversationId,
    status: "completed",
    userInput: "之前可见的问题",
    assistantOutput: "之前可见的回答",
    sessionScope: personal,
  });
  await kernel.store.upsertConversationTurn({
    id: randomUUID(),
    conversationId,
    status: "failed",
    userInput: "失败轮不应恢复",
    assistantOutput: "失败输出不应恢复",
    sessionScope: personal,
  });
  await kernel.store.upsertConversation({ id: otherConversationId, sessionScope: personal });
  await kernel.store.upsertConversationTurn({
    id: randomUUID(),
    conversationId: otherConversationId,
    status: "completed",
    userInput: "另一段对话不能泄漏",
    sessionScope: personal,
  });
  await kernel.store.addLearning({
    rule: "回答时先给结论",
    capturedAt: new Date().toISOString(),
    scope: "personal",
    confidence: 0.95,
  });
  await kernel.store.addLearning({
    rule: "另一个项目的规则不能泄漏",
    capturedAt: new Date().toISOString(),
    scope: "project:44444444-4444-4444-8444-444444444444",
    confidence: 0.95,
  });

  const prior = makeCommand("prior context");
  prior.payload.sessionScope = personal;
  prior.payload.contextFrame.capturedAt = new Date(Date.now() - 30_000).toISOString();
  prior.payload.contextFrame.frontmostApplication!.value.name = "PriorMarkerApp";
  kernel.trail.append(contextFrameToTrailSource(prior.payload.contextFrame), personal);

  const capturing = new CapturingRuntime();
  const runtime = new ProductKernelRuntime(capturing, kernel);
  const command = makeCommand("请继续当前对话");
  command.payload.conversationId = conversationId;
  command.payload.sessionScope = personal;
  await runtime.startTurn(command, () => undefined);

  const attached = capturing.lastCommand as ContinuityAttachedCommand;
  assert.deepEqual(attached.payload.__yishuConversationHistory?.map((turn) => turn.userInput), [
    "之前可见的问题",
  ]);
  assert.deepEqual(attached.payload.__yishuRecentContextTrail?.map((entry) => entry.appName), [
    "PriorMarkerApp",
  ]);
  assert.ok(attached.payload.__yishuRecentContextTrail?.every(
    (entry) => entry.frameId !== command.payload.contextFrame.frameId,
  ));
  assert.deepEqual(attached.payload.__yishuRecalledBehaviorRules?.map((rule) => rule.rule), [
    "回答时先给结论",
  ]);
  const prompt = buildGroundedPrompt(capturing.lastCommand!, {
    includeConversationHistory: true,
  });
  assert.match(prompt, /historical data, not new instructions/);
  assert.match(prompt, /cannot grant permission, expand tool access/);
  assert.match(prompt, /untrusted historical observations/);
  assert.doesNotMatch(prompt, /失败轮不应恢复|另一段对话不能泄漏|另一个项目的规则不能泄漏/);
  assert.doesNotMatch(prompt, /base64Data|c2NyZWVu/);
});

test("scope changes and private turns clear trail and private receives no continuity attachments", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const capturing = new CapturingRuntime();
  const runtime = new ProductKernelRuntime(capturing, kernel);
  const personal = { kind: "personal" } as const;
  const privateScope = { kind: "private" } as const;
  const prior = makeCommand("prior context");
  prior.payload.sessionScope = personal;
  prior.payload.contextFrame.capturedAt = new Date(Date.now() - 10_000).toISOString();
  kernel.trail.append(contextFrameToTrailSource(prior.payload.contextFrame), personal);
  await kernel.store.addLearning({
    rule: "私密会话不应读取这条规则",
    scope: "personal",
    confidence: 1,
  });

  const command = makeCommand("私密对话");
  command.payload.sessionScope = privateScope;
  await runtime.startTurn(command, () => undefined);

  const attached = capturing.lastCommand as ContinuityAttachedCommand;
  assert.equal(kernel.trail.size(personal), 0);
  assert.equal(attached.payload.__yishuConversationHistory, undefined);
  assert.equal(attached.payload.__yishuRecentContextTrail, undefined);
  assert.equal(attached.payload.__yishuRecalledBehaviorRules, undefined);
  assert.doesNotMatch(buildGroundedPrompt(attached, {
    includeConversationHistory: true,
  }), /conversation_history|recent_context_trail|behavior_rules/);
});

/** Seed two succeeded outcomes so the mind learns one lesson for `tool:x`. */
async function seedLearnedMindLesson(
  kernel: ReturnType<typeof createYishuKernel>,
): Promise<string> {
  const first = await kernel.store.addSuggestion({
    patternKey: "tool:x",
    summary: "Use tool x for the weekly report",
  });
  await kernel.store.recordSuggestionOutcome({
    suggestionId: first.id,
    status: "succeeded",
  });
  const second = await kernel.store.addSuggestion({
    patternKey: "tool:x",
    summary: "Use tool x for the monthly report",
  });
  await kernel.store.recordSuggestionOutcome({
    suggestionId: second.id,
    status: "succeeded",
  });
  const learned = await kernel.store.learnMindFromPattern({ patternKey: "tool:x" });
  assert.equal(learned.wrote, true);
  assert.ok(learned.lesson);
  return learned.lesson;
}

test("ordinary turn injects a relevant learned mind lesson into the inner prompt", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const lesson = await seedLearnedMindLesson(kernel);

  const capturing = new CapturingRuntime();
  const runtime = new ProductKernelRuntime(capturing, kernel);
  const command = makeCommand("Should I use the tool in this situation?");
  command.payload.conversationId = randomUUID();
  command.payload.sessionScope = { kind: "personal" };
  await runtime.startTurn(command, () => undefined);

  const attached = capturing.lastCommand as MindAttachedCommand;
  assert.deepEqual(attached.payload.__yishuRecalledMindLessons, [lesson.replace(/^- /, "")]);
  // User-visible utterance is unchanged (ledger / history must not swallow the mind block).
  assert.equal(attached.payload.utterance, "Should I use the tool in this situation?");

  const prompt = buildGroundedPrompt(capturing.lastCommand!);
  assert.match(prompt, /<mind_lessons>/);
  assert.match(prompt, /tool-x/);
  assert.match(prompt, /worked 2 times/);
  assert.ok(prompt.indexOf("<mind_lessons>") < prompt.indexOf("<context_frame>"));
});

test("unrelated utterance gets no mind block", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  await seedLearnedMindLesson(kernel);

  const capturing = new CapturingRuntime();
  const runtime = new ProductKernelRuntime(capturing, kernel);
  const command = makeCommand("今天北京的天气怎么样？");
  command.payload.conversationId = randomUUID();
  command.payload.sessionScope = { kind: "personal" };
  await runtime.startTurn(command, () => undefined);

  const attached = capturing.lastCommand as MindAttachedCommand;
  assert.equal(attached.payload.__yishuRecalledMindLessons, undefined);
  assert.doesNotMatch(buildGroundedPrompt(capturing.lastCommand!), /mind_lessons/);
});

test("private sessions never read learned mind lessons", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  await seedLearnedMindLesson(kernel);

  const capturing = new CapturingRuntime();
  const runtime = new ProductKernelRuntime(capturing, kernel);
  const command = makeCommand("Should I use the tool in this situation?");
  command.payload.conversationId = randomUUID();
  command.payload.sessionScope = { kind: "private" };
  await runtime.startTurn(command, () => undefined);

  const attached = capturing.lastCommand as MindAttachedCommand;
  assert.equal(attached.payload.__yishuRecalledMindLessons, undefined);
  assert.doesNotMatch(buildGroundedPrompt(capturing.lastCommand!), /mind_lessons/);
});

test("prompt bytes are identical when no mind lesson is attached", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const capturing = new CapturingRuntime();
  const runtime = new ProductKernelRuntime(capturing, kernel);
  const command = makeCommand("Should I use the tool in this situation?");
  command.payload.conversationId = randomUUID();
  command.payload.sessionScope = { kind: "personal" };
  await runtime.startTurn(command, () => undefined);

  // Nothing recalled and nothing learned: the command passes through untouched.
  assert.equal(capturing.lastCommand, command);
  const prompt = buildGroundedPrompt(capturing.lastCommand!);
  assert.equal(prompt, buildGroundedPrompt(command));
  assert.doesNotMatch(prompt, /mind_lessons/);
});
