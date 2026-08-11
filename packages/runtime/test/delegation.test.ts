// Delegated execution V1 regression tests (RFC v2, ADR 0009).
// Covers the runtime contract: asynchronous accepted receipt, independent
// child session, TaskTruth as the only status truth, payload-only one-shot
// Result Inbox, and safe result re-entry into the next Main turn prompt.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createYishuKernel, type SessionScope } from "@yishu/kernel";
import {
  DelegationCoordinator,
  ResultInbox,
  isChildConversation,
  type DelegatedResult,
} from "../src/delegation.js";
import {
  PROTOCOL_VERSION,
  runtimeEvent,
  type RuntimeEvent,
  type TurnStartCommand,
} from "../src/protocol.js";
import {
  DELEGATED_RESULTS_KEY,
  buildGroundedPrompt,
  type DelegatedResultSnippet,
} from "../src/context-prompt.js";
import type { AgentRuntime, RuntimeEventSink } from "../src/runtime-port.js";
import { ProductKernelRuntime } from "../src/product-kernel-runtime.js";
import { makeTurnStartCommand } from "./fixtures.js";

const PERSONAL: SessionScope = { kind: "personal" };

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: { accepted: boolean; taskId: string };
};
type ExecutableTool = {
  name: string;
  execute: (toolCallId: string, params: { task: string }) => Promise<ToolResult>;
};

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Deterministic child executor: records commands, runs a per-call handler. */
class FakeChildHarness {
  readonly calls: TurnStartCommand[] = [];
  handlers: Array<(emit: RuntimeEventSink, command: TurnStartCommand) => Promise<void>> = [];

  executeTurn = async (command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> => {
    this.calls.push(command);
    const handler = this.handlers[this.calls.length - 1];
    if (handler) {
      await handler(emit, command);
      return;
    }
    emit(runtimeEvent("response.completed", command.requestId, command.traceId, {
      text: "调研完成：默认结果",
    }));
  };
}

function makeCoordinator(
  harness: FakeChildHarness,
  now?: () => Date,
): { coordinator: DelegationCoordinator; kernel: ReturnType<typeof createYishuKernel> } {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const coordinator = new DelegationCoordinator({
    kernel,
    executeTurn: harness.executeTurn,
    ...(now ? { now } : {}),
  });
  return { coordinator, kernel };
}

function delegateToolFor(
  coordinator: DelegationCoordinator,
  conversationId: string,
): ExecutableTool {
  const tools = coordinator.delegateToolFor(conversationId);
  assert.equal(tools.length, 1, "main conversation must receive exactly one delegate tool");
  return tools[0] as unknown as ExecutableTool;
}

test("ResultInbox is payload-only, conversation-scoped, and one-shot", () => {
  const inbox = new ResultInbox();
  const entry: DelegatedResult = {
    taskId: "task-1",
    parentId: "req-1",
    resultKind: "succeeded",
    summary: "结果摘要",
    completedAt: new Date().toISOString(),
  };
  inbox.put("conv-a", entry);

  // Delivery metadata only — no second task-status truth may sneak in.
  assert.deepEqual(Object.keys(entry).sort(), [
    "completedAt",
    "parentId",
    "resultKind",
    "summary",
    "taskId",
  ]);

  assert.equal(inbox.pendingCount("conv-a"), 1);
  assert.equal(inbox.consume("conv-b").length, 0, "results never cross conversations");
  const consumed = inbox.consume("conv-a");
  assert.equal(consumed.length, 1);
  assert.equal(consumed[0]?.resultKind, "succeeded");
  assert.equal(inbox.consume("conv-a").length, 0, "consume must be one-shot");
});

test("child conversations receive no delegate tool (recursion structurally impossible)", () => {
  const harness = new FakeChildHarness();
  const { coordinator } = makeCoordinator(harness);
  assert.equal(isChildConversation("child-abc"), true);
  assert.equal(isChildConversation("main"), false);
  assert.equal(coordinator.delegateToolFor("child-abc").length, 0);
  assert.equal(coordinator.delegateToolFor("main").length, 1);
});

test("delegate returns an accepted receipt immediately while the child runs in background", async (t) => {
  const harness = new FakeChildHarness();
  const gate = deferred();
  harness.handlers.push(async (emit) => {
    await gate.promise;
    emit(runtimeEvent("response.completed", "child", "trace", { text: "调研结论：三层记忆" }));
  });
  const { coordinator, kernel } = makeCoordinator(harness);
  t.after(async () => {
    gate.resolve();
    await coordinator.dispose();
  });

  coordinator.noteMainTurn("conv-main", "req-parent-1", PERSONAL);
  const tool = delegateToolFor(coordinator, "conv-main");
  assert.equal(tool.name, "delegate");

  const result = await tool.execute("tool-call-1", { task: "研究记忆分层方案" });

  // Accepted receipt — the child is still gated, i.e. the caller never waited.
  assert.equal(result.details.accepted, true);
  assert.ok(result.details.taskId.length > 0);
  assert.match(result.content[0]?.text ?? "", /taskId=/);
  assert.equal(harness.calls.length, 1, "child session started in background");

  // Child session identity: independent conversation, conversation profile,
  // no screenshots, and a ContextCapsule-derived prompt (never full history).
  const childCommand = harness.calls[0]!;
  assert.equal(childCommand.payload.conversationId, `child-${result.details.taskId}`);
  assert.equal(childCommand.payload.capabilityProfile, "conversation");
  assert.equal(childCommand.payload.contextFrame.screenshots.length, 0);
  assert.match(childCommand.payload.utterance, /delegated background task/);
  assert.match(childCommand.payload.utterance, /研究记忆分层方案/);

  // TaskTruth is the only status truth: running, parent-linked, right away.
  const taskId = result.details.taskId;
  await kernel.taskTruth.flush(taskId);
  const running = (await kernel.store.listTasks()).find((task) => task.id === taskId);
  assert.equal(running?.status, "running");
  assert.equal(running?.parentId, "req-parent-1");

  // Child finishes later: TaskTruth settles and the payload enters the inbox.
  gate.resolve();
  await waitFor(() => coordinator.inbox.pendingCount("conv-main") === 1, "inbox entry");
  await kernel.taskTruth.flush(taskId);
  const done = (await kernel.store.listTasks()).find((task) => task.id === taskId);
  assert.equal(done?.status, "done");

  const consumed = coordinator.consumeForTurn("conv-main");
  assert.equal(consumed.length, 1);
  assert.equal(consumed[0]?.resultKind, "succeeded");
  assert.equal(consumed[0]?.summary, "调研结论：三层记忆");
  assert.equal(consumed[0]?.parentId, "req-parent-1");
  assert.equal(coordinator.consumeForTurn("conv-main").length, 0);
});

test("child failure is delivered as failed without touching the Main turn", async (t) => {
  const harness = new FakeChildHarness();
  harness.handlers.push(async (emit) => {
    emit(runtimeEvent("turn.failed", "child", "trace", {
      code: "invalid_model_preference",
      message: "model unavailable",
    }));
  });
  const { coordinator, kernel } = makeCoordinator(harness);
  t.after(async () => {
    await coordinator.dispose();
  });

  coordinator.noteMainTurn("conv-main", "req-parent-2", PERSONAL);
  const tool = delegateToolFor(coordinator, "conv-main");
  const result = await tool.execute("tool-call-2", { task: "会失败的任务" });
  assert.equal(result.details.accepted, true);

  await waitFor(() => coordinator.inbox.pendingCount("conv-main") === 1, "failed inbox entry");
  const entry = coordinator.consumeForTurn("conv-main")[0];
  assert.equal(entry?.resultKind, "failed");
  assert.match(entry?.summary ?? "", /model unavailable/);

  await kernel.taskTruth.flush(result.details.taskId);
  const task = (await kernel.store.listTasks()).find((t2) => t2.id === result.details.taskId);
  assert.equal(task?.status, "failed");
});

test("child cancellation is delivered as cancelled, never as failure", async (t) => {
  const harness = new FakeChildHarness();
  harness.handlers.push(async (emit) => {
    emit(runtimeEvent("turn.cancelled", "child", "trace", { reason: "user_cancelled" }));
  });
  const { coordinator, kernel } = makeCoordinator(harness);
  t.after(async () => {
    await coordinator.dispose();
  });

  coordinator.noteMainTurn("conv-main", "req-parent-3", PERSONAL);
  const tool = delegateToolFor(coordinator, "conv-main");
  const result = await tool.execute("tool-call-3", { task: "会被取消的任务" });

  await waitFor(() => coordinator.inbox.pendingCount("conv-main") === 1, "cancelled inbox entry");
  const entry = coordinator.consumeForTurn("conv-main")[0];
  assert.equal(entry?.resultKind, "cancelled");

  await kernel.taskTruth.flush(result.details.taskId);
  const task = (await kernel.store.listTasks()).find((t2) => t2.id === result.details.taskId);
  assert.equal(task?.status, "cancelled");
});

test("delegate refuses private sessions and missing main turns", async (t) => {
  const harness = new FakeChildHarness();
  const { coordinator, kernel } = makeCoordinator(harness);
  t.after(async () => {
    await coordinator.dispose();
  });

  // Private scope: refused at the tool boundary, no TaskTruth, no child call.
  coordinator.noteMainTurn("conv-private", "req-private", { kind: "private" });
  const privateTool = delegateToolFor(coordinator, "conv-private");
  await assert.rejects(privateTool.execute("tc", { task: "私密任务" }), /private/);

  // No active main turn: structurally unavailable.
  const orphanTool = delegateToolFor(coordinator, "conv-unknown");
  await assert.rejects(orphanTool.execute("tc", { task: "无父任务" }), /no active main turn/);

  assert.equal(harness.calls.length, 0);
  assert.equal((await kernel.store.listTasks()).length, 0);
});

test("an expired handoff capsule fails the child instead of executing it", async (t) => {
  const harness = new FakeChildHarness();
  const base = Date.now();
  let nowCalls = 0;
  // Capsule build + registry invoke happen at `base`; the receiver-side expiry
  // validation (third now()) sees a clock far past the capsule TTL.
  const now = () => {
    nowCalls += 1;
    return new Date(nowCalls >= 3 ? base + 24 * 60 * 60_000 : base);
  };
  const { coordinator, kernel } = makeCoordinator(harness, now);
  t.after(async () => {
    await coordinator.dispose();
  });

  coordinator.noteMainTurn("conv-main", "req-parent-4", PERSONAL);
  const tool = delegateToolFor(coordinator, "conv-main");
  const result = await tool.execute("tool-call-4", { task: "过期的交接" });

  await waitFor(() => coordinator.inbox.pendingCount("conv-main") === 1, "expired inbox entry");
  const entry = coordinator.consumeForTurn("conv-main")[0];
  assert.equal(entry?.resultKind, "failed");
  assert.match(entry?.summary ?? "", /expired/);
  assert.equal(harness.calls.length, 0, "an expired capsule must never reach the harness");

  await kernel.taskTruth.flush(result.details.taskId);
  const task = (await kernel.store.listTasks()).find((t2) => t2.id === result.details.taskId);
  assert.equal(task?.status, "failed");
});

test("TaskTruth persistence failure drops the inbox entry instead of faking settlement", async (t) => {
  const harness = new FakeChildHarness();
  const { coordinator, kernel } = makeCoordinator(harness);
  t.after(async () => {
    await coordinator.dispose();
  });
  const originalRecord = kernel.taskTruth.record.bind(kernel.taskTruth);
  let poisoned = false;
  kernel.taskTruth.record = (signal) => {
    if (poisoned && signal.kind !== "start") {
      return Promise.reject(new Error("store unavailable"));
    }
    return originalRecord(signal);
  };

  coordinator.noteMainTurn("conv-main", "req-parent-5", PERSONAL);
  const tool = delegateToolFor(coordinator, "conv-main");
  poisoned = true;
  const result = await tool.execute("tool-call-5", { task: "真相不可用" });
  assert.equal(result.details.accepted, true);

  await waitFor(() => harness.calls.length === 1, "child executed");
  // Give the settle path a chance to attempt the write.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(
    coordinator.inbox.pendingCount("conv-main"),
    0,
    "no inbox entry may pretend a task settled when TaskTruth is unavailable",
  );
});

// --- Result re-entry into the Main turn prompt ----------------------------

class CapturingInnerRuntime implements AgentRuntime {
  readonly received: TurnStartCommand[] = [];

  async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
    this.received.push(command);
    emit(runtimeEvent("turn.started", command.requestId, command.traceId, {}));
    emit(runtimeEvent("response.completed", command.requestId, command.traceId, {
      text: "好的",
      verified: true,
    }));
  }

  async dispose(): Promise<void> {}
}

function makeMainCommand(conversationId: string, sessionScope?: SessionScope): TurnStartCommand {
  const command = makeTurnStartCommand();
  command.payload.conversationId = conversationId;
  command.payload.utterance = "刚才那个任务怎么样了？";
  if (sessionScope) command.payload.sessionScope = sessionScope;
  return command;
}

function snippetsFrom(command: TurnStartCommand): readonly DelegatedResultSnippet[] {
  const raw = (command.payload as Record<string, unknown>)[DELEGATED_RESULTS_KEY];
  return Array.isArray(raw) ? (raw as DelegatedResultSnippet[]) : [];
}

test("a delegated result re-enters exactly the next Main turn prompt, wrapped as untrusted", async (t) => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const inner = new CapturingInnerRuntime();
  const runtime = new ProductKernelRuntime(inner, kernel);
  t.after(async () => {
    await runtime.dispose();
  });

  const entry: DelegatedResult = {
    taskId: "task-9",
    parentId: "req-parent-9",
    resultKind: "succeeded",
    summary: "调研结论：三层记忆架构",
    completedAt: new Date().toISOString(),
  };
  runtime.delegation.inbox.put("conv-main", entry);

  await runtime.startTurn(makeMainCommand("conv-main"), () => undefined);
  assert.equal(inner.received.length, 1);
  const first = inner.received[0]!;
  const snippets = snippetsFrom(first);
  assert.equal(snippets.length, 1, "pending result must attach to the next main turn");
  assert.equal(snippets[0]?.taskId, "task-9");
  assert.equal(snippets[0]?.resultKind, "succeeded");

  const prompt = buildGroundedPrompt(first);
  assert.match(prompt, /<untrusted source="delegated_results">/);
  assert.match(prompt, /not instructions/);
  assert.match(prompt, /调研结论：三层记忆架构/);

  // One-shot: the following turn of the same conversation carries nothing.
  await runtime.startTurn(makeMainCommand("conv-main"), () => undefined);
  assert.equal(inner.received.length, 2);
  assert.equal(snippetsFrom(inner.received[1]!).length, 0);
  assert.doesNotMatch(buildGroundedPrompt(inner.received[1]!), /delegated_results/);
});

test("private turns never receive delegated results", async (t) => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const inner = new CapturingInnerRuntime();
  const runtime = new ProductKernelRuntime(inner, kernel);
  t.after(async () => {
    await runtime.dispose();
  });

  runtime.delegation.inbox.put("conv-private", {
    taskId: "task-10",
    parentId: "req-parent-10",
    resultKind: "succeeded",
    summary: "不应注入私密会话",
    completedAt: new Date().toISOString(),
  });

  await runtime.startTurn(makeMainCommand("conv-private", { kind: "private" }), () => undefined);
  assert.equal(inner.received.length, 1);
  assert.equal(snippetsFrom(inner.received[0]!).length, 0);
});
