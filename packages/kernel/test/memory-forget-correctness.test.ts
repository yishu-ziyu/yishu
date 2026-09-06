import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createYishuKernel,
  isVisibleFactSuppressed,
  normalizeVisibleFact,
  type MemoryClaim,
  type YishuKernel,
} from "../src/index.js";
import {
  FORGET_FIXTURE_CLAIM,
  FORGET_FIXTURE_OTHER,
  FORGET_FIXTURE_TRUTH_CLAIM,
  measureMemoryForgetFitness,
} from "./memory-forget-harness.js";

const PROJECT_SCOPE = "project:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function withDir(
  prefix: string,
  run: (dir: string, kernel: YishuKernel) => Promise<void>,
  backend: "memory" | "json" = "memory",
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    const kernel = createYishuKernel({
      storeBackend: backend,
      ...(backend === "json" ? { storeDir: dir } : {}),
      memoryDir: path.join(dir, "memory"),
    });
    if (backend !== "memory") await kernel.store.load();
    await run(dir, kernel);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function remember(
  kernel: YishuKernel,
  claim: string,
  scope = "personal",
): Promise<MemoryClaim> {
  const receipt = await kernel.registry.invoke("remember", {
    caller: "ui",
    input: { claim, scope },
  });
  assert.equal(receipt.status, "verified", receipt.message);
  return receipt.output as MemoryClaim;
}

function visibleHas(text: string, claim: string): boolean {
  const key = normalizeVisibleFact(claim);
  return text.split("\n").some((line) => {
    const body = line.replace(/^\s*[-*]\s+/u, "").trim();
    return body.length > 0 && normalizeVisibleFact(body) === key;
  });
}

async function assertFullyForgotten(
  kernel: YishuKernel,
  target: MemoryClaim,
): Promise<void> {
  const active = (await kernel.store.searchMemory("", {
    minConfidence: 0,
  })).some((row) => row.id === target.id);
  assert.equal(active, false);
  const text = await kernel.memory!.visible.readText();
  assert.equal(visibleHas(text, target.claim), false);
  if (target.truthRef !== undefined) {
    const match = /#mem:([^\s]+)$/.exec(target.truthRef);
    const factId = match?.[1] ?? target.id;
    const facts = await kernel.memory!.truth.listFacts(target.scope);
    assert.equal(facts.some((fact) => fact.id === factId), false);
  } else {
    assert.equal((await kernel.memory!.truth.listFacts(target.scope)).length, 0);
  }
  const authority = await kernel.memory!.visible.reconcileAuthority();
  if (target.scope === "personal" && target.truthRef === undefined) {
    assert.equal(isVisibleFactSuppressed(authority, target.claim), true);
  }
  const recalled = await kernel.memories.recall(target.claim, { scope: target.scope });
  assert.equal(recalled.some((row) => row.id === target.id), false);
  assert.equal(
    recalled.some((row) => normalizeVisibleFact(row.claim) === normalizeVisibleFact(target.claim)),
    false,
  );
}

describe("memory forget correctness", () => {
  it("fitness functions are at target", async () => {
    const report = await measureMemoryForgetFitness();
    assert.equal(
      report.falsePositiveSuccesses,
      0,
      report.details.join("; "),
    );
    assert.equal(report.nonConvergentRetries, 0, report.details.join("; "));
    assert.equal(report.mutationPaths, 1, report.paths.join(", "));
  });

  it("happy path: remember then forget through both entry points", async () => {
    await withDir("yishu-forget-happy-", async (_dir, kernel) => {
      const remembered = await remember(kernel, FORGET_FIXTURE_CLAIM);
      assert.match(await kernel.memory!.visible.readText(), /钥匙放在抽屉第二格/u);
      assert.equal(remembered.truthRef, undefined);

      const viaAction = await kernel.registry.invoke("forget", {
        caller: "ui",
        input: { memoryId: remembered.id },
      });
      assert.equal(viaAction.status, "verified", viaAction.message);
      await assertFullyForgotten(kernel, remembered);

      const again = await kernel.memories.forget({
        id: remembered.id,
        expectedScope: "personal",
      });
      assert.equal(again?.alreadyGone, true);
      await assertFullyForgotten(kernel, remembered);
    });
  });

  it("visible-authority failure is not success and retry converges", async () => {
    await withDir("yishu-forget-visible-fail-", async (_dir, kernel) => {
      const remembered = await remember(kernel, FORGET_FIXTURE_CLAIM);
      const other = await remember(kernel, FORGET_FIXTURE_OTHER);
      const original = kernel.memory!.visible.removeFactsMatching.bind(
        kernel.memory!.visible,
      );
      kernel.memory!.visible.removeFactsMatching = async () => {
        throw new Error("injected visible remove failure");
      };
      const failed = await kernel.registry.invoke("forget", {
        caller: "ui",
        input: { memoryId: remembered.id },
      });
      assert.notEqual(failed.status, "verified");
      assert.notEqual(failed.status, "ok");
      assert.equal(
        visibleHas(await kernel.memory!.visible.readText(), FORGET_FIXTURE_CLAIM),
        true,
      );
      assert.ok(
        (await kernel.store.searchMemory("", { minConfidence: 0 }))
          .some((row) => row.id === remembered.id),
      );

      kernel.memory!.visible.removeFactsMatching = original;
      const retried = await kernel.registry.invoke("forget", {
        caller: "ui",
        input: { memoryId: remembered.id },
      });
      assert.equal(retried.status, "verified", retried.message);
      await assertFullyForgotten(kernel, remembered);
      assert.equal(
        visibleHas(await kernel.memory!.visible.readText(), FORGET_FIXTURE_OTHER),
        true,
      );
      assert.ok(
        (await kernel.store.searchMemory("", { minConfidence: 0 }))
          .some((row) => row.id === other.id),
      );
    });
  });

  it("visible write-then-throw still retries to completion", async () => {
    await withDir("yishu-forget-visible-after-write-", async (_dir, kernel) => {
      const remembered = await remember(kernel, FORGET_FIXTURE_CLAIM);
      const original = kernel.memory!.visible.removeFactsMatching.bind(
        kernel.memory!.visible,
      );
      kernel.memory!.visible.removeFactsMatching = async (claim) => {
        await original(claim);
        throw new Error("injected visible post-write failure");
      };
      const failed = await kernel.memories.forget({
        id: remembered.id,
        expectedScope: "personal",
      }).catch((error: unknown) => error);
      assert.ok(failed instanceof Error);
      assert.ok(
        (await kernel.store.searchMemory("", { minConfidence: 0 }))
          .some((row) => row.id === remembered.id),
        "store provenance must remain after visible-layer failure",
      );
      kernel.memory!.visible.removeFactsMatching = original;
      const retried = await kernel.memories.forget({
        id: remembered.id,
        expectedScope: "personal",
      });
      assert.equal(retried?.forgotten, true);
      await assertFullyForgotten(kernel, remembered);
    });
  });

  it("legacy Truth failure is not success and retry converges", async () => {
    await withDir("yishu-forget-truth-fail-", async (_dir, kernel) => {
      const now = "2026-09-06T00:00:00.000Z";
      const factId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      await kernel.memory!.truth.upsertFact("personal", {
        id: factId,
        claim: FORGET_FIXTURE_TRUTH_CLAIM,
        source: "conversation",
        capturedAt: now,
        confirmedAt: now,
      });
      const stored = await kernel.store.addMemory({
        claim: FORGET_FIXTURE_TRUTH_CLAIM,
        source: "conversation",
        capturedAt: now,
        scope: "personal",
        confidence: 0.9,
        lastConfirmedAt: now,
        supersedes: null,
        tags: [],
        truthRef: kernel.memory!.truth.truthRefFor("personal", factId),
      });
      const original = kernel.memory!.truth.removeFact.bind(kernel.memory!.truth);
      kernel.memory!.truth.removeFact = async () => {
        throw new Error("injected truth remove failure");
      };
      const failed = await kernel.registry.invoke("forget", {
        caller: "ui",
        input: { memoryId: stored.id },
      });
      assert.notEqual(failed.status, "verified");
      assert.ok(
        (await kernel.memory!.truth.listFacts("personal")).some((fact) => fact.id === factId),
      );
      kernel.memory!.truth.removeFact = original;
      const retried = await kernel.memories.forget({
        id: stored.id,
        expectedScope: "personal",
      });
      assert.equal(retried?.forgotten, true);
      await assertFullyForgotten(kernel, stored);
    });
  });

  it("store mutation failure is not success and retry converges", async () => {
    await withDir("yishu-forget-store-fail-", async (_dir, kernel) => {
      const remembered = await remember(kernel, FORGET_FIXTURE_CLAIM);
      const original = kernel.store.forgetMemory.bind(kernel.store);
      kernel.store.forgetMemory = async () => {
        throw new Error("injected store forget failure");
      };
      const failed = await kernel.registry.invoke("forget", {
        caller: "ui",
        input: { memoryId: remembered.id },
      });
      assert.notEqual(failed.status, "verified");
      assert.ok(
        (await kernel.store.searchMemory("", { minConfidence: 0 }))
          .some((row) => row.id === remembered.id),
      );
      kernel.store.forgetMemory = original;
      const retried = await kernel.memories.forget({
        id: remembered.id,
        expectedScope: "personal",
      });
      assert.equal(retried?.forgotten, true);
      await assertFullyForgotten(kernel, remembered);
    });
  });

  it("partial failure then JSON reopen still converges", async () => {
    await withDir("yishu-forget-reopen-", async (dir, kernel) => {
      const remembered = await remember(kernel, FORGET_FIXTURE_CLAIM);
      kernel.memory!.visible.removeFactsMatching = async () => {
        throw new Error("injected visible remove failure");
      };
      await kernel.memories.forget({
        id: remembered.id,
        expectedScope: "personal",
      }).catch(() => undefined);
      const memoryDir = path.join(dir, "memory");
      const reopened = createYishuKernel({
        storeBackend: "json",
        storeDir: dir,
        memoryDir,
      });
      await reopened.store.load();
      assert.ok(
        (await reopened.store.searchMemory("", { minConfidence: 0 }))
          .some((row) => row.id === remembered.id),
      );
      const retried = await reopened.memories.forget({
        id: remembered.id,
        expectedScope: "personal",
      });
      assert.equal(retried?.forgotten, true);
      await assertFullyForgotten(reopened, remembered);
    }, "json");
  });

  it("scope mismatch mutates nothing", async () => {
    await withDir("yishu-forget-scope-", async (_dir, kernel) => {
      const remembered = await remember(kernel, FORGET_FIXTURE_CLAIM);
      const mismatch = await kernel.memories.forget({
        id: remembered.id,
        expectedScope: PROJECT_SCOPE,
      });
      assert.equal(mismatch, null);
      assert.equal(
        visibleHas(await kernel.memory!.visible.readText(), FORGET_FIXTURE_CLAIM),
        true,
      );
      assert.ok(
        (await kernel.store.searchMemory("", { scope: "personal", minConfidence: 0 }))
          .some((row) => row.id === remembered.id),
      );
    });
  });

  it("forgetting one similar visible fact leaves the other", async () => {
    await withDir("yishu-forget-similar-", async (_dir, kernel) => {
      const first = await remember(kernel, FORGET_FIXTURE_CLAIM);
      await remember(kernel, FORGET_FIXTURE_OTHER);
      const forgotten = await kernel.memories.forget({
        id: first.id,
        expectedScope: "personal",
      });
      assert.equal(forgotten?.alreadyGone, false);
      const text = await kernel.memory!.visible.readText();
      assert.equal(visibleHas(text, FORGET_FIXTURE_CLAIM), false);
      assert.equal(visibleHas(text, FORGET_FIXTURE_OTHER), true);
    });
  });

  it("cancellation after a partial visible mutation is not success and stays retryable", async () => {
    await withDir("yishu-forget-cancel-", async (_dir, kernel) => {
      const remembered = await remember(kernel, FORGET_FIXTURE_CLAIM);
      const controller = new AbortController();
      const original = kernel.store.forgetMemory.bind(kernel.store);
      kernel.store.forgetMemory = async () => {
        controller.abort("cancel after visible");
        const error = new Error("memory forget cancelled");
        error.name = "AbortError";
        throw error;
      };
      const cancelled = await kernel.registry.invoke("forget", {
        caller: "ui",
        input: { memoryId: remembered.id },
        signal: controller.signal,
      });
      assert.ok(
        cancelled.status === "cancelled" || cancelled.status === "cancelled_after_commit",
      );
      assert.notEqual(cancelled.status, "verified");
      kernel.store.forgetMemory = original;
      const retried = await kernel.registry.invoke("forget", {
        caller: "ui",
        input: { memoryId: remembered.id },
      });
      assert.equal(retried.status, "verified", retried.message);
      await assertFullyForgotten(kernel, remembered);
    });
  });

  it("action registry and MemoryLedger share one semantic owner", async () => {
    await withDir("yishu-forget-owner-", async (_dir, kernel) => {
      const remembered = await remember(kernel, FORGET_FIXTURE_CLAIM);
      kernel.memory!.visible.removeFactsMatching = async () => {
        throw new Error("injected visible remove failure");
      };
      const actionStatus = await kernel.registry.invoke("forget", {
        caller: "ui",
        input: { memoryId: remembered.id },
      });
      const ledgerResult = await kernel.memories.forget({
        id: remembered.id,
        expectedScope: "personal",
      }).catch((error: unknown) => error);
      assert.notEqual(actionStatus.status, "verified");
      assert.ok(ledgerResult instanceof Error);
      const report = await measureMemoryForgetFitness();
      assert.equal(report.mutationPaths, 1);
    });
  });
});
