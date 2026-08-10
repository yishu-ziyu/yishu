import { z } from "zod";
import { defineYishuAction } from "../action/define.js";
import { ActionCancelledError } from "../action/types.js";
import type { YishuStorePort } from "../store/yishu-store.js";
import type { MemoryClaim } from "../store/types.js";

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

export function createRememberAction(store: YishuStorePort) {
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
      const payload = {
        claim: input.claim,
        source: input.source,
        capturedAt: now,
        scope: input.scope,
        confidence: input.confidence,
        lastConfirmedAt: now,
        supersedes: input.supersedes ?? null,
        tags: input.tags,
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
