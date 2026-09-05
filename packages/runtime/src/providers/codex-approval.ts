import { randomUUID } from "node:crypto";
import { runtimeEvent, type TurnStartCommand, type CodexApprovalReplyCommand } from "../protocol.js";
import type { RuntimeEventSink } from "../runtime-port.js";

/** Pending confirmation is bound to the owning voice turn, trace, and one server request. */
export class CodexApprovalPort {
  private readonly pending = new Map<string, {
    requestId: string; traceId: string; settle(accept: boolean): void;
  }>();

  request(command: TurnStartCommand, message: string, emit: RuntimeEventSink, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    const approvalId = randomUUID();
    return new Promise((resolve) => {
      const abort = () => settle(false);
      const settle = (accept: boolean) => {
        if (!this.pending.delete(approvalId)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve(accept);
      };
      const timer = setTimeout(() => settle(false), 120_000);
      this.pending.set(approvalId, { requestId: command.requestId, traceId: command.traceId, settle });
      signal.addEventListener("abort", abort, { once: true });
      emit(runtimeEvent("codex.approval.requested", command.requestId, command.traceId, {
        approvalId, message: message.slice(0, 3000), generation: 1,
      }));
    });
  }

  reply(command: CodexApprovalReplyCommand): boolean {
    const pending = this.pending.get(command.payload.approvalId);
    if (!pending || pending.requestId !== command.requestId || pending.traceId !== command.traceId) return false;
    pending.settle(command.payload.accept);
    return true;
  }
}

export const processCodexApprovals = new CodexApprovalPort();
