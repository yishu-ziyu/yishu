/**
 * Single product-owned forget mutation. Action-registry and MemoryLedger
 * both delegate here.
 *
 * Filesystem and store writes are not atomic. Intermediate states must stay
 * truthful and retryable, so the searchable store/index row is removed last.
 * Narrow reconciliation metadata is persisted before that destructive
 * deletion; a receipt is not success while the store row remains.
 * Success is the applicable postcondition, not a single layer's return value.
 */

import path from "node:path";
import type { ForgetMemoryResult, MemoryClaim } from "../store/types.js";
import type { YishuStorePort } from "../store/yishu-store.js";
import {
  isVisibleFactSuppressed,
  normalizeVisibleFact,
  visibleFactFingerprint,
  type VisibleMemoryFile,
} from "./visible-file.js";
import type { MemoryTruthLayer } from "./truth-layer.js";
import { forgetReceiptIO } from "./forget-receipts.js";

export interface MemoryForgetPorts {
  readonly store: YishuStorePort;
  readonly visible?: VisibleMemoryFile;
  readonly truth?: MemoryTruthLayer;
}

export interface MemoryForgetInput {
  readonly id: string;
  /**
   * Required for the ledger/UI path. Omitted by the action path, which
   * only has a memory id; the owner resolves scope from the store row or
   * a completion receipt.
   */
  readonly expectedScope?: string;
  readonly signal?: AbortSignal;
}

export interface MemoryForgetOutcome extends ForgetMemoryResult {
  readonly scope: string;
  readonly visibleFingerprint?: string;
  readonly truthFactId?: string;
}

export class MemoryForgetIncompleteError extends Error {
  readonly residue: readonly string[];

  constructor(residue: readonly string[]) {
    super(`memory forget incomplete: ${residue.join(",")}`);
    this.name = "MemoryForgetIncompleteError";
    this.residue = residue;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("memory forget cancelled");
  error.name = "AbortError";
  throw error;
}

function truthFactIdOf(claim: Pick<MemoryClaim, "id" | "truthRef">): string | undefined {
  if (claim.truthRef === undefined) return undefined;
  const match = /#mem:([^\s]+)$/.exec(claim.truthRef);
  return match?.[1] ?? claim.id;
}

function findClaim(store: YishuStorePort, id: string): MemoryClaim | undefined {
  return store.getSnapshot().memories.find((row) => row.id === id);
}

async function visibleContains(
  visible: VisibleMemoryFile,
  claim: string,
): Promise<boolean> {
  const key = normalizeVisibleFact(claim);
  if (key.length === 0) return false;
  const facts = await visible.listFacts();
  return facts.some((fact) => normalizeVisibleFact(fact) === key);
}

async function truthContains(
  truth: MemoryTruthLayer,
  scope: string,
  factId: string,
): Promise<boolean> {
  const facts = await truth.listFacts(scope);
  return facts.some((fact) => fact.id === factId);
}

export async function inspectMemoryForget(
  ports: MemoryForgetPorts,
  target: {
    readonly id: string;
    readonly scope: string;
    readonly claim?: string;
    readonly visibleFingerprint?: string;
    readonly truthFactId?: string;
    readonly requireVisibleSuppression?: boolean;
  },
): Promise<{ complete: boolean; residue: string[] }> {
  const residue: string[] = [];
  const active = (await ports.store.searchMemory("", {
    ...(target.scope.length > 0 ? { scope: target.scope } : {}),
    minConfidence: 0,
  })).some((row) => row.id === target.id);
  if (active) residue.push("active_store");

  if (ports.visible !== undefined && target.scope === "personal" && target.claim !== undefined) {
    if (await visibleContains(ports.visible, target.claim)) {
      residue.push("visible");
    } else if (target.requireVisibleSuppression === true) {
      const authority = await ports.visible.reconcileAuthority();
      if (!isVisibleFactSuppressed(authority, target.claim)) {
        residue.push("visible_unsuppressed");
      }
    }
  } else if (
    ports.visible !== undefined
    && target.scope === "personal"
    && target.visibleFingerprint !== undefined
  ) {
    const facts = await ports.visible.listFacts();
    if (facts.some((fact) => visibleFactFingerprint(fact) === target.visibleFingerprint)) {
      residue.push("visible");
    } else if (target.requireVisibleSuppression === true) {
      const authority = await ports.visible.reconcileAuthority();
      if (!authority.suppressedFingerprints.includes(target.visibleFingerprint)) {
        residue.push("visible_unsuppressed");
      }
    }
  }

  if (ports.truth !== undefined && target.truthFactId !== undefined) {
    if (await truthContains(ports.truth, target.scope, target.truthFactId)) {
      residue.push("truth");
    }
  }

  return { complete: residue.length === 0, residue };
}

async function removeVisibleIfApplicable(
  visible: VisibleMemoryFile | undefined,
  target: MemoryClaim,
  signal: AbortSignal | undefined,
): Promise<{ fingerprint?: string; requireSuppression: boolean }> {
  if (visible === undefined || target.scope !== "personal") {
    return { requireSuppression: false };
  }
  throwIfAborted(signal);
  const fingerprint = visibleFactFingerprint(target.claim);
  const present = await visibleContains(visible, target.claim);
  await visible.removeFactsMatching(target.claim);
  if (await visibleContains(visible, target.claim)) {
    throw new MemoryForgetIncompleteError(["visible"]);
  }
  if (present) {
    const authority = await visible.reconcileAuthority();
    if (!isVisibleFactSuppressed(authority, target.claim)) {
      throw new MemoryForgetIncompleteError(["visible_unsuppressed"]);
    }
    return { fingerprint, requireSuppression: true };
  }
  return { requireSuppression: false };
}

async function removeTruthIfApplicable(
  truth: MemoryTruthLayer | undefined,
  target: MemoryClaim,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const factId = truthFactIdOf(target);
  if (truth === undefined || factId === undefined) return undefined;
  throwIfAborted(signal);
  await truth.removeFact(target.scope, factId);
  if (await truthContains(truth, target.scope, factId)) {
    throw new MemoryForgetIncompleteError(["truth"]);
  }
  return factId;
}

function parseExpectedScope(input: MemoryForgetInput): string | undefined | null {
  if (input.expectedScope === undefined) return undefined;
  const expected = input.expectedScope.trim();
  return expected.length === 0 ? null : expected;
}

function visibleAuthorityCouldApply(
  ports: MemoryForgetPorts,
  scope: string | undefined,
): boolean {
  if (ports.visible === undefined) return false;
  if (scope === undefined || scope.length === 0) return true;
  return scope === "personal";
}

function receiptDirectory(ports: MemoryForgetPorts): string | undefined {
  if (ports.visible === undefined) return undefined;
  return path.dirname(ports.visible.filePath);
}

async function persistCompletionReceipt(
  ports: MemoryForgetPorts,
  receipt: {
    readonly id: string;
    readonly scope: string;
    readonly visibleFingerprint?: string;
    readonly truthFactId?: string;
  },
): Promise<void> {
  const directory = receiptDirectory(ports);
  if (directory === undefined) return;
  await forgetReceiptIO.write(directory, receipt);
}

async function forgetMissingStoreRow(
  ports: MemoryForgetPorts,
  input: MemoryForgetInput,
  expectedScope: string | undefined,
): Promise<MemoryForgetOutcome | null> {
  throwIfAborted(input.signal);
  const directory = receiptDirectory(ports);
  const receipt = directory === undefined
    ? undefined
    : await forgetReceiptIO.read(directory, input.id);

  if (receipt !== undefined) {
    if (expectedScope !== undefined && receipt.scope !== expectedScope) {
      return null;
    }
    const inspection = await inspectMemoryForget(ports, {
      id: input.id,
      scope: receipt.scope,
      requireVisibleSuppression: receipt.visibleFingerprint !== undefined,
      ...(receipt.visibleFingerprint !== undefined
        ? { visibleFingerprint: receipt.visibleFingerprint }
        : {}),
      ...(receipt.truthFactId !== undefined ? { truthFactId: receipt.truthFactId } : {}),
    });
    if (!inspection.complete) {
      throw new MemoryForgetIncompleteError(inspection.residue);
    }
    return {
      id: input.id,
      forgotten: true,
      alreadyGone: true,
      scope: receipt.scope,
      ...(receipt.visibleFingerprint !== undefined
        ? { visibleFingerprint: receipt.visibleFingerprint }
        : {}),
      ...(receipt.truthFactId !== undefined ? { truthFactId: receipt.truthFactId } : {}),
    };
  }

  if (visibleAuthorityCouldApply(ports, expectedScope)) {
    throw new MemoryForgetIncompleteError(["missing_provenance"]);
  }

  if (expectedScope === undefined) {
    return {
      id: input.id,
      forgotten: true,
      alreadyGone: true,
      scope: "",
    };
  }

  if (ports.truth !== undefined) {
    await ports.truth.removeFact(expectedScope, input.id);
    if (await truthContains(ports.truth, expectedScope, input.id)) {
      throw new MemoryForgetIncompleteError(["truth"]);
    }
  }
  const storeResult = await ports.store.forgetMemory(input.id, { expectedScope });
  if (storeResult === null) return null;
  return {
    id: input.id,
    forgotten: true,
    alreadyGone: true,
    scope: expectedScope,
  };
}

/**
 * Forget one memory by exact id, with optional expected scope.
 * Returns null on scope mismatch (no mutation).
 *
 * Missing store row is alreadyGone only when a completion receipt proves
 * the prior forget, or when visible authority cannot apply. Store absence
 * alone is not verified success.
 */
export async function forgetMemoryClaim(
  ports: MemoryForgetPorts,
  input: MemoryForgetInput,
): Promise<MemoryForgetOutcome | null> {
  throwIfAborted(input.signal);
  const expectedScope = parseExpectedScope(input);
  if (expectedScope === null) return null;

  const existing = findClaim(ports.store, input.id);
  if (existing !== undefined && expectedScope !== undefined && existing.scope !== expectedScope) {
    return null;
  }

  if (existing === undefined) {
    return forgetMissingStoreRow(ports, input, expectedScope);
  }

  const visibleMeta = await removeVisibleIfApplicable(
    ports.visible,
    existing,
    input.signal,
  );
  const truthFactId = await removeTruthIfApplicable(
    ports.truth,
    existing,
    input.signal,
  );

  throwIfAborted(input.signal);
  await persistCompletionReceipt(ports, {
    id: existing.id,
    scope: existing.scope,
    ...(visibleMeta.fingerprint !== undefined
      ? { visibleFingerprint: visibleMeta.fingerprint }
      : {}),
    ...(truthFactId !== undefined ? { truthFactId } : {}),
  });

  throwIfAborted(input.signal);
  const storeResult = await ports.store.forgetMemory(existing.id, {
    expectedScope: existing.scope,
  });
  if (storeResult === null) return null;

  const inspection = await inspectMemoryForget(ports, {
    id: existing.id,
    scope: existing.scope,
    claim: existing.claim,
    requireVisibleSuppression: visibleMeta.requireSuppression,
    ...(visibleMeta.fingerprint !== undefined
      ? { visibleFingerprint: visibleMeta.fingerprint }
      : {}),
    ...(truthFactId !== undefined ? { truthFactId } : {}),
  });
  if (!inspection.complete) {
    throw new MemoryForgetIncompleteError(inspection.residue);
  }

  return {
    id: existing.id,
    forgotten: true,
    alreadyGone: storeResult.alreadyGone,
    scope: existing.scope,
    ...(visibleMeta.fingerprint !== undefined
      ? { visibleFingerprint: visibleMeta.fingerprint }
      : {}),
    ...(truthFactId !== undefined ? { truthFactId } : {}),
  };
}
