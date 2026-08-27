export const QUALITY_EVENT_SCHEMA_VERSION = 1 as const;

export const QUALITY_EVENT_NAMES = [
  "app.launched",
  "app.ready",
  "onboarding.started",
  "onboarding.step_completed",
  "onboarding.first_verified_action",
  "onboarding.completed",
  "permission.prompted",
  "permission.granted",
  "permission.denied",
  "permission.recovery_opened",
  "ptt.key_down",
  "ptt.listening_visible",
  "ptt.key_up",
  "asr.started",
  "asr.first_partial",
  "asr.completed",
  "context.capture_started",
  "context.capture_completed",
  "context.capture_warning",
  "tts.requested",
  "tts.first_audio",
  "tts.interrupted",
  "model.request_started",
  "model.first_byte",
  "model.completed",
  "tool.started",
  "tool.completed",
  "desktop.action_committed",
  "action.receipt",
  "action.verified",
  "task.terminal",
  "false_completion_detected",
  "runtime.restarted",
  "runtime.recovery_completed",
  "provider.auth_transition",
] as const;

export type QualityEventName = (typeof QUALITY_EVENT_NAMES)[number];

export const QUALITY_EVENT_STATUSES = [
  "ok",
  "failed",
  "cancelled",
  "blocked",
  "stale",
  "unknown",
] as const;

export type QualityEventStatus = (typeof QUALITY_EVENT_STATUSES)[number];

/** Attributes that may be persisted. Unknown keys are rejected, not stored. */
export const QUALITY_ATTRIBUTE_ALLOWLIST = [
  "appCategory",
  "actionKind",
  "providerId",
  "modelId",
  "errorCode",
  "stepCount",
  "verified",
  "permission",
  "milestone",
  "scenarioId",
  "receiptStatus",
  "toolName",
  "capabilityProfile",
  "taskTerminal",
  "committed",
  "durationMs",
  "retryCount",
  "spanKind",
] as const;

export type QualityAttributeName = (typeof QUALITY_ATTRIBUTE_ALLOWLIST)[number];

export type QualityAttributeValue = string | number | boolean;

export type QualityAttributes = Partial<Record<QualityAttributeName, QualityAttributeValue>>;

export interface QualityEvent {
  schemaVersion: typeof QUALITY_EVENT_SCHEMA_VERSION;
  eventId: string;
  occurredAt: string;
  sessionId: string;
  requestId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name: QualityEventName;
  durationMs?: number;
  status?: QualityEventStatus;
  attributes: QualityAttributes;
}

export interface QualityEventInput {
  name: QualityEventName;
  sessionId: string;
  occurredAt?: string;
  requestId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  durationMs?: number;
  status?: QualityEventStatus;
  attributes?: QualityAttributes;
}

export class QualityEventRejectedError extends Error {
  readonly code = "QUALITY_EVENT_REJECTED" as const;

  constructor(message: string) {
    super(message);
    this.name = "QualityEventRejectedError";
  }
}
