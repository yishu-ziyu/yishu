import {
  assertPersistableMemoryText,
  everosMessagesForTurn,
  memoryScopeForSession,
  type EverOSAddInput,
  type SessionScope,
} from "@yishu/kernel";
import type { EverOSIngestionCoordinator } from "./everos-ingestion.js";

export interface VerifiedTaskLearningInput {
  readonly taskId: string;
  readonly title: string;
  readonly summary: string;
  readonly resultKind: "succeeded" | "completed" | "unverified" | "failed" | "cancelled";
  readonly sessionScope: SessionScope;
}

/**
 * Only a verified external result becomes EverOS agent learning.
 * Conversation-only completion, failures, and private sessions do not.
 * The write is a task-scoped session, never a Skill.
 */
export function everosInputForVerifiedTask(
  input: VerifiedTaskLearningInput,
): EverOSAddInput | undefined {
  if (input.resultKind !== "succeeded") return undefined;
  const scopeKey = memoryScopeForSession(input.sessionScope);
  if (scopeKey === null) return undefined;
  const title = input.title.replace(/\s+/gu, " ").trim();
  const summary = input.summary.replace(/\s+/gu, " ").trim();
  if (title.length === 0 || summary.length === 0) return undefined;
  const utterance = `任务目标：${title}`;
  const replyText = `已验证结果：${summary}`;
  try {
    assertPersistableMemoryText(utterance, "task learning goal");
    assertPersistableMemoryText(replyText, "task learning result");
  } catch {
    return undefined;
  }
  return {
    sessionId: `task:${input.taskId}`,
    scopeKey,
    messages: everosMessagesForTurn({ utterance, replyText }),
  };
}

export async function ingestVerifiedTaskLearning(
  ingestion: EverOSIngestionCoordinator,
  input: VerifiedTaskLearningInput,
): Promise<boolean> {
  const payload = everosInputForVerifiedTask(input);
  if (payload === undefined) return false;
  await ingestion.ingest(payload, { flushNow: true });
  return true;
}
