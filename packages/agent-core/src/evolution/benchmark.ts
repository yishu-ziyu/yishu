import { promises as fs } from "node:fs";
import path from "node:path";
import type { CaseScore, DimensionScore, EvalMatrix } from "./types.js";

/**
 * Frozen offline evolution benchmark (Penguin-style house convention).
 *
 * Content points are knowable from the task.
 * Convention points are knowable ONLY from identity/INSTRUCTIONS.md
 * that the evolution loop must author and promote.
 *
 * Rubric is private to the evaluator (not shown to the agent under test).
 */

export interface EvolutionCase {
  id: string;
  /** Public statement shown to agent */
  statement: string;
  /** Workspace seed files */
  files: Array<{ name: string; content: string }>;
  /** Retention cases must not regress after promote */
  retention?: boolean;
}

export const EVOLUTION_CASES: EvolutionCase[] = [
  {
    id: "report-aurora",
    statement: `Read notes.txt and write summary.md with:
(1) an overview of at most 2 sentences, and
(2) a bullet list of exactly 3 key facts.
Follow your team's standard report format.`,
    files: [
      {
        name: "notes.txt",
        content: `Project Aurora — Internal Notes

Aurora is a real-time analytics platform launched in Q1 2026. At peak it ingests roughly
2 million events per second through a Kafka-based pipeline. The core query engine was rewritten
in Rust after the original Go version could not keep p99 latency under control; the rewrite cut
p99 from 800ms to 120ms.

The production deployment is single-region with no failover; a multi-region rollout is scheduled
for Q3 2026. Storage is the largest cost line at about $48,000/month, driven by a 90-day
hot-retention policy; cutting retention to 30 days would reduce storage cost by roughly 55%.
`,
      },
    ],
  },
  {
    id: "report-aurora-retention",
    retention: true,
    statement: `Read notes.txt and write summary.md with exactly 3 bullet facts and a short overview.
Follow your team's standard report format.`,
    files: [
      {
        name: "notes.txt",
        content: `Project Aurora retention check notes.

Throughput is about 2 million events per second. p99 is 120ms after the Rust rewrite.
Storage is about $48,000/month; 30-day retention would save roughly 55%.
`,
      },
    ],
  },
];

/** Score a written report (private rubric). */
export function scoreReport(
  summaryText: string | null,
  caseId: string,
): CaseScore {
  const dimensions: DimensionScore[] = [];
  const add = (
    id: string,
    ok: boolean,
    label: string,
    layer: DimensionScore["layer"],
  ) => {
    dimensions.push({
      id,
      score: ok ? 1 : 0,
      max: 1,
      label,
      ok,
      layer,
    });
  };

  const exists = summaryText !== null;
  add("file", exists, "file summary.md was written", "result");
  if (!exists) {
    return {
      caseId,
      score: 0,
      max: 10,
      dimensions,
      evidence: "missing summary.md",
    };
  }

  const text = summaryText!;
  const lines = text.split("\n");
  const bullets = (text.match(/^\s*[-*]\s+/gm) ?? []).length;
  add("bullets", bullets === 3, `exactly 3 bullets (found ${bullets})`, "result");
  add("p99", text.includes("120ms"), "mentions 120ms", "result");
  add(
    "throughput",
    text.includes("2 million") || /2m\s*events/i.test(text),
    "mentions throughput",
    "result",
  );
  add(
    "storage",
    text.includes("55%") || text.includes("48"),
    "mentions storage/cost figure",
    "result",
  );

  // Convention (process/quality) — only from instructions
  add(
    "marker",
    lines[0]?.trim() === "<!-- YISHU-REPORT -->",
    "[convention] line1 marker",
    "process",
  );
  add(
    "title",
    /^#\s+Report:.*aurora/i.test((lines[1] ?? "").trim()),
    "[convention] title Report: Aurora…",
    "process",
  );
  add(
    "class",
    /^Classification:\s*INTERNAL\s*$/m.test(text),
    "[convention] Classification: INTERNAL",
    "process",
  );
  const lastNonEmpty = [...lines].reverse().find((l) => l.trim() !== "") ?? "";
  add(
    "footer",
    lastNonEmpty.trim() === "Reviewed-by: Yishu Team",
    "[convention] footer Reviewed-by",
    "process",
  );
  const allFour =
    lines[0]?.trim() === "<!-- YISHU-REPORT -->" &&
    /^#\s+Report:.*aurora/i.test((lines[1] ?? "").trim()) &&
    /^Classification:\s*INTERNAL\s*$/m.test(text) &&
    lastNonEmpty.trim() === "Reviewed-by: Yishu Team";
  add("full-convention", allFour, "[convention] full format", "quality");

  const score = dimensions.reduce((n, d) => n + d.score, 0);
  const max = dimensions.reduce((n, d) => n + d.max, 0);
  return { caseId, score, max, dimensions, evidence: text.slice(0, 200) };
}

/**
 * Deterministic "agent under test" for the evolution demo.
 * Reads INSTRUCTIONS.md from stateDir; if conventions present, writes correct format.
 * Content always filled from notes when possible.
 */
export async function runEvolutionCaseDeterministic(options: {
  caseDef: EvolutionCase;
  workspaceDir: string;
  instructionsPath: string;
}): Promise<CaseScore> {
  await fs.mkdir(options.workspaceDir, { recursive: true });
  for (const f of options.caseDef.files) {
    await fs.writeFile(path.join(options.workspaceDir, f.name), f.content, "utf8");
  }

  let instructions = "";
  try {
    instructions = await fs.readFile(options.instructionsPath, "utf8");
  } catch {
    instructions = "";
  }

  const notes = options.caseDef.files.find((f) => f.name === "notes.txt")?.content ?? "";
  const hasConvention =
    /YISHU-REPORT|Reviewed-by:\s*Yishu Team|Classification:\s*INTERNAL/i.test(
      instructions,
    );

  const overview =
    "Aurora is a real-time analytics platform. Peak throughput is about 2 million events per second with p99 at 120ms after the Rust rewrite.";
  const bullets = [
    "- p99 latency is 120ms after the Rust rewrite",
    "- Peak throughput is about 2 million events per second",
    "- Storage is about $48,000/month; 30-day retention would save roughly 55%",
  ].join("\n");

  let body: string;
  if (hasConvention) {
    body = [
      "<!-- YISHU-REPORT -->",
      "# Report: Project Aurora",
      "Classification: INTERNAL",
      "",
      overview,
      "",
      bullets,
      "",
      "Reviewed-by: Yishu Team",
      "",
    ].join("\n");
  } else {
    // Baseline: content ok-ish, convention missing → loses convention points
    body = [`# Summary`, "", overview, "", bullets, ""].join("\n");
  }

  await fs.writeFile(path.join(options.workspaceDir, "summary.md"), body, "utf8");
  return scoreReport(body, options.caseDef.id);
}

export async function evaluateEvolutionSuite(options: {
  label: string;
  version: number;
  stateDir: string;
  workRoot: string;
  cases?: EvolutionCase[];
  runsPerCase?: number;
}): Promise<EvalMatrix> {
  const cases = options.cases ?? EVOLUTION_CASES;
  const runsPerCase = options.runsPerCase ?? 1;
  const instructionsPath = path.join(options.stateDir, "identity", "INSTRUCTIONS.md");
  const caseScores: CaseScore[] = [];

  for (const c of cases) {
    const runScores: CaseScore[] = [];
    for (let r = 0; r < runsPerCase; r++) {
      const ws = path.join(options.workRoot, `${c.id}-r${r}`);
      await fs.rm(ws, { recursive: true, force: true }).catch(() => undefined);
      const sc = await runEvolutionCaseDeterministic({
        caseDef: c,
        workspaceDir: ws,
        instructionsPath,
      });
      runScores.push(sc);
    }
    const avg =
      runScores.reduce((n, s) => n + s.score, 0) / Math.max(1, runScores.length);
    const max = runScores[0]?.max ?? 10;
    const entry: CaseScore = {
      caseId: c.id,
      score: avg,
      max,
      dimensions: runScores[0]?.dimensions ?? [],
    };
    const ev = runScores[0]?.evidence;
    if (ev !== undefined) entry.evidence = ev;
    caseScores.push(entry);
  }

  const mean =
    caseScores.reduce((n, c) => n + c.score / c.max, 0) / Math.max(1, caseScores.length);

  return {
    label: options.label,
    version: options.version,
    mean,
    maxMean: 1,
    cases: caseScores,
    runsPerCase,
  };
}
