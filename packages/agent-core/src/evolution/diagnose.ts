import type { EvalMatrix, Diagnosis } from "./types.js";

/**
 * Book ch8: structured diagnosis from dimension failures.
 * Chooses an update carrier — not just "do research".
 */
export function diagnoseFromEval(matrix: EvalMatrix): Diagnosis {
  const missed: string[] = [];
  const evidenceIds: string[] = [];

  for (const c of matrix.cases) {
    for (const d of c.dimensions) {
      if (!d.ok) {
        missed.push(`${c.caseId}:${d.id}:${d.label}`);
        evidenceIds.push(`${c.caseId}/${d.id}`);
      }
    }
  }

  const conventionMiss = missed.some((m) => m.includes("[convention]"));
  const contentMiss = missed.some(
    (m) => m.includes("bullets") || m.includes("p99") || m.includes("throughput"),
  );
  const fileMiss = missed.some((m) => m.includes(":file:"));

  let carrier: Diagnosis["carrier"] = "instruction";
  let rootCause = "unknown performance gap";

  if (fileMiss) {
    carrier = "program";
    rootCause = "agent did not produce the required artifact";
  } else if (conventionMiss) {
    carrier = "instruction";
    rootCause =
      "team report convention missing from durable instructions (not content knowledge)";
  } else if (contentMiss) {
    carrier = "knowledge";
    rootCause = "domain facts missing or not extracted from notes";
  }

  const lessons = [
    ...missed.slice(0, 8).map((m) => `miss: ${m}`),
    `prefer carrier=${carrier}`,
  ];

  return {
    taskFamily: "report-format",
    rootCause,
    carrier,
    lessons,
    evidenceIds,
  };
}
