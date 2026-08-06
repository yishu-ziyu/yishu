import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { YishuAgent } from "@yishu/agent-core";
import type { AgentRuntime, RuntimeEventSink } from "./runtime-port.js";
import {
  runtimeEvent,
  type ContextFrame,
  type TurnCancelCommand,
  type TurnStartCommand,
  type TurnSteerCommand,
} from "./protocol.js";

export interface AgentCoreRuntimeOptions {
  /** Override agent-core package root (skills live under skills/). */
  packageRoot?: string;
  workspaceDir?: string;
  skillsDir?: string;
  memoryPath?: string;
  trajectoriesDir?: string;
  enableReview?: boolean;
}

function resolveAgentCorePackageRoot(): string {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("@yishu/agent-core");
    // .../packages/agent-core/dist/index.js → package root
    return path.resolve(path.dirname(entry), "..");
  } catch {
    // monorepo fallback: packages/runtime/{src|dist} → packages/agent-core
    return path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "agent-core",
    );
  }
}

/** Short context summary for the book harness task string. */
export function summarizeContextFrame(frame: ContextFrame): string {
  const app = frame.frontmostApplication?.value.name;
  const windowTitle = frame.activeWindow?.value.title;
  const element =
    frame.elementUnderCursor?.value.title
    ?? frame.elementUnderCursor?.value.description;

  const parts: string[] = [];
  if (app) parts.push(`app=${app}`);
  if (windowTitle) parts.push(`window=${windowTitle}`);
  if (element) parts.push(`element=${element}`);
  return parts.length > 0 ? parts.join(", ") : "no context";
}

export function buildAgentCoreTask(command: TurnStartCommand): string {
  const summary = summarizeContextFrame(command.payload.contextFrame);
  return `${command.payload.utterance}\n\n[context: ${summary}]`;
}

/**
 * AgentRuntime backed by @yishu/agent-core (book harness / ReAct loop).
 * Product code still depends only on AgentRuntime; agent-core types stay here.
 */
export class AgentCoreRuntime implements AgentRuntime {
  private readonly options: AgentCoreRuntimeOptions;
  private agent: YishuAgent | null = null;
  private ephemeralRoot: string | null = null;
  private cancelled = false;
  private disposed = false;
  private running = false;

  constructor(options: AgentCoreRuntimeOptions = {}) {
    this.options = options;
  }

  private async ensureAgent(): Promise<YishuAgent> {
    if (this.agent) return this.agent;

    const packageRoot = this.options.packageRoot ?? resolveAgentCorePackageRoot();
    const skillsDir = this.options.skillsDir ?? path.join(packageRoot, "skills");

    let workspaceDir: string;
    let memoryPath: string;
    let trajectoriesDir: string;

    if (
      this.options.workspaceDir
      && this.options.memoryPath
      && this.options.trajectoriesDir
    ) {
      workspaceDir = this.options.workspaceDir;
      memoryPath = this.options.memoryPath;
      trajectoriesDir = this.options.trajectoriesDir;
    } else {
      this.ephemeralRoot = await mkdtemp(path.join(tmpdir(), "yishu-agent-core-rt-"));
      workspaceDir = this.options.workspaceDir
        ?? path.join(this.ephemeralRoot, "workspace");
      memoryPath = this.options.memoryPath
        ?? path.join(this.ephemeralRoot, "memory.json");
      trajectoriesDir = this.options.trajectoriesDir
        ?? path.join(this.ephemeralRoot, "trajectories");
    }

    const agent = new YishuAgent({
      workspaceDir,
      skillsDir,
      memoryPath,
      trajectoriesDir,
      enableReview: this.options.enableReview ?? true,
    });
    await agent.init();
    this.agent = agent;
    return agent;
  }

  async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
    if (this.disposed) {
      emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
        code: "runtime_disposed",
        message: "AgentCoreRuntime has been disposed.",
      }));
      return;
    }

    this.cancelled = false;
    this.running = true;

    emit(runtimeEvent("turn.started", command.requestId, command.traceId, {
      runtime: "agent-core",
      capabilityProfile: command.payload.capabilityProfile,
    }));

    try {
      const agent = await this.ensureAgent();
      if (this.cancelled) {
        emit(runtimeEvent("turn.cancelled", command.requestId, command.traceId, {
          reason: "user_cancelled",
        }));
        return;
      }

      const task = buildAgentCoreTask(command);
      const result = await agent.run(task);

      if (this.cancelled) {
        emit(runtimeEvent("turn.cancelled", command.requestId, command.traceId, {
          reason: "user_cancelled",
        }));
        return;
      }

      const text = result.finalText;
      const chunks = text.match(/.{1,18}/gu) ?? [text];
      for (const chunk of chunks) {
        if (this.cancelled) {
          emit(runtimeEvent("turn.cancelled", command.requestId, command.traceId, {
            reason: "user_cancelled",
          }));
          return;
        }
        emit(runtimeEvent("response.delta", command.requestId, command.traceId, {
          text: chunk,
        }));
      }

      // Tool success is not task completion: verified tracks reviewer acceptance.
      emit(runtimeEvent("response.completed", command.requestId, command.traceId, {
        text,
        verified: result.accepted,
        verifier: "agent-core-reviewer",
      }));

      emit(runtimeEvent("runtime.status", command.requestId, command.traceId, {
        status: "trajectory_summary",
        trajectoryId: result.trajectory.id,
        trajectoryStatus: result.trajectory.status,
        toolsUsed: result.toolsUsed,
        stepCount: result.trajectory.steps.length,
        accepted: result.accepted,
      }));
    } catch (error) {
      if (this.cancelled) {
        emit(runtimeEvent("turn.cancelled", command.requestId, command.traceId, {
          reason: "user_cancelled",
        }));
        return;
      }
      emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
        code: "agent_core_turn_failed",
        message: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      this.running = false;
    }
  }

  async steerTurn(command: TurnSteerCommand, emit: RuntimeEventSink): Promise<void> {
    emit(runtimeEvent("runtime.status", command.requestId, command.traceId, {
      status: "steering_received",
      message: command.payload.message,
      note: this.running
        ? "agent-core offline loop cannot soft-steer mid-run"
        : "no active agent-core turn",
    }));
  }

  async cancelTurn(command: TurnCancelCommand, emit: RuntimeEventSink): Promise<void> {
    this.cancelled = true;
    emit(runtimeEvent("turn.cancelled", command.requestId, command.traceId, {
      reason: command.payload.reason ?? "user_cancelled",
    }));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelled = true;
    this.agent = null;
    if (this.ephemeralRoot) {
      await rm(this.ephemeralRoot, { recursive: true, force: true }).catch(() => {});
      this.ephemeralRoot = null;
    }
  }
}
