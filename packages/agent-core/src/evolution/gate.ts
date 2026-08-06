import type { EvalMatrix, GateResult } from "./types.js";

/**
 * SkillOpt / Book / Penguin gate:
 * - boundary (candidate overall mean) must strictly improve
 * - retention subset must not regress beyond epsilon
 * - otherwise reject + caller must rollback
 */
export function decideGate(options: {
  baseline: EvalMatrix;
  candidate: EvalMatrix;
  /** Case ids treated as retention (must not get worse) */
  retentionCaseIds?: string[];
  epsilon?: number;
}): GateResult {
  const epsilon = options.epsilon ?? 1e-9;
  const baselineMean = options.baseline.mean;
  const candidateMean = options.candidate.mean;
  const boundaryImproved = candidateMean > baselineMean + epsilon;

  const retentionIds = new Set(options.retentionCaseIds ?? []);
  let retentionOk = true;
  if (retentionIds.size > 0) {
    for (const id of retentionIds) {
      const b = options.baseline.cases.find((c) => c.caseId === id);
      const c = options.candidate.cases.find((c) => c.caseId === id);
      if (!b || !c) {
        retentionOk = false;
        break;
      }
      if (c.score + epsilon < b.score) {
        retentionOk = false;
        break;
      }
    }
  }

  if (boundaryImproved && retentionOk) {
    return {
      decision: "promote",
      reason: "candidate mean strictly improved and retention held",
      baselineMean,
      candidateMean,
      retentionOk,
      boundaryImproved,
    };
  }

  if (!boundaryImproved) {
    return {
      decision: "rollback",
      reason: "candidate mean did not strictly improve",
      baselineMean,
      candidateMean,
      retentionOk,
      boundaryImproved,
    };
  }

  return {
    decision: "rollback",
    reason: "retention set regressed",
    baselineMean,
    candidateMean,
    retentionOk,
    boundaryImproved,
  };
}
