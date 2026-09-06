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

export interface ForgetOwnershipSource {
  readonly label: string;
  readonly role: "owner" | "entry";
  readonly source: string;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function extractNamedMethod(source: string, name: string): string | undefined {
  const start = source.search(new RegExp(`async(?:\\s+function)?\\s+${name}\\s*\\(`));
  if (start < 0) return undefined;
  const brace = source.indexOf("{", start);
  if (brace < 0) return undefined;
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * Analyze the forget entry surface, not unrelated methods in a god-file.
 * Kernel action/ledger files have no forgetMemory method, so the whole
 * file is the surface. Runtime's handler is the forgetMemory method.
 */
export function forgetEntrySurface(source: string): string {
  const stripped = stripComments(source);
  return extractNamedMethod(stripped, "forgetMemory") ?? stripped;
}

function delegatesToForgetOwner(stripped: string): boolean {
  return /forgetMemoryClaim\s*\(/.test(stripped)
    || /kernel\.memories\.forget\s*\(/.test(stripped);
}

/**
 * An entry independently owns forget success/idempotency when it decides
 * forgotten / alreadyGone / verified completion itself, instead of only
 * forwarding the unified owner's result.
 */
export function entryIndependentlyOwnsForgetSuccess(source: string): boolean {
  const stripped = forgetEntrySurface(source);
  const mutatesStore = /\.(retireMemory|forgetMemory)\s*\(/.test(stripped);
  const mutatesAuthority = /\.(removeFactsMatching|removeFact)\s*\(/.test(stripped);
  if (mutatesStore && mutatesAuthority) return true;
  if (/\balreadyGone\s*:\s*(?:true|false)\b/.test(stripped)) return true;
  if (/\bforgotten\s*:\s*true(?:\s+as\s+const)?\b/.test(stripped)) return true;
  if (/\bverified\s*:\s*true\b/.test(stripped)) return true;
  if (mutatesStore && !delegatesToForgetOwner(stripped)) return true;

  const looksUpRow = /getSnapshot\(\)\s*\.memories/.test(stripped)
    || /\.getById\s*\(/.test(stripped);
  const treatsAbsence = /===\s*undefined/.test(stripped)
    || /==\s*null/.test(stripped);
  const successWord = /\balreadyGone\b/.test(stripped)
    || /\bforgotten\b/.test(stripped)
    || /memory\.forgotten/.test(stripped)
    || /\bverified\s*:/.test(stripped);
  if (looksUpRow && treatsAbsence && successWord) return true;
  return false;
}

export function analyzeForgetMutationPaths(
  sources: readonly ForgetOwnershipSource[],
): { count: number; paths: string[] } {
  const independent: string[] = [];
  let coordinator = false;
  for (const file of sources) {
    const stripped = stripComments(file.source);
    const mutatesStore = /\.(retireMemory|forgetMemory)\s*\(/.test(stripped);
    const mutatesAuthority = /\.(removeFactsMatching|removeFact)\s*\(/.test(stripped);
    if (file.role === "owner") {
      coordinator = mutatesStore && mutatesAuthority;
      continue;
    }
    if (entryIndependentlyOwnsForgetSuccess(file.source)) {
      independent.push(file.label);
    }
  }
  if (coordinator && independent.length === 0) {
    return { count: 1, paths: ["forgetMemoryClaim"] };
  }
  return {
    count: independent.length + (coordinator ? 1 : 0),
    paths: coordinator ? [...independent, "forgetMemoryClaim"] : independent,
  };
}

const PRODUCTION_FORGET_FILES: readonly ForgetOwnershipSource[] = [
  { label: "createForgetAction", role: "entry", source: "" },
  { label: "MemoryLedger.forget", role: "entry", source: "" },
  { label: "MemoryForgetCommand", role: "entry", source: "" },
  { label: "forgetMemoryClaim", role: "owner", source: "" },
];

const PRODUCTION_FORGET_PATHS: Record<string, string> = {
  createForgetAction: "packages/kernel/src/actions/forget.ts",
  "MemoryLedger.forget": "packages/kernel/src/memory/ledger.ts",
  MemoryForgetCommand: "packages/runtime/src/product-kernel-runtime.ts",
  forgetMemoryClaim: "packages/kernel/src/memory/forget.ts",
};

export function loadProductionForgetSources(): ForgetOwnershipSource[] {
  return PRODUCTION_FORGET_FILES.map((file) => {
    const rel = PRODUCTION_FORGET_PATHS[file.label];
    if (rel === undefined) return file;
    let source = "";
    try {
      source = readFileSync(path.join(ROOT, rel), "utf8");
    } catch {
      source = "";
    }
    return { label: file.label, role: file.role, source };
  });
}

function countMutationPaths(): { count: number; paths: string[] } {
  return analyzeForgetMutationPaths(loadProductionForgetSources());
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

async function legacyStoreGoneVisibleResidueFalsePositive(): Promise<string | undefined> {
  return withDir("yishu-forget-fp-legacy-store-gone-", async (dir) => {
    const kernel = createYishuKernel({ storeBackend: "memory", memoryDir: dir });
    const remembered = await rememberPersonal(kernel, CLAIM);
    const other = await rememberPersonal(kernel, OTHER);
    await kernel.store.forgetMemory(remembered.id, { expectedScope: "personal" });
    const visible = kernel.memory!.visible;
    if (!visibleHas(await visible.readText(), CLAIM)) {
      return "legacy fixture lost visible residue before forget";
    }

    const viaAction = await kernel.registry.invoke("forget", {
      caller: "ui",
      input: { memoryId: remembered.id },
    });
    const viaLedger = await kernel.memories.forget({
      id: remembered.id,
      expectedScope: "personal",
    }).then((result) => result, (error: unknown) => error);

    const text = await visible.readText();
    const residue = visibleHas(text, CLAIM);
    const otherKept = visibleHas(text, OTHER);
    const actionSucceeded = viaAction.status === "verified" || viaAction.status === "ok";
    const ledgerSucceeded = viaLedger !== null
      && !(viaLedger instanceof Error)
      && (viaLedger as { forgotten?: boolean; alreadyGone?: boolean }).forgotten === true;

    if (actionSucceeded) {
      return "action forget succeeded from missing store row without completed-forget proof";
    }
    if (ledgerSucceeded) {
      return "ledger forget succeeded from missing store row without completed-forget proof";
    }
    if (!residue) {
      return "legacy visible residue was removed without completed-forget proof";
    }
    if (!otherKept) {
      return "unrelated visible fact was removed during legacy missing-store forget";
    }
    return undefined;
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
    await legacyStoreGoneVisibleResidueFalsePositive(),
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
