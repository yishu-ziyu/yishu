import type { ZodType } from "zod";
import type { SessionScope } from "../session-scope.js";

/** Who initiated the action invocation. */
export type CallerKind =
  | "voice"
  | "ui"
  | "initiative"
  | "mcp"
  | "cli"
  | "pi"
  | "system";

/**
 * How the action is authorized at definition time.
 * Runtime still re-evaluates against risk, approval, and mandates.
 */
export type AuthorityLevel =
  | "automatic"
  | "reversible"
  | "standing_mandate"
  | "explicit_approval";

/** Blast radius / irreversibility of the action effect. */
export type ActionRisk = "low" | "medium" | "high" | "critical";

/** How much shared attention context the action expects at invoke time. */
export type ActionContextMode = "none" | "current-frame" | "trail" | "capsule";

/** Terminal and intermediate receipt states for a single invocation. */
export type ActionReceiptStatus =
  | "ok"
  | "needs_approval"
  | "denied"
  | "failed"
  | "cancelled"
  | "cancelled_after_commit"
  | "verified";

/**
 * Raised by an action when it stops because its invocation was cancelled.
 *
 * The registry converts this into a `cancelled` receipt instead of treating
 * user cancellation as an ordinary action failure.  Its message is
 * deliberately fixed so an abort reason (which may contain private data) is
 * never copied into the receipt or audit log.
 */
export class ActionCancelledError extends Error {
  readonly code = "ACTION_CANCELLED" as const;

  constructor(_reason?: unknown) {
    super("Action invocation cancelled");
    this.name = "ActionCancelledError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Standing user mandate that unlocks actions with authority
 * `standing_mandate`. `scope` is an action name or `"*"` for any action.
 */
export interface StandingMandate {
  id: string;
  scope: string;
}

/**
 * Product-owned, narrowly scoped request for Finder's history Back control.
 *
 * This deliberately describes one semantic native action rather than a
 * general shell or menu-command capability. The runtime bridge owns the
 * transport and the macOS app independently revalidates the target.
 */
export interface FinderHistoryBackRequest {
  targetBundleId: "com.apple.finder";
  targetPid: number;
  intentId: string;
  attemptId: string;
  basisFrameId: string;
}

/** Safe physical receipt returned by the macOS computer-use bridge. */
export interface FinderHistoryBackResult {
  succeeded: boolean;
  verified: boolean;
  message: string;
  evidence?: string;
  status?: string;
  code?: string;
  method?: string;
  receiptId?: string;
  attemptId?: string;
}

/** Narrow host capability injected only for the Finder history action. */
export interface FinderHistoryBackExecutor {
  perform(
    request: FinderHistoryBackRequest,
    signal?: AbortSignal,
  ): Promise<FinderHistoryBackResult>;
}

/** Create-only Notes request bound to one product intent and current frame. */
export interface CreateNoteRequest {
  content: string;
  title: string;
  targetBundleId: "com.apple.Notes";
  intentId: string;
  attemptId: string;
  basisFrameId: string;
  /** Optional complete source-window identity for current-page composition. */
  sourceBundleId?: string;
  sourcePid?: number;
  sourceWindowNumber?: number;
  sourceWindowTitle?: string;
  sourceWindowBounds?: { x: number; y: number; width: number; height: number };
}

/** Content-free receipt returned after creating and reading back one note. */
export interface CreateNoteResult {
  succeeded: boolean;
  verified: boolean;
  message: string;
  evidence?: string;
  status?: string;
  code?: string;
  method?: string;
  receiptId?: string;
  attemptId?: string;
}

/** Narrow host capability injected only for the create-note action. */
export interface CreateNoteExecutor {
  perform(
    request: CreateNoteRequest,
    signal?: AbortSignal,
  ): Promise<CreateNoteResult>;
}

/** One system-owned, one-shot relative reminder. No product-side timer exists. */
export interface ScheduleTimeReminderRequest {
  reminderId: string;
  delaySeconds: number;
  body: string;
  intentId: string;
  attemptId: string;
  basisFrameId: string;
}

/** Content-free receipt returned after macOS reads back the pending notification. */
export interface ScheduleTimeReminderResult {
  succeeded: boolean;
  verified: boolean;
  message: string;
  status?: string;
  code?: string;
  method?: string;
  receiptId?: string;
  attemptId?: string;
  clockLabel?: string;
}

/** Narrow host capability injected only for the one-shot reminder action. */
export interface ScheduleTimeReminderExecutor {
  perform(
    request: ScheduleTimeReminderRequest,
    signal?: AbortSignal,
  ): Promise<ScheduleTimeReminderResult>;
}

/** Post-run observation of the visible or external effect. */
export interface ActionVerification {
  verified: boolean;
  message: string;
  evidence?: unknown;
}

/**
 * Structured result of one invoke. A tool success is not task completion;
 * `status: "verified"` is reserved for successful post-condition checks.
 */
export interface ActionReceipt {
  actionName: string;
  receiptId: string;
  status: ActionReceiptStatus;
  caller: CallerKind;
  input: unknown;
  output: unknown;
  authority: AuthorityLevel;
  risk: ActionRisk;
  reversible: boolean;
  verification?: ActionVerification;
  auditId: string;
  /** ISO-8601 timestamp. */
  occurredAt: string;
  message: string;
}

/**
 * Content classification stored in the internal action audit log.
 *
 * The audit trail intentionally records no user-provided values.  In
 * particular, a `private claim`, credential, screenshot, or model output is
 * represented only by its shape so the audit log remains useful for tracing
 * without becoming a second private-memory store.
 */
export type ActionAuditSummaryKind =
  | "null"
  | "scalar"
  | "object"
  | "array"
  | "signal"
  | "error"
  | "unknown";

export interface ActionAuditSummary {
  kind: ActionAuditSummaryKind;
}

/** Safe, non-content-bearing projection of a receipt for audit/diagnostics. */
export interface ActionAuditEntry {
  actionName: string;
  receiptId: string;
  status: ActionReceiptStatus;
  caller: CallerKind;
  authority: AuthorityLevel;
  risk: ActionRisk;
  reversible: boolean;
  input: ActionAuditSummary;
  output: ActionAuditSummary;
  verification?: { verified: boolean };
  auditId: string;
  /** ISO-8601 timestamp. */
  occurredAt: string;
  /** Fixed status description; never action/error/user text. */
  message: string;
}

/** Arguments passed into `run` after input validation and authority pass. */
export interface ActionRunContext<TInput> {
  input: TInput;
  caller: CallerKind;
  contextFrame?: unknown;
  /** Exact product scope for context-bearing actions. */
  sessionScope?: SessionScope;
  trail?: unknown;
  deps?: ActionInvokeDeps;
  /** Cooperative cancellation signal for long-running action work. */
  signal?: AbortSignal;
  /** Mark the durable/external side effect as committed. Idempotent. */
  markCommitted: () => void;
  now: Date;
}

/** Arguments passed into optional `verify` after a successful `run`. */
export interface ActionVerifyContext<TInput, TOutput> {
  input: TInput;
  output: TOutput;
  caller: CallerKind;
  contextFrame?: unknown;
  /** Exact product scope for context-bearing actions. */
  sessionScope?: SessionScope;
  trail?: unknown;
  deps?: ActionInvokeDeps;
  /** Cooperative cancellation signal for post-run verification. */
  signal?: AbortSignal;
  now: Date;
}

/**
 * Product-owned action definition. Frozen by `defineYishuAction`.
 * No dependency on Agent Native packages.
 *
 * Generics are erased at the registry boundary (`AnyYishuAction`) so mixed
 * actions can share one map without contravariance fights under
 * exactOptionalPropertyTypes.
 */
export interface YishuActionDefinition<
  TInput = unknown,
  TOutput = unknown,
> {
  readonly name: string;
  readonly description: string;
  /** Zod schema; kept loose for zod v4 + generic definition compatibility. */
  readonly inputSchema: ZodType;
  readonly authority: AuthorityLevel;
  readonly risk: ActionRisk;
  readonly reversible: boolean;
  readonly context: ActionContextMode;
  readonly run: (
    ctx: ActionRunContext<TInput>,
  ) => Promise<TOutput> | TOutput;
  readonly verify?: (
    ctx: ActionVerifyContext<TInput, TOutput>,
  ) => Promise<ActionVerification> | ActionVerification;
}

/** Type-erased action used by the registry and host wiring. */
export type AnyYishuAction = YishuActionDefinition<any, any>;

/** Options for a single registry invoke call. */
export interface InvokeOptions {
  caller: CallerKind;
  input: unknown;
  contextFrame?: unknown;
  /** Exact product scope for context-bearing actions. */
  sessionScope?: SessionScope;
  trail?: unknown;
  /** Optional cooperative cancellation signal for this invocation. */
  signal?: AbortSignal;
  /** True when the user (or a trusted surface) has approved this invoke. */
  approved?: boolean;
  /**
   * Optional filter of mandate ids that are active for this call.
   * When omitted, all mandates from deps are considered.
   */
  mandateIds?: string[];
  /** Override clock for tests; Date or ISO string. */
  now?: Date | string;
}

/** Optional dependencies supplied by the host at invoke time. */
export interface ActionInvokeDeps {
  mandates?: StandingMandate[];
  finderHistoryBack?: FinderHistoryBackExecutor;
  createNote?: CreateNoteExecutor;
  scheduleTimeReminder?: ScheduleTimeReminderExecutor;
}

/** Result of authority evaluation before `run`. */
export type AuthorityDecision =
  | { allowed: true }
  | {
      allowed: false;
      status: "needs_approval" | "denied";
      message: string;
    };
