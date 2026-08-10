import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, beforeEach } from "node:test";
import { clearAuditLog } from "../src/action/index.js";
import { createYishuKernel } from "../src/kernel.js";
import {
  LEARNED_HEADING,
  SEED_MIND,
  applyMindUpdate,
  mindText,
  normalizePatternKey,
  summarizePatternEvidence,
} from "../src/mind/index.js";
import type { MindLearnResult, SuggestionRecord } from "../src/store/types.js";
import { SqliteYishuStore } from "../src/store/sqlite-store.js";

describe("mind document helpers", () => {
  it("tracks the shipped seed until the first write forks it", () => {
    assert.equal(mindText(""), SEED_MIND);
    assert.match(SEED_MIND, new RegExp(`## ${LEARNED_HEADING}`));
  });

  it("appends learned lessons by heading", () => {
    const next = applyMindUpdate(SEED_MIND, {
      changed: true,
      sections: [
        {
          heading: LEARNED_HEADING,
          mode: "append",
          content: "- Prefer short voice replies for this user.",
        },
      ],
    });
    assert.match(next, /Prefer short voice replies/);
    assert.match(next, /## Who you are/);
  });

  it("counts repeated outcomes before learning", () => {
    const once = summarizePatternEvidence(["succeeded"]);
    assert.equal(once.canLearn, false);
    const twice = summarizePatternEvidence(["succeeded", "succeeded"]);
    assert.equal(twice.canLearn, true);
    assert.equal(twice.dominant, "succeeded");
    assert.equal(normalizePatternKey(" Lead With Plan "), "lead-with-plan");
  });
});

describe("suggestion and mind product loop", () => {
  beforeEach(() => {
    clearAuditLog();
  });

  it("records suggestions, settles outcomes, and learns only after two successes", async () => {
    const { registry, store } = createYishuKernel();

    const first = await registry.invoke("record_suggestion", {
      caller: "pi",
      input: {
        patternKey: "lead-with-plan",
        summary: "Propose a concrete Saturday plan",
      },
    });
    assert.equal(first.status, "ok");
    const firstId = (first.output as SuggestionRecord).id;

    const early = await registry.invoke("learn_mind_from_pattern", {
      caller: "system",
      input: { patternKey: "lead-with-plan" },
    });
    assert.equal(early.status, "verified");
    const earlyResult = early.output as MindLearnResult;
    assert.equal(earlyResult.wrote, false);
    assert.equal(earlyResult.reason, "need_2_outcomes");

    const settled1 = await registry.invoke("settle_suggestion", {
      caller: "ui",
      input: { suggestionId: firstId, status: "succeeded" },
    });
    assert.equal(settled1.status, "ok");

    const second = await registry.invoke("record_suggestion", {
      caller: "pi",
      input: {
        patternKey: "lead-with-plan",
        summary: "Propose a concrete Sunday plan",
      },
    });
    const secondId = (second.output as SuggestionRecord).id;
    await registry.invoke("settle_suggestion", {
      caller: "ui",
      input: { suggestionId: secondId, status: "succeeded" },
    });

    const learned = await registry.invoke("learn_mind_from_pattern", {
      caller: "system",
      input: { patternKey: "lead-with-plan" },
    });
    assert.equal(learned.status, "verified");
    const learnedResult = learned.output as MindLearnResult;
    assert.equal(learnedResult.wrote, true);
    assert.ok(learnedResult.lesson);

    const mind = await store.getMind();
    assert.notEqual(mind.markdown.trim(), "");
    assert.match(mind.markdown, /lead-with-plan/);
    assert.match(mind.markdown, new RegExp(LEARNED_HEADING));
    assert.equal((await store.listSuggestions()).length, 2);
  });

  it("persists mind and suggestions through sqlite", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-mind-"));
    const dbPath = path.join(dir, "store.sqlite");
    try {
      const store = new SqliteYishuStore(dbPath);
      const a = await store.addSuggestion({
        patternKey: "ask-one-question",
        summary: "Ask one concrete question",
      });
      await store.recordSuggestionOutcome({
        suggestionId: a.id,
        status: "succeeded",
      });
      const b = await store.addSuggestion({
        patternKey: "ask-one-question",
        summary: "Ask one concrete follow-up",
      });
      await store.recordSuggestionOutcome({
        suggestionId: b.id,
        status: "succeeded",
      });
      const learned = await store.learnMindFromPattern({
        patternKey: "ask-one-question",
      });
      assert.equal(learned.wrote, true);
      store.close();

      const reopened = new SqliteYishuStore(dbPath);
      const mind = await reopened.getMind();
      assert.match(mind.markdown, /ask-one-question/);
      assert.equal((await reopened.listSuggestions()).length, 2);
      reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
