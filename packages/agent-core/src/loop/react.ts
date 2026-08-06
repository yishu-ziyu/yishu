import type { LlmPort } from "../llm.js";
import { buildStatusBar } from "../context/status-bar.js";
import { compressMessages } from "../context/compress.js";
import { wrapUntrustedContent } from "../security/injection-guard.js";
import type { ToolRegistry } from "../tools/registry.js";
import { TrajectoryRecorder } from "../trajectory/recorder.js";
import type {
  AgentConfig,
  ChatMessage,
  Trajectory,
  TrajectoryStep,
} from "../types.js";

export interface ReactRunInput {
  llm: LlmPort;
  tools: ToolRegistry;
  messages: ChatMessage[];
  config: AgentConfig;
  task?: string;
  onStep?: (step: TrajectoryStep) => void;
}

export interface ReactRunResult {
  messages: ChatMessage[];
  finalText: string;
  trajectory: Trajectory;
  toolsUsed: string[];
}

function taskNeedsTools(task: string): boolean {
  return /计算|算|compute|calc|\d+\s*[+\-*/]|记住|remember|搜索|查|search|list|列目录|read\s+file|读文件|write\s+file|写文件/i.test(
    task,
  );
}

/**
 * Core ReAct loop:
 * inject status bar -> llm.complete -> tool_calls execute / text done.
 */
export async function runReactAgent(
  input: ReactRunInput,
): Promise<ReactRunResult> {
  const { llm, tools, config, onStep } = input;
  const task =
    input.task ??
    [...input.messages].reverse().find((m) => m.role === "user")?.content ??
    "";
  const recorder = new TrajectoryRecorder(task);
  const messages: ChatMessage[] = [...input.messages];
  const toolsUsed: string[] = [];
  let memoryHits = 0;
  let finalText = "";

  const emit = (kind: TrajectoryStep["kind"], data: unknown) => {
    const step = recorder.step(kind, data);
    onStep?.(step);
  };

  for (let i = 1; i <= config.maxIterations; i++) {
    const status = buildStatusBar({
      now: new Date(),
      iteration: i,
      maxIterations: config.maxIterations,
      toolsUsed,
      memoryHits,
      workspace: config.workspaceDir,
    });
    emit("status", { iteration: i, status });

    // Ephemeral status: not permanently stored as user content after turn
    const forLlm = compressMessages(
      [
        ...messages,
        { role: "system", content: status },
      ],
      12_000,
    );

    const response = await llm.complete(forLlm, tools.list());

    if (response.type === "tool_calls") {
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: "",
        toolCalls: response.toolCalls,
      };
      messages.push(assistantMsg);
      emit("think", { toolCalls: response.toolCalls });

      for (const call of response.toolCalls) {
        emit("tool_call", {
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
        const result = await tools.execute(call.name, call.arguments);
        if (!toolsUsed.includes(call.name)) toolsUsed.push(call.name);
        if (call.name === "memory_search" && result.ok) {
          const n = Number(
            (result.evidence as { count?: number } | undefined)?.count ?? 0,
          );
          memoryHits += n;
        }
        const rawContent = result.ok
          ? result.content
          : `error: ${result.error ?? "unknown"}`;
        // Tool output is untrusted: delimit so model treats it as data, not commands.
        const content = wrapUntrustedContent(call.name, rawContent);
        messages.push({
          role: "tool",
          content,
          toolCallId: call.id,
          name: call.name,
        });
        emit("tool_result", {
          id: call.id,
          name: call.name,
          ok: result.ok,
          content: content.slice(0, 2000),
          evidence: result.evidence,
        });
      }
      continue;
    }

    // text response
    finalText = response.text.trim();
    messages.push({ role: "assistant", content: finalText });
    emit("final", { text: finalText });

    // Guard: never claim success without tool evidence when task needs tools
    if (
      taskNeedsTools(task) &&
      toolsUsed.length === 0 &&
      i < config.maxIterations
    ) {
      // Force one more round with a nudge
      messages.push({
        role: "system",
        content:
          "Task requires tool use. Call the appropriate tool before final answer.",
      });
      continue;
    }

    recorder.finish("completed", finalText);
    return { messages, finalText, trajectory: recorder.trajectory, toolsUsed };
  }

  if (!finalText) {
    finalText =
      toolsUsed.length > 0
        ? "达到迭代上限；已有部分工具结果，请缩小任务再试。"
        : "达到迭代上限，未能完成。";
    emit("final", { text: finalText, reason: "max_iterations" });
  }
  recorder.finish("max_iterations", finalText);
  return { messages, finalText, trajectory: recorder.trajectory, toolsUsed };
}
