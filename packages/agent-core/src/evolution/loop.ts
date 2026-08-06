import { promises as fs } from "node:fs";
import path from "node:path";
import { diagnoseFromEval } from "./diagnose.js";
import { evaluateEvolutionSuite, EVOLUTION_CASES } from "./benchmark.js";
import { decideGate } from "./gate.js";
import { applyCandidate, proposeCandidate } from "./propose.js";
import { appendScoreboard } from "./scoreboard.js";
import { createSnapshot, restoreSnapshot } from "./snapshot.js";
import type { EvolutionRoundReport } from "./types.js";

export interface SelfEvolveOptions {
  /** Root for mutable agent state (identity, skills, knowledge) */
  stateDir: string;
  /** Where snapshots live */
  snapshotsDir: string;
  /** scoreboard.json path */
  scoreboardPath: string;
  /** Temp workspaces for eval */
  workRoot: string;
  /** Current version (default 1) */
  version?: number;
  /** Optional bad candidate injection (tests rollback) */
  injectBadCandidate?: boolean;
}

const MUTABLE_PATHS = [
  "identity/INSTRUCTIONS.md",
  "skills/report-format/SKILL.md",
  "knowledge/report-format.md",
];

/**
 * One full self-evolution round (book ch8 + Penguin):
 * RUN/EVAL baseline → DIAGNOSE → PROPOSE → SNAPSHOT → apply → EVAL candidate → GATE → promote|rollback → RECORD
 */
export async function runSelfEvolveRound(
  options: SelfEvolveOptions,
): Promise<EvolutionRoundReport> {
  const version = options.version ?? 1;
  await fs.mkdir(options.stateDir, { recursive: true });
  await fs.mkdir(options.snapshotsDir, { recursive: true });
  await fs.mkdir(options.workRoot, { recursive: true });
  await fs.mkdir(path.join(options.stateDir, "identity"), { recursive: true });

  // Ensure blank instructions for true baseline if missing
  const instructionsPath = path.join(options.stateDir, "identity", "INSTRUCTIONS.md");
  try {
    await fs.access(instructionsPath);
  } catch {
    await fs.writeFile(instructionsPath, "", "utf8");
  }

  // 1-2. Baseline eval (frozen suite)
  const baseline = await evaluateEvolutionSuite({
    label: "BASELINE",
    version,
    stateDir: options.stateDir,
    workRoot: path.join(options.workRoot, "baseline"),
    cases: EVOLUTION_CASES,
  });

  // 3. Diagnose
  const diagnosis = diagnoseFromEval(baseline);

  // 4. Propose candidate
  let candidate = proposeCandidate({
    diagnosis,
    nextVersion: version + 1,
    referenceArtifact: `<!-- YISHU-REPORT -->
# Report: Project Borealis
Classification: INTERNAL

Borealis is a batch ETL platform.

- Fact one
- Fact two
- Fact three

Reviewed-by: Yishu Team
`,
  });

  if (options.injectBadCandidate) {
    candidate = {
      ...candidate,
      summary: "intentionally bad candidate (test)",
      files: [
        {
          path: "identity/INSTRUCTIONS.md",
          content: "# broken\nDo nothing useful.\n",
        },
      ],
    };
  }

  // 5. Snapshot BEFORE mutate
  const snapshot = await createSnapshot({
    stateDir: options.stateDir,
    snapshotsDir: options.snapshotsDir,
    version,
    relativePaths: MUTABLE_PATHS,
  });

  // Apply candidate
  await applyCandidate(
    options.stateDir,
    candidate,
    async (p, c) => {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, c, "utf8");
    },
    async (p) => {
      await fs.mkdir(p, { recursive: true });
    },
  );

  // 6. Candidate eval
  const candidateEval = await evaluateEvolutionSuite({
    label: "CANDIDATE",
    version: candidate.version,
    stateDir: options.stateDir,
    workRoot: path.join(options.workRoot, "candidate"),
    cases: EVOLUTION_CASES,
  });

  // 7. Gate
  const retentionIds = EVOLUTION_CASES.filter((c) => c.retention).map((c) => c.id);
  const gate = decideGate({
    baseline,
    candidate: candidateEval,
    retentionCaseIds: retentionIds,
  });

  let promotedVersion = version;
  if (gate.decision === "promote") {
    promotedVersion = candidate.version;
    // Write version file
    await fs.writeFile(
      path.join(options.stateDir, "VERSION"),
      String(promotedVersion),
      "utf8",
    );
  } else {
    // 7b. Rollback
    await restoreSnapshot({
      stateDir: options.stateDir,
      snapshot,
      relativePaths: MUTABLE_PATHS,
    });
    promotedVersion = version;
  }

  // 8. Record scoreboard
  await appendScoreboard(options.scoreboardPath, {
    time: new Date().toISOString(),
    version: promotedVersion,
    decision: gate.decision === "promote" ? "promote" : "rollback",
    baselineMean: gate.baselineMean,
    candidateMean: gate.candidateMean,
    summary: candidate.summary,
    carrier: candidate.carrier,
    candidateId: candidate.id,
    snapshotId: snapshot.id,
  });

  return {
    baseline,
    diagnosis,
    candidate,
    snapshot,
    candidateEval,
    gate,
    promotedVersion,
    scoreboardPath: options.scoreboardPath,
  };
}
