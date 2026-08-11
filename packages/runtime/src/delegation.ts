/**
 * Delegated execution V1 (RFC v2, ADR 0009).
 *
 * Runtime side of delegation: expose the delegate tool to the main Pi session,
 * start the independent child session, execute asynchronously, hold results in
 * a payload-only inbox, and hand them to the next main turn for prompt
 * injection. The kernel owns the delegate product semantics (TaskTruth
 * registration); this module never keeps a second task-status truth.
 */

import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { YishuKernel } from "@yishu/kernel";
import { buildContextCapsule, type ContextCapsule } from "@yishu/kernel";
import type { SessionScope } from "@yishu/kernel";
import { sanitizeVisibleText } from "@yishu/kernel";
import type {
  ContextFrame,
  RuntimeEvent,
  TurnStartCommand,
} from "./protocol.js";
import { PROTOCOL_VERSION } from "./protocol.js";

/** Delivery metadata describing what kind of result this is — never a task status. */
export type DelegatedResultKind = "succeeded" | "failed" | "cancelled";

export interface DelegatedResult {
  taskId: string;
  parentId: string;
  resultKind: DelegatedResultKind;
  /** Bounded, sanitized, user-presentable summary. */
  summary: string;
  completedAt: string;
}

const MAX_RESULT_SUMMARY = 500;
const MAX_CHILD_PROMPT_CONTEXT = 1000;

/**
 * Payload-only result inbox, keyed by the main conversation so a result can
 * only re-enter the conversation that delegated the task. In-memory in V1
 * (restart loss recorded as technical debt); TaskTruth is the durable truth.
 */
export class ResultInbox {
  private readonly entries = new Map<string, DelegatedResult[]>();

  put(conversationId: string, entry: DelegatedResult): void {
    const list = this.entries.get(conversationId) ?? [];
    list.push(entry);
    this.entries.set(conversationId, list);
  }

  /** One-shot consume: returns every pending result and clears the queue. */
  consume(conversationId: string): DelegatedResult[] {
    const list = this.entries.get(conversationId) ?? [];
    if (list.length > 0) this.entries.delete(conversationId);
    return list;
  }

  pendingCount(conversationId: string): number {
    return this.entries.get(conversationId)?.length ?? 0;
  }
}

interface MainTurnHandle {
  requestId: string;
  sessionScope: SessionScope;
}

export interface DelegationCoordinatorDeps {
  kernel: YishuKernel;
  /** Execute a turn on the shared execution harness (the inner runtime). */
  executeTurn: (command: TurnStartCommand, emit: (event: RuntimeEvent) => void) => Promise<void>;
  now?: () => Date;
}

const CHILD_CONVERSATION_PREFIX = "child-";

export function isChildConversation(conversationId: string): boolean {
  return conversationId.startsWith(CHILD_CONVERSATION_PREFIX);
}

/**
 * Owns the runtime side of delegation for one ProductKernelRuntime instance.
 */
export class DelegationCoordinator {
  private readonly kernel: YishuKernel;
  private readonly executeTurn: DelegationCoordinatorDeps["executeTurn"];
  private readonly now: () => Date;
  readonly inbox = new ResultInbox();
  private readonly mainTurns = new Map<string, MainTurnHandle>();
  private readonly runningChildren = new Set<Promise<void>>();

  constructor(deps: DelegationCoordinatorDeps) {
    this.kernel = deps.kernel;
    this.executeTurn = deps.executeTurn;
    this.now = deps.now ?? (() => new Date());
  }

  /** Register the active main turn so the delegate tool can link parentage. */
  noteMainTurn(conversationId: string, requestId: string, sessionScope: SessionScope): void {
    this.mainTurns.set(conversationId, { requestId, sessionScope });
  }

  clearMainTurn(conversationId: string, requestId: string): void {
    const handle = this.mainTurns.get(conversationId);
    if (handle?.requestId === requestId) this.mainTurns.delete(conversationId);
  }

  /** Results consumed by the next main turn's prompt assembly. */
  consumeForTurn(conversationId: string): DelegatedResult[] {
    return this.inbox.consume(conversationId);
  }

  /**
   * Tool set for a session about to be created. Child sessions get none —
   * recursive delegation is structurally impossible (RFC v2 §3.7).
   */
  delegateToolFor(conversationId: string): ToolDefinition[] {
    if (isChildConversation(conversationId)) return [];
    return [this.createDelegateTool(conversationId)];
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.runningChildren]);
    this.mainTurns.clear();
  }

  private createDelegateTool(conversationId: string): ToolDefinition {
    const parameters = Type.Object({
      task: Type.String({
        minLength: 1,
        maxLength: 200,
        description: "Short description of the task to delegate, in the user's language.",
      }),
    });
    const coordinator = this;
    return {
      name: "delegate",
      label: "Delegate task",
      description: [
        "Start an independent background task and continue the conversation immediately.",
        "Use when the user asks for research or work that can run in the background",
        "while you keep talking. The result will be delivered in a later turn.",
      ].join(" "),
      promptSnippet: "Delegate a background task and reply right away without waiting for it.",
      promptGuidelines: [
        "After a successful delegate call, confirm briefly that the task started; do not wait for the result.",
        "Never call delegate from within a delegated task.",
      ],
      parameters,
      executionMode: "sequential",
      async execute(_toolCallId: string, params: { task: string }) {
        const mainTurn = coordinator.mainTurns.get(conversationId);
        if (!mainTurn) {
          throw new Error("delegate is unavailable: no active main turn for this conversation");
        }
        if (mainTurn.sessionScope.kind === "private") {
          throw new Error("delegate is unavailable in private sessions");
        }
        try {
          const { accepted, taskId } = await coordinator.acceptDelegation({
            title: params.task,
            mainConversationId: conversationId,
            mainTurn,
          });
          return {
            content: [{
              type: "text",
              text: `Delegated task accepted (taskId=${taskId}). It runs in the background; the result will arrive in a later turn. Tell the user it has started.`,
            }],
            details: { accepted, taskId },
          };
        } catch (error) {
          throw new Error(
            `delegate failed: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
      },
    } as ToolDefinition;
  }

  /**
   * Accept a delegation: kernel registers the child TaskTruth (product
   * semantics), then the child session starts in the background. Returns the
   * receipt immediately — the caller never waits for the child (RFC v2 §3.5).
   */
  private async acceptDelegation(input: {
    title: string;
    mainConversationId: string;
    mainTurn: MainTurnHandle;
  }): Promise<{ accepted: true; taskId: string }> {
    // Handoff payload: a minimal, sanitized capsule — never the full
    // conversation history (RFC v2 §3.9).
    const capsule = buildContextCapsule({
      trail: this.kernel.trail,
      userIntent: input.title,
      recentMinutes: 5,
      now: this.now(),
    });

    const receipt = await this.kernel.registry.invoke("delegate", {
      caller: "pi",
      input: {
        title: input.title,
        parentId: input.mainTurn.requestId,
        sessionScope: input.mainTurn.sessionScope,
      },
      now: this.now(),
    });
    if (receipt.status !== "ok" || !receipt.output) {
      throw new Error(receipt.message ?? "delegate action failed");
    }
    const output = receipt.output as { accepted: true; taskId: string };

    const childPromise = this.runChild({
      taskId: output.taskId,
      title: input.title,
      capsule,
      sessionScope: input.mainTurn.sessionScope,
      parentId: input.mainTurn.requestId,
      mainConversationId: input.mainConversationId,
    });
    this.runningChildren.add(childPromise);
    void childPromise.finally(() => this.runningChildren.delete(childPromise));

    return { accepted: true, taskId: output.taskId };
  }

  /**
   * Execute the child task on the shared harness with an independent session
   * (distinct conversationId — the verified isolation path of Spike A), then
   * translate the outcome into TaskTruth + a payload-only inbox entry.
   */
  private async runChild(input: {
    taskId: string;
    title: string;
    capsule: ContextCapsule;
    sessionScope: SessionScope;
    parentId: string;
    mainConversationId: string;
  }): Promise<void> {
    // Receiver-side expiry validation at the handoff boundary (RFC v2 §3.10).
    if (Date.parse(input.capsule.expiresAt) <= this.now().getTime()) {
      await this.settleChild(input, "failed", "handoff capsule expired before execution");
      return;
    }

    const command = this.buildChildCommand(input);
    let outcome: { kind: DelegatedResultKind; summary: string } = {
      kind: "failed",
      summary: "child execution ended without a result",
    };
    try {
      await this.executeTurn(command, (event) => {
        if (event.type === "response.completed") {
          outcome = { kind: "succeeded", summary: String(event.payload.text ?? "") };
        } else if (event.type === "turn.failed") {
          outcome = {
            kind: "failed",
            summary: String(event.payload.message ?? event.payload.code ?? "unknown failure"),
          };
        } else if (event.type === "turn.cancelled") {
          outcome = { kind: "cancelled", summary: "task was cancelled" };
        }
      });
    } catch (error) {
      outcome = {
        kind: "failed",
        summary: error instanceof Error ? error.message : "child execution failed",
      };
    }
    await this.settleChild(input, outcome.kind, outcome.summary);
  }

  private async settleChild(
    input: { taskId: string; title: string; parentId: string; mainConversationId: string },
    resultKind: DelegatedResultKind,
    rawSummary: string,
  ): Promise<void> {
    const observedAt = this.now().toISOString();
    const kind = resultKind === "succeeded"
      ? "verified"
      : resultKind === "cancelled"
        ? "cancelled"
        : "failed";
    const summary = sanitizeVisibleText(rawSummary, "delegated result summary")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_RESULT_SUMMARY);
    try {
      await this.kernel.taskTruth.record({
        taskId: input.taskId,
        title: input.title,
        kind,
        observedAt,
        evidence: `delegate:${kind}:${input.taskId}`,
      });
      await this.kernel.taskTruth.flush(input.taskId);
    } catch {
      // TaskTruth is the only status truth; if it is unavailable the result
      // must not silently pretend the task settled — drop the inbox entry.
      return;
    }
    this.inbox.put(input.mainConversationId, {
      taskId: input.taskId,
      parentId: input.parentId,
      resultKind,
      summary,
      completedAt: observedAt,
    });
  }

  private buildChildCommand(input: {
    taskId: string;
    title: string;
    capsule: ContextCapsule;
    sessionScope: SessionScope;
  }): TurnStartCommand {
    const now = this.now();
    const contextLines: string[] = [];
    if (input.capsule.userIntent) contextLines.push(`intent: ${input.capsule.userIntent}`);
    if (input.capsule.frontmostApp) contextLines.push(`frontmost app: ${input.capsule.frontmostApp.name}`);
    if (input.capsule.window?.title) contextLines.push(`window: ${input.capsule.window.title}`);
    if (input.capsule.axElement?.title) contextLines.push(`element: ${input.capsule.axElement.title}`);
    if (input.capsule.selectedText) contextLines.push(`selection: ${input.capsule.selectedText}`);
    const contextSummary = contextLines.join("\n").slice(0, MAX_CHILD_PROMPT_CONTEXT);

    const frameId = randomUUID();
    const contextFrame: ContextFrame = {
      schemaVersion: PROTOCOL_VERSION,
      frameId,
      capturedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      cursor: {
        value: { x: 0, y: 0, coordinateSpace: "global-top-left" },
        source: "delegation",
        capturedAt: now.toISOString(),
        confidence: 0,
      },
      pointerTrail: [],
      frontmostApplication: null,
      activeWindow: null,
      elementUnderCursor: null,
      screenshots: [],
      warnings: ["delegated child task: no live desktop context"],
    };

    return {
      schemaVersion: PROTOCOL_VERSION,
      type: "turn.start",
      requestId: `child-turn-${input.taskId}`,
      traceId: randomUUID(),
      sentAt: now.toISOString(),
      payload: {
        utterance: [
          "You are running a delegated background task. Complete it and report a concise result.",
          "",
          `task: ${input.title}`,
          "",
          contextSummary.length > 0 ? "shared context (capsule):" : "",
          contextSummary,
        ].filter((line) => line.length > 0).join("\n"),
        capabilityProfile: "conversation",
        conversationId: `${CHILD_CONVERSATION_PREFIX}${input.taskId}`,
        sessionScope: input.sessionScope,
        contextFrame,
      },
    };
  }
}
