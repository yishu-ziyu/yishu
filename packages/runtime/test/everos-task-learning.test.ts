import assert from "node:assert/strict";
import { test } from "node:test";
import type { EverOSAddInput, EverOSMemoryPort, RecalledMemory } from "@yishu/kernel";
import { EverOSIngestionCoordinator } from "../src/everos-ingestion.js";
import {
  everosInputForVerifiedTask,
  ingestVerifiedTaskLearning,
} from "../src/everos-task-learning.js";

class RecordingEverOS implements EverOSMemoryPort {
  readonly adds: EverOSAddInput[] = [];
  readonly flushes: Array<{ sessionId: string }> = [];

  async add(input: EverOSAddInput): Promise<void> {
    this.adds.push(input);
  }

  async flush(input: { sessionId: string }): Promise<void> {
    this.flushes.push(input);
  }

  async search(): Promise<RecalledMemory[]> {
    return [];
  }

  async profile(): Promise<RecalledMemory[]> {
    return [];
  }
}

test("only a verified personal result becomes an EverOS task session", () => {
  const succeeded = everosInputForVerifiedTask({
    taskId: "task-verified-1",
    title: "把钥匙放回抽屉",
    summary: "抽屉里已经有钥匙。",
    resultKind: "succeeded",
    sessionScope: { kind: "personal" },
  });
  assert.ok(succeeded);
  assert.equal(succeeded.sessionId, "task:task-verified-1");
  assert.equal(succeeded.scopeKey, "personal");
  assert.equal(succeeded.messages[0]?.content, "任务目标：把钥匙放回抽屉");
  assert.equal(succeeded.messages[1]?.content, "已验证结果：抽屉里已经有钥匙。");

  assert.equal(everosInputForVerifiedTask({
    taskId: "task-completed-1",
    title: "调研记忆分层",
    summary: "三层记忆架构",
    resultKind: "completed",
    sessionScope: { kind: "personal" },
  }), undefined);

  assert.equal(everosInputForVerifiedTask({
    taskId: "task-failed-1",
    title: "把钥匙放回抽屉",
    summary: "没找到抽屉",
    resultKind: "failed",
    sessionScope: { kind: "personal" },
  }), undefined);

  assert.equal(everosInputForVerifiedTask({
    taskId: "task-private-1",
    title: "把钥匙放回抽屉",
    summary: "抽屉里已经有钥匙。",
    resultKind: "succeeded",
    sessionScope: { kind: "private" },
  }), undefined);
});

test("verified task learning flushes the task session immediately", async () => {
  const everos = new RecordingEverOS();
  const ingestion = new EverOSIngestionCoordinator(everos, { idleMs: 30_000 });
  const written = await ingestVerifiedTaskLearning(ingestion, {
    taskId: "task-verified-2",
    title: "把钥匙放回抽屉",
    summary: "抽屉里已经有钥匙。",
    resultKind: "succeeded",
    sessionScope: { kind: "personal" },
  });
  assert.equal(written, true);
  assert.equal(everos.adds.length, 1);
  assert.equal(everos.adds[0]?.sessionId, "task:task-verified-2");
  assert.equal(everos.flushes.length, 1);
  assert.equal(everos.flushes[0]?.sessionId, "task:task-verified-2");
  await ingestion.dispose();
});
