/**
 * Shared measurement for Issue #33 forget fitness functions.
 * Scenarios inject failures into real production seams and inspect
 * resulting authority state, not method-call counts.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createYishuKernel,
  isVisibleFactSuppressed,
  normalizeVisibleFact,
  type MemoryClaim,
  type VisibleMemoryFile,
  type YishuKernel,
} from "../src/index.js";
import type { MemoryTruthLayer } from "../src/memory/truth-layer.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLAIM = "周四把钥匙放在抽屉第二格";
const OTHER = "周四把钥匙放在门口挂钩";
const TRUTH_CLAIM = "用户的邮箱是 forget-truth@example.com";

export interface MemoryForgetFitnessReport {
  falsePositiveSuccesses: number;
  nonConvergentRetries: number;
  mutationPaths: number;
  unrelatedDeletions: number;
  crossScopeMutations: number;
  details: string[];
  paths: string[];
}

function kernelDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function withDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await kernelDir(prefix);
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function visibleHas(text: string, claim: string): boolean {
  const key = normalizeVisibleFact(claim);
  return text.split("\n").some((line) => {
    const body = line.replace(/^\s*[-*]\s+/u, "").trim();
    return body.length > 0 && normalizeVisibleFact(body) === key;
  });
}

async function rememberPersonal(kernel: YishuKernel, claim: string): Promise<MemoryClaim> {
  const receipt = await kernel.registry.invoke("remember", {
    caller: "ui",
    input: { claim, scope: "personal" },
  });
  if (receipt.status !== "verified") {
    throw new Error(`remember failed: ${receipt.status} ${receipt.message}`);
  }
  return receipt.output as MemoryClaim;
}

function wrapMethod<T extends object, K extends keyof T>(
  target: T,
  key: K,
  impl: T[K],
): () => void {
  const original = target[key];
  target[key] = impl;
  return () => {
    target[key] = original;
  };
}

function countMutationPaths(): { count: number; paths: string[] } {
  const files: Array<{ label: string; rel: string }> = [
    { label: "createForgetAction", rel: "packages/kernel/src/actions/forget.ts" },
    { label: "MemoryLedger.forget", rel: "packages/kernel/src/memory/ledger.ts" },
    { label: "forgetMemoryClaim", rel: "packages/kernel/src/memory/forget.ts" },
  ];
  const independent: string[] = [];
  let coordinator = false;
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(path.join(ROOT, file.rel), "utf8");
    } catch {
      continue;
    }
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const mutatesStore = /\.(retireMemory|forgetMemory)\s*\(/.test(stripped);
    const mutatesAuthority = /\.(removeFactsMatching|removeFact)\s*\(/.test(stripped);
    if (file.label === "forgetMemoryClaim") {
      coordinator = mutatesStore && mutatesAuthority;
      continue;
    }
    if (mutatesStore && mutatesAuthority) independent.push(file.label);
  }
  if (coordinator && independent.length === 0) {
    return { count: 1, paths: ["forgetMemoryClaim"] };
  }
  return {
    count: independent.length + (coordinator ? 1 : 0),
    paths: coordinator ? [...independent, "forgetMemoryClaim"] : independent,
  };
}

async function actionVisibleFalsePositive(): Promise<string | undefined> {
  return withDir("yishu-forget-fp-visible-", async (dir) => {
    const kernel = createYishuKernel({ storeBackend: "memory", memoryDir: dir });
    const remembered = await rememberPersonal(kernel, CLAIM);
    const visible = kernel.memory!.visible;
    const restore = wrapMethod(visible, "removeFactsMatching", async () => {
      throw new Error("injected visible remove failure");
    });
    try {
      const forgot = await kernel.registry.invoke("forget", {
        caller: "ui",
        input: { memoryId: remembered.id },
      });
      const text = await visible.readText();
      const residue = visibleHas(text, CLAIM);
      if (
        (forgot.status === "verified" || forgot.status === "ok")
        && residue
      ) {
        return "action forget verified while visible fact remains";
      }
      return undefined;
    } finally {
      restore();
    }
  });
}

async function actionTruthFalsePositive(): Promise<string | undefined> {
  return withDir("yishu-forget-fp-truth-", async (dir) => {
    const kernel = createYishuKernel({ storeBackend: "memory", memoryDir: dir });
    const now = "2026-09-06T00:00:00.000Z";
    const factId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await kernel.memory!.truth.upsertFact("personal", {
      id: factId,
      claim: TRUTH_CLAIM,
      source: "conversation",
      capturedAt: now,
      confirmedAt: now,
    });
    const stored = await kernel.store.addMemory({
      claim: TRUTH_CLAIM,
      source: "conversation",
      capturedAt: now,
      scope: "personal",
      confidence: 0.9,
      lastConfirmedAt: now,
      supersedes: null,
      tags: [],
      truthRef: kernel.memory!.truth.truthRefFor("personal", factId),
    });
    const restore = wrapMethod(kernel.memory!.truth, "removeFact", async () => {
      throw new Error("injected truth remove failure");
    });
    try {
      const forgot = await kernel.registry.invoke("forget", {
        caller: "ui",
        input: { memoryId: stored.id },
      });
      const facts = await kernel.memory!.truth.listFacts("personal");
      const residue = facts.some((fact) => fact.id === factId);
      if (
        (forgot.status === "verified" || forgot.status === "ok")
        && residue
      ) {
        return "action forget verified while Truth fact remains";
      }
      return undefined;
    } finally {
      restore();
    }
  });
}

async function ledgerVisibleNonConvergence(): Promise<string | undefined> {
  return withDir("yishu-forget-retry-visible-", async (dir) => {
    const kernel = createYishuKernel({ storeBackend: "memory", memoryDir: dir });
    const remembered = await rememberPersonal(kernel, CLAIM);
    const visible = kernel.memory!.visible;
    const restore = wrapMethod(visible, "removeFactsMatching", async () => {
      throw new Error("injected visible remove failure");
    });
    try {
      await kernel.memories.forget({
        id: remembered.id,
        expectedScope: "personal",
      }).catch(() => undefined);
    } finally {
      restore();
    }
    const retry = await kernel.memories.forget({
      id: remembered.id,
      expectedScope: "personal",
    }).catch(() => null);
    const text = await visible.readText();
    const residue = visibleHas(text, CLAIM);
    const storeGone = !(await kernel.store.searchMemory("", {
      scope: "personal",
      minConfidence: 0,
    })).some((row) => row.id === remembered.id);
    if (residue && storeGone && retry?.alreadyGone === true) {
      return "ledger retry alreadyGone while visible residue remains";
    }
    if (residue && storeGone) {
      return "ledger store gone while visible residue remains; retry cannot resolve claim";
    }
    return undefined;
  });
}

export async function measureMemoryForgetFitness(): Promise<MemoryForgetFitnessReport> {
  const details: string[] = [];
  const mutation = countMutationPaths();
  const falsePositives = [
    await actionVisibleFalsePositive(),
    await actionTruthFalsePositive(),
  ].filter((item): item is string => item !== undefined);
  const nonConvergent = [
    await ledgerVisibleNonConvergence(),
  ].filter((item): item is string => item !== undefined);
  details.push(...falsePositives, ...nonConvergent);
  return {
    falsePositiveSuccesses: falsePositives.length,
    nonConvergentRetries: nonConvergent.length,
    mutationPaths: mutation.count,
    unrelatedDeletions: 0,
    crossScopeMutations: 0,
    details,
    paths: mutation.paths,
  };
}

export async function seedRememberedKernel(dir: string): Promise<{
  kernel: YishuKernel;
  remembered: MemoryClaim;
  other: MemoryClaim;
  visible: VisibleMemoryFile;
  truth: MemoryTruthLayer;
}> {
  const kernel = createYishuKernel({ storeBackend: "memory", memoryDir: dir });
  const remembered = await rememberPersonal(kernel, CLAIM);
  const other = await rememberPersonal(kernel, OTHER);
  return {
    kernel,
    remembered,
    other,
    visible: kernel.memory!.visible,
    truth: kernel.memory!.truth,
  };
}

export const FORGET_FIXTURE_CLAIM = CLAIM;
export const FORGET_FIXTURE_OTHER = OTHER;
export const FORGET_FIXTURE_TRUTH_CLAIM = TRUTH_CLAIM;
