import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InMemoryYishuStore,
  TaskTruthProjector,
  type TaskProgressSignal,
} from "../src/index.js";

const base: TaskProgressSignal = {
  taskId: "turn-1",
  title: "  打开 Safari\n并验证结果  ",
  kind: "start",
  observedAt: "2026-08-08T00:00:00.000Z",
  evidence: "runtime:tool.started:event-1:computer_control",
};

describe("TaskTruthProjector", () => {
  it("owns lifecycle policy and keeps terminal truth monotonic", async () => {
    const store = new InMemoryYishuStore();
    const projector = new TaskTruthProjector(store);

    const running = await projector.record(base);
    assert.equal(running?.status, "running");
    assert.equal(running?.title, "打开 Safari 并验证结果");

    const done = await projector.record({
      ...base,
      kind: "verified",
      observedAt: "2026-08-08T00:00:02.000Z",
      evidence: "runtime:response.completed:event-2:verified",
    });
    assert.equal(done?.status, "done");

    const lateFailure = await projector.record({
      ...base,
      kind: "failed",
      observedAt: "2026-08-08T00:00:03.000Z",
      evidence: "runtime:turn.failed:event-3",
    });
    assert.equal(lateFailure?.status, "done");
    assert.deepEqual(lateFailure?.evidence, done?.evidence);
  });

  it("does not manufacture TaskTruth without an execution start", async () => {
    const store = new InMemoryYishuStore();
    const projector = new TaskTruthProjector(store);

    const result = await projector.record({
      ...base,
      kind: "verified",
    });

    assert.equal(result, null);
    assert.deepEqual(await store.listTasks(), []);
  });

  it("keeps evidence bounded and never stores multiline payloads", async () => {
    const store = new InMemoryYishuStore();
    const projector = new TaskTruthProjector(store, {
      maxEvidenceEntries: 4,
      maxEvidenceLength: 32,
    });
    await projector.record(base);

    for (let index = 0; index < 8; index += 1) {
      await projector.record({
        ...base,
        kind: "progress",
        observedAt: `2026-08-08T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
        evidence: `runtime:tool.completed:event-${index}\n${"x".repeat(80)}`,
      });
    }

    const [task] = await store.listTasks();
    assert.equal(task?.status, "running");
    assert.equal(task?.evidence.length, 4);
    assert.ok(task?.evidence.every((item) => item.length <= 32));
    assert.ok(task?.evidence.every((item) => !item.includes("\n")));
  });

  it("redacts credential-like task titles and evidence before persistence", async () => {
    const store = new InMemoryYishuStore();
    const projector = new TaskTruthProjector(store);
    const secret = "SUPER_SECRET_VALUE_12345";

    await projector.record({
      ...base,
      title: `${"普通说明".repeat(38)} password=${secret}`,
      evidence: `${"runtime:progress:".repeat(14)}Authorization_Bearer_${secret}`,
    });

    const [task] = await store.listTasks();
    assert.equal(task?.title, "敏感任务（标题已隐藏）");
    assert.deepEqual(task?.evidence, ["runtime:evidence:redacted"]);
    assert.doesNotMatch(JSON.stringify(task), new RegExp(secret));
  });

  it("uses call order to make cancellation win over a late failure", async () => {
    const store = new InMemoryYishuStore();
    const projector = new TaskTruthProjector(store);
    await projector.record(base);

    const cancelled = projector.record({
      ...base,
      kind: "cancelled",
      observedAt: "2026-08-08T00:00:02.000Z",
      evidence: "runtime:turn.cancelled:event-2",
    });
    const lateFailure = projector.record({
      ...base,
      kind: "failed",
      observedAt: "2026-08-08T00:00:03.000Z",
      evidence: "runtime:turn.failed:event-3",
    });

    assert.equal((await cancelled)?.status, "cancelled");
    assert.equal((await lateFailure)?.status, "cancelled");
    assert.equal((await store.listTasks())[0]?.status, "cancelled");
  });

  it("keeps unverified completion resumable instead of claiming done", async () => {
    const store = new InMemoryYishuStore();
    const projector = new TaskTruthProjector(store);
    await projector.record(base);

    const blocked = await projector.record({
      ...base,
      kind: "unverified",
      observedAt: "2026-08-08T00:00:02.000Z",
      evidence: "runtime:response.completed:event-2:unverified",
    });
    assert.equal(blocked?.status, "blocked");

    const resumed = await projector.record({
      ...base,
      kind: "progress",
      observedAt: "2026-08-08T00:00:03.000Z",
      evidence: "runtime:tool.started:event-3:retry",
    });
    assert.equal(resumed?.status, "running");
  });

  it("records a safely produced delegated result as done without calling it verified", async () => {
    const store = new InMemoryYishuStore();
    const projector = new TaskTruthProjector(store);
    await projector.record(base);

    const completed = await projector.record({
      ...base,
      kind: "completed",
      observedAt: "2026-08-08T00:00:02.000Z",
      evidence: "delegate:completed:turn-1",
    });

    assert.equal(completed?.status, "done");
    assert.ok(completed?.evidence.includes("delegate:completed:turn-1"));
  });

  it("copies project scope into TaskTruth and filters project queries", async () => {
    const store = new InMemoryYishuStore();
    const projector = new TaskTruthProjector(store);
    const projectA = { kind: "project" as const, projectId: "11111111-1111-4111-8111-111111111111" };
    const projectB = { kind: "project" as const, projectId: "22222222-2222-4222-8222-222222222222" };

    await projector.record({ ...base, taskId: "project-a-task", sessionScope: projectA });
    await projector.record({ ...base, taskId: "project-b-task", sessionScope: projectB });

    assert.deepEqual(
      (await store.listTasks({ sessionScope: projectA })).map((task) => task.id),
      ["project-a-task"],
    );
    assert.deepEqual(
      (await store.listTasks({ sessionScope: projectB })).map((task) => task.id),
      ["project-b-task"],
    );
    await assert.rejects(
      () => projector.record({ ...base, taskId: "project-a-task", sessionScope: projectB }),
      /task_scope_conflict/,
    );
  });

  // Parent-child truth semantics for delegated execution (ADR 0009, RFC v2
  // §2.6): parentId links child truth to its parent, and a child's terminal
  // state never propagates into the parent's own TaskTruth.
  it("keeps parent and child TaskTruth independent across child terminal states", async () => {
    const store = new InMemoryYishuStore();
    const projector = new TaskTruthProjector(store);

    await projector.record({ ...base, taskId: "parent-task", title: "main task" });
    await projector.record({
      ...base,
      taskId: "child-task",
      title: "delegated research",
      parentId: "parent-task",
    });

    let tasks = await store.listTasks();
    const child = tasks.find((task) => task.id === "child-task");
    assert.equal(child?.status, "running");
    assert.equal(child?.parentId, "parent-task");

    // Child failure does not fail the parent.
    await projector.record({
      ...base,
      taskId: "child-task",
      title: "delegated research",
      kind: "failed",
      observedAt: "2026-08-08T00:00:05.000Z",
      evidence: "runtime:turn.failed:event-9",
    });
    tasks = await store.listTasks();
    assert.equal(tasks.find((task) => task.id === "child-task")?.status, "failed");
    assert.equal(tasks.find((task) => task.id === "parent-task")?.status, "running");

    // Parent can still reach its own terminal state afterwards.
    await projector.record({
      ...base,
      taskId: "parent-task",
      title: "main task",
      kind: "verified",
      observedAt: "2026-08-08T00:00:06.000Z",
      evidence: "runtime:response.completed:event-10",
    });
    tasks = await store.listTasks();
    assert.equal(tasks.find((task) => task.id === "parent-task")?.status, "done");

    // A late signal against the failed child cannot move its terminal truth.
    await projector.record({
      ...base,
      taskId: "child-task",
      title: "delegated research",
      kind: "verified",
      observedAt: "2026-08-08T00:00:07.000Z",
      evidence: "runtime:response.completed:event-11",
    });
    tasks = await store.listTasks();
    assert.equal(tasks.find((task) => task.id === "child-task")?.status, "failed");
  });
});
