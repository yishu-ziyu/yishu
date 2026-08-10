import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  InMemoryYishuStore,
  MEMORY_LIST_SUMMARY_MAX,
  SqliteYishuStore,
  YishuStore,
} from "../src/index.js";

async function seedPersonalAndProject(store: {
  addMemory: (input: {
    claim: string;
    source: "conversation";
    capturedAt: string;
    scope: string;
    confidence: number;
    lastConfirmedAt: string;
    supersedes: null;
    tags: string[];
  }) => Promise<{ id: string; claim: string; scope: string }>;
}) {
  const now = new Date().toISOString();
  const personalA = await store.addMemory({
    claim: "验收用个人偏好A：回答先给结论",
    source: "conversation",
    capturedAt: "2026-08-08T10:00:00.000Z",
    scope: "personal",
    confidence: 0.95,
    lastConfirmedAt: "2026-08-08T10:00:00.000Z",
    supersedes: null,
    tags: [],
  });
  const personalB = await store.addMemory({
    claim: "验收用个人偏好B：列表摘要硬上限测试" + "字".repeat(120),
    source: "conversation",
    capturedAt: "2026-08-08T12:00:00.000Z",
    scope: "personal",
    confidence: 0.9,
    lastConfirmedAt: "2026-08-08T12:00:00.000Z",
    supersedes: null,
    tags: [],
  });
  const project = await store.addMemory({
    claim: "项目记忆不应出现在我的列表",
    source: "conversation",
    capturedAt: now,
    scope: "project:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    confidence: 0.9,
    lastConfirmedAt: now,
    supersedes: null,
    tags: [],
  });
  return { personalA, personalB, project };
}

describe("memory list + forget (product UI path)", () => {
  it("lists personal only, newest first, with summary cap (memory)", async () => {
    const store = new InMemoryYishuStore();
    const seeded = await seedPersonalAndProject(store);
    const listed = await store.listMemories({ scope: "personal", limit: 50 });
    assert.equal(listed.length, 2);
    assert.equal(listed[0]?.id, seeded.personalB.id);
    assert.equal(listed[1]?.id, seeded.personalA.id);
    assert.ok((listed[0]?.summary.length ?? 0) <= MEMORY_LIST_SUMMARY_MAX);
    assert.equal(
      listed.some((row) => row.id === seeded.project.id),
      false,
    );
  });

  it("hard-forgets by exact id + scope; missing is stable (memory)", async () => {
    const store = new InMemoryYishuStore();
    const seeded = await seedPersonalAndProject(store);

    const mismatch = await store.forgetMemory(seeded.project.id, {
      expectedScope: "personal",
    });
    assert.equal(mismatch, null);
    assert.equal(
      (await store.searchMemory("", { scope: seeded.project.scope })).length,
      1,
    );

    const gone = await store.forgetMemory(seeded.personalA.id, {
      expectedScope: "personal",
    });
    assert.equal(gone?.forgotten, true);
    assert.equal(gone?.alreadyGone, false);
    assert.equal((await store.searchMemory("", { scope: "personal" })).length, 1);
    assert.equal(
      (await store.listMemories({ scope: "personal" })).some(
        (row) => row.id === seeded.personalA.id,
      ),
      false,
    );
    // Body no longer in snapshot.
    assert.equal(
      store.getSnapshot().memories.some((m) => m.id === seeded.personalA.id),
      false,
    );

    const again = await store.forgetMemory(seeded.personalA.id, {
      expectedScope: "personal",
    });
    assert.equal(again?.alreadyGone, true);
    assert.equal(again?.forgotten, true);
  });

  it("lists and forgets on sqlite backend", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-memory-list-"));
    const store = new SqliteYishuStore(path.join(dir, "yishu.sqlite"));
    try {
      const seeded = await seedPersonalAndProject(store);
      const listed = await store.listMemories({ scope: "personal" });
      assert.equal(listed.length, 2);
      assert.equal(listed[0]?.id, seeded.personalB.id);

      const result = await store.forgetMemory(seeded.personalB.id, {
        expectedScope: "personal",
      });
      assert.equal(result?.forgotten, true);
      assert.equal((await store.listMemories({ scope: "personal" })).length, 1);
      assert.equal(
        (await store.searchMemory("列表摘要", { scope: "personal" })).length,
        0,
      );
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips real injected sensitive claim text from personal list (memory + SQLite)", async () => {
    const now = new Date().toISOString();
    const toxicId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const toxicClaim = "api_key=sk-this-should-not-list-ABCDEF";

    // In-memory live inject (not a getSnapshot clone).
    const mem = new InMemoryYishuStore();
    await mem.addMemory({
      claim: "正常可见偏好",
      source: "conversation",
      capturedAt: now,
      scope: "personal",
      confidence: 0.9,
      lastConfirmedAt: now,
      supersedes: null,
      tags: [],
    });
    mem.injectUncheckedMemoryForTests({
      id: toxicId,
      claim: toxicClaim,
      source: "conversation",
      capturedAt: now,
      scope: "personal",
      confidence: 0.9,
      lastConfirmedAt: now,
      supersedes: null,
      tags: [],
    });
    assert.equal(
      mem.getSnapshot().memories.some((m) => m.id === toxicId),
      true,
      "inject must land in live store",
    );
    const listedMem = await mem.listMemories({ scope: "personal" });
    assert.equal(listedMem.length, 1);
    assert.equal(listedMem[0]?.summary.includes("正常可见"), true);
    assert.equal(listedMem.some((row) => /api_key|sk-this/i.test(row.summary)), false);

    // Real SQLite inject: bypass write guards via raw INSERT, reopen, list.
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-sqlite-sensitive-"));
    const dbPath = path.join(dir, "yishu.sqlite");
    try {
      const store = new SqliteYishuStore(dbPath);
      await store.addMemory({
        claim: "SQLite可见偏好",
        source: "conversation",
        capturedAt: now,
        scope: "personal",
        confidence: 0.9,
        lastConfirmedAt: now,
        supersedes: null,
        tags: [],
      });
      store.close();

      const db = new DatabaseSync(dbPath);
      db.prepare(
        `INSERT INTO memories (
          id, claim, source, captured_at, scope, confidence,
          last_confirmed_at, supersedes, tags_json, retired_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        toxicId,
        toxicClaim,
        "conversation",
        now,
        "personal",
        0.9,
        now,
        null,
        "[]",
        null,
      );
      db.close();

      const reopened = new SqliteYishuStore(dbPath);
      try {
        // Prove the toxic row is on disk (raw SQL) without requiring getSnapshot
        // to accept credential-shaped claims (write/snapshot path stays strict).
        const db2 = new DatabaseSync(dbPath);
        const toxicRow = db2
          .prepare(`SELECT claim FROM memories WHERE id = ?`)
          .get(toxicId) as { claim: string } | undefined;
        db2.close();
        assert.equal(toxicRow?.claim, toxicClaim, "SQLite inject must land on disk");

        const listed = await reopened.listMemories({ scope: "personal" });
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.summary.includes("SQLite可见"), true);
        assert.equal(
          listed.some((row) => /api_key|sk-this/i.test(row.summary)),
          false,
        );
      } finally {
        reopened.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("JSON backend: hard-forget survives reopen; project stays; alreadyGone stable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-json-forget-"));
    const file = path.join(dir, "yishu-store.json");
    try {
      const store = new YishuStore(dir);
      await store.load();
      const seeded = await seedPersonalAndProject(store);
      await store.save();

      // Prove file on disk has both personal rows before forget.
      const beforeRaw = JSON.parse(await readFile(file, "utf8")) as {
        memories: Array<{ id: string; claim: string; scope: string }>;
      };
      assert.equal(
        beforeRaw.memories.filter((m) => m.scope === "personal").length,
        2,
      );
      assert.equal(
        beforeRaw.memories.some((m) => m.id === seeded.project.id),
        true,
      );

      const gone = await store.forgetMemory(seeded.personalA.id, {
        expectedScope: "personal",
      });
      assert.equal(gone?.forgotten, true);
      assert.equal(gone?.alreadyGone, false);
      await store.save();

      // Reopen from disk (JSON restart).
      const reopened = new YishuStore(dir);
      await reopened.load();
      const listed = await reopened.listMemories({ scope: "personal" });
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.id, seeded.personalB.id);
      assert.equal(
        reopened.getSnapshot().memories.some((m) => m.id === seeded.personalA.id),
        false,
      );
      assert.equal(
        (await reopened.searchMemory("项目记忆", {
          scope: seeded.project.scope,
        })).length,
        1,
      );

      const again = await reopened.forgetMemory(seeded.personalA.id, {
        expectedScope: "personal",
      });
      assert.equal(again?.alreadyGone, true);
      assert.equal(again?.forgotten, true);

      // File body must not still contain the forgotten claim text.
      const afterRaw = await readFile(file, "utf8");
      assert.equal(afterRaw.includes(seeded.personalA.claim), false);
      assert.equal(afterRaw.includes("项目记忆不应出现在我的列表"), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("SQLite backend: hard-forget survives reopen", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-sqlite-forget-reopen-"));
    const dbPath = path.join(dir, "yishu.sqlite");
    try {
      const store = new SqliteYishuStore(dbPath);
      const seeded = await seedPersonalAndProject(store);
      const gone = await store.forgetMemory(seeded.personalB.id, {
        expectedScope: "personal",
      });
      assert.equal(gone?.forgotten, true);
      store.close();

      const reopened = new SqliteYishuStore(dbPath);
      try {
        const listed = await reopened.listMemories({ scope: "personal" });
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.id, seeded.personalA.id);
        const again = await reopened.forgetMemory(seeded.personalB.id, {
          expectedScope: "personal",
        });
        assert.equal(again?.alreadyGone, true);
        assert.equal(
          (await reopened.searchMemory("", {
            scope: seeded.project.scope,
          })).length,
          1,
        );
      } finally {
        reopened.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
