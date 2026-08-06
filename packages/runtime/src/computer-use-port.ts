import { randomUUID } from "node:crypto";
import {
  runtimeEvent,
  type ComputerAction,
  type ComputerActionResultCommand,
} from "./protocol.js";
import type { RuntimeEventSink } from "./runtime-port.js";

export interface ComputerActionContext {
  requestId: string;
  traceId: string;
}

export interface ComputerActionResult {
  succeeded: boolean;
  verified: boolean;
  message: string;
  evidence?: string;
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
  resolve: (result: ComputerActionResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
}

export class StdioComputerUsePort implements ComputerUsePort {
  private readonly pending = new Map<string, PendingAction>();

  constructor(
    private readonly emit: RuntimeEventSink,
    private readonly timeoutMilliseconds = 8_000,
  ) {}

  perform(
    action: ComputerAction,
    context: ComputerActionContext,
    signal?: AbortSignal,
  ): Promise<ComputerActionResult> {
    if (signal?.aborted) return Promise.reject(new Error("Computer action was cancelled."));

    const actionId = randomUUID();
    return new Promise<ComputerActionResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.finish(actionId, new Error("Computer action timed out before macOS returned evidence."));
      }, this.timeoutMilliseconds);

      const pendingAction: PendingAction = {
        requestId: context.requestId,
        resolve,
        reject,
        timeout,
      };
      if (signal) {
        const abort = () => this.finish(actionId, new Error("Computer action was cancelled."));
        signal.addEventListener("abort", abort, { once: true });
        pendingAction.removeAbortListener = () => signal.removeEventListener("abort", abort);
      }
      this.pending.set(actionId, pendingAction);

      this.emit(runtimeEvent("computer.action.requested", context.requestId, context.traceId, {
        actionId,
        ...action,
      }));
    });
  }

  resolve(command: ComputerActionResultCommand): boolean {
    const pendingAction = this.pending.get(command.payload.actionId);
    if (!pendingAction || pendingAction.requestId !== command.requestId) return false;

    this.pending.delete(command.payload.actionId);
    clearTimeout(pendingAction.timeout);
    pendingAction.removeAbortListener?.();
    pendingAction.resolve({
      succeeded: command.payload.succeeded,
      verified: command.payload.verified,
      message: command.payload.message,
      ...(command.payload.evidence === undefined
        ? {}
        : { evidence: command.payload.evidence }),
    });
    return true;
  }

  cancelRequest(requestId: string, reason = "Computer action was cancelled."): void {
    for (const [actionId, pendingAction] of this.pending) {
      if (pendingAction.requestId === requestId) this.finish(actionId, new Error(reason));
    }
  }

  dispose(): void {
    for (const actionId of [...this.pending.keys()]) {
      this.finish(actionId, new Error("Computer-use port was disposed."));
    }
  }

  private finish(actionId: string, error: Error): void {
    const pendingAction = this.pending.get(actionId);
    if (!pendingAction) return;
    this.pending.delete(actionId);
    clearTimeout(pendingAction.timeout);
    pendingAction.removeAbortListener?.();
    pendingAction.reject(error);
  }
}

export class UnavailableComputerUsePort implements ComputerUsePort {
  async perform(): Promise<ComputerActionResult> {
    return {
      succeeded: false,
      verified: false,
      message: "The macOS computer-use bridge is unavailable.",
    };
  }

  resolve(): boolean { return false; }
  cancelRequest(): void {}
  dispose(): void {}
}
