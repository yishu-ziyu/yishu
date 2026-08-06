import type { Trajectory } from "../types.js";

export interface EvalCase {
  id: string;
  name: string;
  task: string;
  /** Return true if the agent output is acceptable. */
  check: (result: EvalAgentResult) => boolean;
}

export interface EvalAgentResult {
  finalText: string;
  toolsUsed: string[];
  trajectory: Trajectory;
  accepted?: boolean;
}

export interface EvalCaseReport {
  id: string;
  name: string;
  pass: boolean;
  finalText: string;
  toolsUsed: string[];
  detail?: string;
}

export interface EvalReport {
  total: number;
  passed: number;
  passRate: number;
  cases: EvalCaseReport[];
}

export type AgentFactory = () => {
  run: (task: string) => Promise<EvalAgentResult>;
};

export async function runEval(
  cases: EvalCase[],
  agentFactory: AgentFactory,
): Promise<EvalReport> {
  const reports: EvalCaseReport[] = [];

  for (const c of cases) {
    const agent = agentFactory();
    try {
      const result = await agent.run(c.task);
      const pass = c.check(result);
      reports.push({
        id: c.id,
        name: c.name,
        pass,
        finalText: result.finalText,
        toolsUsed: result.toolsUsed,
      });
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
    }
  }

  const passed = reports.filter((r) => r.pass).length;
  const total = reports.length;
  return {
    total,
    passed,
    passRate: total === 0 ? 0 : passed / total,
    cases: reports,
  };
}

/**
 * Built-in offline eval gold set (DeterministicLlm friendly).
 *
 * Book chapter map (CLI / docs summary):
 * | case id         | book chapter                                      |
 * |-----------------|---------------------------------------------------|
 * | math            | Ch1 ReAct + Ch4 tools (code_exec) + Ch5 coding    |
 * | memory-cycle    | Ch3 user memory (memory_write)                    |
 * | list-workspace  | Ch4 tools / Ch5 filesystem (list_dir)             |
 * | search          | Ch4 perception tools (web_search)                 |
 * | write-file      | Ch4 sandbox + Ch5 coding agent (write_file)       |
 * | knowledge       | Ch3 RAG / knowledge_search                        |
 * | knowledge-write | Ch3 multi-hop RAG lite (search → write summary)   |
 *
 * Peer collaboration (Ch10) and injection safety (Ch2) are covered by
 * dedicated tests, not this offline gold set.
 * Pass-rate gates in tests: agent-core >= 0.75, eval.test > 0.5.
 */
export function builtinEvalCases(): EvalCase[] {
  return [
    {
      // Ch1 ReAct · Ch4 tools · Ch5 coding agent
      id: "math",
      name: "arithmetic",
      task: "计算 17*19+3",
      check: (r) => {
        const has326 =
          r.finalText.includes("326") ||
          r.trajectory.steps.some((s) => {
            if (s.kind !== "tool_result") return false;
            return JSON.stringify(s.data).includes("326");
          });
        const used = r.toolsUsed.includes("code_exec");
        return has326 || used;
      },
    },
    {
      // Ch3 user memory
      id: "memory-cycle",
      name: "memory write then search",
      task: "记住：我偏好 tokyonight 主题",
      check: (r) => {
        return (
          r.toolsUsed.includes("memory_write") ||
          /记下|已记|tokyonight|偏好/.test(r.finalText)
        );
      },
    },
    {
      // Ch4 tools / Ch5 filesystem
      id: "list-workspace",
      name: "list workspace",
      task: "列目录 .",
      check: (r) => {
        return (
          r.toolsUsed.includes("list_dir") ||
          r.finalText.length > 0
        );
      },
    },
    {
      // Ch4 perception tools
      id: "search",
      name: "search query",
      task: "搜索 agent react",
      check: (r) => {
        return (
          r.toolsUsed.includes("web_search") ||
          /ReAct|react|检索|结果/i.test(r.finalText)
        );
      },
    },
    {
      // Ch4 sandbox execution + Ch5 coding agent (write_file)
      id: "write-file",
      name: "write workspace file",
      task: "写文件 eval-note.md 内容 eval-ok",
      check: (r) => {
        return r.toolsUsed.includes("write_file");
      },
    },
    {
      // Ch3 RAG / offline knowledge base
      id: "knowledge",
      name: "knowledge search ReAct",
      task: "关于 ReAct 模式",
      check: (r) => {
        return (
          r.toolsUsed.includes("knowledge_search") ||
          /ReAct|think|act|observe|知识库/i.test(r.finalText)
        );
      },
    },
    {
      // Ch3 multi-hop RAG lite: knowledge_search then write_file
      id: "knowledge-write",
      name: "knowledge then write summary file",
      task: "查知识 Agent 公式 并写文件 formula-summary.md 内容为知识摘要",
      check: (r) => {
        const searched = r.toolsUsed.includes("knowledge_search");
        const wrote = r.toolsUsed.includes("write_file");
        return searched && wrote;
      },
    },
  ];
}
