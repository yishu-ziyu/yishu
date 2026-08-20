import { randomUUID } from "node:crypto";
import {
  runtimeEvent,
  type ComputerAction,
  type ComputerActionMethod,
  type ComputerActionResultCode,
  type ComputerActionResultCommand,
  type ComputerActionStatus,
} from "./protocol.js";
import { processResourceLease } from "./resource-lease.js";
import type { RuntimeEventSink } from "./runtime-port.js";

const DESKTOP_RESOURCE = "desktop";

export interface ComputerActionContext {
  requestId: string;
  traceId: string;
  /** Runtime-owned assistant generation that authorized this dispatch. */
  generation?: number;
  /** Stable product intent across attempts in one logical turn. */
  intentId?: string;
  /** Fresh product attempt identifier for this dispatch. */
  attemptId?: string;
  /** Context frame that justified the target selection. */
  basisFrameId?: string;
  /** Optional policy vocabulary retained for older clients. */
  effectClass?: string;
  /** Called only after the request has entered the macOS receipt queue. */
  onDispatched?: () => void;
}

export interface ComputerActionResult {
  succeeded: boolean;
  verified: boolean;
  message: string;
  evidence?: string;
  status?: ComputerActionStatus;
  code?: ComputerActionResultCode;
  method?: ComputerActionMethod;
  receiptId?: string;
  attemptId?: string;
  clockLabel?: string;
}

export interface ComputerActionFailureDetails {
  status: ComputerActionStatus;
  code: ComputerActionResultCode;
  method: ComputerActionMethod;
  attemptId?: string;
}

/** A rejected port call still carries a typed receipt state for the adapter. */
export class ComputerActionError extends Error {
  readonly status: ComputerActionStatus;
  readonly code: ComputerActionResultCode;
  readonly method: ComputerActionMethod;
  readonly attemptId: string | undefined;
  readonly receipt: ComputerActionResult | undefined;

  constructor(
    message: string,
    details: ComputerActionFailureDetails,
    receipt?: ComputerActionResult,
  ) {
    super(message);
    this.name = "ComputerActionError";
    this.status = details.status;
    this.code = details.code;
    this.method = details.method;
    this.attemptId = details.attemptId;
    this.receipt = receipt;
  }
}

export interface ComputerUsePort {
  perform(
    action: ComputerAction,
    context: ComputerActionContext,
    signal?: AbortSignal,
  ): Promise<ComputerActionResult>;
  resolve(command: ComputerActionResultCommand): boolean;
  cancelRequest(requestId: string, reason?: string): void;
  dispose(): void;
}

interface PendingAction {
  requestId: string;
  traceId: string;
  attemptId: string;
  resolve: (result: ComputerActionResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  leaseToken: string;
  leaseEpoch: number;
  removeAbortListener?: () => void;
}

export class StdioComputerUsePort implements ComputerUsePort {
  private readonly pending = new Map<string, PendingAction>();
  private readonly resourceLease = processResourceLease;

  constructor(
    private readonly emit: RuntimeEventSink,
    private readonly timeoutMilliseconds = 8_000,
  ) {}

  perform(
    action: ComputerAction,
    context: ComputerActionContext,
    signal?: AbortSignal,
  ): Promise<ComputerActionResult> {
    const intentId = context.intentId ?? randomUUID();
    const attemptId = context.attemptId ?? randomUUID();
    const effectClass = context.effectClass ?? "write";

    if (signal?.aborted) {
      return Promise.reject(new ComputerActionError(
        "Computer action was cancelled.",
        { status: "cancelled", code: "cancelled", method: "unknown", attemptId },
      ));
    }

    const actionId = randomUUID();
    const lease = this.resourceLease.acquire(DESKTOP_RESOURCE, actionId);
    if (!lease.granted) {
      return Promise.resolve({
        succeeded: false,
        verified: false,
        status: "blocked",
        code: "runtime_error",
        method: "unknown",
        attemptId,
        message: "Desktop is busy with another computer action.",
      });
    }

    return new Promise<ComputerActionResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.finish(actionId, new ComputerActionError(
          "Computer action timed out before macOS returned evidence.",
          { status: "failed", code: "timeout", method: "unknown", attemptId },
        ));
      }, this.timeoutMilliseconds);

      const pendingAction: PendingAction = {
        requestId: context.requestId,
        traceId: context.traceId,
        attemptId,
        resolve,
        reject,
        timeout,
        leaseToken: lease.token,
        leaseEpoch: lease.epoch,
      };
      if (signal) {
        const abort = () => this.finish(actionId, new ComputerActionError(
          "Computer action was cancelled.",
          { status: "cancelled", code: "cancelled", method: "unknown", attemptId },
        ));
        signal.addEventListener("abort", abort, { once: true });
        pendingAction.removeAbortListener = () => signal.removeEventListener("abort", abort);
      }
      this.pending.set(actionId, pendingAction);

      if (signal?.aborted) {
        this.finish(actionId, new ComputerActionError(
          "Computer action was cancelled.",
          { status: "cancelled", code: "cancelled", method: "unknown", attemptId },
        ));
        return;
      }

      try {
        this.emit(runtimeEvent("computer.action.requested", context.requestId, context.traceId, {
          actionId,
          ...actionForWire(action),
          intentId,
          attemptId,
          ...(context.basisFrameId === undefined ? {} : { basisFrameId: context.basisFrameId }),
          ...(context.generation === undefined ? {} : { generation: context.generation }),
          effectClass,
        }));
        context.onDispatched?.();
      } catch (error) {
        this.finish(actionId, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  resolve(command: ComputerActionResultCommand): boolean {
    const pendingAction = this.pending.get(command.payload.actionId);
    if (!pendingAction
      || pendingAction.requestId !== command.requestId
      || pendingAction.traceId !== command.traceId) return false;
    // A late result from a prior attempt must not settle a newer attempt. Old
    // clients omit attemptId and remain fully compatible with this check.
    if (command.payload.attemptId !== undefined
      && command.payload.attemptId !== pendingAction.attemptId) return false;

    const settledAction = this.takePending(command.payload.actionId);
    if (!settledAction) return false;
    settledAction.resolve({
      succeeded: command.payload.succeeded,
      verified: command.payload.verified,
      message: command.payload.message,
      ...(command.payload.evidence === undefined
        ? {}
        : { evidence: command.payload.evidence }),
      ...(command.payload.status === undefined ? {} : { status: command.payload.status }),
      ...(command.payload.code === undefined ? {} : { code: command.payload.code }),
      ...(command.payload.method === undefined ? {} : { method: command.payload.method }),
      ...(command.payload.receiptId === undefined ? {} : { receiptId: command.payload.receiptId }),
      ...(command.payload.attemptId === undefined ? {} : { attemptId: command.payload.attemptId }),
      ...(command.payload.clockLabel === undefined ? {} : { clockLabel: command.payload.clockLabel }),
    });
    return true;
  }

  cancelRequest(requestId: string, reason = "Computer action was cancelled."): void {
    for (const [actionId, pendingAction] of this.pending) {
      if (pendingAction.requestId === requestId) {
        this.finish(actionId, new ComputerActionError(reason, {
          status: "cancelled",
          code: "cancelled",
          method: "unknown",
          attemptId: pendingAction.attemptId,
        }));
      }
    }
  }

  dispose(): void {
    for (const actionId of [...this.pending.keys()]) {
      const pendingAction = this.pending.get(actionId);
      this.finish(actionId, new ComputerActionError("Computer-use port was disposed.", {
        status: "cancelled",
        code: "cancelled",
        method: "unknown",
        ...(pendingAction?.attemptId === undefined ? {} : { attemptId: pendingAction.attemptId }),
      }));
    }
  }

  private finish(actionId: string, error: Error): void {
    const pendingAction = this.takePending(actionId);
    if (!pendingAction) return;
    pendingAction.reject(error);
  }

  private takePending(actionId: string): PendingAction | undefined {
    const pendingAction = this.pending.get(actionId);
    if (!pendingAction) return undefined;
    this.pending.delete(actionId);
    clearTimeout(pendingAction.timeout);
    pendingAction.removeAbortListener?.();
    this.resourceLease.release(
      DESKTOP_RESOURCE,
      pendingAction.leaseToken,
      pendingAction.leaseEpoch,
    );
    return pendingAction;
  }
}

/** Blank labels are absent. Icon buttons must not poison the Swift decoder. */
function actionForWire(action: ComputerAction): ComputerAction {
  if (action.action !== "left_click") return action;
  const label = action.label?.trim();
  if (label === undefined || label.length === 0) {
    const { label: _omit, ...rest } = action;
    return rest;
  }
  return label === action.label ? action : { ...action, label };
}

export class UnavailableComputerUsePort implements ComputerUsePort {
  async perform(): Promise<ComputerActionResult> {
    return {
      succeeded: false,
      verified: false,
      message: "The macOS computer-use bridge is unavailable.",
      status: "failed",
      code: "runtime_error",
      method: "unknown",
    };
  }

  resolve(): boolean { return false; }
  cancelRequest(): void {}
  dispose(): void {}
}
