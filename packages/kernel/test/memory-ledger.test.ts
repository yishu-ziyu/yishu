import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createYishuKernel,
  type MemoryClaim,
  type YishuKernel,
} from "../src/index.js";

const PROJECT_SCOPE = "project:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function addMemory(
  kernel: YishuKernel,
  claim: string,
  scope: string,
  capturedAt: string,
): Promise<MemoryClaim> {
  return kernel.store.addMemory({
    claim,
    source: "conversation",
    capturedAt,
    scope,
    confidence: 0.95,
    lastConfirmedAt: capturedAt,
    supersedes: null,
    tags: [],
  });
}

describe("MemoryLedger", () => {
  it("owns scoped list, read-back, and recall above the raw store", async () => {
    const kernel = createYishuKernel({ storeBackend: "memory" });
    const personal = await addMemory(
      kernel,
      "回答时先给结论",
      "personal",
      "2026-08-23T08:00:00.000Z",
    );
    await addMemory(
      kernel,
      "这个项目使用蓝色图标",
      PROJECT_SCOPE,
      "2026-08-23T09:00:00.000Z",
    );

    const listed = await kernel.memories.list({ scope: "personal" });
    assert.deepEqual(listed.map((row) => row.id), [personal.id]);
    assert.equal((await kernel.memories.findVisible({
      id: personal.id,
      scope: "personal",
    }))?.summary, "回答时先给结论");

    const recalled = await kernel.memories.recall("回答应该先说什么？", {
      scope: "personal",
    });
    assert.deepEqual(recalled.map((row) => row.id), [personal.id]);
  });

  it("hydrates and forgets through the one visible authority", async () => {
    const memoryDir = await mkdtemp(path.join(tmpdir(), "yishu-memory-ledger-"));
    try {
      const kernel = createYishuKernel({
        storeBackend: "memory",
        memoryDir,
      });
      const claim = await addMemory(
        kernel,
        "不要在回答里堆很多标题",
        "personal",
        "2026-08-23T10:00:00.000Z",
      );

      await kernel.memories.hydrateVisible(["保留这条旧记忆"]);
      const visiblePath = path.join(memoryDir, "记忆.md");
      const hydrated = await readFile(visiblePath, "utf8");
      assert.match(hydrated, /不要在回答里堆很多标题/u);
      assert.match(hydrated, /保留这条旧记忆/u);

      assert.equal(await kernel.memories.forget({
        id: claim.id,
        expectedScope: PROJECT_SCOPE,
      }), null);
      const forgotten = await kernel.memories.forget({
        id: claim.id,
        expectedScope: "personal",
      });
      assert.equal(forgotten?.alreadyGone, false);

      const after = await readFile(visiblePath, "utf8");
      assert.doesNotMatch(after, /不要在回答里堆很多标题/u);
      assert.match(after, /保留这条旧记忆/u);
      assert.equal((await kernel.memories.forget({
        id: claim.id,
        expectedScope: "personal",
      }))?.alreadyGone, true);
    } finally {
      await rm(memoryDir, { recursive: true, force: true });
    }
  });
});
