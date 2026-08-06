import type { Trajectory, TrajectoryStep } from "../types.js";
import type { ReactRunResult } from "./react.js";

export interface ReviewVerdict {
  accepted: boolean;
  reason: string;
}

export interface ReviewRound {
  round: number;
  accepted: boolean;
  reason: string;
  at: string;
}

export interface ReviewerResult {
  accepted: boolean;
  reviews: ReviewRound[];
  finalText: string;
  trajectory: Trajectory;
  toolsUsed: string[];
}

export interface ProposerRunFactory {
  (): Promise<ReactRunResult>;
}

function toolsFromTrajectory(t: Trajectory): string[] {
  const names: string[] = [];
  for (const s of t.steps) {
    if (s.kind === "tool_call") {
      const name = (s.data as { name?: string }).name;
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** Rule-based offline reviewer. */
export function reviewProposal(
  task: string,
  finalText: string,
  toolsUsed: string[],
): ReviewVerdict {
  if (!finalText.trim()) {
    return { accepted: false, reason: "final text empty" };
  }

  const needsCompute =
    /计算|算|compute|calc|\d+\s*[+\-*/]|17\s*\*|math/i.test(task);
  if (needsCompute && !toolsUsed.includes("code_exec")) {
    return {
      accepted: false,
      reason: "task needs computation but code_exec was not used",
    };
  }

  const needsWrite =
    /write\s+file|写入文件|写文件|保存到|写到/i.test(task);
  if (needsWrite && !toolsUsed.includes("write_file")) {
    return {
      accepted: false,
      reason: "task needs file write but write_file was not used",
    };
  }

  const needsSearch = /搜索|查一下|research|web_search/i.test(task);
  if (
    needsSearch &&
    !toolsUsed.includes("web_search") &&
    !toolsUsed.includes("memory_search")
  ) {
    return {
      accepted: false,
      reason: "task needs search but no search tool was used",
    };
  }

  // Reject hallucinated "done" without any tools when tools clearly needed
  if (
    /已完成|成功写入|计算结果是/i.test(finalText) &&
    toolsUsed.length === 0 &&
    (needsCompute || needsWrite || needsSearch)
  ) {
    return {
      accepted: false,
      reason: "claimed completion without tool evidence",
    };
  }

  return { accepted: true, reason: "ok" };
}

/**
 * Proposer-Reviewer loop. Re-runs proposer on reject until maxRounds.
 */
export async function runWithReviewer(options: {
  proposerRun: ProposerRunFactory;
  maxRounds?: number;
  task: string;
  onStep?: (step: TrajectoryStep) => void;
}): Promise<ReviewerResult> {
  const maxRounds = options.maxRounds ?? 2;
  const reviews: ReviewRound[] = [];
  let last: ReactRunResult | undefined;

  for (let round = 1; round <= maxRounds; round++) {
    last = await options.proposerRun();
    const toolsUsed =
      last.toolsUsed.length > 0
        ? last.toolsUsed
        : toolsFromTrajectory(last.trajectory);
    const verdict = reviewProposal(
      options.task,
      last.finalText,
      toolsUsed,
    );
    const rec: ReviewRound = {
      round,
      accepted: verdict.accepted,
      reason: verdict.reason,
      at: new Date().toISOString(),
    };
    reviews.push(rec);
    last.trajectory.steps.push({
      kind: "review",
      at: rec.at,
      data: rec,
    });
    options.onStep?.({ kind: "review", at: rec.at, data: rec });

    if (verdict.accepted) {
      return {
        accepted: true,
        reviews,
        finalText: last.finalText,
        trajectory: last.trajectory,
        toolsUsed,
      };
    }
  }

  // Final reject
  if (last) {
    last.trajectory.status = "rejected";
    return {
      accepted: false,
      reviews,
      finalText: last.finalText,
      trajectory: last.trajectory,
      toolsUsed: last.toolsUsed,
    };
  }

  const emptyTrajectory: Trajectory = {
    id: "none",
    task: options.task,
    startedAt: new Date().toISOString(),
    steps: [],
    status: "failed",
  };
  return {
    accepted: false,
    reviews,
    finalText: "",
    trajectory: emptyTrajectory,
    toolsUsed: [],
  };
}
