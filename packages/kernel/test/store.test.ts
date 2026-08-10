import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  extractProcedureFromTrail,
  InMemoryYishuStore,
  SENSITIVE_CONTENT_REJECTED,
  SENSITIVE_MEMORY_REJECTED,
  YishuStore,
} from "../src/store/index.js";
import { TaskTruthProjector } from "../src/task-truth.js";

describe("YishuStore evidence resources", () => {
  it("stores memory claims with evidence fields (not bare strings)", async () => {
    const store = new InMemoryYishuStore();
    const now = "2026-08-07T12:00:00.000Z";
    const claim = await store.addMemory({
      claim: "用户在这个项目中偏好 React",
      source: "conversation",
      capturedAt: now,
      scope: "project:yishu",
      confidence: 0.91,
      lastConfirmedAt: now,
      supersedes: null,
      tags: ["stack"],
    });

    assert.equal(claim.claim, "用户在这个项目中偏好 React");
    assert.equal(claim.source, "conversation");
    assert.equal(claim.scope, "project:yishu");
    assert.equal(claim.confidence, 0.91);
    assert.ok(claim.id);

    const hits = await store.searchMemory("React", {
      scope: "project:yishu",
      minConfidence: 0.5,
    });
    assert.equal(hits.length, 1);

    await store.retireMemory(claim.id);
    const after = await store.searchMemory("React");
    assert.equal(after.length, 0);
  });

  it("rejects sensitive memory atomically without creating redacted pseudo-memory", async () => {
    const store = new InMemoryYishuStore();
    const secret = "password=DO_NOT_STORE_12345";
    const now = "2026-08-08T00:00:00.000Z";

    await assert.rejects(
      () => store.addMemory({
        claim: `用户的 ${secret}`,
        source: "conversation",
        capturedAt: now,
        scope: "project:yishu",
        confidence: 0.9,
        lastConfirmedAt: now,
        supersedes: null,
        tags: ["preference"],
      }),
      (error: unknown) =>
        error instanceof Error && error.message === SENSITIVE_MEMORY_REJECTED,
    );
    await assert.rejects(
      () => store.addLearning({
        rule: "chain_of_thought=PRIVATE_PLAN_12345",
        capturedAt: now,
        scope: "project:yishu",
        confidence: 0.9,
        examples: ["正常例子"],
      }),
      (error: unknown) =>
        error instanceof Error && error.message === SENSITIVE_MEMORY_REJECTED,
    );
    await assert.rejects(
      () => store.addMemory({
        claim: "普通偏好",
        source: "conversation",
        capturedAt: now,
        scope: "api-key",
        confidence: 0.9,
        lastConfirmedAt: now,
        supersedes: null,
        tags: ["preference"],
      }),
      (error: unknown) =>
        error instanceof Error && error.message === SENSITIVE_MEMORY_REJECTED,
    );

    assert.equal(store.getSnapshot().memories.length, 0);
    assert.equal(store.getSnapshot().learnings.length, 0);

    const normal = await store.addMemory({
      claim: "打开 Secret Manager；政策是禁止保存 screenshot 或 system prompt",
      source: "conversation",
      capturedAt: now,
      scope: "project:yishu",
      confidence: 0.8,
      lastConfirmedAt: now,
      supersedes: null,
      tags: ["normal"],
    });
    assert.equal(
      normal.claim,
      "打开 Secret Manager；政策是禁止保存 screenshot 或 system prompt",
    );
    assert.ok(!JSON.stringify(store.getSnapshot()).includes("[redacted]"));
  });

  it("fails closed when an old JSON snapshot already contains sensitive memory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-store-sensitive-old-"));
    const secret = "api_key=DO_NOT_EXPOSE_98765";
    await writeFile(
      path.join(dir, "yishu-store.json"),
      JSON.stringify({
        memories: [{
          id: "unsafe",
          claim: secret,
          source: "system",
          capturedAt: "2026-08-08T00:00:00.000Z",
          scope: "global",
          confidence: 0.5,
          lastConfirmedAt: "2026-08-08T00:00:00.000Z",
          supersedes: null,
          tags: [],
        }],
      }),
      "utf8",
    );

    const store = new YishuStore(dir);
    await assert.rejects(
      () => store.load(),
      (error: unknown) =>
        error instanceof Error && error.message === SENSITIVE_MEMORY_REJECTED,
    );
    assert.equal(store.getSnapshot().memories.length, 0);
  });

  it("does not write a rejected memory to the JSON snapshot", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-store-sensitive-write-"));
    const store = new YishuStore(dir);
    await store.load();
    const secret = "password=DO_NOT_WRITE_JSON_24680";

    await assert.rejects(
      () => store.addMemory({
        claim: secret,
        source: "conversation",
        capturedAt: "2026-08-08T00:00:00.000Z",
        scope: "global",
        confidence: 0.9,
        lastConfirmedAt: "2026-08-08T00:00:00.000Z",
        supersedes: null,
        tags: [],
      }),
      (error: unknown) =>
        error instanceof Error && error.message === SENSITIVE_MEMORY_REJECTED,
    );

    const raw = await readFile(path.join(dir, "yishu-store.json"), "utf8").catch(() => "");
    assert.ok(!raw.includes(secret));
    assert.ok(!raw.includes("[redacted]"));
    assert.equal(store.getSnapshot().memories.length, 0);
  });

  it("promotes skill candidates to verified skills", async () => {
    const store = new InMemoryYishuStore();
    const candidate = await store.addSkillCandidate({
      name: "hand_repo_to_codex",
      triggerPhrase: "把这个仓库交给 Codex",
      steps: [
        {
          id: "s1",
          description: "resolve current github repo",
          kind: "resolve",
        },
        { id: "s2", description: "open codex", kind: "act" },
      ],
      conditions: { app: "Chrome" },
      verification: ["codex_session_contains_repo"],
      sourceTrailFrom: "2026-08-07T12:00:00.000Z",
      sourceTrailTo: "2026-08-07T12:03:00.000Z",
    });

    const skill = await store.promoteSkill(candidate.id, { confidence: 0.88 });
    assert.ok(skill);
    assert.equal(skill!.status, "verified");
    assert.equal(skill!.candidateId, candidate.id);
    assert.equal((await store.listSkillCandidates()).length, 0);
    assert.equal((await store.listVerifiedSkills()).length, 1);
  });

  it("fails closed at direct Skill persistence while allowing policy prose", async () => {
    const store = new InMemoryYishuStore();
    const now = "2026-08-08T00:00:00.000Z";
    const base = {
      steps: [{ id: "s1", description: "open app", kind: "resolve" as const }],
      conditions: { app: "Chrome" },
      verification: ["user_confirmed"],
      sourceTrailFrom: now,
      sourceTrailTo: now,
    };

    await assert.rejects(
      () => store.addSkillCandidate({
        ...base,
        name: "unsafe",
        steps: [{ id: "s1", description: "token=SKILL_SECRET_12345", kind: "resolve" }],
      }),
      (error: unknown) =>
        error instanceof Error && error.message === SENSITIVE_CONTENT_REJECTED,
    );
    assert.equal((await store.listSkillCandidates()).length, 0);

    const normal = await store.addSkillCandidate({
      ...base,
      name: "open Secret Manager policy",
      triggerPhrase: "打开 Secret Manager；政策是禁止保存 screenshot 或 system prompt",
    });
    await assert.rejects(
      () => store.promoteSkill(normal.id, { verifierNote: "hidden_prompt=DO_NOT_STORE_12345" }),
      (error: unknown) =>
        error instanceof Error && error.message === SENSITIVE_CONTENT_REJECTED,
    );
    assert.equal((await store.listSkillCandidates()).length, 1);
    assert.equal((await store.listVerifiedSkills()).length, 0);
  });

  it("rejects sensitive Skill rows when loading an old JSON snapshot", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-store-sensitive-skill-"));
    await writeFile(
      path.join(dir, "yishu-store.json"),
      JSON.stringify({
        skillCandidates: [{
          id: "unsafe",
          name: "unsafe",
          steps: [{ id: "s1", description: "screenshot: data:image/png;base64,AAAA", kind: "observe" }],
          conditions: { app: "Chrome" },
          verification: ["user_confirmed"],
          sourceTrailFrom: "2026-08-08T00:00:00.000Z",
          sourceTrailTo: "2026-08-08T00:00:00.000Z",
          status: "candidate",
          createdAt: "2026-08-08T00:00:00.000Z",
        }],
      }),
      "utf8",
    );
    const store = new YishuStore(dir);
    await assert.rejects(
      () => store.load(),
      (error: unknown) =>
        error instanceof Error && error.message === SENSITIVE_CONTENT_REJECTED,
    );
    assert.equal(store.getSnapshot().skillCandidates.length, 0);
  });

  it("extracts procedure steps from multi-app trail", () => {
    const candidate = extractProcedureFromTrail(
      [
        {
          capturedAt: "2026-08-07T12:00:00.000Z",
          appName: "Chrome",
          windowTitle: "github.com/yishu",
        },
        {
          capturedAt: "2026-08-07T12:01:00.000Z",
          appName: "Chrome",
          windowTitle: "Pull requests",
        },
        {
          capturedAt: "2026-08-07T12:02:00.000Z",
          appName: "Codex",
          windowTitle: "yishu",
        },
      ],
      { triggerPhrase: "把这个仓库交给 Codex" },
    );

    assert.equal(candidate.status, "candidate");
    assert.ok(candidate.steps.length >= 2);
    assert.equal(candidate.steps[0]?.kind, "resolve");
    assert.ok(candidate.steps.some((s) => s.kind === "act"));
    assert.equal(candidate.triggerPhrase, "把这个仓库交给 Codex");
  });

  it("fails closed before skill persistence when trail text contains secrets", () => {
    assert.throws(
      () => extractProcedureFromTrail([
        {
          capturedAt: "2026-08-07T12:00:00.000Z",
          appName: "Chrome",
          windowTitle: "https://example.test/?token=TRAIL_SECRET_12345",
          axPreview: "password=AX_SECRET_12345",
        },
      ]),
      (error: unknown) =>
        error instanceof Error && error.message === SENSITIVE_CONTENT_REJECTED,
    );
    assert.throws(
      () => extractProcedureFromTrail([
        {
          capturedAt: "2026-08-07T12:00:00.000Z",
          appName: "Chrome",
          url: "https://user:URL_SECRET_12345@example.test/private",
        },
      ]),
      (error: unknown) =>
        error instanceof Error && error.message === SENSITIVE_CONTENT_REJECTED,
    );
  });

  it("keeps ordinary Secret Manager policy text out of the rejection path", () => {
    const candidate = extractProcedureFromTrail([
      {
        capturedAt: "2026-08-07T12:00:00.000Z",
        appName: "Chrome",
        windowTitle: "打开 Secret Manager；政策是禁止保存 screenshot 或 system prompt",
        axPreview: "普通可见文本",
      },
    ]);
    assert.match(candidate.steps[0]?.description ?? "", /Secret Manager/);
    assert.ok(!JSON.stringify(candidate).includes("[redacted]"));
  });

  it("persists to yishu-store.json on disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-store-"));
    const store = new YishuStore(dir);
    await store.load();
    await store.addMemory({
      claim: "disk claim",
      source: "system",
      capturedAt: new Date().toISOString(),
      scope: "global",
      confidence: 0.7,
      lastConfirmedAt: new Date().toISOString(),
      supersedes: null,
      tags: [],
    });

    const raw = await readFile(path.join(dir, "yishu-store.json"), "utf8");
    const parsed = JSON.parse(raw) as { memories: Array<{ claim: string }> };
    assert.equal(parsed.memories[0]?.claim, "disk claim");
  });

  it("serializes concurrent JSON task writes without losing durable truth", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-store-concurrent-"));
    const store = new YishuStore(dir);
    const projector = new TaskTruthProjector(store);
    const taskCount = 50;

    await Promise.all(Array.from({ length: taskCount }, (_, index) => (
      projector.record({
        taskId: `task-${index}`,
        title: `任务 ${index}`,
        kind: "start",
        observedAt: new Date(Date.UTC(2026, 7, 8, 0, 0, index)).toISOString(),
        evidence: `runtime:tool.started:event-${index}:test`,
      })
    )));
    await projector.flush();

    assert.equal((await store.listTasks()).length, taskCount);
    const raw = await readFile(path.join(dir, "yishu-store.json"), "utf8");
    assert.equal((JSON.parse(raw) as { tasks: unknown[] }).tasks.length, taskCount);

    const reopened = new YishuStore(dir);
    assert.equal((await reopened.listTasks()).length, taskCount);
  });

  it("grants and checks mandates", async () => {
    const store = new InMemoryYishuStore();
    await store.grantMandate({
      actionName: "send_message",
      scope: "global",
      note: "standing allow for external messages",
    });
    assert.equal(await store.hasMandate("send_message"), true);
    assert.equal(await store.hasMandate("purchase"), false);
    assert.equal(await store.hasMandate("*"), false);

    await store.grantMandate({ actionName: "*", scope: "global" });
    assert.equal(await store.hasMandate("purchase"), true);
  });
});
