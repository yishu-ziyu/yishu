/**
 * Book Ch6 LLM-as-Judge — offline heuristic + optional LLM judge.
 * Heuristic is deterministic and network-free; llmJudge falls back to it.
 */
import type { LlmPort } from "../llm.js";
import type { Trajectory } from "../types.js";
import {
  runEval,
  type AgentFactory,
  type EvalAgentResult,
  type EvalCase,
  type EvalReport,
} from "./harness.js";

export interface JudgeRubric {
  criteria: string[];
  /** 0–1; score >= threshold ⇒ pass */
  passThreshold: number;
}

export interface JudgeVerdict {
  score: number;
  pass: boolean;
  reasons: string[];
  method: "heuristic" | "llm";
}

export interface JudgeableResult {
  finalText: string;
  toolsUsed: string[];
  task: string;
  /** Optional trajectory for tool-evidence checks (math digits, etc.). */
  trajectory?: Trajectory;
}

export const DEFAULT_JUDGE_RUBRIC: JudgeRubric = {
  criteria: [
    "answer is non-empty and reasonably concise",
    "tools used when the task implies tool use",
    "math answers contain digits grounded in tool evidence when applicable",
  ],
  passThreshold: 0.6,
};

const META_ONLY = new Set(["discover_tools", "ask_user"]);

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function isMathTask(task: string): boolean {
  return /计算|算一算|compute|calc|math|\d+\s*[+\-*/×xX]\s*\d+|17\s*\*/i.test(
    task,
  );
}

function taskImpliesTools(task: string): boolean {
  return (
    isMathTask(task) ||
    /写文件|write\s+file|写入|搜索|search|列目录|list|记住|memory|读文件|read/i.test(
      task,
    )
  );
}

function reasonableLength(text: string): boolean {
  const len = text.trim().length;
  // Too short or dump-like walls both hurt
  return len >= 1 && len <= 2000;
}

function toolEvidenceText(result: JudgeableResult): string {
  const parts: string[] = [];
  if (result.trajectory) {
    for (const s of result.trajectory.steps) {
      if (s.kind === "tool_result") {
        parts.push(JSON.stringify(s.data));
      }
    }
  }
  return parts.join("\n");
}

/**
 * Offline rule-based judge (no network). Deterministic for a given input.
 */
export function heuristicJudge(
  result: JudgeableResult,
  rubric: JudgeRubric = DEFAULT_JUDGE_RUBRIC,
): JudgeVerdict {
  const reasons: string[] = [];
  let score = 0.5; // neutral base
  const text = (result.finalText ?? "").trim();
  const tools = result.toolsUsed ?? [];
  const task = result.task ?? "";

  // Empty answer → low score
  if (text.length === 0) {
    score = 0.15;
    reasons.push("empty final answer");
    return {
      score: clamp01(score),
      pass: clamp01(score) >= rubric.passThreshold,
      reasons,
      method: "heuristic",
    };
  }

  // Non-empty + reasonable length
  if (reasonableLength(text)) {
    score += 0.2;
    reasons.push("finalText non-empty and length reasonable");
  } else if (text.length > 2000) {
    score -= 0.1;
    reasons.push("finalText excessively long");
  }

  // Tools when task implies tools
  if (taskImpliesTools(task)) {
    const productive = tools.filter((t) => !META_ONLY.has(t));
    if (productive.length > 0) {
      score += 0.2;
      reasons.push(`used productive tools: ${productive.join(", ")}`);
    } else if (tools.length > 0) {
      score += 0.05;
      reasons.push("only meta tools used (discover_tools/ask_user)");
    } else {
      score -= 0.15;
      reasons.push("task implies tools but none were used");
    }
  } else if (tools.length > 0) {
    score += 0.05;
    reasons.push("tools used on open-ended task");
  }

  // Math: must contain digits / match tool evidence
  if (isMathTask(task)) {
    const hasDigits = /\d/.test(text);
    const evidence = toolEvidenceText(result);
    const evidenceDigits = evidence.match(/-?\d+(?:\.\d+)?/g) ?? [];
    const textHasEvidenceDigit =
      evidenceDigits.length > 0 &&
      evidenceDigits.some((d) => text.includes(d));

    if (hasDigits && (textHasEvidenceDigit || tools.includes("code_exec"))) {
      score += 0.15;
      reasons.push("math answer contains digits grounded in tools/evidence");
    } else if (hasDigits) {
      score += 0.05;
      reasons.push("math answer has digits but weak tool grounding");
    } else {
      score -= 0.2;
      reasons.push("math task answer lacks digits");
    }
  }

  // Soft bonus: any listed criterion string mentioned is ignored — score is rule-driven
  score = clamp01(score);
  const pass = score >= rubric.passThreshold;
  if (pass) {
    reasons.push(`pass (score ${score.toFixed(2)} ≥ ${rubric.passThreshold})`);
  } else {
    reasons.push(`fail (score ${score.toFixed(2)} < ${rubric.passThreshold})`);
  }

  return { score, pass, reasons, method: "heuristic" };
}

function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  // fenced ```json ... ```
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence?.[1]?.trim() ?? trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return body.slice(start, end + 1);
}

function parseLlmVerdict(
  raw: string,
  rubric: JudgeRubric,
): JudgeVerdict | null {
  const jsonStr = extractJsonObject(raw);
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr) as {
      score?: unknown;
      reasons?: unknown;
      pass?: unknown;
    };
    if (typeof parsed.score !== "number") return null;
    const score = clamp01(parsed.score);
    const reasons = Array.isArray(parsed.reasons)
      ? parsed.reasons.filter((r): r is string => typeof r === "string")
      : [];
    if (reasons.length === 0) {
      reasons.push("llm judge returned score without reasons");
    }
    const pass =
      typeof parsed.pass === "boolean"
        ? parsed.pass
        : score >= rubric.passThreshold;
    return { score, pass, reasons, method: "llm" };
  } catch {
    return null;
  }
}

/**
 * Optional LLM judge. Prompts for JSON `{score, reasons}`; falls back to heuristic on parse fail.
 */
export async function llmJudge(
  llm: LlmPort,
  result: JudgeableResult,
  rubric: JudgeRubric = DEFAULT_JUDGE_RUBRIC,
): Promise<JudgeVerdict> {
  const criteria = rubric.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const prompt = [
    "You are an evaluation judge. Score the agent result from 0 to 1.",
    `Pass threshold: ${rubric.passThreshold}`,
    "Criteria:",
    criteria,
    "",
    `Task: ${result.task}`,
    `Tools used: ${result.toolsUsed.join(", ") || "(none)"}`,
    `Final answer: ${result.finalText.slice(0, 1500)}`,
    "",
    'Respond with ONLY JSON: {"score": <number 0-1>, "reasons": ["..."]}',
  ].join("\n");

  try {
    const response = await llm.complete([
      { role: "system", content: "You output strict JSON only." },
      { role: "user", content: prompt },
    ]);
    if (response.type !== "text") {
      const fallback = heuristicJudge(result, rubric);
      return {
        ...fallback,
        reasons: [
          "llm returned tool_calls; fell back to heuristic",
          ...fallback.reasons,
        ],
      };
    }
    const parsed = parseLlmVerdict(response.text, rubric);
    if (parsed) return parsed;
    const fallback = heuristicJudge(result, rubric);
    return {
      ...fallback,
      reasons: [
        "llm JSON parse failed; fell back to heuristic",
        ...fallback.reasons,
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const fallback = heuristicJudge(result, rubric);
    return {
      ...fallback,
      reasons: [`llm error: ${msg}; fell back to heuristic`, ...fallback.reasons],
    };
  }
}

export interface CaseJudgment {
  id: string;
  name: string;
  verdict: JudgeVerdict;
}

export type EvalReportWithJudgments = EvalReport & {
  judgments: CaseJudgment[];
};

export interface RunEvalWithJudgeOptions {
  judge?: "heuristic" | "llm";
  llm?: LlmPort;
  rubric?: JudgeRubric;
}

/**
 * Run eval cases and attach a judge verdict per case (Ch6).
 * Does not replace gold `check` pass/fail; adds independent judgment scores.
 */
export async function runEvalWithJudge(
  cases: EvalCase[],
  agentFactory: AgentFactory,
  options?: RunEvalWithJudgeOptions,
): Promise<EvalReportWithJudgments> {
  const mode = options?.judge ?? "heuristic";
  const rubric = options?.rubric ?? DEFAULT_JUDGE_RUBRIC;
  const judgments: CaseJudgment[] = [];
  const reports: EvalReport["cases"] = [];

  for (const c of cases) {
    const agent = agentFactory();
    try {
      const result: EvalAgentResult = await agent.run(c.task);
      const goldPass = c.check(result);
      reports.push({
        id: c.id,
        name: c.name,
        pass: goldPass,
        finalText: result.finalText,
        toolsUsed: result.toolsUsed,
      });

      const judgeable: JudgeableResult = {
        finalText: result.finalText,
        toolsUsed: result.toolsUsed,
        task: c.task,
        trajectory: result.trajectory,
      };

      let verdict: JudgeVerdict;
      if (mode === "llm" && options?.llm) {
        verdict = await llmJudge(options.llm, judgeable, rubric);
      } else {
        verdict = heuristicJudge(judgeable, rubric);
      }
      judgments.push({ id: c.id, name: c.name, verdict });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      reports.push({
        id: c.id,
        name: c.name,
        pass: false,
        finalText: "",
        toolsUsed: [],
        detail: msg,
      });
      const verdict = heuristicJudge(
        { finalText: "", toolsUsed: [], task: c.task },
        rubric,
      );
      judgments.push({
        id: c.id,
        name: c.name,
        verdict: {
          ...verdict,
          reasons: [`case error: ${msg}`, ...verdict.reasons],
        },
      });
    }
  }

  const passed = reports.filter((r) => r.pass).length;
  const total = reports.length;
  return {
    total,
    passed,
    passRate: total === 0 ? 0 : passed / total,
    cases: reports,
    judgments,
  };
}

/** Convenience: gold eval only (no judge) — re-export path for callers. */
export { runEval };
