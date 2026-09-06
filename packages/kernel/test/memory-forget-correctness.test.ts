import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createYishuKernel,
  isVisibleFactSuppressed,
  normalizeVisibleFact,
  visibleFactFingerprint,
  type MemoryClaim,
  type YishuKernel,
} from "../src/index.js";
import {
  analyzeForgetMutationPaths,
  FORGET_FIXTURE_CLAIM,
  FORGET_FIXTURE_OTHER,
  FORGET_FIXTURE_TRUTH_CLAIM,
  loadProductionForgetSources,
  measureMemoryForgetFitness,
  receiptPersistBeforeStoreDeletion,
} from "./memory-forget-harness.js";
import {
  FORGET_RECEIPT_FILE_NAME,
  forgetReceiptIO,
} from "../src/memory/forget-receipts.js";

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

      const actionAgain = await kernel.registry.invoke("forget", {
        caller: "ui",
        input: { memoryId: remembered.id },
      });
      assert.equal(actionAgain.status, "verified", actionAgain.message);
    });
  });

  it("legacy store-gone visible residue is not verified through either entry", async () => {
    await withDir("yishu-forget-legacy-residue-", async (_dir, kernel) => {
      const remembered = await remember(kernel, FORGET_FIXTURE_CLAIM);
      const other = await remember(kernel, FORGET_FIXTURE_OTHER);
      await kernel.store.forgetMemory(remembered.id, { expectedScope: "personal" });
      assert.equal(
        visibleHas(await kernel.memory!.visible.readText(), FORGET_FIXTURE_CLAIM),
        true,
      );

      const viaAction = await kernel.registry.invoke("forget", {
        caller: "ui",
        input: { memoryId: remembered.id },
      });
      const viaLedger = await kernel.memories.forget({
        id: remembered.id,
        expectedScope: "personal",
      }).then((result) => result, (error: unknown) => error);

      assert.notEqual(viaAction.status, "verified");
      assert.notEqual(viaAction.status, "ok");
      assert.ok(viaLedger instanceof Error);
      const text = await kernel.memory!.visible.readText();
      assert.equal(visibleHas(text, FORGET_FIXTURE_CLAIM), true);
      assert.equal(visibleHas(text, FORGET_FIXTURE_OTHER), true);
      assert.ok(
        (await kernel.store.searchMemory("", { minConfidence: 0 }))
          .some((row) => row.id === other.id),
      );
    });
  });

  it("completed forget writes a fingerprint receipt and stays alreadyGone after reopen", async () => {
    await withDir("yishu-forget-receipt-reopen-", async (dir, kernel) => {
      const remembered = await remember(kernel, FORGET_FIXTURE_CLAIM);
      const forgotten = await kernel.memories.forget({
        id: remembered.id,
        expectedScope: "personal",
      });
      assert.equal(forgotten?.alreadyGone, false);
      const receiptPath = path.join(dir, "memory", FORGET_RECEIPT_FILE_NAME);
      const raw = await readFile(receiptPath, "utf8");
      assert.equal(raw.includes(FORGET_FIXTURE_CLAIM), false);
      assert.equal(raw.includes(remembered.claim), false);
      assert.equal(raw.includes(remembered.id), true);

      const reopened = createYishuKernel({
        storeBackend: "json",
        storeDir: dir,
        memoryDir: path.join(dir, "memory"),
      });
      await reopened.store.load();
      const again = await reopened.memories.forget({
        id: remembered.id,
        expectedScope: "personal",
      });
      assert.equal(again?.alreadyGone, true);
      await assertFullyForgotten(reopened, remembered);
      const actionAgain = await reopened.registry.invoke("forget", {
        caller: "ui",
        input: { memoryId: remembered.id },
      });
      assert.equal(actionAgain.status, "verified", actionAgain.message);
    }, "json");
  });

  it("receipt persist failure is not success and retry converges after reopen", async () => {
    await withDir("yishu-forget-receipt-fail-", async (dir, kernel) => {
      const remembered = await remember(kernel, FORGET_FIXTURE_CLAIM);
      const original = forgetReceiptIO.write;
      forgetReceiptIO.write = async () => {
        throw new Error("injected receipt persist failure");
      };
      let failed;
      try {
        failed = await kernel.registry.invoke("forget", {
          caller: "ui",
          input: { memoryId: remembered.id },
        });
      } finally {
        forgetReceiptIO.write = original;
      }
      assert.notEqual(failed.status, "verified");
      assert.notEqual(failed.status, "ok");
      assert.ok(
        (await kernel.store.searchMemory("", { minConfidence: 0 }))
          .some((row) => row.id === remembered.id),
        "store provenance must remain after receipt persist failure",
      );

      const reopened = createYishuKernel({
        storeBackend: "json",
        storeDir: dir,
        memoryDir: path.join(dir, "memory"),
      });
      await reopened.store.load();
      const retried = await reopened.memories.forget({
        id: remembered.id,
        expectedScope: "personal",
      });
      assert.equal(retried?.forgotten, true);
      await assertFullyForgotten(reopened, remembered);
      const receiptPath = path.join(dir, "memory", FORGET_RECEIPT_FILE_NAME);
      const raw = await readFile(receiptPath, "utf8");
      assert.equal(raw.includes(FORGET_FIXTURE_CLAIM), false);
      assert.equal(raw.includes(remembered.claim), false);

      const againKernel = createYishuKernel({
        storeBackend: "json",
        storeDir: dir,
        memoryDir: path.join(dir, "memory"),
      });
      await againKernel.store.load();
      const again = await againKernel.memories.forget({
        id: remembered.id,
        expectedScope: "personal",
      });
      assert.equal(again?.alreadyGone, true);
    }, "json");
  });

  it("a prewritten receipt is not success while the store row remains", async () => {
    await withDir("yishu-forget-receipt-active-store-", async (dir, kernel) => {
      const remembered = await remember(kernel, FORGET_FIXTURE_CLAIM);
      await forgetReceiptIO.write(path.join(dir, "memory"), {
        id: remembered.id,
        scope: "personal",
        visibleFingerprint: visibleFactFingerprint(remembered.claim),
      });
      const forgotten = await kernel.memories.forget({
        id: remembered.id,
        expectedScope: "personal",
      });
      assert.equal(forgotten?.alreadyGone, false);
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

  it("evaluator fails if an entry independently decides missing-id success", () => {
    const production = loadProductionForgetSources();
    const owner = production.find((file) => file.role === "owner");
    const ledger = production.find((file) => file.label === "MemoryLedger.forget");
    const runtime = production.find((file) => file.label === "MemoryForgetCommand");
    assert.ok(owner && ledger && runtime);

    const shortcutAction = `
export function createForgetAction(store, truth, visible) {
  return defineYishuAction({
    run: async (ctx) => {
      const existing = store.getSnapshot().memories.find((row) => row.id === ctx.input.memoryId);
      if (existing === undefined) {
        return { id: ctx.input.memoryId, forgotten: true as const, alreadyGone: true, scope: "" };
      }
      return forgetMemoryClaim(ports, { id: ctx.input.memoryId, expectedScope: existing.scope });
    },
  });
}
`;
    const bypassLedger = `
export function createMemoryLedger(store, visible, truth) {
  return {
    async forget(input) {
      const existing = store.getSnapshot().memories.find((row) => row.id === input.id);
      if (existing === undefined) {
        return { id: input.id, forgotten: true, alreadyGone: true };
      }
      return forgetMemoryClaim({ store, visible, truth }, input);
    },
  };
}
`;
    const storeAbsenceVerified = `
export function createForgetAction(store) {
  return defineYishuAction({
    verify: async (ctx) => {
      const existing = store.getSnapshot().memories.find((row) => row.id === ctx.input.memoryId);
      return { verified: existing === undefined };
    },
  });
}
`;
    const storeAbsenceAlreadyGone = `
async function forgetMemory(command, emit) {
  const existing = this.kernel.store.getSnapshot().memories.find((row) => row.id === command.payload.memoryId);
  if (existing === undefined) {
    emit(runtimeEvent("memory.forgotten", command.requestId, command.traceId, {
      memoryId: command.payload.memoryId,
      alreadyGone: true,
    }));
    return;
  }
  const result = await this.kernel.memories.forget({
    id: command.payload.memoryId,
    expectedScope: "personal",
  });
  emit(runtimeEvent("memory.forgotten", command.requestId, command.traceId, {
    alreadyGone: result.alreadyGone,
  }));
}
`;

    const productionCount = analyzeForgetMutationPaths(production);
    assert.equal(productionCount.count, 1, productionCount.paths.join(", "));

    const actionGamed = analyzeForgetMutationPaths([
      { label: "createForgetAction", role: "entry", source: shortcutAction },
      ledger,
      runtime,
      owner,
    ]);
    assert.notEqual(actionGamed.count, 1, "missing-id action shortcut must not report one owner");

    const ledgerGamed = analyzeForgetMutationPaths([
      { label: "createForgetAction", role: "entry", source: production.find((file) => file.label === "createForgetAction")!.source },
      { label: "MemoryLedger.forget", role: "entry", source: bypassLedger },
      runtime,
      owner,
    ]);
    assert.notEqual(ledgerGamed.count, 1, "ledger missing-target bypass must not report one owner");

    const verifiedGamed = analyzeForgetMutationPaths([
      { label: "createForgetAction", role: "entry", source: storeAbsenceVerified },
      ledger,
      runtime,
      owner,
    ]);
    assert.notEqual(verifiedGamed.count, 1, "store absence as verified must not report one owner");

    const runtimeGamed = analyzeForgetMutationPaths([
      { label: "createForgetAction", role: "entry", source: production.find((file) => file.label === "createForgetAction")!.source },
      ledger,
      { label: "MemoryForgetCommand", role: "entry", source: storeAbsenceAlreadyGone },
      owner,
    ]);
    assert.notEqual(runtimeGamed.count, 1, "runtime store-absence alreadyGone must not report one owner");
  });

  it("evaluator fails if receipt persist moves behind store deletion", () => {
    const owner = loadProductionForgetSources().find((file) => file.role === "owner");
    assert.ok(owner);
    assert.equal(receiptPersistBeforeStoreDeletion(owner.source), true);

    const persistAfterDelete = `
export async function forgetMemoryClaim(ports, input) {
  await ports.visible.removeFactsMatching(target.claim);
  await ports.truth.removeFact(scope, id);
  await ports.store.forgetMemory(id, { expectedScope });
  await persistCompletionReceipt(ports, receipt);
  return { forgotten: true, alreadyGone: false };
}
`;
    assert.equal(
      receiptPersistBeforeStoreDeletion(persistAfterDelete),
      false,
      "persist after store deletion must fail the ordering ratchet",
    );
  });
});
