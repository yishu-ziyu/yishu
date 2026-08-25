/* Runtime event sanitizing / projection helpers.
 *
 * Extracted from product-kernel-runtime.ts to split the god-file. This layer
 * is module-level pure functions + constants: no class state, no this.
 * Moving it here is a behavior-neutral cut (dependency-cruiser
 * no-circular; check-file-size-limit).
 */

import type {
  ConversationTurn, RecalledMemory, SessionScope, TaskExecutionContract, TurnIntentFrame,
} from "@yishu/kernel";
import { sanitizeVisibleText } from "@yishu/kernel";
import type { ContextFrame, ConversationId, RuntimeEvent, TurnStartCommand } from "./protocol.js";
import type { RuntimeEventSink } from "./runtime-port.js";
import type { StatusBarToolState } from "./model-loop/index.js";
import type { PromptConversationTurn, PromptMemorySnippet } from "./context-prompt.js";
import type { CurrentPageNoteResult, DelegatedTaskPresenceUpdate } from "./delegation.js";

type TerminalKind = "completed" | "cancelled" | "failed";

const CONVERSATION_HISTORY_MAX_TURNS = 10;
const CONVERSATION_HISTORY_TEXT_BYTES = 5_000;
const CONTEXT_WATCH_OBSERVATION_MAX_AGE_MS = 30_000;
const CONTEXT_WATCH_CLOCK_SKEW_MS = 5_000;
export const GENERATION_EVENT_TYPES = new Set<RuntimeEvent["type"]>([
  "turn.started",
  "response.delta",
  "tool.started",
  "tool.completed",
  "computer.action.requested",
  "runtime.status",
  "response.completed",
  "turn.cancelled",
  "turn.failed",
  "runtime.error",
]);
export interface TurnLedgerState {
  readonly command: TurnStartCommand;
  readonly conversationId: string;
  readonly traceId: string;
  readonly emit: RuntimeEventSink;
  readonly seenEventIds: Set<string>;
  readonly sessionScope: SessionScope;
  readonly durable: boolean;
  productActionAbortController?: AbortController | undefined;
  productActionCancelRequested: boolean;
  currentPageNoteAttempted?: boolean;
  currentPageNoteResult?: CurrentPageNoteResult;
  currentPageNoteReceiptInFlight?: boolean;
  currentPageNoteDispatched?: boolean;
  currentPageNoteCancelRequested?: boolean;
  currentPageNoteReceiptSettled?: Promise<void>;
  currentPageNoteReceiptSettle?: () => void;
  readonly interruptEligible: boolean;
  generation: number;
  effectsStarted: boolean;
  effectsBlocked: boolean;
  interruptPending: boolean;
  interruptedGeneration?: number;
  awaitingSteerGeneration?: number;
  steerSubmitted: boolean;
  interruptTimeout?: ReturnType<typeof setTimeout>;
  supersedeRequested: boolean;
  preparePromise?: Promise<unknown>;
  innerStarted: boolean;
  terminalKind?: TerminalKind;
  pendingTerminal?: RuntimeEvent;
  terminalPersistence?: Promise<void>;
  terminalDelivered: boolean;
  ledgerError?: unknown;
  readonly intent: TurnIntentFrame;
  contract?: TaskExecutionContract;
  /** Product action name when this turn was routed to the kernel registry. */
  productAction?: string;
  /** Scoped recall for this turn; engine assembleTurnMemory reads this cache. */
  recalledMemories?: RecalledMemory[];
}
/**
 * L1 catalog description for a verified skill (ADR 0015): trigger phrase
 * first, then the conditioning app, then the first procedural step — enough
 * for the model to decide whether to load the skill, nothing more.
 */
export function verifiedSkillL1Description(skill: {
  triggerPhrase?: string;
  steps: readonly { description: string }[];
  conditions: Record<string, string>;
}): string {
  const parts: string[] = [];
  if (skill.triggerPhrase !== undefined && skill.triggerPhrase.length > 0) {
    parts.push(skill.triggerPhrase);
  }
  const app = skill.conditions.app;
  if (app !== undefined && app.length > 0) parts.push(app);
  const firstStep = skill.steps
    .map((step) => step.description.trim())
    .find((description) => description.length > 0);
  if (firstStep !== undefined) parts.push(firstStep);
  const text = parts.join(" · ").slice(0, 160).trim();
  return text.length > 0 ? text : "verified procedural skill";
}

/** Status bar v1 (ADR 0015): engine-observable facts only, single line. */
export function formatEngineStatusBar(state: StatusBarToolState): string {
  const calls = `${state.toolCallCount} tool call${state.toolCallCount === 1 ? "" : "s"}`;
  const last = state.lastToolName === undefined
    ? ""
    : `, last ${state.lastToolName}${state.lastToolFailed ? " failed" : " ok"}`;
  return `[executor: ${calls}${last}]`;
}

export function freshObservedBundleId(frame: ContextFrame, now = new Date()): string | null {
  const capturedAt = Date.parse(frame.capturedAt);
  const expiresAt = Date.parse(frame.expiresAt);
  const observedAt = Date.parse(frame.frontmostApplication?.capturedAt ?? "");
  const nowMs = now.getTime();
  if (
    !Number.isFinite(capturedAt)
    || !Number.isFinite(expiresAt)
    || !Number.isFinite(observedAt)
    || capturedAt > nowMs + CONTEXT_WATCH_CLOCK_SKEW_MS
    || observedAt > nowMs + CONTEXT_WATCH_CLOCK_SKEW_MS
    || nowMs - capturedAt > CONTEXT_WATCH_OBSERVATION_MAX_AGE_MS
    || nowMs - observedAt > CONTEXT_WATCH_OBSERVATION_MAX_AGE_MS
    || expiresAt <= nowMs
    || (frame.frontmostApplication?.confidence ?? 0) < 0.8
  ) return null;
  const bundleId = frame.frontmostApplication?.value.bundleIdentifier;
  return typeof bundleId === "string" && bundleId.length > 0 ? bundleId : null;
}

export function contextWatchIdFromEvidence(evidence: readonly string[]): string | null {
  const prefix = "context_watch:waiting_for_departure:";
  const row = evidence.find((entry) => entry.startsWith(prefix));
  const id = row?.slice(prefix.length).trim() ?? "";
  return id.length > 0 ? id : null;
}

export function contextWatchStateFromTask(
  status: "pending" | "running" | "blocked" | "done" | "failed" | "cancelled",
  evidence: readonly string[],
): DelegatedTaskPresenceUpdate["watchState"] {
  if (status === "cancelled" || evidence.some((entry) => entry.startsWith("context_watch:cancelled:"))) {
    return "cancelled";
  }
  if (status === "done" || evidence.some((entry) => entry.startsWith("context_watch:fired:"))) {
    return "fired";
  }
  if (evidence.some((entry) => entry.startsWith("context_watch:armed:"))) {
    return "armed";
  }
  return "waiting_for_departure";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function speechOutputForProductAction(
  route: { action: string; input: Record<string, unknown> },
  output: unknown,
): unknown {
  if (route.action !== "schedule_time_reminder") return output;
  if (!isRecord(output)) return output;
  const clockLabel = typeof output.clockLabel === "string" && /^\d{2}:\d{2}$/.test(output.clockLabel)
    ? output.clockLabel
    : undefined;
  return clockLabel === undefined ? output : { ...output, clockLabel };
}

export function toPromptMemorySnippet(memory: RecalledMemory): PromptMemorySnippet {
  return {
    id: memory.id,
    claim: memory.claim,
    source: memory.source,
    capturedAt: memory.capturedAt,
    scope: memory.scope,
    authority: memory.authority ?? "derived",
  };
}

type ClientEventScalar = string | number | boolean | null;
type ClientEventPayload = Record<string, ClientEventScalar>;

const SAFE_PRODUCT_ACTIONS = new Set([
  "remember",
  "forget",
  "remember_how",
  "share_context",
  "record_learning",
  "run_skill",
  "watch_app_return",
  "finder_history_back",
  "create_note",
  "schedule_time_reminder",
]);

const SAFE_PRODUCT_STATUSES = new Set([
  "ok",
  "needs_approval",
  "denied",
  "failed",
  "cancelled",
  "cancelled_after_commit",
  "verified",
]);

const SAFE_RUNTIME_STATUSES = new Set([
  "active",
  "blocked",
  "cancelled",
  "completed",
  "done",
  "failed",
  "idle",
  "running",
  "steering_received",
  "trajectory_summary",
]);

const SAFE_FAILURE_CODES = new Set([
  "agent_core_turn_failed",
  "conversation_ledger_failed",
  "conversation_ledger_unavailable",
  "action_committed_after_cancel",
  "action_outcome_unknown",
  "duplicate_request",
  "invalid_model_preference",
  "late_failure_after_cancel",
  "pi_turn_failed",
  "product_action_failed",
  "recovery_required",
  "request_reuse_conflict",
  "runtime_disposed",
  "runtime_operation_failed",
  "scripted_failure",
  "steer_failed",
  "steer_replacement_failed_before_start",
  "task_truth_unavailable",
  "turn_ended_without_terminal",
  "turn_not_active",
]);

const SAFE_INTERRUPT_REJECTION_CODES = new Set([
  "duplicate_steer",
  "effect_started",
  "effectful_steer",
  "generation_exhausted",
  "ineligible_turn",
  "inner_rejected",
  "interrupt_in_progress",
  "stale_generation",
  "trace_mismatch",
  "turn_not_active",
  "turn_terminal",
  "unsupported",
]);

/**
 * Runtime events are a client boundary as well as a ledger boundary.  Keep
 * the fields that Clicky needs, but never forward arbitrary provider/tool
 * payloads, nested output objects, diagnostics, or hidden reasoning.
 */
export function sanitizeClientEvent(event: RuntimeEvent): RuntimeEvent | undefined {
  const payload = asRecord(event.payload);
  switch (event.type) {
    case "turn.started":
      return withClientPayload(event, pickSafe(payload, [
        "runtime",
        "capabilityProfile",
        "provider",
        "model",
        "generation",
      ]));
    case "turn.interrupt.accepted": {
      const interruptedGeneration = safeGeneration(payload.interruptedGeneration);
      const nextGeneration = safeGeneration(payload.nextGeneration);
      if (interruptedGeneration === undefined
        || nextGeneration !== interruptedGeneration + 1) return undefined;
      return withClientPayload(event, { interruptedGeneration, nextGeneration });
    }
    case "turn.interrupt.rejected": {
      const generation = safeGeneration(payload.generation);
      const code = safeMetadata(payload.code);
      if (generation === undefined || code === undefined
        || !SAFE_INTERRUPT_REJECTION_CODES.has(code)) return undefined;
      return withClientPayload(event, { generation, code });
    }
    case "response.delta": {
      const generation = safeGeneration(payload.generation);
      return withClientPayload(event, {
        ...safeVisibleTextPayload(payload.text),
        ...(generation === undefined ? {} : { generation }),
      });
    }
    case "response.completed": {
      const safeText = safeVisibleTextPayload(payload.text);
      const generation = safeGeneration(payload.generation);
      return withClientPayload(event, {
        ...safeText,
        verified: payload.verified === true,
        ...(payload.replayed === true ? { replayed: true } : {}),
        ...(generation === undefined ? {} : { generation }),
      });
    }
    case "tool.started":
    case "tool.completed":
      return withClientPayload(event, pickSafe(payload, [
        "toolName",
        "runtime",
        "isError",
        "compatibilityMode",
        "generation",
      ]));
    case "computer.action.requested": {
      const safeAction = safeComputerActionPayload(payload);
      const generation = safeGeneration(payload.generation);
      return safeAction ? withClientPayload(event, {
        ...safeAction,
        ...(generation === undefined ? {} : { generation }),
      }) : undefined;
    }
    case "runtime.status": {
      const generation = safeGeneration(payload.generation);
      return withClientPayload(event, {
        ...safeRuntimeStatusPayload(payload),
        ...(generation === undefined ? {} : { generation }),
      });
    }
    case "product.action.completed":
      return withClientPayload(event, safeProductActionPayload(payload));
    case "memory.used":
      return withClientPayload(event, safeMemoryUsedPayload(payload));
    case "turn.cancelled":
      {
        const generation = safeGeneration(payload.generation);
      return withClientPayload(event, {
        reason: safeCancellationReason(payload.reason),
        ...(generation === undefined ? {} : { generation }),
      });
      }
    case "turn.failed":
    case "runtime.error":
      {
        const generation = safeGeneration(payload.generation);
      return withClientPayload(event, {
        code: safeFailureCode(payload.code),
        ...(generation === undefined ? {} : { generation }),
      });
      }
    default:
      return undefined;
  }
}

/**
 * memory.used is a live product UI notice. Keep only controlled scalars:
 * count + up to 3 {memoryId, summary, source, capturedAt, scope} slots.
 * Never forward raw tool args, screenshots, or unbounded claim text.
 */
function safeMemoryUsedPayload(
  payload: Record<string, unknown>,
): ClientEventPayload {
  const countRaw = payload.count;
  const count =
    typeof countRaw === "number" && Number.isInteger(countRaw)
      ? Math.min(3, Math.max(0, countRaw))
      : 0;
  const result: ClientEventPayload = { count };
  for (let n = 1; n <= count; n += 1) {
    const memoryId = safeIdentifier(payload[`memoryId${n}`]);
    if (memoryId !== undefined) result[`memoryId${n}`] = memoryId;
    const summary = boundedVisibleString(payload[`summary${n}`], 80);
    if (summary !== undefined) result[`summary${n}`] = summary;
    const source = safeMemorySource(payload[`source${n}`]);
    if (source !== undefined) result[`source${n}`] = source;
    const capturedAt = safeIsoTimestamp(payload[`capturedAt${n}`]);
    if (capturedAt !== undefined) result[`capturedAt${n}`] = capturedAt;
    const scope = boundedVisibleString(payload[`scope${n}`], 80);
    if (scope !== undefined) result[`scope${n}`] = scope;
  }
  return result;
}

function safeMemorySource(value: unknown): string | undefined {
  if (
    value === "conversation"
    || value === "observation"
    || value === "user_correction"
    || value === "skill_verify"
    || value === "system"
  ) {
    return value;
  }
  return undefined;
}

function withClientPayload(
  event: RuntimeEvent,
  payload: ClientEventPayload,
): RuntimeEvent {
  return { ...event, payload };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeVisibleTextPayload(value: unknown): Record<string, string | boolean> {
  if (typeof value !== "string") return { text: "" };
  try {
    return eventText(value);
  } catch {
    return { text: "[omitted]" };
  }
}

function safeComputerActionPayload(payload: Record<string, unknown>): ClientEventPayload | undefined {
  const actionId = safeIdentifier(payload.actionId);
  const action = payload.action === "left_click"
    || payload.action === "finder_history_back"
    || payload.action === "set_text"
    || payload.action === "create_note"
    || payload.action === "schedule_reminder"
    ? payload.action
    : undefined;
  if (actionId === undefined || action === undefined) {
    return undefined;
  }

  const result: ClientEventPayload = { actionId, action };
  if (action === "left_click") {
    const targetId = typeof payload.targetId === "string" && /^[1-9][0-9]?$/.test(payload.targetId)
      ? payload.targetId
      : undefined;
    const x = finiteNonNegative(payload.x);
    const y = finiteNonNegative(payload.y);
    if (targetId !== undefined) {
      result.targetId = targetId;
    } else if (x === undefined || y === undefined) {
      return undefined;
    }
    if (x !== undefined && y !== undefined) {
      result.x = x;
      result.y = y;
    }
  } else if (action === "finder_history_back") {
    if (payload.targetBundleId !== "com.apple.finder" || !Number.isInteger(payload.targetPid)) {
      return undefined;
    }
    result.targetBundleId = payload.targetBundleId;
    result.targetPid = payload.targetPid as number;
  } else if (action === "set_text") {
    const text = typeof payload.text === "string" && payload.text.length > 0 && payload.text.length <= 10_000
      ? payload.text
      : undefined;
    const targetBundleId = boundedVisibleString(payload.targetBundleId, 255);
    if (
      text === undefined
      || targetBundleId === undefined
      || !Number.isInteger(payload.targetPid)
      || (payload.targetPid as number) <= 0
    ) {
      return undefined;
    }
    result.text = text;
    result.targetBundleId = targetBundleId;
    result.targetPid = payload.targetPid as number;
  } else if (action === "create_note") {
    const content = typeof payload.content === "string"
      && payload.content.trim().length > 0
      && payload.content.length <= 5_000
      ? payload.content
      : undefined;
    const title = typeof payload.title === "string"
      && payload.title.trim().length > 0
      && payload.title.length <= 120
      ? payload.title
      : undefined;
    if (
      content === undefined
      || title === undefined
      || payload.targetBundleId !== "com.apple.Notes"
    ) {
      return undefined;
    }
    result.content = content;
    result.title = title;
    result.targetBundleId = "com.apple.Notes";
    const sourceValues = [
      payload.sourceBundleId,
      payload.sourcePid,
      payload.sourceWindowNumber,
      payload.sourceWindowTitle,
      payload.sourceWindowBounds,
    ];
    const sourceCount = sourceValues.filter((value) => value !== undefined).length;
    if (sourceCount !== 0 && sourceCount !== sourceValues.length) return undefined;
    if (sourceCount === sourceValues.length) {
      const sourceBundleId = boundedVisibleString(payload.sourceBundleId, 255);
      const sourceWindowTitle = typeof payload.sourceWindowTitle === "string"
        && payload.sourceWindowTitle.trim() === payload.sourceWindowTitle
        && payload.sourceWindowTitle.length > 0
        && payload.sourceWindowTitle.length <= 240
        ? payload.sourceWindowTitle
        : undefined;
      const sourceBounds = payload.sourceWindowBounds;
      if (
        sourceBundleId === undefined
        || !Number.isInteger(payload.sourcePid) || (payload.sourcePid as number) <= 0
        || !Number.isInteger(payload.sourceWindowNumber) || (payload.sourceWindowNumber as number) <= 0
        || sourceWindowTitle === undefined
        || !isValidSourceWindowBounds(sourceBounds)
      ) return undefined;
      result.sourceBundleId = sourceBundleId;
      result.sourcePid = payload.sourcePid as number;
      result.sourceWindowNumber = payload.sourceWindowNumber as number;
      result.sourceWindowTitle = sourceWindowTitle;
      result.sourceWindowBounds = sourceBounds as never;
    }
  } else {
    const reminderId = safeIdentifier(payload.reminderId);
    const delaySeconds = payload.delaySeconds;
    const body = typeof payload.body === "string"
      && payload.body.trim().length > 0
      && payload.body.length <= 500
      ? payload.body
      : undefined;
    if (reminderId === undefined
      || !Number.isInteger(delaySeconds)
      || (delaySeconds as number) < 60
      || (delaySeconds as number) > 86_400
      || body === undefined) return undefined;
    result.reminderId = reminderId;
    result.delaySeconds = delaySeconds as number;
    result.body = body;
  }
  if (Number.isInteger(payload.screen) && (payload.screen as number) > 0) {
    result.screen = payload.screen as number;
  }
  const label = boundedVisibleString(payload.label, 120);
  if (label !== undefined) result.label = label;
  const effectClass = safeMetadata(payload.effectClass);
  if (effectClass !== undefined) result.effectClass = effectClass;
  for (const key of ["intentId", "attemptId", "basisFrameId"] as const) {
    const identifier = safeIdentifier(payload[key]);
    if (identifier !== undefined) result[key] = identifier;
  }
  return result;
}

function isValidSourceWindowBounds(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (!isRecord(value) || Object.keys(value).length !== 4) return false;
  const { x, y, width, height } = value;
  return typeof x === "number" && Number.isFinite(x)
    && typeof y === "number" && Number.isFinite(y)
    && typeof width === "number" && Number.isFinite(width) && width > 0
    && typeof height === "number" && Number.isFinite(height) && height > 0;
}

function safeRuntimeStatusPayload(payload: Record<string, unknown>): ClientEventPayload {
  const result: ClientEventPayload = {
    status: safeRuntimeStatus(payload.status),
  };
  const stepCount = boundedCount(payload.stepCount);
  if (stepCount !== undefined) result.stepCount = stepCount;
  if (typeof payload.accepted === "boolean") result.accepted = payload.accepted;
  const trajectoryId = safeIdentifier(payload.trajectoryId);
  if (trajectoryId !== undefined) result.trajectoryId = trajectoryId;
  const trajectoryStatus = safeRuntimeStatus(payload.trajectoryStatus, "unknown");
  if (trajectoryStatus !== "unknown") result.trajectoryStatus = trajectoryStatus;
  if (Array.isArray(payload.toolsUsed)) {
    result.toolsUsedCount = Math.min(payload.toolsUsed.length, 1000);
  }
  return result;
}

function safeProductActionPayload(payload: Record<string, unknown>): ClientEventPayload {
  const actionName = safeMetadata(payload.actionName);
  const status = safeMetadata(payload.status);
  const result: ClientEventPayload = {
    actionName: actionName && SAFE_PRODUCT_ACTIONS.has(actionName) ? actionName : "unknown",
    status: status && SAFE_PRODUCT_STATUSES.has(status) ? status : "unknown",
  };
  const receiptId = safeIdentifier(payload.receiptId);
  if (receiptId !== undefined) result.receiptId = receiptId;
  const auditId = safeIdentifier(payload.auditId);
  if (auditId !== undefined) result.auditId = auditId;
  Object.assign(result, summarizeProductActionOutput(actionName, payload.output));
  return result;
}

function summarizeProductActionOutput(
  actionName: string | undefined,
  output: unknown,
): ClientEventPayload {
  const value = asRecord(output);
  if (actionName === "share_context") {
    const capsule = asRecord(value.capsule);
    const provenance = asRecord(capsule.provenance);
    const result: ClientEventPayload = {};
    const capsuleId = safeIdentifier(capsule.capsuleId);
    if (capsuleId !== undefined) result.capsuleId = capsuleId;
    const expiresAt = safeIsoTimestamp(capsule.expiresAt);
    if (expiresAt !== undefined) result.expiresAt = expiresAt;
    const trailEntryCount = boundedCount(provenance.trailEntryCount);
    if (trailEntryCount !== undefined) result.trailEntryCount = trailEntryCount;
    return result;
  }
  if (actionName === "remember") {
    const memoryId = safeIdentifier(value.id);
    return memoryId === undefined ? {} : { memoryId };
  }
  if (actionName === "remember_how") {
    const candidate = asRecord(value.candidate);
    const skill = asRecord(value.skill);
    const result: ClientEventPayload = {};
    const candidateId = safeIdentifier(candidate.id);
    if (candidateId !== undefined) result.candidateId = candidateId;
    const skillId = safeIdentifier(skill.id);
    if (skillId !== undefined) result.skillId = skillId;
    const entryCount = boundedCount(value.entryCount);
    if (entryCount !== undefined) result.entryCount = entryCount;
    const report = asRecord(value.verifyReport);
    if (typeof report.verified === "boolean") result.verified = report.verified;
    const confidence = boundedConfidence(report.confidence);
    if (confidence !== undefined) result.confidence = confidence;
    return result;
  }
  if (actionName === "record_learning") {
    const learningId = safeIdentifier(value.id);
    return learningId === undefined ? {} : { learningId };
  }
  if (actionName === "run_skill") {
    const result: ClientEventPayload = {};
    const mode = safeMetadata(value.mode);
    if (mode === "skill" || mode === "capsule_fallback") result.mode = mode;
    const skillId = safeIdentifier(value.skillId);
    if (skillId !== undefined) result.skillId = skillId;
    if (typeof value.capsuleReady === "boolean") result.capsuleReady = value.capsuleReady;
    if (typeof value.revalidated === "boolean") result.revalidated = value.revalidated;
    const confidence = boundedConfidence(value.revalidateConfidence);
    if (confidence !== undefined) result.revalidateConfidence = confidence;
    return result;
  }
  if (actionName === "forget") {
    const retiredId = safeIdentifier(value.retiredId);
    return retiredId === undefined ? {} : { retiredId };
  }
  if (actionName === "finder_history_back" || actionName === "create_note" || actionName === "schedule_time_reminder") {
    const result: ClientEventPayload = {};
    if (typeof value.succeeded === "boolean") result.succeeded = value.succeeded;
    if (typeof value.verified === "boolean") result.verified = value.verified;
    const status = safeMetadata(value.status);
    if (status && ["delivered", "verified", "unverified", "blocked", "stale", "cancelled", "failed"].includes(status)) {
      result.computerStatus = status;
    }
    const code = safeMetadata(value.code);
    if (code && [
      "frontmost_mismatch",
      "target_stale",
      "ax_lookup_failed",
      "ax_press_failed",
      "ax_press_unverified",
      "verified_accessibility",
      "verified_system_notification",
      "permission_denied",
      "notification_permission_pending",
      "notification_permission_denied",
      "notification_schedule_failed",
      "timeout",
      "runtime_error",
    ].includes(code)) {
      result.code = code;
    }
    const method = safeMetadata(value.method);
    const safeMethods = actionName === "create_note" || actionName === "schedule_time_reminder"
      ? ["native_command", "unknown"]
      : ["ax_press", "unknown"];
    if (method && safeMethods.includes(method)) result.method = method;
    if (actionName === "schedule_time_reminder"
      && typeof value.clockLabel === "string"
      && /^\d{2}:\d{2}$/.test(value.clockLabel)) {
      result.clockLabel = value.clockLabel;
    }
    return result;
  }
  return {};
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function boundedCount(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= 100_000
    ? value
    : undefined;
}

function boundedConfidence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function safeIdentifier(value: unknown): string | undefined {
  if (
    typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) return undefined;
  return value.toLowerCase();
}

function safeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}

function boundedVisibleString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const safe = safeVisibleTextPayload(value).text;
  if (typeof safe !== "string" || safe.length === 0) return undefined;
  return safe.slice(0, maxLength);
}

function safeRuntimeStatus(value: unknown, fallback = "unknown"): string {
  const status = safeMetadata(value);
  return status && SAFE_RUNTIME_STATUSES.has(status) ? status : fallback;
}

function safeCancellationReason(value: unknown): string {
  return safeMetadata(value) ?? "user_cancelled";
}

function safeFailureCode(value: unknown): string {
  const code = safeMetadata(value);
  return code && SAFE_FAILURE_CODES.has(code) ? code : "runtime_operation_failed";
}

export function mapInnerInterruptRejection(value: unknown): string {
  switch (safeMetadata(value)) {
    case "already_interrupted":
      return "interrupt_in_progress";
    case "effect_already_dispatched":
      return "effect_started";
    case "generation_mismatch":
      return "stale_generation";
    case "terminal":
      return "turn_terminal";
    default:
      return "inner_rejected";
  }
}

export function projectionFor(event: RuntimeEvent): {
  type: "turn.started" | "tool.started" | "tool.completed" | "action.requested" | "action.completed" | "task.updated";
  payload: Record<string, string | number | boolean | null>;
} | undefined {
  switch (event.type) {
    case "turn.started":
      return {
        type: "turn.started",
        payload: pickSafe(event.payload, ["runtime", "capabilityProfile", "provider", "model", "generation"]),
      };
    case "tool.started":
      return {
        type: "tool.started",
        payload: pickSafe(event.payload, ["toolName", "runtime", "compatibilityMode", "generation"]),
      };
    case "tool.completed":
      return {
        type: "tool.completed",
        payload: pickSafe(event.payload, ["toolName", "runtime", "isError", "compatibilityMode", "generation"]),
      };
    case "computer.action.requested":
      return {
        type: "action.requested",
        payload: pickSafe(event.payload, ["actionId", "effectClass", "generation"]),
      };
    case "product.action.completed":
      return {
        type: "action.completed",
        payload: pickSafe(event.payload, ["actionName", "status", "receiptId", "auditId"]),
      };
    case "runtime.status":
      return {
        type: "task.updated",
        payload: pickSafe(event.payload, ["status", "stepCount", "toolsUsed", "accepted", "generation"]),
      };
    default:
      return undefined;
  }
}

function pickSafe(
  payload: Record<string, unknown>,
  keys: readonly string[],
): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    const value = payload[key];
    if (
      value === null
      || typeof value === "string"
      || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value))
    ) {
      const text = typeof value === "string" ? safeMetadata(value) : value;
      if (text !== undefined) result[key] = text;
      else if (value === null || typeof value === "boolean" || typeof value === "number") result[key] = value;
    }
  }
  return result;
}

export function enrichEvent(event: RuntimeEvent, state: TurnLedgerState): RuntimeEvent {
  const payload = asRecord(event.payload);
  const generation = safeGeneration(payload.generation) ?? state.generation;
  return {
    ...event,
    requestId: state.command.requestId,
    traceId: state.traceId,
    conversationId: state.conversationId as ConversationId,
    payload: GENERATION_EVENT_TYPES.has(event.type)
      ? { ...payload, generation }
      : payload,
  };
}

export function enrichFreeEvent(event: RuntimeEvent, conversationId: string): RuntimeEvent {
  return {
    ...event,
    conversationId: conversationId as ConversationId,
  };
}

export function boundedConversationHistory(
  turns: readonly ConversationTurn[],
): PromptConversationTurn[] {
  const candidates = turns.slice(-CONVERSATION_HISTORY_MAX_TURNS).map((turn) => ({
    id: turn.id,
    capturedAt: turn.createdAt,
    userInput: safeHistoryText(turn.userInput, "conversation user input"),
    assistantOutput: safeHistoryText(
      turn.assistantOutput,
      "conversation assistant output",
    ),
  }));
  const selected: PromptConversationTurn[] = [];
  let remainingBytes = CONVERSATION_HISTORY_TEXT_BYTES;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!;
    if (candidate.userInput === undefined && candidate.assistantOutput === undefined) continue;
    let userInput = candidate.userInput;
    let assistantOutput = candidate.assistantOutput;
    const userBytes = utf8Bytes(userInput);
    const assistantBytes = utf8Bytes(assistantOutput);
    const candidateBytes = userBytes + assistantBytes;

    if (candidateBytes > remainingBytes) {
      if (selected.length > 0 || remainingBytes <= 0) break;
      if (userBytes > 0 && assistantBytes > 0) {
        const userBudget = Math.floor(remainingBytes * userBytes / candidateBytes);
        userInput = truncateUtf8(userInput!, userBudget);
        assistantOutput = truncateUtf8(
          assistantOutput!,
          remainingBytes - utf8Bytes(userInput),
        );
      } else if (userInput !== undefined) {
        userInput = truncateUtf8(userInput, remainingBytes);
      } else if (assistantOutput !== undefined) {
        assistantOutput = truncateUtf8(assistantOutput, remainingBytes);
      }
    }

    const usedBytes = utf8Bytes(userInput) + utf8Bytes(assistantOutput);
    if (usedBytes === 0) break;
    selected.unshift({
      id: candidate.id,
      capturedAt: candidate.capturedAt,
      ...(userInput !== undefined && userInput.length > 0 ? { userInput } : {}),
      ...(assistantOutput !== undefined && assistantOutput.length > 0
        ? { assistantOutput }
        : {}),
    });
    remainingBytes -= usedBytes;
  }

  return selected;
}

export function safeHistoryText(value: string | undefined, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  try {
    const safe = sanitizeVisibleText(value, fieldName).trim();
    return safe.length > 0 ? safe : undefined;
  } catch {
    return undefined;
  }
}

function utf8Bytes(value: string | undefined): number {
  return value === undefined ? 0 : Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
}

export function eventText(value: string): Record<string, string | boolean> {
  const text = sanitizeVisibleText(value, "conversation event text");
  const bounded = text.slice(0, 500);
  return bounded.length < text.length ? { text: bounded, truncated: true } : { text: bounded };
}

export function ledgerText(value: string): string {
  return sanitizeVisibleText(value, "conversation visible text");
}

export function safeMetadata(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let sanitized: string;
  try {
    sanitized = sanitizeVisibleText(value, "runtime metadata");
  } catch {
    return undefined;
  }
  if (sanitized.includes("[redacted]")) return "redacted";
  const compact = sanitized
    .replace(/[^a-zA-Z0-9._:-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 120);
  return compact.length > 0 ? compact : undefined;
}

export function safeGeneration(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1
    ? value
    : undefined;
}

export function summarizeOutput(output: unknown): unknown {
  if (output == null) return null;
  if (typeof output !== "object") return output;
  const o = output as Record<string, unknown>;
  // Drop large capsule JSON from live event payloads; keep ids and counts.
  if ("capsule" in o && o.capsule && typeof o.capsule === "object") {
    const c = o.capsule as Record<string, unknown>;
    return {
      ...o,
      capsule: {
        capsuleId: c.capsuleId,
        expiresAt: c.expiresAt,
        schemaVersion: c.schemaVersion,
        provenance: c.provenance,
      },
      capsuleJson: undefined,
    };
  }
  if ("trailSummary" in o) {
    const { trailSummary: _drop, ...rest } = o;
    return rest;
  }
  return o;
}

