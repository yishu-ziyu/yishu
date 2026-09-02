import {
  normalizeSessionScope,
  sessionScopesEqual,
  type SessionScope,
} from "../session-scope.js";
import { sanitizeVisibleText } from "../store/ledger-safety.js";
import type {
  ConversationListItem,
  ConversationStatus,
  ConversationTurnStatus,
} from "../store/types.js";
import type { YishuStorePort } from "../store/yishu-store.js";

/** Restored visible turns for continue; matches the previous PKR open cap. */
const VISIBLE_HISTORY_TURN_LIMIT = 20;

export interface VisibleConversation {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: ConversationStatus;
  readonly sessionScope: SessionScope;
  readonly title?: string;
}

export interface VisibleConversationTurn {
  readonly id: string;
  readonly sequence: number;
  readonly status: ConversationTurnStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly userInput?: string;
  readonly assistantOutput?: string;
}

export type ConversationOpenFailureReason =
  | "private"
  | "not_found"
  | "scope_mismatch"
  | "archived";

export type ConversationOpenResult =
  | {
      ok: true;
      conversation: VisibleConversation;
      turns: readonly VisibleConversationTurn[];
    }
  | {
      ok: false;
      reason: ConversationOpenFailureReason;
    };

export type ConversationArchiveFailureReason =
  | "private"
  | "not_found"
  | "scope_mismatch"
  | "scope_not_supported"
  | "archive_failed";

export type ConversationArchiveResult =
  | {
      ok: true;
      conversationId: string;
      status: "archived";
      sessionScope: SessionScope;
      alreadyArchived: boolean;
    }
  | {
      ok: false;
      reason: ConversationArchiveFailureReason;
    };

export type ConversationRestoreFailureReason =
  | "private"
  | "not_found"
  | "scope_mismatch"
  | "scope_not_supported"
  | "restore_failed";

export type ConversationRestoreResult =
  | {
      ok: true;
      conversationId: string;
      status: "active";
      sessionScope: SessionScope;
      alreadyActive: boolean;
    }
  | {
      ok: false;
      reason: ConversationRestoreFailureReason;
    };

/**
 * Product history list / open / personal archive.
 * Returns user-visible rows only; never raw events or protocol types.
 */
export interface ConversationLedger {
  list(input: {
    sessionScope: SessionScope;
    limit?: number;
    /** Include archived rows (history window "已归档" section). */
    includeArchived?: boolean;
  }): Promise<readonly ConversationListItem[]>;

  open(input: {
    conversationId: string;
    expectedScope: SessionScope;
    /** Filter non-completed turns before applying the visible history cap. */
    completedOnly?: boolean;
  }): Promise<ConversationOpenResult>;

  archivePersonal(input: {
    conversationId: string;
    expectedScope: SessionScope;
  }): Promise<ConversationArchiveResult>;

  restorePersonal(input: {
    conversationId: string;
    expectedScope: SessionScope;
  }): Promise<ConversationRestoreResult>;
}

function toVisibleConversation(conversation: {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: ConversationStatus;
  sessionScope: SessionScope;
  title?: string;
}): VisibleConversation {
  return {
    id: conversation.id,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    status: conversation.status,
    sessionScope: conversation.sessionScope,
    ...(conversation.title !== undefined ? { title: conversation.title } : {}),
  };
}

function toVisibleTurn(turn: {
  id: string;
  sequence: number;
  status: ConversationTurnStatus;
  createdAt: string;
  updatedAt: string;
  userInput?: string;
  assistantOutput?: string;
}): VisibleConversationTurn {
  return {
    id: turn.id,
    sequence: turn.sequence,
    status: turn.status,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    ...(turn.userInput !== undefined
      ? { userInput: sanitizeVisibleText(turn.userInput, "conversation user input") }
      : {}),
    ...(turn.assistantOutput !== undefined
      ? {
          assistantOutput: sanitizeVisibleText(
            turn.assistantOutput,
            "conversation assistant output",
          ),
        }
      : {}),
  };
}

export function createConversationLedger(store: YishuStorePort): ConversationLedger {
  return {
    async list(input) {
      const sessionScope = normalizeSessionScope(input.sessionScope);
      return store.listConversations({
        sessionScope,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.includeArchived === true ? { includeArchived: true } : {}),
      });
    },

    async open(input) {
      const expectedScope = normalizeSessionScope(input.expectedScope);
      if (expectedScope.kind === "private") {
        return { ok: false, reason: "private" };
      }
      const conversation = await store.getConversation(input.conversationId);
      if (!conversation) {
        return { ok: false, reason: "not_found" };
      }
      if (!sessionScopesEqual(conversation.sessionScope, expectedScope)) {
        return { ok: false, reason: "scope_mismatch" };
      }
      if (conversation.status === "archived") {
        return { ok: false, reason: "archived" };
      }
      const turns = await store.listConversationTurns(conversation.id);
      const visibleTurns = turns
        .filter((turn) => {
          if (input.completedOnly === true && turn.status !== "completed") return false;
          const hasUser = turn.userInput !== undefined && turn.userInput.trim().length > 0;
          const hasAssistant =
            turn.assistantOutput !== undefined && turn.assistantOutput.trim().length > 0;
          return hasUser || hasAssistant;
        })
        .slice(-VISIBLE_HISTORY_TURN_LIMIT)
        .map(toVisibleTurn);
      return {
        ok: true,
        conversation: toVisibleConversation(conversation),
        turns: visibleTurns,
      };
    },

    async archivePersonal(input) {
      const expectedScope = normalizeSessionScope(input.expectedScope);
      if (expectedScope.kind === "private") {
        return { ok: false, reason: "private" };
      }
      if (expectedScope.kind !== "personal") {
        return { ok: false, reason: "scope_not_supported" };
      }
      const existing = await store.getConversation(input.conversationId);
      if (!existing) {
        return { ok: false, reason: "not_found" };
      }
      if (!sessionScopesEqual(existing.sessionScope, expectedScope)) {
        return { ok: false, reason: "scope_mismatch" };
      }
      const archived = await store.archiveConversation(existing.id, {
        expectedScope,
      });
      if (!archived || archived.status !== "archived") {
        return { ok: false, reason: "archive_failed" };
      }
      return {
        ok: true,
        conversationId: archived.id,
        status: archived.status,
        sessionScope: archived.sessionScope,
        alreadyArchived: existing.status === "archived",
      };
    },

    async restorePersonal(input) {
      const expectedScope = normalizeSessionScope(input.expectedScope);
      if (expectedScope.kind === "private") {
        return { ok: false, reason: "private" };
      }
      if (expectedScope.kind !== "personal") {
        return { ok: false, reason: "scope_not_supported" };
      }
      const existing = await store.getConversation(input.conversationId);
      if (!existing) {
        return { ok: false, reason: "not_found" };
      }
      if (!sessionScopesEqual(existing.sessionScope, expectedScope)) {
        return { ok: false, reason: "scope_mismatch" };
      }
      const restored = await store.restoreConversation(existing.id, {
        expectedScope,
      });
      if (!restored || restored.status !== "active") {
        return { ok: false, reason: "restore_failed" };
      }
      return {
        ok: true,
        conversationId: restored.id,
        status: "active",
        sessionScope: restored.sessionScope,
        alreadyActive: existing.status !== "archived",
      };
    },
  };
}
