import { z } from "zod"
import { defineYishuAction } from "../action/define.js"
import { normalizeSessionScope } from "../session-scope.js"
import type { YishuStorePort } from "../store/yishu-store.js"
import type { ContextWatchCreateResult } from "../store/types.js"

const watchAppReturnInputSchema = z.object({
  reminder: z.string().trim().min(1).max(200),
  mainConversationId: z.string().trim().min(1).max(160),
  targetBundleId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/u),
  sourceFrameId: z.string().trim().min(1).max(160),
}).strict()

export type WatchAppReturnInput = z.infer<typeof watchAppReturnInputSchema>

export interface WatchAppReturnResult extends ContextWatchCreateResult {
  accepted: true
}

const MAX_SOURCE_FRAME_AGE_MS = 30_000
const MAX_CLOCK_SKEW_MS = 5_000

/**
 * Create one explicit, one-shot return reminder. The store commits its
 * Mandate, TaskTruth, and ContextWatch as a single mutation.
 */
export function createWatchAppReturnAction(store: YishuStorePort) {
  return defineYishuAction({
    name: "watch_app_return",
    description:
      "Create one durable reminder that fires after leaving and returning to the currently observed application.",
    inputSchema: watchAppReturnInputSchema,
    authority: "reversible",
    risk: "low",
    context: "current-frame",
    run: async (ctx): Promise<WatchAppReturnResult> => {
      if (ctx.sessionScope === undefined) {
        throw new Error("context_watch_requires_exact_session_scope")
      }
      const sessionScope = normalizeSessionScope(ctx.sessionScope)
      if (sessionScope.kind === "private") {
        throw new Error("context watches are unavailable in private sessions")
      }
      assertFreshBoundApplication(
        ctx.contextFrame,
        ctx.input.sourceFrameId,
        ctx.input.targetBundleId,
        ctx.now,
      )
      const created = await store.createContextWatch({
        mainConversationId: ctx.input.mainConversationId,
        sessionScope,
        targetBundleId: ctx.input.targetBundleId,
        reminder: ctx.input.reminder,
        sourceFrameId: ctx.input.sourceFrameId,
        createdAt: ctx.now.toISOString(),
      })
      ctx.markCommitted()
      return { accepted: true, ...created }
    },
  })
}

function assertFreshBoundApplication(
  contextFrame: unknown,
  sourceFrameId: string,
  targetBundleId: string,
  now: Date,
): void {
  if (!isRecord(contextFrame)) throw new Error("context_watch_requires_current_frame")
  if (contextFrame.frameId !== sourceFrameId) {
    throw new Error("context_watch_source_frame_changed")
  }
  const capturedAt = timestamp(contextFrame.capturedAt)
  const expiresAt = timestamp(contextFrame.expiresAt)
  const nowMs = now.getTime()
  if (
    capturedAt === null
    || expiresAt === null
    || capturedAt > nowMs + MAX_CLOCK_SKEW_MS
    || nowMs - capturedAt > MAX_SOURCE_FRAME_AGE_MS
    || expiresAt <= nowMs
  ) {
    throw new Error("context_watch_source_frame_stale")
  }
  const observed = isRecord(contextFrame.frontmostApplication)
    ? contextFrame.frontmostApplication
    : null
  const application = observed && isRecord(observed.value) ? observed.value : null
  if (!application || application.bundleIdentifier !== targetBundleId) {
    throw new Error("context_watch_frontmost_application_changed")
  }
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
