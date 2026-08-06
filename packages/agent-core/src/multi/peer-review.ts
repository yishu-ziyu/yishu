import type { LlmPort } from "../llm.js";
import { DeterministicLlm } from "../llm.js";
import { runReactAgent } from "../loop/react.js";
import { reviewProposal } from "../loop/verify.js";
import type { ToolRegistry } from "../tools/registry.js";
import { TrajectoryRecorder } from "../trajectory/recorder.js";
import type { AgentConfig, ChatMessage, Trajectory } from "../types.js";

/**
 * Book ch10 peer collaboration: isolated Proposer + Critic contexts,
 * structured critique handoff, iterate until accept or max rounds.
 */

const PROPOSER_SYSTEM =
  "You are the Proposer peer. Complete the user task with tools when needed. " +
  "Produce a clear final answer with evidence. If you receive REVISE feedback, fix those issues.";

const CRITIC_SYSTEM =
  "You are the Critic peer. Independently verify the proposal. " +
  "You may use tools to gather evidence. " +
  "If acceptable, start with ACCEPT: and a short reason. " +
  "If not, start with REVISE: and list concrete issues and missing evidence.";

export interface PeerReviewOptions {
  task: string;
  llm?: LlmPort;
  tools: ToolRegistry;
  config: AgentConfig;
  /** Max propose-critique rounds (default 3). */
  rounds?: number;
}

export interface PeerRound {
  round: number;
  proposal: string;
  critique: string;
  accepted: boolean;
  proposerTools: string[];
  criticTools: string[];
}

export interface PeerReviewResult {
  finalText: string;
  rounds: PeerRound[];
  accepted: boolean;
  trajectory: Trajectory;
}

function freshLlm(llm: LlmPort): LlmPort {
  return llm instanceof DeterministicLlm ? new DeterministicLlm() : llm;
}

function parseCriticAcceptance(text: string): boolean | undefined {
  const t = text.trim();
  if (/^ACCEPT\b/i.test(t) || /审查通过|验收通过|accepted/i.test(t)) {
    return true;
  }
  if (/^REVISE\b/i.test(t) || /需修改|请修改|rejected|不足/i.test(t)) {
    return false;
  }
  return undefined;
}

/**
 * Critic: isolated context; may call tools for evidence; always emits structured critique.
 * Offline DeterministicLlm path falls back to rule-based reviewProposal.
 */
async function runCritic(options: {
  task: string;
  proposal: string;
  proposerTools: string[];
  llm: LlmPort;
  tools: ToolRegistry;
  config: AgentConfig;
}): Promise<{ critique: string; accepted: boolean; toolsUsed: string[] }> {
  const { task, proposal, proposerTools, tools, config } = options;

  // Rule baseline (always available offline)
  const rule = reviewProposal(task, proposal, proposerTools);

  // Critic may gather independent evidence via tools
  const criticUser =
    `任务：${task}\n\n提案：\n${proposal}\n\n提案方工具：${proposerTools.join(", ") || "(无)"}\n\n` +
    `请独立审查。通过则以 ACCEPT: 开头；否则以 REVISE: 开头，说明问题与需要的证据。`;

  const criticMessages: ChatMessage[] = [
    { role: "system", content: CRITIC_SYSTEM },
    { role: "user", content: criticUser },
  ];

  const needsEvidence =
    !rule.accepted &&
    /code_exec|write_file|search|web_search|memory_search/i.test(rule.reason);

  let criticTools: string[] = [];
  let criticText = "";

  if (needsEvidence || !rule.accepted) {
    // Give critic a short react loop to fetch evidence (isolated)
    const run = await runReactAgent({
      llm: freshLlm(options.llm),
      tools,
      messages: criticMessages,
      config: {
        ...config,
        maxIterations: Math.min(config.maxIterations, 4),
        enableReview: false,
      },
      task: `审查验证：${task}`,
    });
    criticTools = run.toolsUsed;
    criticText = run.finalText;
  }

  // Merge rule verdict with critic text / tools
  const combinedTools = [...new Set([...proposerTools, ...criticTools])];
  const recheck = reviewProposal(task, proposal, combinedTools);
  const parsed = criticText ? parseCriticAcceptance(criticText) : undefined;

  let accepted = recheck.accepted;
  if (parsed === true && recheck.accepted) accepted = true;
  if (parsed === false) accepted = false;
  // Rule is source of truth for offline safety when tools still missing
  if (!recheck.accepted) accepted = false;

  const critique = accepted
    ? `ACCEPT: ${recheck.reason}${criticText ? ` | ${criticText.slice(0, 200)}` : ""}`
    : `REVISE: ${recheck.reason}${
        criticText ? `\n批评意见：${criticText.slice(0, 400)}` : ""
      }\n请补齐证据后重提。`;

  return { critique, accepted, toolsUsed: criticTools };
}

/**
 * Peer collaboration loop: Proposer proposes, Critic critiques, handoff via critique text.
 * Contexts are isolated each turn; only structured critique crosses the boundary.
 */
export async function runPeerReviewLoop(
  options: PeerReviewOptions,
): Promise<PeerReviewResult> {
  const maxRounds = options.rounds ?? 3;
  const llm = options.llm ?? new DeterministicLlm();
  const { tools, config, task } = options;
  const recorder = new TrajectoryRecorder(task);
  recorder.step("status", { phase: "peer_review", maxRounds });

  const rounds: PeerRound[] = [];
  let critiqueFeedback = "";
  let lastProposal = "";
  let lastAccepted = false;

  for (let round = 1; round <= maxRounds; round++) {
    recorder.step("status", { phase: "propose", round });

    const proposerUser =
      critiqueFeedback.length > 0
        ? `任务：${task}\n\n上一轮审核意见（请据此改进）：\n${critiqueFeedback}`
        : task;

    // Isolated proposer context
    const proposerMessages: ChatMessage[] = [
      { role: "system", content: PROPOSER_SYSTEM },
      { role: "user", content: proposerUser },
    ];

    const propRun = await runReactAgent({
      llm: freshLlm(llm),
      tools,
      messages: proposerMessages,
      config: {
        ...config,
        maxIterations: Math.min(config.maxIterations, 6),
        enableReview: false,
      },
      task,
    });

    lastProposal = propRun.finalText;
    recorder.step("final", {
      role: "proposer",
      round,
      text: propRun.finalText,
      toolsUsed: propRun.toolsUsed,
    });

    recorder.step("status", { phase: "critique", round });

    const critic = await runCritic({
      task,
      proposal: propRun.finalText,
      proposerTools: propRun.toolsUsed,
      llm,
      tools,
      config,
    });

    const rec: PeerRound = {
      round,
      proposal: propRun.finalText,
      critique: critic.critique,
      accepted: critic.accepted,
      proposerTools: propRun.toolsUsed,
      criticTools: critic.toolsUsed,
    };
    rounds.push(rec);

    recorder.step("review", {
      round,
      accepted: critic.accepted,
      critique: critic.critique,
      proposerTools: propRun.toolsUsed,
      criticTools: critic.toolsUsed,
    });

    lastAccepted = critic.accepted;
    if (critic.accepted) {
      const finalText = propRun.finalText;
      recorder.finish("completed", finalText);
      return {
        finalText,
        rounds,
        accepted: true,
        trajectory: recorder.trajectory,
      };
    }

    // Structured handoff only - no shared message history
    critiqueFeedback = critic.critique;
  }

  recorder.finish(lastAccepted ? "completed" : "rejected", lastProposal);
  return {
    finalText: lastProposal,
    rounds,
    accepted: lastAccepted,
    trajectory: recorder.trajectory,
  };
}
