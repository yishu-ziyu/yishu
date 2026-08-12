import { z } from "zod";
import { randomUUID } from "node:crypto";
import { defineYishuAction } from "../action/define.js";
import type { TaskTruthProjector } from "../task-truth.js";
import { normalizeSessionScope } from "../session-scope.js";
import type { TaskExecutionContract } from "../task-contract.js";

const delegateInputSchema = z.object({
  /** Short human-readable task title, e.g. "研究 Yishu memory 方案". */
  title: z.string().trim().min(1).max(200),
  /** The parent task id this delegated task belongs to (main turn task). */
  parentId: z.string().trim().min(1).max(160),
  /** Durable Main-conversation owner used for restart recovery and result routing. */
  mainConversationId: z.string().trim().min(1).max(160),
  contract: z.object({
    objective: z.string().trim().min(1).max(160),
    successMode: z.enum(["read_only_delivery", "external_effect"]),
    authority: z.enum(["automatic", "reversible", "standing_mandate", "explicit_approval"]),
    risk: z.enum(["low", "medium", "high", "critical"]),
    maxAttempts: z.literal(1),
  }).strict(),
  sessionScope: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("personal") }),
      z.object({
        kind: z.literal("project"),
        projectId: z.string().trim().min(1),
        projectLabel: z.string().trim().min(1).max(80).optional(),
      }),
      z.object({ kind: z.literal("private") }),
    ])
    .optional(),
});

export type DelegateInput = z.infer<typeof delegateInputSchema>;

export interface DelegateResult {
  accepted: true;
  taskId: string;
}

/**
 * Product semantics of delegation: register the child TaskTruth linked to its
 * parent and acknowledge acceptance. The kernel deliberately does NOT start
 * any execution — starting the child session is the runtime's job (RFC v2 §3,
 * ADR 0009). TaskTruth remains the only task-status truth.
 */
export function createDelegateAction(deps: { taskTruth: TaskTruthProjector }) {
  return defineYishuAction({
    name: "delegate",
    description:
      "Register a delegated child task (TaskTruth, parent-linked) and accept it for asynchronous execution.",
    inputSchema: delegateInputSchema,
    authority: "automatic",
    risk: "low",
    context: "none",
    run: async (ctx): Promise<DelegateResult> => {
      const sessionScope = normalizeSessionScope(ctx.input.sessionScope);
      if (sessionScope.kind === "private") {
        throw new Error("delegate is unavailable in private sessions");
      }
      const taskId = randomUUID();
      await deps.taskTruth.record({
        taskId,
        title: ctx.input.title,
        kind: "start",
        observedAt: ctx.now.toISOString(),
        evidence: `delegate:accepted:${taskId}`,
        parentId: ctx.input.parentId,
        mainConversationId: ctx.input.mainConversationId,
        contract: ctx.input.contract as TaskExecutionContract,
        sessionScope,
      });
      return { accepted: true, taskId };
    },
  });
}
