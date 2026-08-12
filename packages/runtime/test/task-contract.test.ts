import assert from "node:assert/strict";
import test from "node:test";
import {
  createTaskExecutionContract,
  decideTaskRetry,
  evaluateTaskCompletion,
} from "../src/task-contract.js";
import { terminalTaskProgressKindFor } from "../src/task-progress.js";
import { RuntimeTaskProgressTracker } from "../src/task-progress.js";
import { runtimeEvent } from "../src/protocol.js";
import { makeTurnStartCommand } from "./fixtures.js";
import { createYishuKernel } from "@yishu/kernel";

function contract(overrides: Partial<Parameters<typeof createTaskExecutionContract>[0]> = {}) {
  return createTaskExecutionContract({
    objective: "交付任务结果",
    successMode: "read_only_delivery",
    authority: "automatic",
    risk: "low",
    maxAttempts: 1,
    ...overrides,
  });
}

test("task contract is immutable and requires an explicit fixed attempt budget", () => {
  const created = contract({ objective: "  查找三条资料  " });
  assert.equal(created.objective, "查找三条资料");
  assert.equal(created.maxAttempts, 1);
  assert.equal(Object.isFrozen(created), true);
  assert.throws(() => contract({ objective: "   " }), /objective/);
  assert.throws(() => contract({ maxAttempts: 0 }), /maxAttempts/);
  assert.throws(() => contract({ maxAttempts: 1.5 }), /maxAttempts/);
  assert.throws(() => contract({ maxAttempts: 2 }), /maxAttempts/);
});

test("read-only delivery completes on a non-empty response", () => {
  const readOnly = contract();
  assert.equal(evaluateTaskCompletion(readOnly, { responseText: "三条结论" }), "completed");
  assert.equal(evaluateTaskCompletion(readOnly, { responseText: "  \n " }), "unverified");
});

test("external effects require a verified action receipt or fresh read-back", () => {
  const external = contract({
    successMode: "external_effect",
    authority: "reversible",
  });
  assert.equal(evaluateTaskCompletion(external, { responseText: "我做完了" }), "unverified");
  assert.equal(evaluateTaskCompletion(external, {
    externalVerification: { source: "action_receipt", verified: false },
  }), "unverified");
  assert.equal(evaluateTaskCompletion(external, {
    externalVerification: { source: "action_receipt", verified: true },
  }), "verified");
  assert.equal(evaluateTaskCompletion(external, {
    externalVerification: { source: "read_back", verified: true },
  }), "verified");
});

test("task progress uses the contract gate without trusting a bare runtime verified bit", () => {
  const command = makeTurnStartCommand();
  const event = runtimeEvent("response.completed", command.requestId, command.traceId, {
    text: "交付内容",
    verified: true,
  });
  assert.equal(terminalTaskProgressKindFor(event, contract()), "completed");
  const external = contract({ successMode: "external_effect", authority: "reversible" });
  assert.equal(terminalTaskProgressKindFor(event, external), "unverified");
  assert.equal(terminalTaskProgressKindFor(event, external, {
    source: "read_back",
    verified: true,
  }), "verified");
  assert.equal(terminalTaskProgressKindFor(event), "verified", "legacy callers remain compatible");
});

test("runtime tracker projects read-only delivery and external verification through TaskTruth", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const readOnlyCommand = makeTurnStartCommand();
  const readOnlyTracker = new RuntimeTaskProgressTracker(
    kernel.taskTruth,
    readOnlyCommand,
    contract({ objective: "交付调研摘要" }),
  );
  readOnlyTracker.observe(runtimeEvent(
    "tool.started",
    readOnlyCommand.requestId,
    readOnlyCommand.traceId,
    { toolName: "web_search" },
  ));
  readOnlyTracker.observe(runtimeEvent(
    "response.completed",
    readOnlyCommand.requestId,
    readOnlyCommand.traceId,
    { text: "三条调研结论", verified: false },
  ));
  await readOnlyTracker.flush();

  const unverifiedCommand = makeTurnStartCommand();
  const unverifiedTracker = new RuntimeTaskProgressTracker(
    kernel.taskTruth,
    unverifiedCommand,
    contract({
      objective: "改变外部界面",
      successMode: "external_effect",
      authority: "reversible",
    }),
  );
  unverifiedTracker.observe(runtimeEvent(
    "tool.started",
    unverifiedCommand.requestId,
    unverifiedCommand.traceId,
    { toolName: "computer_control" },
  ));
  unverifiedTracker.observe(runtimeEvent(
    "response.completed",
    unverifiedCommand.requestId,
    unverifiedCommand.traceId,
    { text: "已完成", verified: true },
  ));
  await unverifiedTracker.flush();

  const verifiedCommand = makeTurnStartCommand();
  const verifiedTracker = new RuntimeTaskProgressTracker(
    kernel.taskTruth,
    verifiedCommand,
    contract({
      objective: "改变并回读外部界面",
      successMode: "external_effect",
      authority: "reversible",
    }),
  );
  verifiedTracker.observe(runtimeEvent(
    "tool.started",
    verifiedCommand.requestId,
    verifiedCommand.traceId,
    { toolName: "computer_control" },
  ));
  verifiedTracker.observe(runtimeEvent(
    "response.completed",
    verifiedCommand.requestId,
    verifiedCommand.traceId,
    { text: "已完成", verified: false },
  ), { source: "read_back", verified: true });
  await verifiedTracker.flush();

  const tasks = await kernel.store.listTasks();
  assert.equal(tasks.find((task) => task.id === readOnlyCommand.requestId)?.status, "done");
  assert.equal(tasks.find((task) => task.id === readOnlyCommand.requestId)?.title, "交付调研摘要");
  assert.equal(tasks.find((task) => task.id === unverifiedCommand.requestId)?.status, "blocked");
  assert.equal(tasks.find((task) => task.id === verifiedCommand.requestId)?.status, "done");
});

test("retry decision stays within the fixed budget and original risk boundary", () => {
  const controlled = contract({ authority: "reversible", risk: "medium" });
  assert.deepEqual(decideTaskRetry(controlled, {
    attemptsUsed: 0,
    proposedAuthority: "reversible",
    proposedRisk: "low",
  }), { decision: "retry", nextAttempt: 1 });
  assert.deepEqual(decideTaskRetry(controlled, {
    attemptsUsed: 1,
    proposedAuthority: "reversible",
    proposedRisk: "medium",
  }), { decision: "escalate", reason: "attempt_budget_exhausted" });
  assert.deepEqual(decideTaskRetry(controlled, {
    attemptsUsed: 0,
    proposedAuthority: "reversible",
    proposedRisk: "high",
  }), { decision: "escalate", reason: "risk_increased" });
  assert.deepEqual(decideTaskRetry(controlled, {
    attemptsUsed: 0,
    proposedAuthority: "explicit_approval",
    proposedRisk: "medium",
  }), { decision: "escalate", reason: "authority_changed" });
  assert.throws(() => decideTaskRetry(controlled, {
    attemptsUsed: -1,
    proposedAuthority: "reversible",
    proposedRisk: "low",
  }), /attemptsUsed/);
});

test("runtime tracker admits only budgeted attempts and does not consume a slot on escalation", () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const tracker = new RuntimeTaskProgressTracker(
    kernel.taskTruth,
    makeTurnStartCommand(),
    contract({ authority: "reversible", risk: "medium" }),
  );

  assert.deepEqual(tracker.requestAttempt({
    proposedAuthority: "reversible",
    proposedRisk: "low",
  }), { decision: "retry", nextAttempt: 1 });
  assert.deepEqual(tracker.requestAttempt({
    proposedAuthority: "explicit_approval",
    proposedRisk: "low",
  }), { decision: "escalate", reason: "authority_changed" });
  assert.deepEqual(tracker.requestAttempt({
    proposedAuthority: "reversible",
    proposedRisk: "low",
  }), { decision: "escalate", reason: "attempt_budget_exhausted" });
});
