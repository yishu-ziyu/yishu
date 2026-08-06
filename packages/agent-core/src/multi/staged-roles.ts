import type { LlmPort } from "../llm.js";
import { DeterministicLlm } from "../llm.js";
import { runReactAgent } from "../loop/react.js";
import type { ToolRegistry } from "../tools/registry.js";
import { TrajectoryRecorder } from "../trajectory/recorder.js";
import type { AgentConfig, ChatMessage, Trajectory } from "../types.js";

/**
 * Book ch10 shared-context multi-stage role transfer:
 * planner -> worker -> checker on one continuous message list;
 * only the system prompt (role identity) swaps per stage.
 */

export type StageRole = "planner" | "worker" | "checker";

const STAGE_PROMPTS: Record<StageRole, string> = {
  planner:
    "You are the Planner. Decompose the task into clear steps and acceptance criteria. " +
    "Do not execute tools unless necessary to understand the task. " +
    "Output a short numbered plan, then stop.",
  worker:
    "You are the Worker. Execute the plan using tools as needed. " +
    "Follow prior planner output in this conversation. Produce concrete results with evidence.",
  checker:
    "You are the Checker. Review whether the worker completed the original task. " +
    "You may use tools to verify. Summarize acceptance and the final answer.",
};

const STAGE_ORDER: StageRole[] = ["planner", "worker", "checker"];

export interface StagedRolesOptions {
  task: string;
  llm?: LlmPort;
  tools: ToolRegistry;
  config: AgentConfig;
}

export interface StageResult {
  role: StageRole;
  text: string;
  toolsUsed: string[];
  systemPrompt: string;
}

export interface StagedRolesResult {
  task: string;
  stages: StageResult[];
  finalText: string;
  messages: ChatMessage[];
  trajectory: Trajectory;
}

function freshLlm(llm: LlmPort): LlmPort {
  return llm instanceof DeterministicLlm ? new DeterministicLlm() : llm;
}

/** Swap system prompt in place; keep all non-system history (shared context). */
export function swapSystemPrompt(
  messages: ChatMessage[],
  newSystem: string,
): void {
  const idx = messages.findIndex((m) => m.role === "system");
  if (idx >= 0) {
    messages[idx] = { role: "system", content: newSystem };
  } else {
    messages.unshift({ role: "system", content: newSystem });
  }
}

function stageUserNudge(role: StageRole, task: string): string {
  switch (role) {
    case "planner":
      return `请规划如何完成任务（列出步骤与验收标准）：${task}`;
    case "worker":
      return `进入执行阶段。按上文计划完成任务：${task}`;
    case "checker":
      return `进入检查阶段。审查上文执行是否完成任务「${task}」，给出验收结论与最终答案。`;
  }
}

/**
 * Shared-context staged roles: one message list, system prompt swaps per stage.
 */
export async function runStagedRoles(
  options: StagedRolesOptions,
): Promise<StagedRolesResult> {
  const llm = options.llm ?? new DeterministicLlm();
  const { tools, config, task } = options;
  const recorder = new TrajectoryRecorder(task);
  recorder.step("status", { phase: "staged_roles", stages: STAGE_ORDER });

  // Continuous shared context
  let messages: ChatMessage[] = [
    { role: "system", content: STAGE_PROMPTS.planner },
    { role: "user", content: stageUserNudge("planner", task) },
  ];

  const stages: StageResult[] = [];

  for (const role of STAGE_ORDER) {
    const systemPrompt = STAGE_PROMPTS[role];
    swapSystemPrompt(messages, systemPrompt);

    // After first stage, inject role-transition user nudge while keeping history
    if (role !== "planner") {
      messages.push({
        role: "user",
        content: stageUserNudge(role, task),
      });
    }

    recorder.step("status", {
      phase: "stage",
      role,
      messageCount: messages.length,
    });

    const run = await runReactAgent({
      llm: freshLlm(llm),
      tools,
      messages,
      config: {
        ...config,
        maxIterations: Math.min(config.maxIterations, 6),
        enableReview: false,
      },
      // Worker/checker keep original task for tool routing; planner uses nudge
      task: role === "planner" ? stageUserNudge("planner", task) : task,
    });

    // Inherit full history for next stage (shared context)
    messages = run.messages;

    const stage: StageResult = {
      role,
      text: run.finalText,
      toolsUsed: run.toolsUsed,
      systemPrompt,
    };
    stages.push(stage);

    recorder.step("final", {
      role,
      text: run.finalText,
      toolsUsed: run.toolsUsed,
    });
  }

  const composed =
    `阶段协作完成「${task.slice(0, 60)}」。\n` +
    stages.map((s) => `【${s.role}】${s.text}`).join("\n");

  recorder.finish("completed", composed);

  return {
    task,
    stages,
    finalText: composed,
    messages,
    trajectory: recorder.trajectory,
  };
}
