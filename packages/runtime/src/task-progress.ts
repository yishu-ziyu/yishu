import type {
  ActionRisk,
  AuthorityLevel,
  TaskProgressKind,
  TaskTruthProjector,
} from "@yishu/kernel";
import type { RuntimeEvent, TurnStartCommand } from "./protocol.js";
import { normalizeSessionScope } from "@yishu/kernel";
import {
  decideTaskRetry,
  evaluateTaskCompletion,
  type ExternalTaskVerification,
  type TaskExecutionContract,
  type TaskRetryDecision,
} from "./task-contract.js";

function safeMetadata(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value
    .replace(/[^a-zA-Z0-9._-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 80);
  return compact.length > 0 ? compact : undefined;
}

function evidenceFor(event: RuntimeEvent, suffix?: string): string {
  return ["runtime", event.type, event.eventId, suffix]
    .filter((part): part is string => Boolean(part))
    .join(":");
}

export type TerminalTaskProgressKind =
  | "completed"
  | "verified"
  | "unverified"
  | "cancelled"
  | "failed";

/**
 * The single source of truth for terminal event → TaskTruth kind, shared by
 * the per-turn tracker and delegated-child settlement (ADR 0009). An
 * unverified completion is never promoted to verified/done.
 */
export function terminalTaskProgressKindFor(
  event: RuntimeEvent,
  contract?: TaskExecutionContract,
  externalVerification?: ExternalTaskVerification,
): TerminalTaskProgressKind | undefined {
  if (event.type === "response.completed") {
    if (contract) {
      const responseText = typeof event.payload.text === "string"
        ? event.payload.text
        : undefined;
      return evaluateTaskCompletion(contract, {
        ...(responseText === undefined ? {} : { responseText }),
        ...(externalVerification === undefined ? {} : { externalVerification }),
      });
    }
    return event.payload.verified === true ? "verified" : "unverified";
  }
  if (event.type === "turn.cancelled") return "cancelled";
  if (event.type === "turn.failed" || event.type === "runtime.error") return "failed";
  return undefined;
}

/**
 * Runtime-side adapter only: translate typed execution events into the generic
 * progress signals whose persistence policy is owned by TaskTruthProjector.
 */
export class RuntimeTaskProgressTracker {
  private executionStarted = false;
  private turnEnded = false;
  private attemptsDispatched = 0;
  private tail: Promise<void> = Promise.resolve();
  private persistenceError: unknown;

  constructor(
    private readonly projector: TaskTruthProjector,
    private readonly command: TurnStartCommand,
    private readonly contract?: TaskExecutionContract,
  ) {}

  /**
   * Admission point for a product-level attempt. Call immediately before a
   * dispatch; successful admission consumes one slot. Pi's transport/model
   * retries must not call this method.
   */
  requestAttempt(input: {
    proposedAuthority: AuthorityLevel;
    proposedRisk: ActionRisk;
  }): TaskRetryDecision | undefined {
    if (!this.contract) return undefined;
    const decision = decideTaskRetry(this.contract, {
      attemptsUsed: this.attemptsDispatched,
      proposedAuthority: input.proposedAuthority,
      proposedRisk: input.proposedRisk,
    });
    if (decision.decision === "retry") {
      this.attemptsDispatched = decision.nextAttempt;
    }
    return decision;
  }

  observe(event: RuntimeEvent, externalVerification?: ExternalTaskVerification): void {
    const signal = this.signalFor(event, externalVerification);
    if (!signal) return;

    this.tail = this.tail.then(async () => {
      try {
        await this.projector.record({
          taskId: this.command.requestId,
          title: this.contract?.objective ?? this.command.payload.utterance,
          kind: signal.kind,
          observedAt: event.occurredAt,
          evidence: signal.evidence,
          sessionScope: normalizeSessionScope(this.command.payload.sessionScope),
          ...(this.command.payload.conversationId !== undefined
            ? { mainConversationId: this.command.payload.conversationId }
            : {}),
          ...(this.contract !== undefined ? { contract: this.contract } : {}),
        });
      } catch (error) {
        this.persistenceError ??= error;
      }
    });
  }

  recordRuntimeFailure(phase: "start" | "steer" | "cancel"): void {
    if (this.turnEnded) return;
    this.turnEnded = true;
    if (!this.executionStarted) return;
    const occurredAt = new Date().toISOString();
    this.tail = this.tail.then(async () => {
      try {
        await this.projector.record({
          taskId: this.command.requestId,
          title: this.contract?.objective ?? this.command.payload.utterance,
          kind: "failed",
          observedAt: occurredAt,
          evidence: `runtime:operation_failed:${phase}`,
          sessionScope: normalizeSessionScope(this.command.payload.sessionScope),
          ...(this.command.payload.conversationId !== undefined
            ? { mainConversationId: this.command.payload.conversationId }
            : {}),
          ...(this.contract !== undefined ? { contract: this.contract } : {}),
        });
      } catch (error) {
        this.persistenceError ??= error;
      }
    });
  }

  async flush(): Promise<void> {
    await this.tail;
    await this.projector.flush(this.command.requestId);
    if (this.persistenceError !== undefined) throw this.persistenceError;
  }

  private signalFor(
    event: RuntimeEvent,
    externalVerification?: ExternalTaskVerification,
  ): { kind: TaskProgressKind; evidence: string } | undefined {
    if (this.turnEnded) return undefined;

    // A terminal event closes the request even when no tool has started yet.
    // This prevents a cancelled or completed conversation from later being
    // resurrected into a task by delayed runtime events.
    const terminalKind = terminalTaskProgressKindFor(
      event,
      this.contract,
      externalVerification,
    );
    if (terminalKind !== undefined) {
      this.turnEnded = true;
      if (!this.executionStarted) return undefined;
      const suffix = terminalKind === "completed"
        || terminalKind === "verified"
        || terminalKind === "unverified"
        ? terminalKind
        : undefined;
      return { kind: terminalKind, evidence: evidenceFor(event, suffix) };
    }

    if (event.type === "tool.started" || event.type === "computer.action.requested") {
      const firstExecutionObservation = !this.executionStarted;
      this.executionStarted = true;
      const toolName = safeMetadata(event.payload.toolName);
      const action = safeMetadata(event.payload.action);
      return {
        kind: firstExecutionObservation ? "start" : "progress",
        evidence: evidenceFor(event, toolName ?? action),
      };
    }

    if (!this.executionStarted) return undefined;

    if (event.type === "tool.completed") {
      const toolName = safeMetadata(event.payload.toolName);
      const outcome = event.payload.isError === true ? "error" : "ok";
      return {
        kind: "progress",
        evidence: evidenceFor(event, [toolName, outcome].filter(Boolean).join("_")),
      };
    }

    if (event.type === "runtime.status") {
      return {
        kind: "progress",
        evidence: evidenceFor(event, safeMetadata(event.payload.status)),
      };
    }

    return undefined;
  }
}
