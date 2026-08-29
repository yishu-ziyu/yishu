/**
 * Write-side memory P1 smokes.
 * Covers: episode idempotence, candidate→sensitivity→active gating, greeting
 * prefilter, confirm-bump dedupe, deterministic-id crash replay, and the
 * private-scope/queue boundary types.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createYishuKernel } from "../src/kernel.js";
import {
  InMemoryExtractionQueue,
  assertMemoryPathWithinRoot,
  memoryScopeSlug,
  runExtractionPass,
  isGreetingUtterance,
  type MemoryExtractionModel,
  type ExtractionSnapshot,
} from "../src/memory/index.js";
import { MemoryTruthLayer } from "../src/memory/truth-layer.js";
import type { MemoryClaim } from "../src/store/types.js";

const CAPTURED_AT = "2026-08-15T10:42:00.000Z";

function snapshot(overrides: Partial<ExtractionSnapshot> = {}): ExtractionSnapshot {
  return {
    turnId: "11111111-1111-1111-1111-111111111111",
    conversationId: "conv-1",
    scopeKey: "personal",
    utterance: "我以后都用要点列表回答我。",
    replyText: "好的，之后都用要点列表。",
    providerId: "openai",
    modelId: "gpt-test",
    capturedAt: CAPTURED_AT,
    ...overrides,
  };
}

// Scripted extraction model: records provider/model per call for assertions.
function scriptedModel(
  output: { newFacts: string[]; confirmedFactIds: string[] },
  calls: string[] = [],
): MemoryExtractionModel {
  return {
    async extract(input) {
      calls.push(`${input.providerId}/${input.modelId}`);
      return output;
    },
  };
}

async function makeDeps(t: TestContext) {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "yishu-memory-p1-"));
  t.after(() => rm(memoryDir, { recursive: true, force: true }));
  const kernel = createYishuKernel({ storeBackend: "memory", memoryDir });
  assert.ok(kernel.memory !== undefined, "memory layer must be wired with memoryDir");
  return { kernel, memory: kernel.memory! };
}

test("memory layer exposes the extraction-only store port", async (t) => {
  const { memory } = await makeDeps(t);
  const capturedAt = "2026-08-15T10:42:00.000Z";
  const claim = await memory.extraction.addExtractedMemory({
    claim: "用户偏好要点列表",
    capturedAt,
    scope: "personal",
    confidence: 0.6,
    lastConfirmedAt: capturedAt,
    supersedes: null,
    tags: [],
  });
  assert.equal(claim.source, "extraction");

  const existing = await memory.extraction.searchExistingClaims("personal");
  assert.deepEqual(existing.map((row) => row.id), [claim.id]);
  assert.equal(
    await memory.extraction.confirmMemory(claim.id, "2026-08-16T10:42:00.000Z"),
    true,
  );
});

test("episode append is idempotent per turn id (crash replay safe)", async (t) => {
  const { memory } = await makeDeps(t);
  const entry = {
    turnId: "turn-abc",
    scopeKey: "personal",
    utterance: "你好",
    replyText: "你好！",
    capturedAt: CAPTURED_AT,
  };
  assert.equal(await memory.truth.appendEpisode(entry), true);
  assert.equal(await memory.truth.appendEpisode(entry), false, "replay appends nothing");
  const file = await readFile(
    path.join(memory.truth.root, "personal", "episodes", "2026-08-15.md"),
    "utf8",
  );
  assert.match(file, /\[turn:turn-abc\] U: 你好 A: 你好！/);
  assert.equal(file.match(/turn:turn-abc/g)?.length, 1);
});

test("pipeline writes episode + active fact with truthRef, then replay adds nothing", async (t) => {
  const { kernel, memory } = await makeDeps(t);
  const queue = new InMemoryExtractionQueue();
  await queue.enqueue(snapshot());
  const calls: string[] = [];
  const stats = await runExtractionPass({
    queue,
    truth: memory.truth,
    store: memory.extraction,
    model: scriptedModel({ newFacts: ["用户偏好要点列表"], confirmedFactIds: [] }, calls),
    visible: memory.visible,
  });
  assert.deepEqual(stats, { processed: 1, skippedModel: 0, discardedSensitive: 0, failed: 0 });
  assert.deepEqual(calls, ["openai/gpt-test"], "extraction follows the turn's provider/model");

  const claims = await kernel.store.searchMemory("", { scope: "personal", minConfidence: 0 });
  assert.equal(claims.length, 1);
  assert.equal(claims[0]!.source, "extraction");
  assert.match(claims[0]!.truthRef ?? "", /^personal\/facts\/preferences\.md#mem:fx-/);
  const factsFile = await readFile(
    path.join(memory.truth.root, "personal", "facts", "preferences.md"),
    "utf8",
  );
  assert.match(factsFile, /用户偏好要点列表/);
  const visibleFile = await readFile(memory.visible.filePath, "utf8");
  assert.match(visibleFile, /用户偏好要点列表/);

  // Crash replay: re-enqueue is a no-op; a second pass over the same row
  // cannot duplicate the fact (deterministic fx- id -> confirm, not create).
  await queue.enqueue(snapshot());
  await queue.requeue(snapshot().turnId, CAPTURED_AT);
  await runExtractionPass({
    queue,
    truth: memory.truth,
    store: memory.extraction,
    model: scriptedModel({ newFacts: ["用户偏好要点列表"], confirmedFactIds: [] }),
  });
  const after = await kernel.store.searchMemory("", { scope: "personal", minConfidence: 0 });
  assert.equal(after.length, 1, "deterministic fact ids prevent replay duplication");
  const factsAfter = await memory.truth.listFacts("personal");
  assert.equal(factsAfter.length, 1);
});

test("greeting turns skip the model but keep their episode", async (t) => {
  const { kernel, memory } = await makeDeps(t);
  assert.ok(isGreetingUtterance(" 谢谢 "));
  const queue = new InMemoryExtractionQueue();
  await queue.enqueue(snapshot({ turnId: "turn-greet", utterance: "谢谢", replyText: "不客气。" }));
  const calls: string[] = [];
  const stats = await runExtractionPass({
    queue,
    truth: memory.truth,
    store: memory.extraction,
    model: scriptedModel({ newFacts: ["x"], confirmedFactIds: [] }, calls),
  });
  assert.equal(stats.skippedModel, 1);
  assert.deepEqual(calls, [], "no model call for small talk");
  const episode = await readFile(
    path.join(memory.truth.root, "personal", "episodes", "2026-08-15.md"),
    "utf8",
  );
  assert.match(episode, /turn:turn-greet/);
  assert.equal((await kernel.store.searchMemory("", { minConfidence: 0 })).length, 0);
});

test("sensitive candidates are discarded; nothing reaches markdown or index", async (t) => {
  const { kernel, memory } = await makeDeps(t);
  const queue = new InMemoryExtractionQueue();
  await queue.enqueue(snapshot({ turnId: "turn-secret" }));
  const stats = await runExtractionPass({
    queue,
    truth: memory.truth,
    store: memory.extraction,
    model: scriptedModel({
      newFacts: ["api_key=sk-abcdefgh12345678", "用户喜欢深色模式"],
      confirmedFactIds: [],
    }),
  });
  assert.equal(stats.discardedSensitive, 1);
  assert.equal(stats.failed, 0);
  const claims = await kernel.store.searchMemory("", { minConfidence: 0 });
  assert.equal(claims.length, 1);
  assert.equal(claims[0]!.claim, "用户喜欢深色模式");
  const facts = await memory.truth.listFacts("personal");
  assert.equal(facts.length, 1);
});

test("confirmed_fact_ids bump lastConfirmedAt instead of creating rows", async (t) => {
  const { kernel, memory } = await makeDeps(t);
  // Seed one explicit fact through the single write path.
  await memory.truth.upsertFact("personal", {
    id: "fact-seed",
    claim: "用户在用 Mac",
    source: "conversation",
    capturedAt: "2026-08-01T00:00:00.000Z",
    confirmedAt: "2026-08-01T00:00:00.000Z",
  });
  await kernel.store.addMemory({
    claim: "用户在用 Mac",
    source: "conversation",
    capturedAt: "2026-08-01T00:00:00.000Z",
    scope: "personal",
    confidence: 0.9,
    lastConfirmedAt: "2026-08-01T00:00:00.000Z",
    supersedes: null,
    tags: [],
    truthRef: memory.truth.truthRefFor("personal", "fact-seed"),
  });

  const queue = new InMemoryExtractionQueue();
  await queue.enqueue(snapshot({ turnId: "turn-confirm" }));
  const seeded = await kernel.store.searchMemory("", { scope: "personal", minConfidence: 0 });
  const stats = await runExtractionPass({
    queue,
    truth: memory.truth,
    store: memory.extraction,
    model: scriptedModel({
      newFacts: [],
      confirmedFactIds: [seeded[0]!.id],
    }),
  });
  assert.equal(stats.processed, 1);
  const after = await kernel.store.searchMemory("", { scope: "personal", minConfidence: 0 });
  assert.equal(after.length, 1, "confirmation never creates a second row");
  assert.equal(after[0]!.lastConfirmedAt, CAPTURED_AT);
  const facts = await memory.truth.listFacts("personal");
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.lastConfirmedAt, "2026-08-15");
});

test("model failures retry within bounds and park as failed for replay", async (t) => {
  const { kernel, memory } = await makeDeps(t);
  const queue = new InMemoryExtractionQueue();
  await queue.enqueue(snapshot({ turnId: "turn-fail" }));
  const failing: MemoryExtractionModel = {
    async extract() {
      throw new Error("provider unavailable");
    },
  };
  const first = await runExtractionPass({
    queue, truth: memory.truth, store: memory.extraction, model: failing,
  });
  assert.equal(first.failed, 0, "first failure stays retryable");
  const second = await runExtractionPass({
    queue, truth: memory.truth, store: memory.extraction, model: failing,
  });
  assert.equal(second.failed, 0, "second failure stays retryable");
  const third = await runExtractionPass({
    queue, truth: memory.truth, store: memory.extraction, model: failing,
  });
  assert.equal(third.failed, 1, "third failure parks as failed");
  const row = await queue.getRow("turn-fail");
  assert.equal(row?.status, "failed");
  // Replay after restart: the row is still replayable and now succeeds.
  await queue.requeue("turn-fail", CAPTURED_AT);
  const recovered = await runExtractionPass({
    queue,
    truth: memory.truth,
    store: memory.extraction,
    model: scriptedModel({ newFacts: ["用户回来了"], confirmedFactIds: [] }),
  });
  assert.equal(recovered.failed, 0);
  assert.equal((await queue.getRow("turn-fail"))?.status, "done");
});

test("user-authored markdown lines are preserved by writes", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "yishu-truth-edit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const truth = new MemoryTruthLayer(dir);
  await truth.upsertFact("personal", {
    id: "fact-1",
    claim: "机器写的",
    source: "extraction",
    capturedAt: CAPTURED_AT,
    confirmedAt: CAPTURED_AT,
  });
  const file = path.join(dir, "personal", "facts", "preferences.md");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, "# 手写标题\n\n- 我自己记的笔记\n", "utf8");
  await truth.upsertFact("personal", {
    id: "fact-2",
    claim: "又一条机器写的",
    source: "extraction",
    capturedAt: CAPTURED_AT,
    confirmedAt: CAPTURED_AT,
  });
  const finalText = await readFile(file, "utf8");
  assert.match(finalText, /我自己记的笔记/);
  assert.match(finalText, /又一条机器写的/);
});

test("scope slugs sanitize to single safe path segments", () => {
  assert.equal(memoryScopeSlug("personal"), "personal");
  assert.equal(memoryScopeSlug("project:3f2a-uuid"), "project-3f2a-uuid");
  assert.equal(memoryScopeSlug("../../etc/passwd"), "etc-passwd");
});

test("resolved memory paths must stay inside the truth-layer root", () => {
  const root = path.resolve("/tmp/yishu-memory-root");
  assert.equal(
    assertMemoryPathWithinRoot(root, path.join(root, "personal", "facts", "preferences.md")),
    path.resolve(root, "personal", "facts", "preferences.md"),
  );
  assert.throws(
    () => assertMemoryPathWithinRoot(root, "/etc/passwd"),
    /escapes truth-layer root/,
  );
  assert.throws(
    () => assertMemoryPathWithinRoot(root, path.join(root, "..", "outside.md")),
    /escapes truth-layer root/,
  );
});

test("hostile capturedAt cannot write episode files outside the root", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "yishu-truth-path-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const truth = new MemoryTruthLayer(dir);
  await truth.appendEpisode({
    turnId: "turn-escape",
    scopeKey: "personal",
    utterance: "x",
    replyText: "y",
    capturedAt: "../../../tmp/escape",
  });
  const safe = await readFile(
    path.join(dir, "personal", "episodes", "unknown.md"),
    "utf8",
  );
  assert.match(safe, /\[turn:turn-escape\]/);
});

test("explicit remember writes markdown truth and index truthRef", async (t) => {
  const { kernel, memory } = await makeDeps(t);
  const receipt = await kernel.registry.invoke("remember", {
    caller: "voice",
    input: { claim: "用户偏好要点列表", scope: "personal" },
  });
  assert.equal(receipt.status, "verified");
  const claim = receipt.output as MemoryClaim;
  assert.match(claim.truthRef ?? "", /^personal\/facts\/preferences\.md#mem:/);
  const facts = await memory.truth.listFacts("personal");
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.claim, "用户偏好要点列表");
  const indexed = await kernel.store.searchMemory("", { scope: "personal", minConfidence: 0 });
  assert.equal(indexed.length, 1);
  assert.equal(indexed[0]!.truthRef, claim.truthRef);
});
