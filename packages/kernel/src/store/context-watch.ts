import { randomUUID } from "node:crypto"
import {
  assertDurableSessionScope,
  cloneSessionScope,
  normalizeSessionScope,
} from "../session-scope.js"
import { createTaskExecutionContract } from "../task-contract.js"
import { assertPersistableSafeText } from "./ledger-safety.js"
import type {
  ContextWatch,
  ContextWatchCreateInput,
  ContextWatchCreateResult,
  ContextWatchState,
} from "./types.js"

export const CONTEXT_WATCH_FIRE_ACTION = "context_watch_fire"

const ACTIVE_CONTEXT_WATCH_STATES = new Set<ContextWatchState>([
  "waiting_for_departure",
  "armed",
])
const CONTEXT_WATCH_STATES = new Set<ContextWatchState>([
  "waiting_for_departure",
  "armed",
  "fired",
  "cancelled",
])
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/u

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`context_watch_invalid_${field}`)
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 160) {
    throw new Error(`context_watch_invalid_${field}`)
  }
  assertPersistableSafeText(normalized, `context watch ${field}`)
  return normalized
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`context_watch_invalid_${field}`)
  }
  return value
}

function reminderText(value: unknown): string {
  if (typeof value !== "string") throw new Error("context_watch_invalid_reminder")
  const reminder = value.trim()
  if (reminder.length === 0 || reminder.length > 200) {
    throw new Error("context_watch_invalid_reminder")
  }
  assertPersistableSafeText(reminder, "context watch reminder")
  return reminder
}

function bundleIdentifier(value: unknown): string {
  if (typeof value !== "string" || !BUNDLE_ID_PATTERN.test(value)) {
    throw new Error("context_watch_invalid_target_bundle")
  }
  return value
}

export function isActiveContextWatch(watch: ContextWatch): boolean {
  return ACTIVE_CONTEXT_WATCH_STATES.has(watch.state)
}

export function cloneContextWatch(watch: ContextWatch): ContextWatch {
  return {
    ...watch,
    sessionScope: cloneSessionScope(watch.sessionScope),
  }
}

/** A queued observation from before the watch/arm boundary cannot advance it. */
export function contextWatchObservationIsNew(
  watch: ContextWatch,
  nextState: "armed" | "fired",
  occurredAt: string,
): boolean {
  const boundary = nextState === "armed" ? watch.createdAt : watch.armedAt
  if (boundary === undefined) return false
  return Date.parse(occurredAt) > Date.parse(boundary)
}

/** Validate persisted records as strictly as new writes. */
export function normalizeContextWatchRecord(raw: unknown): ContextWatch {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("context_watch_invalid_record")
  }
  const value = raw as Record<string, unknown>
  if (typeof value.state !== "string" || !CONTEXT_WATCH_STATES.has(value.state as ContextWatchState)) {
    throw new Error("context_watch_invalid_state")
  }
  const sessionScope = normalizeSessionScope(value.sessionScope)
  assertDurableSessionScope(sessionScope)
  const watch: ContextWatch = {
    id: identifier(value.id, "id"),
    taskId: identifier(value.taskId, "task_id"),
    mandateId: identifier(value.mandateId, "mandate_id"),
    mainConversationId: identifier(value.mainConversationId, "conversation_id"),
    sessionScope,
    targetBundleId: bundleIdentifier(value.targetBundleId),
    reminder: reminderText(value.reminder),
    state: value.state as ContextWatchState,
    createdAt: timestamp(value.createdAt, "created_at"),
    sourceFrameId: identifier(value.sourceFrameId, "source_frame_id"),
  }
  if (value.armedAt !== undefined) watch.armedAt = timestamp(value.armedAt, "armed_at")
  if (value.firedAt !== undefined) watch.firedAt = timestamp(value.firedAt, "fired_at")

  if (watch.state === "waiting_for_departure" && (watch.armedAt || watch.firedAt)) {
    throw new Error("context_watch_invalid_timeline")
  }
  if (watch.state === "armed" && (!watch.armedAt || watch.firedAt)) {
    throw new Error("context_watch_invalid_timeline")
  }
  if (watch.state === "fired" && (!watch.armedAt || !watch.firedAt)) {
    throw new Error("context_watch_invalid_timeline")
  }
  if (watch.state === "cancelled" && watch.firedAt) {
    throw new Error("context_watch_invalid_timeline")
  }
  return watch
}

export function buildContextWatchCreation(
  input: ContextWatchCreateInput,
): ContextWatchCreateResult {
  const sessionScope = normalizeSessionScope(input.sessionScope)
  assertDurableSessionScope(sessionScope)
  const createdAt = timestamp(input.createdAt ?? new Date().toISOString(), "created_at")
  const watchId = identifier(input.id ?? randomUUID(), "id")
  const taskId = identifier(input.taskId ?? randomUUID(), "task_id")
  const mandateId = identifier(input.mandateId ?? randomUUID(), "mandate_id")
  const mainConversationId = identifier(input.mainConversationId, "conversation_id")
  const targetBundleId = bundleIdentifier(input.targetBundleId)
  const reminder = reminderText(input.reminder)
  const sourceFrameId = identifier(input.sourceFrameId, "source_frame_id")
  const title = `提醒：${reminder}`

  return {
    watch: {
      id: watchId,
      taskId,
      mandateId,
      mainConversationId,
      sessionScope: cloneSessionScope(sessionScope),
      targetBundleId,
      reminder,
      state: "waiting_for_departure",
      createdAt,
      sourceFrameId,
    },
    task: {
      id: taskId,
      parentId: mandateId,
      title,
      status: "running",
      createdAt,
      updatedAt: createdAt,
      evidence: [
        `context_watch:waiting_for_departure:${watchId}`,
        `context_watch:source_frame:${sourceFrameId}`,
      ],
      sessionScope: cloneSessionScope(sessionScope),
      mainConversationId,
      contract: createTaskExecutionContract({
        objective: title,
        successMode: "external_effect",
        authority: "standing_mandate",
        risk: "low",
        maxAttempts: 1,
      }),
    },
    mandate: {
      id: mandateId,
      actionName: CONTEXT_WATCH_FIRE_ACTION,
      scope: CONTEXT_WATCH_FIRE_ACTION,
      grantedAt: createdAt,
    },
  }
}
