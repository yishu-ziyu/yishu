/** Types for the book-ch8 / Penguin-style self-evolution loop. */

export type UpdateCarrier =
  | "knowledge"
  | "instruction"
  | "skill"
  | "program"
  | "parameters";

export type GateDecision = "promote" | "reject" | "rollback";

export interface DimensionScore {
  id: string;
  /** 0 or 1 for atomic checks; may be fractional later */
  score: number;
  max: number;
  label: string;
  ok: boolean;
  layer: "result" | "process" | "quality";
}

export interface CaseScore {
  caseId: string;
  score: number;
  max: number;
  dimensions: DimensionScore[];
  evidence?: string;
}

export interface EvalMatrix {
  label: string;
  version: number;
  mean: number;
  maxMean: number;
  cases: CaseScore[];
  runsPerCase: number;
}

export interface Diagnosis {
  taskFamily: string;
  rootCause: string;
  carrier: UpdateCarrier;
  lessons: string[];
  evidenceIds: string[];
}

export interface EvolutionCandidate {
  id: string;
  version: number;
  carrier: UpdateCarrier;
  summary: string;
  /** Relative paths written under agent state root */
  files: Array<{ path: string; content: string }>;
  sourceDiagnosis: Diagnosis;
  createdAt: string;
}

export interface SnapshotMeta {
  id: string;
  version: number;
  dir: string;
  createdAt: string;
  files: string[];
}

export interface GateResult {
  decision: GateDecision;
  reason: string;
  baselineMean: number;
  candidateMean: number;
  retentionOk: boolean;
  boundaryImproved: boolean;
}

export interface ScoreboardEntry {
  time: string;
  version: number;
  decision: GateDecision;
  baselineMean: number;
  candidateMean: number;
  summary: string;
  carrier: UpdateCarrier;
  candidateId: string;
  snapshotId: string;
}

export interface EvolutionRoundReport {
  baseline: EvalMatrix;
  diagnosis: Diagnosis;
  candidate: EvolutionCandidate;
  snapshot: SnapshotMeta;
  candidateEval: EvalMatrix;
  gate: GateResult;
  promotedVersion: number;
  scoreboardPath: string;
}
