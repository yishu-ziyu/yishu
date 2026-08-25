import {
  normalizeSessionScope,
  sessionScopesEqual,
  type SessionScope,
} from "../session-scope.js";
import type { ContextWatch, TaskTruth } from "../store/types.js";
import type { YishuStorePort } from "../store/yishu-store.js";

export interface ContextWatchObservationInput {
  /** Exact scope from the fresh observation; private scopes never persist. */
  sessionScope: SessionScope;
  /** Exact bundle identifier extracted from a fresh foreground observation. */
  observedBundleId: string;
  occurredAt: string;
  observationFrameId: string;
}

export type ContextWatchAdvance =
  | {
      kind: "armed";
      watch: ContextWatch;
      taskTitle: string;
    }
  | {
      kind: "fired";
      watch: ContextWatch;
    };

export interface ContextWatchCancellation {
  watch: ContextWatch;
  task: TaskTruth;
  cancelledAt: string;
}

/**
 * Product policy for durable one-shot application watches.
 *
 * The runtime supplies a fresh observed bundle and maps outcomes to its wire
 * events. This module owns exact-scope lookup, leave-then-return progression,
 * compare-and-swap transitions, and cancellation authorization.
 */
export interface ContextWatchLedger {
  observeApplication(
    input: ContextWatchObservationInput,
  ): Promise<readonly ContextWatchAdvance[]>;

  cancelTask(input: {
    taskId: string;
    mainConversationId: string;
    cancelledAt?: string;
  }): Promise<ContextWatchCancellation | null>;
}

export function createContextWatchLedger(store: YishuStorePort): ContextWatchLedger {
  return {
    async observeApplication(input) {
      const sessionScope = normalizeSessionScope(input.sessionScope);
      if (sessionScope.kind === "private") return [];

      const advances: ContextWatchAdvance[] = [];
      let tasksById: Map<string, TaskTruth> | undefined;
      const watches = await store.listActiveContextWatches(sessionScope);
      for (const watch of watches) {
        if (watch.state === "waiting_for_departure") {
          if (input.observedBundleId === watch.targetBundleId) continue;
          const armed = await store.transitionContextWatch({
            id: watch.id,
            sessionScope,
            expectedState: "waiting_for_departure",
            nextState: "armed",
            occurredAt: input.occurredAt,
            observationFrameId: input.observationFrameId,
          });
          if (armed === null) continue;
          if (tasksById === undefined) {
            tasksById = new Map(
              (await store.listTasks({ sessionScope }))
                .map((task) => [task.id, task]),
            );
          }
          advances.push({
            kind: "armed",
            watch: armed,
            taskTitle: tasksById.get(armed.taskId)?.title
              ?? `提醒：${armed.reminder}`,
          });
          continue;
        }
        if (input.observedBundleId !== watch.targetBundleId) continue;
        const fired = await store.transitionContextWatch({
          id: watch.id,
          sessionScope,
          expectedState: "armed",
          nextState: "fired",
          occurredAt: input.occurredAt,
          observationFrameId: input.observationFrameId,
        });
        if (fired !== null) advances.push({ kind: "fired", watch: fired });
      }
      return advances;
    },

    async cancelTask(input) {
      const task = (await store.listTasks()).find((candidate) =>
        candidate.id === input.taskId
        && candidate.status === "running"
        && candidate.mainConversationId?.toLowerCase()
          === input.mainConversationId.toLowerCase()
        && contextWatchIdFromEvidence(candidate.evidence) !== null);
      if (task === undefined || task.sessionScope.kind === "private") return null;

      const conversation = await store.getConversation(input.mainConversationId);
      if (
        conversation === null
        || !sessionScopesEqual(conversation.sessionScope, task.sessionScope)
      ) return null;

      const watches = await store.listActiveContextWatches(task.sessionScope);
      const watch = watches.find((candidate) => candidate.taskId === task.id);
      if (watch === undefined) return null;

      const cancelledAt = input.cancelledAt ?? new Date().toISOString();
      const cancelled = await store.cancelContextWatch(
        watch.id,
        task.sessionScope,
        cancelledAt,
      );
      if (cancelled === null) return null;
      return { watch: cancelled, task, cancelledAt };
    },
  };
}

function contextWatchIdFromEvidence(evidence: readonly string[]): string | null {
  const prefix = "context_watch:waiting_for_departure:";
  const row = evidence.find((entry) => entry.startsWith(prefix));
  const id = row?.slice(prefix.length).trim() ?? "";
  return id.length > 0 ? id : null;
}
