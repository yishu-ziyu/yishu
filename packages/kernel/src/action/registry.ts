import { randomUUID } from "node:crypto";
import { evaluateAuthority } from "./authority.js";
import { ActionCancelledError } from "./types.js";
import type {
  ActionAuditEntry,
  ActionAuditSummary,
  ActionInvokeDeps,
  ActionReceipt,
  ActionVerification,
  AnyYishuAction,
  InvokeOptions,
  StandingMandate,
  YishuActionDefinition,
} from "./types.js";

/** In-memory audit trail for tests and local inspection. */
const auditLog: ActionAuditEntry[] = [];
const MAX_AUDIT_ENTRIES = 500;

export function getAuditLog(): readonly ActionAuditEntry[] {
  return auditLog.slice();
}

export function clearAuditLog(): void {
  auditLog.length = 0;
}

/**
 * Registry of product-owned Yishu actions.
 * Lookup → parse → authority → run → optional verify → receipt.
 */
export class YishuActionRegistry {
  private readonly actions = new Map<string, AnyYishuAction>();

  register(def: AnyYishuAction): void {
    if (this.actions.has(def.name)) {
      throw new Error(
        `YishuActionRegistry: action "${def.name}" is already registered`,
      );
    }
    this.actions.set(def.name, def);
  }

  get(name: string): AnyYishuAction | undefined {
    return this.actions.get(name);
  }

  list(): AnyYishuAction[] {
    return [...this.actions.values()];
  }

  async invoke(
    name: string,
    options: InvokeOptions,
    deps?: ActionInvokeDeps,
  ): Promise<ActionReceipt> {
    const now = resolveNow(options.now);
    const occurredAt = now.toISOString();
    const receiptId = randomUUID();
    const auditId = randomUUID();

    const definition = this.actions.get(name);
    if (!definition) {
      return this.commitReceipt({
        actionName: name,
        receiptId,
        status: "failed",
        caller: options.caller,
        input: options.input,
        output: null,
        authority: "explicit_approval",
        risk: "high",
        reversible: false,
        auditId,
        occurredAt,
        message: `Unknown action: ${name}`,
      });
    }

    // Product actions call this immediately after their durable/external
    // mutation succeeds.  It lets cancellation report a committed outcome
    // instead of pretending that no side effect happened.
    let committed = false;
    const markCommitted = (): void => {
      committed = true;
    };

    const parsed = definition.inputSchema.safeParse(options.input);
    if (!parsed.success) {
      const detail = formatZodError(parsed.error);
      return this.commitReceipt({
        actionName: definition.name,
        receiptId,
        status: "failed",
        caller: options.caller,
        input: options.input,
        output: null,
        authority: definition.authority,
        risk: definition.risk,
        reversible: definition.reversible,
        auditId,
        occurredAt,
        message: `Invalid input for action "${definition.name}": ${detail}`,
      });
    }

    const mandates = resolveMandates(deps, options.mandateIds);
    const authorityInput: {
      definition: YishuActionDefinition;
      caller: InvokeOptions["caller"];
      approved?: boolean;
      mandates?: StandingMandate[];
    } = {
      definition,
      caller: options.caller,
    };
    if (options.approved !== undefined) {
      authorityInput.approved = options.approved;
    }
    if (mandates !== undefined) {
      authorityInput.mandates = mandates;
    }

    const decision = evaluateAuthority(authorityInput);
    if (!decision.allowed) {
      return this.commitReceipt({
        actionName: definition.name,
        receiptId,
        status: decision.status,
        caller: options.caller,
        input: parsed.data,
        output: null,
        authority: definition.authority,
        risk: definition.risk,
        reversible: definition.reversible,
        auditId,
        occurredAt,
        message: decision.message,
      });
    }

    // Input and authority remain deterministic, but no action work may start
    // after the caller has cancelled this invocation.
    if (options.signal?.aborted) {
      return this.commitCancelledReceipt(
        definition,
        receiptId,
        auditId,
        occurredAt,
        options.caller,
        parsed.data,
        committed,
      );
    }

    const runCtxBase = {
      input: parsed.data,
      caller: options.caller,
      now,
    };
    const runCtx = {
      ...runCtxBase,
      ...(options.contextFrame !== undefined
        ? { contextFrame: options.contextFrame }
        : {}),
      ...(options.trail !== undefined ? { trail: options.trail } : {}),
      ...(deps !== undefined ? { deps } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      markCommitted,
    };

    let output: unknown;
    try {
      output = await definition.run(runCtx);
    } catch (err) {
      if (isCancellationError(err, options.signal)) {
        return this.commitCancelledReceipt(
          definition,
          receiptId,
          auditId,
          occurredAt,
          options.caller,
          parsed.data,
          committed,
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      return this.commitReceipt({
        actionName: definition.name,
        receiptId,
        status: "failed",
        caller: options.caller,
        input: parsed.data,
        output: null,
        authority: definition.authority,
        risk: definition.risk,
        reversible: definition.reversible,
        auditId,
        occurredAt,
        message: `Action "${definition.name}" failed: ${msg}`,
      });
    }

    // A cooperative action may resolve after its signal was aborted.  Do not
    // expose its output or proceed to verification in that case.
    if (options.signal?.aborted) {
      return this.commitCancelledReceipt(
        definition,
        receiptId,
        auditId,
        occurredAt,
        options.caller,
        parsed.data,
        committed,
      );
    }

    if (!definition.verify) {
      return this.commitReceipt({
        actionName: definition.name,
        receiptId,
        status: "ok",
        caller: options.caller,
        input: parsed.data,
        output,
        authority: definition.authority,
        risk: definition.risk,
        reversible: definition.reversible,
        auditId,
        occurredAt,
        message: `Action "${definition.name}" completed`,
      });
    }

    // Check immediately before verify: verification may have external side
    // effects and must never begin after user cancellation.
    if (options.signal?.aborted) {
      return this.commitCancelledReceipt(
        definition,
        receiptId,
        auditId,
        occurredAt,
        options.caller,
        parsed.data,
        committed,
      );
    }

    let verification: ActionVerification;
    try {
      const verifyCtx = {
        input: parsed.data,
        output,
        caller: options.caller,
        now,
        ...(options.contextFrame !== undefined
          ? { contextFrame: options.contextFrame }
          : {}),
        ...(options.trail !== undefined ? { trail: options.trail } : {}),
        ...(deps !== undefined ? { deps } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      };
      verification = await definition.verify(verifyCtx);
    } catch (err) {
      if (isCancellationError(err, options.signal)) {
        return this.commitCancelledReceipt(
          definition,
          receiptId,
          auditId,
          occurredAt,
          options.caller,
          parsed.data,
          committed,
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      return this.commitReceipt({
        actionName: definition.name,
        receiptId,
        status: "failed",
        caller: options.caller,
        input: parsed.data,
        output,
        authority: definition.authority,
        risk: definition.risk,
        reversible: definition.reversible,
        auditId,
        occurredAt,
        message: `Verification for "${definition.name}" threw: ${msg}`,
      });
    }

    if (options.signal?.aborted) {
      return this.commitCancelledReceipt(
        definition,
        receiptId,
        auditId,
        occurredAt,
        options.caller,
        parsed.data,
        committed,
      );
    }

    if (verification.verified) {
      return this.commitReceipt({
        actionName: definition.name,
        receiptId,
        status: "verified",
        caller: options.caller,
        input: parsed.data,
        output,
        authority: definition.authority,
        risk: definition.risk,
        reversible: definition.reversible,
        verification,
        auditId,
        occurredAt,
        message: verification.message || `Action "${definition.name}" verified`,
      });
    }

    return this.commitReceipt({
      actionName: definition.name,
      receiptId,
      status: "failed",
      caller: options.caller,
      input: parsed.data,
      output,
      authority: definition.authority,
      risk: definition.risk,
      reversible: definition.reversible,
      verification,
      auditId,
      occurredAt,
      message:
        verification.message ||
        `Action "${definition.name}" completed but was not verified`,
    });
  }

  private commitReceipt(receipt: ActionReceipt): ActionReceipt {
    const frozen = Object.freeze({ ...receipt });
    auditLog.push(toAuditEntry(frozen));
    if (auditLog.length > MAX_AUDIT_ENTRIES) {
      auditLog.splice(0, auditLog.length - MAX_AUDIT_ENTRIES);
    }
    return frozen;
  }

  private commitCancelledReceipt(
    definition: AnyYishuAction,
    receiptId: string,
    auditId: string,
    occurredAt: string,
    caller: InvokeOptions["caller"],
    input: unknown,
    committed: boolean,
  ): ActionReceipt {
    return this.commitReceipt({
      actionName: definition.name,
      receiptId,
      status: committed ? "cancelled_after_commit" : "cancelled",
      caller,
      input,
      output: null,
      authority: definition.authority,
      risk: definition.risk,
      reversible: definition.reversible,
      auditId,
      occurredAt,
      // Never include AbortSignal.reason or any action error text here: both
      // can contain credentials or private conversation content.
      message: committed
        ? `Action "${definition.name}" cancelled after commit`
        : `Action "${definition.name}" cancelled`,
    });
  }
}

/**
 * Project a public receipt into the content-free internal audit shape.  The
 * caller may still receive the action's output through `ActionReceipt`, but
 * audit consumers can never accidentally serialize private input/output,
 * verification evidence, or an abort/error reason.
 */
function toAuditEntry(receipt: ActionReceipt): ActionAuditEntry {
  return Object.freeze({
    actionName: safeActionName(receipt.actionName),
    receiptId: receipt.receiptId,
    status: receipt.status,
    caller: safeCaller(receipt.caller),
    authority: receipt.authority,
    risk: receipt.risk,
    reversible: receipt.reversible,
    input: summarizeAuditValue(receipt.input),
    output: summarizeAuditValue(receipt.output),
    ...(receipt.verification !== undefined
      ? { verification: { verified: receipt.verification.verified } }
      : {}),
    auditId: receipt.auditId,
    occurredAt: receipt.occurredAt,
    message: auditMessageForStatus(receipt.status),
  });
}

function summarizeAuditValue(value: unknown): ActionAuditSummary {
  if (value === null) return { kind: "null" };
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { kind: "scalar" };
  }
  if (typeof AbortSignal !== "undefined" && value instanceof AbortSignal) {
    return { kind: "signal" };
  }
  if (value instanceof Error) return { kind: "error" };
  if (Array.isArray(value)) return { kind: "array" };
  if (typeof value === "object") return { kind: "object" };
  return { kind: "unknown" };
}

function safeActionName(name: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,80}$/.test(name)
    ? name
    : "unknown_action";
}

function safeCaller(caller: unknown): ActionReceipt["caller"] {
  switch (caller) {
    case "voice":
    case "ui":
    case "initiative":
    case "mcp":
    case "cli":
    case "pi":
    case "system":
      return caller;
    default:
      return "system";
  }
}

function auditMessageForStatus(status: ActionReceipt["status"]): string {
  switch (status) {
    case "ok":
      return "Action completed";
    case "verified":
      return "Action verified";
    case "needs_approval":
      return "Action requires approval";
    case "denied":
      return "Action denied";
    case "cancelled":
      return "Action cancelled";
    case "cancelled_after_commit":
      return "Action cancelled after commit";
    case "failed":
      return "Action failed";
  }
}

function isCancellationError(
  error: unknown,
  signal: AbortSignal | undefined,
): boolean {
  if (signal?.aborted) return true;
  if (error instanceof ActionCancelledError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function resolveNow(now: Date | string | undefined): Date {
  if (now === undefined) {
    return new Date();
  }
  if (now instanceof Date) {
    return now;
  }
  const parsed = new Date(now);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }
  return parsed;
}

function resolveMandates(
  deps: ActionInvokeDeps | undefined,
  mandateIds: string[] | undefined,
): StandingMandate[] | undefined {
  const all = deps?.mandates;
  if (!all) {
    return undefined;
  }
  if (!mandateIds || mandateIds.length === 0) {
    return all;
  }
  const want = new Set(mandateIds);
  return all.filter((m) => want.has(m.id));
}

function formatZodError(error: {
  issues: ReadonlyArray<{ path: Array<string | number | symbol>; message: string }>;
}): string {
  return error.issues
    .map((issue) => {
      const path =
        issue.path.length > 0
          ? issue.path.map(String).join(".")
          : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
