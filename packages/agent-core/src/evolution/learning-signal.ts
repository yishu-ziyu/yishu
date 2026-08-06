import { promises as fs } from "node:fs";
import path from "node:path";
import type { Trajectory, TrajectoryStep } from "../types.js";

/** Book ch8: outcome of one trajectory as a learning unit. */
export type LearningOutcome = "success" | "fail" | "partial";

export interface LearningSignal {
  outcome: LearningOutcome;
  toolsUsed: string[];
  reviewAccepted?: boolean;
  lessons: string[];
}

function toolsFromSteps(steps: TrajectoryStep[]): string[] {
  const names: string[] = [];
  for (const s of steps) {
    if (s.kind === "tool_call") {
      const name = (s.data as { name?: string }).name;
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

function lastReviewAccepted(steps: TrajectoryStep[]): boolean | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s?.kind === "review") {
      const accepted = (s.data as { accepted?: boolean }).accepted;
      if (typeof accepted === "boolean") return accepted;
    }
  }
  return undefined;
}

function outcomeFromTrajectory(
  t: Trajectory,
  reviewAccepted: boolean | undefined,
): LearningOutcome {
  if (t.status === "completed") {
    if (reviewAccepted === false) return "fail";
    return "success";
  }
  if (t.status === "failed" || t.status === "rejected") return "fail";
  if (t.status === "max_iterations") return "partial";
  // still running or unknown
  return "partial";
}

function buildLessons(
  t: Trajectory,
  toolsUsed: string[],
  outcome: LearningOutcome,
  reviewAccepted: boolean | undefined,
): string[] {
  const lessons: string[] = [];

  if (outcome === "success") {
    if (toolsUsed.length > 0) {
      lessons.push(
        `tools [${toolsUsed.join(", ")}] supported a completed run for: ${t.task.slice(0, 80)}`,
      );
    } else {
      lessons.push("completed without tools; pure reasoning may suffice for this task shape");
    }
  } else if (outcome === "fail") {
    if (reviewAccepted === false) {
      lessons.push("review rejected the proposal; gather tool evidence before claiming done");
    }
    if (t.status === "failed" || t.status === "rejected") {
      lessons.push(`trajectory ended as ${t.status}; avoid repeating the same tool-free claim`);
    }
    if (toolsUsed.length === 0) {
      lessons.push("no tools used on a failed run; prefer tool evidence next time");
    }
  } else {
    // partial
    if (t.status === "max_iterations") {
      lessons.push("hit max iterations; narrow the task or pick higher-leverage tools earlier");
    } else {
      lessons.push("run ended partial; trajectory incomplete or still open");
    }
  }

  return lessons;
}

/**
 * Turn a finished trajectory into a compact learning signal (book ch8).
 */
export function extractLearningSignal(trajectory: Trajectory): LearningSignal {
  const toolsUsed = toolsFromSteps(trajectory.steps);
  const reviewAccepted = lastReviewAccepted(trajectory.steps);
  const outcome = outcomeFromTrajectory(trajectory, reviewAccepted);
  const lessons = buildLessons(trajectory, toolsUsed, outcome, reviewAccepted);

  const signal: LearningSignal = {
    outcome,
    toolsUsed,
    lessons,
  };
  if (reviewAccepted !== undefined) {
    signal.reviewAccepted = reviewAccepted;
  }
  return signal;
}

/**
 * Append one experience line to a JSONL file (creates parent dirs).
 */
export async function appendExperience(
  filePath: string,
  signal: LearningSignal,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const line = JSON.stringify(signal) + "\n";
  await fs.appendFile(filePath, line, "utf8");
}

/**
 * Load all experiences from a JSONL file. Missing file → [].
 */
export async function loadExperiences(filePath: string): Promise<LearningSignal[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }

  const out: LearningSignal[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed) as LearningSignal);
  }
  return out;
}
