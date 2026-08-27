export const COMPLETION_SPEECH_PATTERN = /点好了|做好了|已经完成|已完成|完成了|设置好了|保存好了|创建好了|verified complete|successfully completed/u;

export interface FalseCompletionTask {
  taskId: string;
  status: string;
  verified?: boolean;
  hasTrustedReceipt?: boolean;
  receiptStatus?: string;
  cancelled?: boolean;
  lateEventOverwroteTerminal?: boolean;
  delegated?: boolean;
  hasDeliverable?: boolean;
  externalStateMatches?: boolean;
  searchUsed?: boolean;
  researchFinalized?: boolean;
}

export interface FalseCompletionUtterance {
  text: string;
  taskId?: string;
}

export interface FalseCompletionFinding {
  code:
    | "speech_without_terminal_task"
    | "verified_without_trusted_receipt"
    | "unverified_receipt_reported_complete"
    | "external_state_mismatch"
    | "cancelled_overwritten"
    | "delegated_without_deliverable"
    | "search_without_primary_evidence";
  taskId?: string;
}

export function speechClaimsCompletion(text: string): boolean {
  return COMPLETION_SPEECH_PATTERN.test(text.trim());
}

export function detectFalseCompletions(input: {
  tasks: readonly FalseCompletionTask[];
  utterances?: readonly FalseCompletionUtterance[];
}): FalseCompletionFinding[] {
  const findings: FalseCompletionFinding[] = [];
  const tasksById = new Map(input.tasks.map((task) => [task.taskId, task]));

  for (const utterance of input.utterances ?? []) {
    if (!speechClaimsCompletion(utterance.text)) continue;
    const task = utterance.taskId === undefined ? undefined : tasksById.get(utterance.taskId);
    const terminal = task !== undefined && (task.status === "done" || task.status === "verified" || task.status === "completed");
    if (task === undefined || !terminal) {
      findings.push({
        code: "speech_without_terminal_task",
        ...(utterance.taskId === undefined ? {} : { taskId: utterance.taskId }),
      });
    }
  }

  for (const task of input.tasks) {
    const claimsVerified = task.status === "verified" || task.verified === true;
    if (claimsVerified && task.hasTrustedReceipt !== true) {
      findings.push({ code: "verified_without_trusted_receipt", taskId: task.taskId });
    }
    const unverifiedReceipt = task.receiptStatus === "delivered"
      || task.receiptStatus === "unknown"
      || task.receiptStatus === "stale"
      || task.receiptStatus === "failed"
      || task.receiptStatus === "unverified";
    if (unverifiedReceipt && (task.status === "done" || task.status === "verified" || task.status === "completed")) {
      findings.push({ code: "unverified_receipt_reported_complete", taskId: task.taskId });
    }
    if (task.externalStateMatches === false && (task.status === "done" || task.status === "verified" || task.status === "completed")) {
      findings.push({ code: "external_state_mismatch", taskId: task.taskId });
    }
    if (task.lateEventOverwroteTerminal === true) {
      findings.push({ code: "cancelled_overwritten", taskId: task.taskId });
    }
    if (task.delegated === true && task.hasDeliverable !== true && (task.status === "done" || task.status === "completed" || task.status === "verified")) {
      findings.push({ code: "delegated_without_deliverable", taskId: task.taskId });
    }
    if (
      task.searchUsed === true
      && task.researchFinalized !== true
      && (claimsVerified || task.status === "done" || task.status === "completed")
    ) {
      findings.push({ code: "search_without_primary_evidence", taskId: task.taskId });
    }
  }

  return findings;
}

export function falseCompletionCount(input: {
  tasks: readonly FalseCompletionTask[];
  utterances?: readonly FalseCompletionUtterance[];
}): number {
  return detectFalseCompletions(input).length;
}
