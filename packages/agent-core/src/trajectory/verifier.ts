import type { Trajectory, TrajectoryStep } from "../types.js";

export interface TrajectoryVerifyResult {
  ok: boolean;
  issues: string[];
  /** 0 = all rules failed / empty; 1 = clean */
  score: number;
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

function hasFinalStep(steps: TrajectoryStep[]): boolean {
  return steps.some((s) => s.kind === "final");
}

function finalTextFromTrajectory(t: Trajectory): string {
  for (let i = t.steps.length - 1; i >= 0; i--) {
    const s = t.steps[i];
    if (s?.kind === "final") {
      const text = (s.data as { text?: string }).text;
      if (typeof text === "string") return text;
    }
  }
  return t.result ?? "";
}

function anyToolFailed(steps: TrajectoryStep[]): boolean {
  return steps.some((s) => {
    if (s.kind !== "tool_result") return false;
    return (s.data as { ok?: boolean }).ok === false;
  });
}

function claimsSuccess(text: string): boolean {
  return /成功|已完成|完成了|写入成功|ok\b|success|done|completed successfully/i.test(
    text,
  );
}

function isMathTask(task: string): boolean {
  return /计算|算一算|compute|calc|math|\d+\s*[+\-*/×xX]\s*\d+|17\s*\*/i.test(
    task,
  );
}

function isWriteTask(task: string): boolean {
  return /write\s+file|写入文件|写文件|保存到|写到|写入/i.test(task);
}

/**
 * Rule-based trajectory verification (book ch8 evolution feedback).
 * Does not mutate the trajectory.
 */
export function verifyTrajectory(
  trajectory: Trajectory,
  task?: string,
): TrajectoryVerifyResult {
  const issues: string[] = [];
  const taskText = task ?? trajectory.task;
  const steps = trajectory.steps;
  const tools = toolsFromSteps(steps);

  // Rule: empty steps
  if (steps.length === 0) {
    issues.push("empty steps");
  }

  // Rule: completed without final step
  if (trajectory.status === "completed" && !hasFinalStep(steps)) {
    issues.push("completed status but no final step");
  }

  // Rule: math task without code_exec
  if (isMathTask(taskText) && !tools.includes("code_exec")) {
    issues.push("math task without code_exec tool_call");
  }

  // Rule: write task without write_file
  if (isWriteTask(taskText) && !tools.includes("write_file")) {
    issues.push("write task without write_file tool_call");
  }

  // Rule: tool failure but final claims success
  if (anyToolFailed(steps)) {
    const finalText = finalTextFromTrajectory(trajectory);
    if (claimsSuccess(finalText)) {
      issues.push("tool_result ok=false but final claims success");
    }
  }

  // Score: fraction of checks that pass. We always run 5 rule families;
  // empty steps alone is one issue; remaining rules fire independently.
  const ruleCount = 5;
  const score =
    steps.length === 0 && issues.length === 1
      ? 0
      : Math.max(0, Math.min(1, (ruleCount - issues.length) / ruleCount));

  return {
    ok: issues.length === 0,
    issues,
    score,
  };
}
