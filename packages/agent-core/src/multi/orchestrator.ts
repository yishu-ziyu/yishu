import type { LlmPort } from "../llm.js";
import { DeterministicLlm } from "../llm.js";
import { runReactAgent } from "../loop/react.js";
import type { ToolRegistry } from "../tools/registry.js";
import { TrajectoryRecorder } from "../trajectory/recorder.js";
import type { AgentConfig, ChatMessage, Trajectory } from "../types.js";

export type SpecialistRole = "researcher" | "coder" | "reviewer";

export interface SubTask {
  id: string;
  role: SpecialistRole;
  prompt: string;
  dependsOn: string[];
}

export interface SpecialistResult {
  role: SpecialistRole;
  subTaskId: string;
  text: string;
  toolsUsed: string[];
  trajectory: Trajectory;
}

export interface MultiResult {
  task: string;
  subtasks: SubTask[];
  results: SpecialistResult[];
  handoffs: Array<{ from: string; to: string; summary: string }>;
  finalText: string;
  trajectory: Trajectory;
}

const ROLE_PROMPTS: Record<SpecialistRole, string> = {
  researcher:
    "You are the researcher specialist. Search and gather facts. Prefer web_search and list_dir.",
  coder:
    "You are the coder specialist. Compute and write files. Prefer code_exec and write_file.",
  reviewer:
    "You are the reviewer specialist. Check evidence and produce a short acceptance note.",
};

/**
 * Deterministic task decomposition for offline multi-agent demo.
 */
export function decomposeTask(task: string): SubTask[] {
  const subs: SubTask[] = [];
  const needsResearch = /查|搜|research|search|资料|调研/i.test(task);
  const needsCode =
    /计算|算|code|写|实现|math|compute|\d+\s*[+\-*/]|写文件|write.?file/i.test(
      task,
    );
  const alwaysReview = true;

  if (needsResearch) {
    // Isolate research so math tokens in the original task don't steal the tool.
    const researchFocus =
      task
        .replace(/并?计算[^，。]*/g, "")
        .replace(/并?写[^，。]*/g, "")
        .trim() || task;
    subs.push({
      id: "st-research",
      role: "researcher",
      prompt: `只做检索与摘要，不要计算。查询：${researchFocus}`,
      dependsOn: [],
    });
  }

  if (needsCode || !needsResearch) {
    const depends = needsResearch ? ["st-research"] : [];
    // Default path: coder handles general + compute tasks
    if (needsCode || subs.length === 0) {
      const codeFocus =
        task.match(/计算[^，。]*/)?.[0] ??
        task.match(/写文件[^，。]*/)?.[0] ??
        task;
      subs.push({
        id: "st-code",
        role: "coder",
        prompt: needsCode
          ? `执行计算或写文件，不要重复检索：${codeFocus}`
          : `处理任务：${task}`,
        dependsOn: depends,
      });
    }
  }

  if (alwaysReview) {
    const deps = subs.map((s) => s.id);
    subs.push({
      id: "st-review",
      role: "reviewer",
      prompt: `审查上述结果是否完成任务：${task}`,
      dependsOn: deps,
    });
  }

  return subs;
}

export interface ManagerOrchestratorOptions {
  llm?: LlmPort;
  tools: ToolRegistry;
  config: AgentConfig;
}

/**
 * Manager decomposes task, runs specialists with isolated contexts,
 * shares workspace via tools, handoff via structured messages.
 */
export class ManagerOrchestrator {
  private readonly llm: LlmPort;
  private readonly tools: ToolRegistry;
  private readonly config: AgentConfig;

  constructor(options: ManagerOrchestratorOptions) {
    this.llm = options.llm ?? new DeterministicLlm();
    this.tools = options.tools;
    this.config = options.config;
  }

  async run(task: string): Promise<MultiResult> {
    const recorder = new TrajectoryRecorder(task);
    recorder.step("status", { phase: "decompose" });
    const subtasks = decomposeTask(task);
    recorder.step("think", { subtasks });

    const results: SpecialistResult[] = [];
    const handoffs: MultiResult["handoffs"] = [];
    const artifacts: string[] = [];

    for (const st of subtasks) {
      // Wait: sequential with dependency notes
      const depNotes = st.dependsOn
        .map((id) => {
          const r = results.find((x) => x.subTaskId === id);
          return r ? `[${r.role}] ${r.text}` : "";
        })
        .filter(Boolean);

      if (depNotes.length > 0) {
        handoffs.push({
          from: st.dependsOn.join(","),
          to: st.role,
          summary: depNotes.join(" | ").slice(0, 300),
        });
        recorder.step("status", {
          handoff: handoffs[handoffs.length - 1],
        });
      }

      // Isolated context per specialist
      const messages: ChatMessage[] = [
        { role: "system", content: ROLE_PROMPTS[st.role] },
        {
          role: "user",
          content:
            depNotes.length > 0
              ? `${st.prompt}\n\n上游交接：\n${depNotes.join("\n")}`
              : st.prompt,
        },
      ];

      // Fresh deterministic LLM per specialist for clean call counts
      const llm =
        this.llm instanceof DeterministicLlm
          ? new DeterministicLlm()
          : this.llm;

      // Reviewer is rule-only: no tools required
      if (st.role === "reviewer") {
        const prior = results.map((r) => r.text).join("\n");
        const hasEvidence = results.some((r) => r.toolsUsed.length > 0);
        const text = hasEvidence
          ? `审查通过。上游产出：${prior.slice(0, 200)}`
          : `审查存疑：未见工具证据。上游：${prior.slice(0, 200)}`;
        const tr = new TrajectoryRecorder(st.prompt);
        tr.step("final", { text });
        tr.finish("completed", text);
        const sr: SpecialistResult = {
          role: st.role,
          subTaskId: st.id,
          text,
          toolsUsed: [],
          trajectory: tr.trajectory,
        };
        results.push(sr);
        artifacts.push(text);
        recorder.step("final", { role: st.role, text });
        continue;
      }

      const run = await runReactAgent({
        llm,
        tools: this.tools,
        messages,
        config: {
          ...this.config,
          maxIterations: Math.min(this.config.maxIterations, 6),
          enableReview: false,
        },
        task: st.prompt,
      });

      results.push({
        role: st.role,
        subTaskId: st.id,
        text: run.finalText,
        toolsUsed: run.toolsUsed,
        trajectory: run.trajectory,
      });
      artifacts.push(run.finalText);
      recorder.step("final", {
        role: st.role,
        text: run.finalText,
        toolsUsed: run.toolsUsed,
      });
    }

    const finalText = composeFinal(task, results, handoffs);
    recorder.finish("completed", finalText);

    return {
      task,
      subtasks,
      results,
      handoffs,
      finalText,
      trajectory: recorder.trajectory,
    };
  }
}

function composeFinal(
  task: string,
  results: SpecialistResult[],
  handoffs: MultiResult["handoffs"],
): string {
  const parts = results.map((r) => `【${r.role}】${r.text}`);
  const handoffLine =
    handoffs.length > 0
      ? `交接 ${handoffs.length} 次：` +
        handoffs.map((h) => `${h.from}->${h.to}`).join(", ")
      : "无交接";
  return `多人协作完成「${task.slice(0, 60)}」。${handoffLine}\n${parts.join("\n")}`;
}
