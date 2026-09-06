/**
 * Single product-owned forget mutation. Action-registry and MemoryLedger
 * both delegate here.
 *
 * Filesystem and store writes are not atomic. Intermediate states must stay
 * truthful and retryable, so the searchable store/index row is removed last.
 * Success is the applicable postcondition, not a single layer's return value.
 */

import type { ForgetMemoryResult, MemoryClaim } from "../store/types.js";
import type { YishuStorePort } from "../store/yishu-store.js";
import {
  isVisibleFactSuppressed,
  normalizeVisibleFact,
  visibleFactFingerprint,
  type VisibleMemoryFile,
} from "./visible-file.js";
import type { MemoryTruthLayer } from "./truth-layer.js";

export interface MemoryForgetPorts {
  readonly store: YishuStorePort;
  readonly visible?: VisibleMemoryFile;
  readonly truth?: MemoryTruthLayer;
}

export interface MemoryForgetInput {
  readonly id: string;
  readonly expectedScope: string;
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

/**
 * Forget one memory by exact id + expected scope.
 * Returns null on scope mismatch (no mutation). Missing id is alreadyGone
 * only after applicable leftover Truth for that id is also absent.
 */
export async function forgetMemoryClaim(
  ports: MemoryForgetPorts,
  input: MemoryForgetInput,
): Promise<MemoryForgetOutcome | null> {
  throwIfAborted(input.signal);
  const expectedScope = input.expectedScope.trim();
  if (expectedScope.length === 0) return null;

  const existing = findClaim(ports.store, input.id);
  if (existing !== undefined && existing.scope !== expectedScope) {
    return null;
  }

  if (existing === undefined) {
    throwIfAborted(input.signal);
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
  const storeResult = await ports.store.forgetMemory(existing.id, { expectedScope });
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
