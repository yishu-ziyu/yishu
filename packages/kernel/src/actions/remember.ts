import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineYishuAction } from "../action/define.js";
import { ActionCancelledError } from "../action/types.js";
import type { YishuStorePort } from "../store/yishu-store.js";
import type { MemoryClaim } from "../store/types.js";
import type { MemoryTruthLayer } from "../memory/truth-layer.js";
import type { VisibleMemoryFile } from "../memory/visible-file.js";

const rememberInputSchema = z.object({
  claim: z.string().trim().min(1).max(2000),
  scope: z.string().trim().min(1).max(200).default("global"),
  confidence: z.number().min(0).max(1).default(0.9),
  source: z
    .enum([
      "conversation",
      "observation",
      "user_correction",
      "skill_verify",
      "system",
    ])
    .default("conversation"),
  tags: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  supersedes: z.string().uuid().nullable().optional(),
});

export type RememberInput = z.infer<typeof rememberInputSchema>;

/**
 * ADR 0016 #2: single write path. Explicit remember writes the markdown
 * truth layer first (when wired), then mirrors into the store index with a
 * truthRef. Hosts without a memory directory keep index-only writes for
 * tests/embedded use.
 */
export function createRememberAction(
  store: YishuStorePort,
  truth?: MemoryTruthLayer,
  visible?: VisibleMemoryFile,
) {
  return defineYishuAction({
    name: "remember",
    description:
      "Store an evidence-backed memory claim about the user, project, or habit.",
    inputSchema: rememberInputSchema,
    authority: "reversible",
    risk: "low",
    context: "current-frame",
    run: async (ctx): Promise<MemoryClaim> => {
      throwIfAborted(ctx.signal);
      const now = ctx.now.toISOString();
      const input = ctx.input;
      let truthRef: string | undefined;
      if (visible !== undefined) {
        await visible.appendFacts([input.claim], input.scope);
      }
      // The markdown line is the truth; write it before the index row so a
      // crash between the two leaves a rebuildable gap, not a lost fact.
      if (truth !== undefined) {
        const factId = randomUUID();
        await truth.upsertFact(input.scope, {
          id: factId,
          claim: input.claim,
          source: input.source,
          capturedAt: now,
          confirmedAt: now,
        });
        truthRef = truth.truthRefFor(input.scope, factId);
      }
      const payload = {
        claim: input.claim,
        source: input.source,
        capturedAt: now,
        scope: input.scope,
        confidence: input.confidence,
        lastConfirmedAt: now,
        supersedes: input.supersedes ?? null,
        tags: input.tags,
        ...(truthRef !== undefined ? { truthRef } : {}),
      };
      const mutationOptions =
        ctx.signal === undefined ? undefined : { signal: ctx.signal };
      const memory = mutationOptions === undefined
        ? store.addMemory(payload)
        : store.addMemory(payload, mutationOptions);
      const committed = await memory;
      ctx.markCommitted();
      return committed;
    },
    verify: async (ctx) => {
      throwIfAborted(ctx.signal);
      const output = ctx.output as MemoryClaim;
      const found = await store.searchMemory(output.claim, {
        scope: output.scope,
        minConfidence: 0,
      });
      throwIfAborted(ctx.signal);
      const hit = found.some((m) => m.id === output.id);
      return {
        verified: hit,
        message: hit
          ? "Memory claim is present in the store"
          : "Memory claim was not found after write",
        evidence: { id: output.id, found: hit },
      };
    },
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ActionCancelledError();
}
