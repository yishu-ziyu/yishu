import assert from "node:assert/strict";
import { mkdtemp, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, it } from "node:test";
import { TaskTruthProjector } from "../src/task-truth.js";
import {
  SENSITIVE_CONTENT_REJECTED,
  SENSITIVE_MEMORY_REJECTED,
  SqliteYishuStore,
} from "../src/store/index.js";

describe("SqliteYishuStore", () => {
  it("persists memory, skill promote, and mandates", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-sqlite-"));
    const dbPath = path.join(dir, "test.sqlite");
    const store = new SqliteYishuStore(dbPath);
    await store.load();

    const now = new Date().toISOString();
    const mem = await store.addMemory({
      claim: "sqlite works",
      source: "system",
      capturedAt: now,
      scope: "global",
      confidence: 0.8,
      lastConfirmedAt: now,
      supersedes: null,
      tags: ["t"],
    });
    assert.ok(mem.id);

    const candidate = await store.addSkillCandidate({
      name: "s1",
      steps: [{ id: "1", description: "open app", kind: "resolve" }],
      conditions: { app: "Chrome" },
      verification: ["trail_replay"],
      sourceTrailFrom: now,
      sourceTrailTo: now,
    });
    const skill = await store.promoteSkill(candidate.id, { confidence: 0.9 });
    assert.equal(skill?.status, "verified");
    assert.equal((await store.listSkillCandidates()).length, 0);

    await store.grantMandate({ actionName: "send_message", scope: "global" });
    assert.equal(await store.hasMandate("send_message"), true);

    const projector = new TaskTruthProjector(store);
    await projector.record({
      taskId: "sqlite-task",
      title: "验证 SQLite 任务持久化",
      kind: "start",
      observedAt: now,
      evidence: "runtime:tool.started:event-1:test",
    });
    await projector.record({
      taskId: "sqlite-task",
      title: "验证 SQLite 任务持久化",
      kind: "verified",
      observedAt: new Date(Date.parse(now) + 1_000).toISOString(),
      evidence: "runtime:response.completed:event-2:verified",
    });

    store.close();

    const reopened = new SqliteYishuStore(dbPath);
    const hits = await reopened.searchMemory("sqlite");
    assert.equal(hits.length, 1);
    assert.equal((await reopened.listVerifiedSkills()).length, 1);
    const [task] = await reopened.listTasks();
    assert.equal(task?.id, "sqlite-task");
    assert.equal(task?.status, "done");
    assert.equal(task?.evidence.length, 2);
    reopened.close();

    await unlink(dbPath).catch(() => undefined);
  });

  it("rejects sensitive memory before SQLite mutation", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-sqlite-sensitive-"));
    const dbPath = path.join(dir, "test.sqlite");
    const store = new SqliteYishuStore(dbPath);
    const now = new Date().toISOString();
    const secret = "refresh_token=DO_NOT_STORE_SQLITE_456";

    await assert.rejects(
      () => store.addMemory({
        claim: "用户偏好",
        source: "conversation",
        capturedAt: now,
        scope: "global",
        confidence: 0.9,
        lastConfirmedAt: now,
        supersedes: null,
        tags: [secret],
      }),
      (error: unknown) =>
        error instanceof Error && error.message === SENSITIVE_MEMORY_REJECTED,
    );
    await assert.rejects(
      () => store.addLearning({
        rule: "保持普通规则",
        capturedAt: now,
        scope: "global",
        confidence: 0.9,
        examples: [`data:image/png;base64,${"A".repeat(32)}`],
      }),
      (error: unknown) =>
        error instanceof Error && error.message === SENSITIVE_MEMORY_REJECTED,
    );
    assert.equal((await store.searchMemory("用户偏好")).length, 0);
    assert.equal((await store.listLearnings()).length, 0);
    assert.ok(!JSON.stringify(store.getSnapshot()).includes("[redacted]"));

    const normal = await store.addMemory({
      claim: "打开 Secret Manager",
      source: "conversation",
      capturedAt: now,
      scope: "global",
      confidence: 0.8,
      lastConfirmedAt: now,
      supersedes: null,
      tags: ["normal"],
    });
    assert.equal(normal.claim, "打开 Secret Manager");
    const dbContents = await readFile(dbPath, "utf8");
    assert.ok(!dbContents.includes(secret));
    assert.ok(!dbContents.includes("DO_NOT_STORE_SQLITE_456"));

    store.close();
    await unlink(dbPath).catch(() => undefined);
  });

  it("fails closed when a SQLite Skill row is poisoned outside the store", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-sqlite-sensitive-skill-"));
    const dbPath = path.join(dir, "test.sqlite");
    const store = new SqliteYishuStore(dbPath);
    await assert.rejects(
      () => store.addSkillCandidate({
        name: "unsafe",
        steps: [{ id: "s1", description: "hidden_prompt=DO_NOT_STORE_12345", kind: "observe" }],
        conditions: { app: "Chrome" },
        verification: ["user_confirmed"],
        sourceTrailFrom: "2026-08-08T00:00:00.000Z",
        sourceTrailTo: "2026-08-08T00:00:00.000Z",
      }),
      (error: unknown) =>
        error instanceof Error && error.message === SENSITIVE_CONTENT_REJECTED,
    );
    store.close();

    const db = new DatabaseSync(dbPath);
    db.prepare(
      `INSERT INTO skill_candidates (
        id, name, trigger_phrase, steps_json, conditions_json, verification_json,
        source_trail_from, source_trail_to, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "poisoned",
      "unsafe",
      null,
      JSON.stringify([{ id: "s1", description: "screenshot: data:image/png;base64,AAAA", kind: "observe" }]),
      JSON.stringify({ app: "Chrome" }),
      JSON.stringify(["user_confirmed"]),
      "2026-08-08T00:00:00.000Z",
      "2026-08-08T00:00:00.000Z",
      "candidate",
      "2026-08-08T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO verified_skills (
        id, name, trigger_phrase, steps_json, conditions_json, verification_json,
        status, verified_at, candidate_id, confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "poisoned-verified",
      "unsafe verified",
      null,
      JSON.stringify([{ id: "s1", description: "open app", kind: "observe" }]),
      JSON.stringify({ app: "Chrome" }),
      JSON.stringify(["hidden_prompt=DO_NOT_STORE_12345"]),
      "verified",
      "2026-08-08T00:00:00.000Z",
      "poisoned",
      0.8,
    );
    db.close();

    const reopened = new SqliteYishuStore(dbPath);
    await assert.rejects(
      () => reopened.listSkillCandidates(),
      (error: unknown) =>
        error instanceof Error && error.message === SENSITIVE_CONTENT_REJECTED,
    );
    await assert.rejects(
      () => reopened.listVerifiedSkills(),
      (error: unknown) =>
        error instanceof Error && error.message === SENSITIVE_CONTENT_REJECTED,
    );
    reopened.close();
    await unlink(dbPath).catch(() => undefined);
  });
});
