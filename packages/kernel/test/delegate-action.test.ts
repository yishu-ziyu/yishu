import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createYishuKernel, type DelegateResult } from "../src/index.js";

test("delegate action registers a parent-linked child TaskTruth and accepts immediately", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const projectId = randomUUID();
  const receipt = await kernel.registry.invoke("delegate", {
    caller: "pi",
    input: {
      title: "研究 Yishu memory 方案",
      parentId: "main-turn-req-1",
      sessionScope: { kind: "project", projectId },
    },
  });

  assert.equal(receipt.status, "ok");
  const output = receipt.output as DelegateResult;
  assert.equal(output.accepted, true);
  assert.equal(typeof output.taskId, "string");
  assert.ok(output.taskId.length > 0);

  // TaskTruth is the only status truth: the child must be durable and
  // parent-linked right after acceptance, before any execution settles.
  await kernel.taskTruth.flush(output.taskId);
  const task = (await kernel.store.listTasks()).find((t) => t.id === output.taskId);
  assert.ok(task, "child task truth must exist");
  assert.equal(task.status, "running");
  assert.equal(task.title, "研究 Yishu memory 方案");
  assert.equal(task.parentId, "main-turn-req-1");
  assert.equal(task.sessionScope.kind, "project");
  assert.ok(task.evidence.includes(`delegate:accepted:${output.taskId}`));
});

test("delegate action refuses private sessions", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const receipt = await kernel.registry.invoke("delegate", {
    caller: "pi",
    input: {
      title: "私密任务",
      parentId: "main-turn-req-2",
      sessionScope: { kind: "private" },
    },
  });

  assert.equal(receipt.status, "failed");
  assert.match(receipt.message, /private/);
  assert.equal((await kernel.store.listTasks()).length, 0);
});

test("delegate action defaults to personal scope when none is given", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const receipt = await kernel.registry.invoke("delegate", {
    caller: "pi",
    input: { title: "背景调研", parentId: "main-turn-req-3" },
  });

  assert.equal(receipt.status, "ok");
  const output = receipt.output as DelegateResult;
  await kernel.taskTruth.flush(output.taskId);
  const task = (await kernel.store.listTasks()).find((t) => t.id === output.taskId);
  assert.equal(task?.sessionScope.kind, "personal");
});

test("delegate action rejects an empty title or parent id", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  for (const input of [
    { title: "   ", parentId: "p" },
    { title: "任务", parentId: "" },
  ]) {
    const receipt = await kernel.registry.invoke("delegate", { caller: "pi", input });
    assert.notEqual(receipt.status, "ok");
  }
  assert.equal((await kernel.store.listTasks()).length, 0);
});
