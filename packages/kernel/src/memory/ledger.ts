import type {
  ForgetMemoryResult,
  MemoryListItem,
  MemoryListOptions,
} from "../store/types.js";
import type { EmailProvider } from "../action/email-types.js";
import type { YishuStorePort } from "../store/yishu-store.js";
import {
  recallRelevantMemories,
  type RecalledMemory,
  type RecallRelevantMemoriesOptions,
} from "./recall.js";
import {
  hydrateVisibleMemoryIfNew,
  type VisibleMemoryFile,
} from "./visible-file.js";
import type { MemoryTruthLayer } from "./truth-layer.js";

/**
 * Product-facing memory interface. Runtime callers see bounded product rows
 * and policy operations, never the backing store or backend-specific types.
 */
export interface MemoryLedger {
  list(options: MemoryListOptions): Promise<readonly MemoryListItem[]>;

  findVisible(input: {
    id: string;
    scope: string;
  }): Promise<MemoryListItem | undefined>;

  forget(input: {
    id: string;
    expectedScope: string;
  }): Promise<ForgetMemoryResult | null>;

  recall(
    query: string,
    options: RecallRelevantMemoriesOptions,
  ): Promise<RecalledMemory[]>;

  resolveDefaultEmailProvider(): Promise<EmailProvider | undefined>;

  hydrateVisible(legacyClaims: readonly string[]): Promise<void>;
}

export function createMemoryLedger(
  store: YishuStorePort,
  visible?: VisibleMemoryFile,
  truth?: MemoryTruthLayer,
): MemoryLedger {
  return {
    async list(options) {
      return store.listMemories(options);
    },

    async findVisible(input) {
      const rows = await store.listMemories({
        scope: input.scope,
        limit: 50,
      });
      return rows.find((row) => row.id === input.id);
    },

    async forget(input) {
      const forgotten = (await store.searchMemory("", {
        scope: input.expectedScope,
        minConfidence: 0,
      })).find((memory) => memory.id === input.id);

      // Remove the markdown truth first. If this fails, leave the index row
      // intact so the caller can report the failure and retry; deleting the
      // index first could let an index rebuild resurrect the fact from Truth.
      if (
        truth !== undefined
        && forgotten !== undefined
        && forgotten.scope === input.expectedScope
      ) {
        const match = /#mem:([^\s]+)$/.exec(forgotten.truthRef ?? "");
        const factId = match ? match[1]! : forgotten.id;
        await truth.removeFact(input.expectedScope, factId);
      }

      const result = await store.forgetMemory(input.id, {
        expectedScope: input.expectedScope,
      });
      if (
        result !== null
        && !result.alreadyGone
        && forgotten !== undefined
        && forgotten.scope === "personal"
      ) {
        await visible?.removeFactsMatching(forgotten.claim);
      }
      return result;
    },

    async recall(query, options) {
      return recallRelevantMemories(store, query, options);
    },

    async resolveDefaultEmailProvider() {
      const matches = await store.searchMemory("key:email.provider", {
        scope: "personal",
        minConfidence: 0,
      });
      const active = matches.find((memory) =>
        memory.tags.includes("personal_default")
        && memory.tags.includes("key:email.provider"));
      return active?.tags.includes("value:google") ? "google" : undefined;
    },

    async hydrateVisible(legacyClaims) {
      if (visible === undefined) return;
      const stored = (await store.searchMemory("", {
        scope: "personal",
        minConfidence: 0,
      }))
        .filter((claim) => claim.retiredAt === undefined)
        .map((claim) => claim.claim);
      await hydrateVisibleMemoryIfNew(visible, [...legacyClaims, ...stored]);
      await visible.reconcileAuthority();
    },
  };
}
