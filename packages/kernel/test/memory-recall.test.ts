import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MEMORY_RECALL_MAX_ITEMS,
  contentTokens,
  recallRelevantMemories,
} from "../src/memory/index.js";
import { createInMemoryStore } from "../src/store/index.js";

async function seed(
  scope: string,
  claim: string,
  extras?: Partial<{
    source: "conversation" | "user_correction" | "observation" | "skill_verify" | "system";
    confidence: number;
    retiredAt: string;
    tags: string[];
  }>,
) {
  const store = createInMemoryStore();
  const now = "2026-08-08T10:00:00.000Z";
  const memory = await store.addMemory({
    claim,
    source: extras?.source ?? "conversation",
    capturedAt: now,
    scope,
    confidence: extras?.confidence ?? 0.9,
    lastConfirmedAt: now,
    supersedes: null,
    tags: extras?.tags ?? [],
    ...(extras?.retiredAt !== undefined ? { retiredAt: extras.retiredAt } : {}),
  });
  return { store, memory };
}

describe("recallRelevantMemories", () => {
  it("recalls related personal preference for a style question", async () => {
    const { store, memory } = await seed("personal", "验收回答先给结论");
    const hits = await recallRelevantMemories(store, "我希望你怎么回答？", {
      scope: "personal",
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.id, memory.id);
    assert.match(hits[0]?.claim ?? "", /验收回答先给结论/);
    assert.equal(hits[0]?.source, "conversation");
    assert.equal(hits[0]?.scope, "personal");
  });

  it("does not hard-force unrelated questions", async () => {
    const { store } = await seed("personal", "验收回答先给结论");
    const hits = await recallRelevantMemories(store, "今天北京的天气怎么样？", {
      scope: "personal",
    });
    assert.equal(hits.length, 0);
  });

  it("isolates personal and project scopes", async () => {
    const store = createInMemoryStore();
    const now = "2026-08-08T10:00:00.000Z";
    await store.addMemory({
      claim: "验收回答先给结论",
      source: "conversation",
      capturedAt: now,
      scope: "personal",
      confidence: 0.9,
      lastConfirmedAt: now,
      supersedes: null,
      tags: [],
    });
    await store.addMemory({
      claim: "验收回答先给结论",
      source: "conversation",
      capturedAt: now,
      scope: "project:11111111-1111-4111-8111-111111111111",
      confidence: 0.9,
      lastConfirmedAt: now,
      supersedes: null,
      tags: [],
    });

    const personal = await recallRelevantMemories(store, "我希望你怎么回答", {
      scope: "personal",
    });
    const project = await recallRelevantMemories(store, "我希望你怎么回答", {
      scope: "project:11111111-1111-4111-8111-111111111111",
    });
    const other = await recallRelevantMemories(store, "我希望你怎么回答", {
      scope: "project:22222222-2222-4222-8222-222222222222",
    });

    assert.equal(personal.length, 1);
    assert.equal(personal[0]?.scope, "personal");
    assert.equal(project.length, 1);
    assert.equal(project[0]?.scope, "project:11111111-1111-4111-8111-111111111111");
    assert.equal(other.length, 0);
  });

  it("never recalls retired memories", async () => {
    const store = createInMemoryStore();
    const now = "2026-08-08T10:00:00.000Z";
    const memory = await store.addMemory({
      claim: "验收回答先给结论",
      source: "conversation",
      capturedAt: now,
      scope: "personal",
      confidence: 0.9,
      lastConfirmedAt: now,
      supersedes: null,
      tags: [],
    });
    await store.retireMemory(memory.id);

    const hits = await recallRelevantMemories(store, "我希望你怎么回答", {
      scope: "personal",
    });
    assert.equal(hits.length, 0);
  });

  it("filters credential-shaped claims from recall", async () => {
    const store = createInMemoryStore();
    // addMemory rejects secrets; inject a poison row only through the search port.
    const poisonStore = {
      searchMemory: async () => [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          claim: "api_key=sk-DO_NOT_RECALL_THIS_SECRET_VALUE",
          source: "conversation" as const,
          capturedAt: "2026-08-08T10:00:00.000Z",
          scope: "personal",
          confidence: 0.95,
          lastConfirmedAt: "2026-08-08T10:00:00.000Z",
          supersedes: null,
          tags: ["secret"],
        },
      ],
    };

    const hits = await recallRelevantMemories(
      poisonStore as typeof store,
      "api key preference",
      { scope: "personal" },
    );
    assert.equal(hits.length, 0);
  });

  it("caps at three related memories and total length", async () => {
    const store = createInMemoryStore();
    const now = "2026-08-08T10:00:00.000Z";
    for (let i = 0; i < 5; i += 1) {
      await store.addMemory({
        claim: `验收回答先给结论 变体${i} ${"偏".repeat(40)}`,
        source: "conversation",
        capturedAt: now,
        scope: "personal",
        confidence: 0.9 - i * 0.01,
        lastConfirmedAt: now,
        supersedes: null,
        tags: ["style"],
      });
    }
    const hits = await recallRelevantMemories(store, "回答 结论 验收", {
      scope: "personal",
      maxClaimChars: 40,
      maxTotalChars: 90,
    });
    assert.ok(hits.length <= MEMORY_RECALL_MAX_ITEMS);
    assert.ok(hits.length <= 3);
    const total = hits.reduce((sum, row) => sum + row.claim.length, 0);
    assert.ok(total <= 90);
    for (const hit of hits) {
      assert.ok(hit.claim.length <= 40);
    }
  });

  it("contentTokens drops stopwords but keeps distinctive bigrams", () => {
    const tokens = contentTokens("我希望你怎么回答");
    assert.ok(tokens.includes("回答"));
    assert.ok(!tokens.includes("怎么"));
    assert.ok(!tokens.includes("希望"));
  });
});
