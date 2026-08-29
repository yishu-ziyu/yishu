/**
 * Memory extraction pipeline (ADR 0013 #3, ADR 0016 #3–#8).
 *
 * candidate → sensitivity check → active. The model only proposes; the
 * ledger-safety checker is the sole gate. Facts written by this pipeline use
 * deterministic ids derived from the turn id so crash replay can never
 * duplicate a fact.
 */

import type { MemoryClaim } from "../store/types.js";
import { assertPersistableMemoryFields } from "../store/ledger-safety.js";
import { MemoryTruthLayer } from "./truth-layer.js";
import type { VisibleMemoryFile } from "./visible-file.js";
import { EXTRACTION_MAX_ATTEMPTS, type ExtractionQueuePort } from "./extraction-queue.js";

export type { ExtractionSnapshot } from "./extraction-types.js";

export interface MemoryExtractionInput {
  readonly providerId: string;
  readonly modelId: string;
  readonly utterance: string;
  readonly replyText: string;
  readonly existingFacts: ReadonlyArray<{ id: string; claim: string }>;
}

export interface MemoryExtractionOutput {
  readonly newFacts: readonly string[];
  readonly confirmedFactIds: readonly string[];
}

/**
 * Port implemented by the runtime with the turn's own provider/model
 * (ADR 0016 #4). The kernel never sees credentials or the provider registry.
 */
export interface MemoryExtractionModel {
  extract(input: MemoryExtractionInput): Promise<MemoryExtractionOutput>;
}

export interface ExtractedMemoryInput {
  readonly claim: string;
  readonly capturedAt: string;
  readonly scope: string;
  readonly confidence: number;
  readonly lastConfirmedAt: string;
  readonly supersedes: string | null;
  readonly tags: readonly string[];
  readonly truthRef?: string;
}

/**
 * The only durable index operations needed by the extraction worker.
 * Keeping this port here prevents the worker from depending on the complete
 * product store surface (and keeps provider/runtime details out of Kernel).
 */
export interface MemoryExtractionStorePort {
  searchExistingClaims(scopeKey: string): Promise<readonly MemoryClaim[]>;
  addExtractedMemory(input: ExtractedMemoryInput): Promise<MemoryClaim>;
  confirmMemory(id: string, confirmedAt: string): Promise<boolean>;
}

/** Deterministic small-talk set (ADR 0016 #5); whole-utterance equality. */
export const GREETING_SKIP_PHRASES: ReadonlySet<string> = new Set([
  "你好", "您好", "嗨", "哈喽", "在吗",
  "嗯", "嗯嗯", "好", "好的", "ok", "okay",
  "谢谢", "多谢", "不客气", "再见", "拜拜",
  "收到", "明白了", "知道了",
]);

export function isGreetingUtterance(utterance: string): boolean {
  return GREETING_SKIP_PHRASES.has(utterance.trim().toLowerCase());
}

/** New-fact index → deterministic id so replay converges on the same row. */
function factIdForTurn(turnId: string, index: number): string {
  const head = turnId.replace(/-/g, "").slice(0, 12).toLowerCase();
  return `fx-${head}-${index + 1}`;
}

export interface ExtractionRunStats {
  readonly processed: number;
  readonly skippedModel: number;
  readonly discardedSensitive: number;
  readonly failed: number;
}

interface ExtractionDeps {
  readonly queue: ExtractionQueuePort;
  readonly truth: MemoryTruthLayer;
  readonly store: MemoryExtractionStorePort;
  readonly model: MemoryExtractionModel;
  readonly visible?: VisibleMemoryFile;
  readonly now?: () => Date;
}

interface ExistingFactView {
  readonly facts: ReadonlyArray<{ id: string; claim: string }>;
  readonly byId: Map<string, MemoryClaim>;
}

async function loadExistingFacts(
  store: MemoryExtractionStorePort,
  scopeKey: string,
): Promise<ExistingFactView> {
  const claims = (await store.searchExistingClaims(scopeKey))
    .filter((claim) => claim.retiredAt === undefined);
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  return {
    facts: claims.slice(0, 50).map((claim) => ({
      id: claim.id,
      claim: claim.claim.slice(0, 200),
    })),
    byId,
  };
}

type ProcessOutcome = {
  readonly kind: "done" | "skipped_model" | "failed" | "retry";
  readonly discardedSensitive: number;
};

async function processOne(deps: ExtractionDeps, turnId: string): Promise<ProcessOutcome> {
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  const row = await deps.queue.getRow(turnId);
  if (row === null || (row.status !== "pending" && row.status !== "failed")) {
    return { kind: "done", discardedSensitive: 0 };
  }
  const snapshot = row.payload;

  // 1. Episode append is deterministic, always runs, and is idempotent per
  // turn id, so crash replay cannot duplicate lines.
  await deps.truth.appendEpisode({
    turnId: snapshot.turnId,
    scopeKey: snapshot.scopeKey,
    utterance: snapshot.utterance,
    replyText: snapshot.replyText,
    capturedAt: snapshot.capturedAt,
  });

  // 2. Small-talk turns keep their episode but never spend a model call.
  if (isGreetingUtterance(snapshot.utterance)) {
    await deps.queue.markDone(turnId, "skipped_model");
    return { kind: "skipped_model", discardedSensitive: 0 };
  }

  // 3. Model extraction with the turn's own provider/model.
  const existing = await loadExistingFacts(deps.store, snapshot.scopeKey);
  let output: MemoryExtractionOutput;
  try {
    output = await deps.model.extract({
      providerId: snapshot.providerId,
      modelId: snapshot.modelId,
      utterance: snapshot.utterance,
      replyText: snapshot.replyText,
      existingFacts: existing.facts,
    });
  } catch (error) {
    await deps.queue.markFailed(
      turnId,
      error instanceof Error ? error.message : String(error),
      now(),
    );
    const updated = await deps.queue.getRow(turnId);
    if (updated !== null && updated.attempts >= EXTRACTION_MAX_ATTEMPTS) {
      return { kind: "failed", discardedSensitive: 0 };
    }
    return { kind: "retry", discardedSensitive: 0 };
  }

  // 4. candidate → sensitivity check → active. Rejected facts are discarded
  // and counted; they never reach markdown or the index.
  let discarded = 0;
  let factIndex = 0;
  for (const candidate of output.newFacts) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) continue;
    try {
      assertPersistableMemoryFields({ claim: candidate, scope: snapshot.scopeKey, tags: [] });
    } catch {
      discarded += 1;
      continue;
    }
    const factId = factIdForTurn(snapshot.turnId, factIndex);
    factIndex += 1;
    const result = await deps.truth.upsertFact(snapshot.scopeKey, {
      id: factId,
      claim: candidate,
      source: "extraction",
      capturedAt: snapshot.capturedAt,
      confirmedAt: snapshot.capturedAt,
    });
    if (result === "created") {
      await deps.store.addExtractedMemory({
        claim: candidate.trim(),
        capturedAt: snapshot.capturedAt,
        scope: snapshot.scopeKey,
        confidence: 0.6,
        lastConfirmedAt: snapshot.capturedAt,
        supersedes: null,
        tags: [],
        truthRef: deps.truth.truthRefFor(snapshot.scopeKey, factId),
      });
      if (deps.visible !== undefined) {
        await deps.visible.appendFacts([candidate.trim()], snapshot.scopeKey);
      }
    }
  }

  // 5. Confirmations bump the markdown truth line and the index row. The
  // markdown fact id comes from the row's truthRef; the index id is the
  // store claim id the model was shown.
  for (const factId of output.confirmedFactIds) {
    const claim = existing.byId.get(factId);
    if (claim === undefined) continue;
    await deps.truth.upsertFact(snapshot.scopeKey, {
      id: factIdOfStoredClaim(claim),
      claim: claim.claim,
      source: claim.source,
      capturedAt: claim.capturedAt,
      confirmedAt: snapshot.capturedAt,
    });
    await deps.store.confirmMemory(factId, snapshot.capturedAt);
  }

  await deps.queue.markDone(turnId, "done");
  return { kind: "done", discardedSensitive: discarded };
}

function factIdOfStoredClaim(claim: MemoryClaim): string {
  // Index rows written by this pipeline carry truthRef#mem:<id>; explicit
  // remember rows use their own claim id as the markdown fact id.
  const match = /#mem:([^\s]+)$/.exec(claim.truthRef ?? "");
  return match ? match[1]! : claim.id;
}

/**
 * Drain every replayable row once. Rows that exhaust their attempts stay
 * failed for the next startup replay (ADR 0016 #3).
 */
export async function runExtractionPass(deps: ExtractionDeps): Promise<ExtractionRunStats> {
  const rows = await deps.queue.listReplayable();
  const stats = { processed: 0, skippedModel: 0, discardedSensitive: 0, failed: 0 };
  for (const row of rows) {
    const outcome = await processOne(deps, row.turnId);
    if (outcome.kind === "skipped_model") stats.skippedModel += 1;
    if (outcome.kind === "failed") stats.failed += 1;
    if (outcome.kind !== "retry") stats.processed += 1;
    stats.discardedSensitive += outcome.discardedSensitive;
  }
  return stats;
}
