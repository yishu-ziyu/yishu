import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
  createYishuKernel,
  type ContextWatchCreateResult,
  type SessionScope,
  type YishuKernel,
} from "../src/index.js";

const CREATED_AT = "2026-08-23T08:00:00.000Z";
const DEPARTED_AT = "2026-08-23T08:01:00.000Z";
const RETURNED_AT = "2026-08-23T08:02:00.000Z";

async function createWatch(
  kernel: YishuKernel,
  input: {
    mainConversationId?: string;
    sessionScope?: Exclude<SessionScope, { kind: "private" }>;
  } = {},
): Promise<ContextWatchCreateResult> {
  const mainConversationId = input.mainConversationId ?? randomUUID();
  const sessionScope = input.sessionScope ?? { kind: "personal" as const };
  await kernel.store.upsertConversation({
    id: mainConversationId,
    sessionScope,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  return kernel.store.createContextWatch({
    mainConversationId,
    sessionScope,
    targetBundleId: "com.apple.mail",
    reminder: "提交报销",
    sourceFrameId: "source-frame",
    createdAt: CREATED_AT,
  });
}

describe("ContextWatchLedger", () => {
  it("owns leave-then-return progression and preserves one-shot semantics", async () => {
    const kernel = createYishuKernel({ storeBackend: "memory" });
    const created = await createWatch(kernel);

    assert.deepEqual(await kernel.contextWatches.observeApplication({
      sessionScope: { kind: "personal" },
      observedBundleId: "com.apple.mail",
      occurredAt: DEPARTED_AT,
      observationFrameId: "still-here-frame",
    }), []);

    const armed = await kernel.contextWatches.observeApplication({
      sessionScope: { kind: "personal" },
      observedBundleId: "com.apple.finder",
      occurredAt: DEPARTED_AT,
      observationFrameId: "departure-frame",
    });
    assert.equal(armed.length, 1);
    assert.equal(armed[0]?.kind, "armed");
    assert.equal(armed[0]?.watch.id, created.watch.id);
    assert.equal(armed[0]?.taskTitle, "提醒：提交报销");

    const fired = await kernel.contextWatches.observeApplication({
      sessionScope: { kind: "personal" },
      observedBundleId: "com.apple.mail",
      occurredAt: RETURNED_AT,
      observationFrameId: "return-frame",
    });
    assert.equal(fired.length, 1);
    assert.equal(fired[0]?.kind, "fired");
    assert.equal(fired[0]?.watch.state, "fired");

    assert.deepEqual(await kernel.contextWatches.observeApplication({
      sessionScope: { kind: "personal" },
      observedBundleId: "com.apple.mail",
      occurredAt: "2026-08-23T08:03:00.000Z",
      observationFrameId: "duplicate-return-frame",
    }), []);
    assert.equal((await kernel.store.listTasks())[0]?.status, "done");
    assert.equal((await kernel.store.listDelegatedResults()).length, 1);
  });

  it("does not advance across scopes and cancels only through the owning conversation", async () => {
    const kernel = createYishuKernel({ storeBackend: "memory" });
    const project = {
      kind: "project" as const,
      projectId: randomUUID(),
      projectLabel: "Alpha",
    };
    const mainConversationId = randomUUID();
    const created = await createWatch(kernel, {
      mainConversationId,
      sessionScope: project,
    });

    assert.deepEqual(await kernel.contextWatches.observeApplication({
      sessionScope: { kind: "personal" },
      observedBundleId: "com.apple.finder",
      occurredAt: DEPARTED_AT,
      observationFrameId: "wrong-scope-frame",
    }), []);
    assert.deepEqual(await kernel.contextWatches.observeApplication({
      sessionScope: { kind: "private" },
      observedBundleId: "com.apple.finder",
      occurredAt: DEPARTED_AT,
      observationFrameId: "private-frame",
    }), []);
    assert.equal(
      (await kernel.store.listActiveContextWatches(project))[0]?.state,
      "waiting_for_departure",
    );

    assert.equal(await kernel.contextWatches.cancelTask({
      taskId: created.task.id,
      mainConversationId: randomUUID(),
      cancelledAt: DEPARTED_AT,
    }), null);

    const cancelled = await kernel.contextWatches.cancelTask({
      taskId: created.task.id,
      mainConversationId: mainConversationId.toUpperCase(),
      cancelledAt: DEPARTED_AT,
    });
    assert.equal(cancelled?.watch.state, "cancelled");
    assert.equal(cancelled?.task.id, created.task.id);
    assert.equal(cancelled?.task.title, "提醒：提交报销");
    assert.equal(cancelled?.cancelledAt, DEPARTED_AT);
    assert.equal(
      (await kernel.store.listTasks({ sessionScope: project }))[0]?.status,
      "cancelled",
    );
    assert.deepEqual(await kernel.store.listActiveContextWatches(project), []);
  });
});
