import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  authLoginStartPayloadSchema,
  authLoginCancelPayloadSchema,
  authLogoutPayloadSchema,
  authModelPreferenceSchema,
  authPromptReplyPayloadSchema,
  authStatusPayloadSchema,
  type AuthModelPreference,
} from "./auth-protocol.js";

export const PROTOCOL_VERSION = 1 as const;

/**
 * The only model gateway that the desktop presentation layer may select.
 *
 * Clicky owns the credentialed hop from this loopback endpoint to its existing
 * upstream proxy. The runtime intentionally has no remote endpoint field so a
 * turn cannot redirect Pi to an arbitrary URL.
 */
export const LOCAL_GROK_PROVIDER = "yishu-local-grok" as const;
export const LOCAL_GROK_BASE_URL = "http://127.0.0.1:8787/v1" as const;
export const LOCAL_GROK_DEFAULT_MODEL = "grok-4.6" as const;

/** Current Grok choices exposed by Clicky's model picker. */
export const LOCAL_GROK_MODEL_IDS = [
  "grok-4.6",
  "grok-4.5",
  "grok-4.3",
  "grok-4.20-0309-reasoning",
  "grok-4.20-0309-non-reasoning",
  "grok-4.20-multi-agent-0309",
  "grok-3-mini",
  "grok-3-mini-fast",
  "grok-composer-2.5-fast",
  "grok-build-0.1",
] as const;

const grokModelIdSchema = z.enum(LOCAL_GROK_MODEL_IDS);

const confidenceSchema = z.number().min(0).max(1);

/**
 * A conversation is the durable user-session scope that can contain many
 * turns.  It is optional on the wire so older Clicky clients remain valid;
 * the product runtime may derive a single-turn fallback when it is absent.
 */
export const conversationIdSchema = z.string().uuid();

/** Explicit product scope; the runtime must never infer project identity. */
export const sessionScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("personal") }).strict(),
  z.object({
    kind: z.literal("project"),
    projectId: z.string().uuid(),
    projectLabel: z.string().trim().min(1).max(80).optional(),
  }).strict(),
  z.object({ kind: z.literal("private") }).strict(),
]);

export const screenPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  coordinateSpace: z.enum(["global-top-left", "appkit-bottom-left"]),
});

const numberedTargetIdSchema = z.string().regex(/^[1-9][0-9]?$/, "targetId must be 1-99");

const leftClickComputerActionSchema = z.object({
  action: z.literal("left_click"),
  targetId: numberedTargetIdSchema.optional(),
  x: z.number().finite().nonnegative().optional(),
  y: z.number().finite().nonnegative().optional(),
  screen: z.number().int().positive().optional(),
  label: z.string().trim().min(1).max(120).optional(),
}).superRefine((action, ctx) => {
  const hasTarget = action.targetId !== undefined;
  const hasX = action.x !== undefined;
  const hasY = action.y !== undefined;
  if (hasX !== hasY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "left_click coordinates must include both x and y.",
    });
  }
  if (!hasTarget && !hasX) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "left_click requires targetId or x,y.",
    });
  }
});

/**
 * A product-owned semantic operation. It is not exposed through the model's
 * `computer_control` tool: only the high-precision Product Kernel router may
 * emit it, and Swift independently validates the observed Finder target.
 */
const finderHistoryBackComputerActionSchema = z.object({
  action: z.literal("finder_history_back"),
  // Keep the wire shape compatible with older transport readers. These are
  // never used as coordinates by the semantic Finder action.
  x: z.literal(0),
  y: z.literal(0),
  targetBundleId: z.literal("com.apple.finder"),
  targetPid: z.number().int().positive(),
});

/**
 * Text is supplied by the model only after an explicit user request. The
 * target identity is attached by the runtime from the turn's Context Frame;
 * it is never accepted from model tool parameters.
 */
const setTextComputerActionSchema = z.object({
  action: z.literal("set_text"),
  text: z.string().min(1).max(10_000),
  targetBundleId: z.string().trim().min(1).max(255),
  targetPid: z.number().int().positive(),
});

/**
 * A product-owned, create-only Notes action. Content is carried only to the
 * trusted macOS actuator; it must never be copied into audit summaries.
 */
const createNoteComputerActionSchema = z.object({
  action: z.literal("create_note"),
  // Keep the wire shape compatible with the existing computer-action reader.
  x: z.literal(0),
  y: z.literal(0),
  content: z.string().trim().min(1).max(5_000),
  title: z.string().trim().min(1).max(120),
  targetBundleId: z.literal("com.apple.Notes"),
  sourceBundleId: z.string().trim().min(1).max(255).optional(),
  sourcePid: z.number().int().positive().optional(),
  sourceWindowNumber: z.number().int().positive().optional(),
  sourceWindowTitle: z.string().trim().min(1).max(240).optional(),
  sourceWindowBounds: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  }).strict().optional(),
}).superRefine((action, ctx) => {
  const values = [
    action.sourceBundleId,
    action.sourcePid,
    action.sourceWindowNumber,
    action.sourceWindowTitle,
    action.sourceWindowBounds,
  ];
  const count = values.filter((value) => value !== undefined).length;
  if (count !== 0 && count !== values.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Note source identity must be complete or absent." });
  }
});

/** One system-owned relative reminder. The body travels only to macOS. */
const scheduleReminderComputerActionSchema = z.object({
  action: z.literal("schedule_reminder"),
  x: z.literal(0),
  y: z.literal(0),
  reminderId: z.string().uuid(),
  delaySeconds: z.number().int().min(60).max(86_400),
  body: z.string().trim().min(1).max(500),
});

export const computerActionSchema = z.discriminatedUnion("action", [
  leftClickComputerActionSchema,
  finderHistoryBackComputerActionSchema,
  setTextComputerActionSchema,
  createNoteComputerActionSchema,
  scheduleReminderComputerActionSchema,
]);

/**
 * Receipt state is deliberately independent from the legacy `succeeded` and
 * `verified` booleans.  The booleans remain required for old Swift clients;
 * these values let newer clients distinguish a delivered input event from a
 * visible, post-condition-verified effect.
 */
export const COMPUTER_ACTION_STATUSES = [
  "delivered",
  "verified",
  "unverified",
  "blocked",
  "stale",
  "cancelled",
  "failed",
] as const;
export const computerActionStatusSchema = z.enum(COMPUTER_ACTION_STATUSES);

export const COMPUTER_ACTION_METHODS = [
  "ax_press",
  "ax_set_value",
  "quartz",
  "native_command",
  "shortcut",
  "unknown",
] as const;
export const computerActionMethodSchema = z.enum(COMPUTER_ACTION_METHODS);

/**
 * Result codes stay typed. In particular, the model never receives a native
 * command field that it could populate directly.
 */
export const COMPUTER_ACTION_RESULT_CODES = [
  "permission_denied",
  "notification_permission_pending",
  "notification_permission_denied",
  "notification_schedule_failed",
  "screen_unavailable",
  "target_out_of_bounds",
  "ax_lookup_failed",
  "ax_press_unsupported",
  "ax_press_failed",
  "ax_press_unverified",
  "focused_element_unavailable",
  "secure_text_blocked",
  "ax_set_value_unsupported",
  "ax_set_value_failed",
  "ax_set_value_unverified",
  "frontmost_mismatch",
  "target_stale",
  "quartz_event_creation_failed",
  "quartz_unverified",
  "verified_accessibility",
  "verified_system_notification",
  "verified_screen",
  "direct_action_already_attempted",
  "action_limit_reached",
  "cancelled",
  "timeout",
  "runtime_error",
] as const;
export const computerActionResultCodeSchema = z.enum(COMPUTER_ACTION_RESULT_CODES);

/**
 * `effectClass` is an optional compatibility hint.  It is intentionally a
 * bounded string rather than a second action capability surface so older and
 * newer clients can add policy vocabulary without making left_click parse
 * failures.  The runtime emits `write` for the product-owned click action.
 */
export const computerActionEffectClassSchema = z.string().trim().min(1).max(64);

const computerActionRequestMetadata = {
  actionId: z.string().uuid(),
  intentId: z.string().uuid().optional(),
  attemptId: z.string().uuid().optional(),
  basisFrameId: z.string().uuid().optional(),
  effectClass: computerActionEffectClassSchema.optional(),
};

export const computerActionRequestedPayloadSchema = z.discriminatedUnion("action", [
  leftClickComputerActionSchema.extend(computerActionRequestMetadata),
  finderHistoryBackComputerActionSchema.extend(computerActionRequestMetadata),
  setTextComputerActionSchema.extend(computerActionRequestMetadata),
  createNoteComputerActionSchema.extend(computerActionRequestMetadata),
  scheduleReminderComputerActionSchema.extend(computerActionRequestMetadata),
]);

export const computerActionResultPayloadSchema = z.object({
  actionId: z.string().uuid(),
  // Required for compatibility with the first protocol version.
  succeeded: z.boolean(),
  verified: z.boolean(),
  message: z.string().trim().min(1).max(500),
  evidence: z.string().trim().min(1).max(500).optional(),
  status: computerActionStatusSchema.optional(),
  code: computerActionResultCodeSchema.optional(),
  method: computerActionMethodSchema.optional(),
  receiptId: z.string().trim().min(1).max(160).optional(),
  attemptId: z.string().uuid().optional(),
  clockLabel: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});

export const pointerSampleSchema = z.object({
  capturedAt: z.string().datetime(),
  point: screenPointSchema,
  kind: z.enum(["move", "drag", "leftDown", "leftUp", "rightDown", "rightUp", "scroll"]),
});

export const observedValueSchema = <Schema extends z.ZodType>(valueSchema: Schema) =>
  z.object({
    value: valueSchema,
    source: z.string().min(1),
    capturedAt: z.string().datetime(),
    confidence: confidenceSchema,
  });

export const applicationContextSchema = z.object({
  name: z.string().min(1),
  bundleIdentifier: z.string().nullable(),
  processIdentifier: z.number().int().positive(),
});

export const windowContextSchema = z.object({
  title: z.string().nullable(),
  ownerName: z.string().min(1),
  processIdentifier: z.number().int().positive(),
  windowNumber: z.number().int().positive().optional(),
  bounds: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  }).nullable(),
});

export const accessibilityElementSchema = z.object({
  role: z.string().nullable(),
  subrole: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  valuePreview: z.string().nullable(),
});

export const numberedAccessibilityTargetSchema = z.object({
  id: numberedTargetIdSchema,
  role: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  enabled: z.boolean().nullable().optional(),
});

export const screenshotSchema = z.object({
  label: z.string().min(1),
  /** Optional source-window binding for an image captured from one window. */
  sourceWindowNumber: z.number().int().positive().optional(),
  mediaType: z.literal("image/jpeg"),
  base64Data: z.string().min(1),
  displayWidthPoints: z.number().int().positive(),
  displayHeightPoints: z.number().int().positive(),
  screenshotWidthPixels: z.number().int().positive(),
  screenshotHeightPixels: z.number().int().positive(),
  // Optional protocol-v1 extension. Clicky supplies both values from the
  // NSScreen/AppKit display frame so negative and vertical display origins are
  // preserved without breaking frames from older clients.
  displayOriginXPoints: z.number().finite().optional(),
  displayOriginYPoints: z.number().finite().optional(),
}).refine(
  (screenshot) =>
    (screenshot.displayOriginXPoints === undefined) ===
      (screenshot.displayOriginYPoints === undefined),
  { message: "display origin requires both x and y" },
);

export const contextFrameSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  frameId: z.string().uuid(),
  capturedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  cursor: observedValueSchema(screenPointSchema),
  pointerTrail: z.array(pointerSampleSchema).max(240),
  frontmostApplication: observedValueSchema(applicationContextSchema).nullable(),
  activeWindow: observedValueSchema(windowContextSchema).nullable(),
  elementUnderCursor: observedValueSchema(accessibilityElementSchema).nullable(),
  screenshots: z.array(screenshotSchema).max(4),
  numberedTargets: z.array(numberedAccessibilityTargetSchema).max(50).optional(),
  warnings: z.array(z.string()),
});

export const capabilityProfileSchema = z.enum(["conversation", "observe", "build", "owner"]);

/** A constrained model choice supplied by Clicky. */
export const localModelPreferenceSchema = z
  .object({
    provider: z.literal(LOCAL_GROK_PROVIDER),
    model: grokModelIdSchema,
  })
  .strict();

/**
 * The desktop may select a product-approved OAuth model after login.  No URL,
 * header, account, or provider config is accepted on the wire.
 */
export const modelPreferenceSchema = z.union([
  localModelPreferenceSchema,
  authModelPreferenceSchema,
]);

export const turnStartCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("turn.start"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: z.object({
    utterance: z.string().trim().min(1),
    contextFrame: contextFrameSchema,
    capabilityProfile: capabilityProfileSchema.default("conversation"),
    modelPreference: modelPreferenceSchema.optional(),
    conversationId: conversationIdSchema.optional(),
    /** Optional for v1 clients; absence is the legacy personal scope. */
    sessionScope: sessionScopeSchema.optional(),
  }),
});

const turnGenerationSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const turnSteerCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("turn.steer"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: z.object({
    message: z.string().trim().min(1),
    nextGeneration: turnGenerationSchema,
    interactionClass: z.literal("conversation"),
  }).strict(),
}).strict();

export const turnInterruptCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("turn.interrupt"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: z.object({
    expectedGeneration: turnGenerationSchema,
    reason: z.literal("user_barge_in"),
  }).strict(),
}).strict();

export const turnCancelCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("turn.cancel"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: z.object({ reason: z.string().trim().min(1).optional() }),
});

/** Cancel one running delegated child owned by the current Main conversation. */
export const delegatedTaskCancelCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("task.cancel"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: z.object({
    taskId: z.string().uuid(),
    mainConversationId: conversationIdSchema,
    reason: z.string().trim().min(1).max(80).optional(),
  }),
});

/** Restore delegated-task presence for one Main conversation after restart. */
export const delegatedTaskListCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("task.list"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: z.object({
    mainConversationId: conversationIdSchema,
  }).strict(),
}).strict();

export const computerActionResultCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("computer.action.result"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: computerActionResultPayloadSchema,
});

export const runtimePingCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("runtime.ping"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: z.object({}).default({}),
});

/**
 * Append a ContextFrame into the product ContextTrail without starting a turn.
 * Background sampling should omit screenshot bytes (empty screenshots array).
 */
export const trailObserveCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("trail.observe"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: z.object({
    contextFrame: contextFrameSchema,
    sessionScope: sessionScopeSchema.optional(),
  }),
});

export const authStatusCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("auth.status"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: authStatusPayloadSchema,
});

export const authLoginStartCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("auth.login.start"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: authLoginStartPayloadSchema,
});

export const authPromptReplyCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("auth.prompt.reply"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: authPromptReplyPayloadSchema,
});

export const authLoginCancelCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("auth.login.cancel"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: authLoginCancelPayloadSchema,
});

export const authLogoutCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("auth.logout"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: authLogoutPayloadSchema,
});

/**
 * Read-only personal/project history list. Private scope always returns [].
 * Limit is hard-capped at 50 so a UI cannot dump the whole ledger.
 */
export const historyListCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("history.list"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: z.object({
    /** Defaults to personal for the "我的" entry. */
    sessionScope: sessionScopeSchema.default({ kind: "personal" }),
    limit: z.number().int().min(1).max(50).optional(),
  }).default({ sessionScope: { kind: "personal" } }),
});

/**
 * Open one durable conversation for continue. Client must still switch its
 * local conversation id; this command only validates scope and returns
 * user-visible turns for context restore.
 */
export const historyOpenCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("history.open"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: z.object({
    conversationId: conversationIdSchema,
    /** Expected scope; mismatch fails closed. Defaults to personal. */
    sessionScope: sessionScopeSchema.default({ kind: "personal" }),
  }),
});

/**
 * Soft-delete (archive) one personal conversation. UI says "删除"; storage
 * keeps the row as archived so recovery remains possible. Private/project
 * are rejected on this path. Idempotent when already archived.
 */
export const historyDeleteCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("history.delete"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: z.object({
    conversationId: conversationIdSchema,
    /** Only personal is accepted for the "我的" delete entry. */
    sessionScope: sessionScopeSchema.default({ kind: "personal" }),
  }),
});

/**
 * Read-only personal memory list for the "我的" entry.
 * Only personal sessionScope is accepted; private/project fail closed.
 * Limit hard-capped at 50.
 */
export const memoryListCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("memory.list"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: z.object({
    sessionScope: sessionScopeSchema.default({ kind: "personal" }),
    limit: z.number().int().min(1).max(50).optional(),
  }).default({ sessionScope: { kind: "personal" } }),
});

/**
 * User-confirmed forget by exact memory id. Personal only.
 * Hard-removes the claim from product storage after scope check.
 * Repeat requests are stable (alreadyGone).
 */
export const memoryForgetCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("memory.forget"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: z.object({
    memoryId: z.string().uuid(),
    sessionScope: sessionScopeSchema.default({ kind: "personal" }),
  }),
});

/**
 * Explicit personal note from the product panel. Same store as voice
 * "记住…"; empty/whitespace text is rejected and must not persist.
 */
export const memoryRememberCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("memory.remember"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: z.object({
    text: z.string().trim().min(1).max(2000),
    sessionScope: sessionScopeSchema.default({ kind: "personal" }),
  }),
});

/**
 * Ask the same turn provider/model for at most two spoken sentences
 * from a scrubbed visible reply. Failure must not fall back to the essay.
 */
export const speechExcerptCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("speech.excerpt"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: z.object({
    visibleText: z.string().trim().min(1).max(8000),
    modelPreference: modelPreferenceSchema,
  }),
});

export const clientCommandSchema = z.discriminatedUnion("type", [
  turnStartCommandSchema,
  turnInterruptCommandSchema,
  turnSteerCommandSchema,
  turnCancelCommandSchema,
  delegatedTaskCancelCommandSchema,
  delegatedTaskListCommandSchema,
  computerActionResultCommandSchema,
  runtimePingCommandSchema,
  trailObserveCommandSchema,
  authStatusCommandSchema,
  authLoginStartCommandSchema,
  authPromptReplyCommandSchema,
  authLoginCancelCommandSchema,
  authLogoutCommandSchema,
  historyListCommandSchema,
  historyOpenCommandSchema,
  historyDeleteCommandSchema,
  memoryListCommandSchema,
  memoryForgetCommandSchema,
  memoryRememberCommandSchema,
  speechExcerptCommandSchema,
]);

export type ContextFrame = z.infer<typeof contextFrameSchema>;
export type CapabilityProfile = z.infer<typeof capabilityProfileSchema>;
export type ModelPreference = z.infer<typeof modelPreferenceSchema>;
export type ConversationId = z.infer<typeof conversationIdSchema>;
export type SessionScope = z.infer<typeof sessionScopeSchema>;
export type { AuthModelPreference };
export type TurnStartCommand = z.infer<typeof turnStartCommandSchema>;
export type TurnInterruptCommand = z.infer<typeof turnInterruptCommandSchema>;
export type TurnSteerCommand = z.infer<typeof turnSteerCommandSchema>;
export type TurnCancelCommand = z.infer<typeof turnCancelCommandSchema>;
export type DelegatedTaskCancelCommand = z.infer<typeof delegatedTaskCancelCommandSchema>;
export type DelegatedTaskListCommand = z.infer<typeof delegatedTaskListCommandSchema>;
export type ComputerAction = z.infer<typeof computerActionSchema>;
export type ComputerActionStatus = z.infer<typeof computerActionStatusSchema>;
export type ComputerActionMethod = z.infer<typeof computerActionMethodSchema>;
export type ComputerActionResultCode = z.infer<typeof computerActionResultCodeSchema>;
export type ComputerActionRequestedPayload = z.infer<typeof computerActionRequestedPayloadSchema>;
export type ComputerActionResultPayload = z.infer<typeof computerActionResultPayloadSchema>;
export type ComputerActionResultCommand = z.infer<typeof computerActionResultCommandSchema>;
export type TrailObserveCommand = z.infer<typeof trailObserveCommandSchema>;
export type AuthStatusCommand = z.infer<typeof authStatusCommandSchema>;
export type AuthLoginStartCommand = z.infer<typeof authLoginStartCommandSchema>;
export type AuthPromptReplyCommand = z.infer<typeof authPromptReplyCommandSchema>;
export type AuthLoginCancelCommand = z.infer<typeof authLoginCancelCommandSchema>;
export type AuthLogoutCommand = z.infer<typeof authLogoutCommandSchema>;
export type HistoryListCommand = z.infer<typeof historyListCommandSchema>;
export type HistoryOpenCommand = z.infer<typeof historyOpenCommandSchema>;
export type HistoryDeleteCommand = z.infer<typeof historyDeleteCommandSchema>;
export type MemoryListCommand = z.infer<typeof memoryListCommandSchema>;
export type MemoryForgetCommand = z.infer<typeof memoryForgetCommandSchema>;
export type MemoryRememberCommand = z.infer<typeof memoryRememberCommandSchema>;
export type SpeechExcerptCommand = z.infer<typeof speechExcerptCommandSchema>;
export type ClientCommand = z.infer<typeof clientCommandSchema>;

/**
 * `requestId` is the wire name retained for compatibility.  Semantically it
 * is the id of one turn; there is deliberately no second `turnId` field.
 */
export type TurnId = TurnStartCommand["requestId"];

export type RuntimeEventType =
  | "runtime.ready"
  | "runtime.pong"
  | "runtime.status"
  | "turn.started"
  | "turn.interrupt.accepted"
  | "turn.interrupt.rejected"
  | "response.delta"
  | "tool.started"
  | "tool.completed"
  | "computer.action.requested"
  | "response.completed"
  | "turn.cancelled"
  | "turn.failed"
  | "task.presence.updated"
  | "task.listed"
  | "task.cancel.accepted"
  | "runtime.error"
  | "trail.appended"
  | "trail.skipped"
  | "product.action.completed"
  | "auth.status"
  | "auth.prompt"
  | "auth.info"
  | "auth.url"
  | "auth.device_code"
  | "auth.progress"
  | "auth.completed"
  | "auth.failed"
  | "auth.logged_out"
  | "history.listed"
  | "history.opened"
  | "history.deleted"
  | "history.failed"
  | "memory.listed"
  | "memory.forgotten"
  | "memory.remembered"
  | "memory.failed"
  /** Controlled durable-memory use notice for the product UI (not full claim dumps). */
  | "memory.used"
  | "speech.excerpted"
  | "speech.failed";

export interface RuntimeEvent<Payload = Record<string, unknown>> {
  schemaVersion: typeof PROTOCOL_VERSION;
  type: RuntimeEventType;
  eventId: string;
  requestId: string;
  traceId: string;
  /** Optional session scope, echoed from turn.start by the product runtime. */
  conversationId?: ConversationId;
  occurredAt: string;
  payload: Payload;
}

export function runtimeEvent<Payload>(
  type: RuntimeEventType,
  requestId: string,
  traceId: string,
  payload: Payload,
  conversationId?: ConversationId,
): RuntimeEvent<Payload> {
  return {
    schemaVersion: PROTOCOL_VERSION,
    type,
    eventId: randomUUID(),
    requestId,
    traceId,
    ...(conversationId ? { conversationId } : {}),
    occurredAt: new Date().toISOString(),
    payload,
  };
}
