import { z } from "zod";
import { defineYishuAction } from "../action/define.js";
import { ActionCancelledError } from "../action/types.js";
import type { YishuStorePort } from "../store/yishu-store.js";
import type { MemoryTruthLayer } from "../memory/truth-layer.js";

const forgetInputSchema = z.object({
  memoryId: z.string().uuid(),
});

export type ForgetInput = z.infer<typeof forgetInputSchema>;

/**
 * ADR 0016 #2: forgetting removes both layers. The index row is the lookup
 * key; the markdown fact line is removed from the truth layer so a future
 * index rebuild cannot resurrect a forgotten fact.
 */
export function createForgetAction(store: YishuStorePort, truth?: MemoryTruthLayer) {
  return defineYishuAction({
    name: "forget",
    description:
      "Retire a memory claim (soft delete). Reversible via store inspection.",
    inputSchema: forgetInputSchema,
    authority: "reversible",
    risk: "medium",
    context: "none",
    run: async (ctx) => {
      throwIfAborted(ctx.signal);
      const claim = (await store.searchMemory("", { minConfidence: 0 }))
        .find((m) => m.id === ctx.input.memoryId);
      const mutationOptions =
        ctx.signal === undefined ? undefined : { signal: ctx.signal };
      const ok =
        mutationOptions === undefined
          ? await store.retireMemory(ctx.input.memoryId)
          : await store.retireMemory(ctx.input.memoryId, mutationOptions);
      if (!ok) {
        throw new Error(`Memory not found: ${ctx.input.memoryId}`);
      }
      if (truth !== undefined && claim !== undefined) {
        const match = /#mem:([^\s]+)$/.exec(claim.truthRef ?? "");
        const factId = match ? match[1]! : claim.id;
        await truth.removeFact(claim.scope, factId).catch(() => undefined);
      }
      ctx.markCommitted();
      return { retiredId: ctx.input.memoryId };
    },
    verify: async (ctx) => {
      throwIfAborted(ctx.signal);
      const snap = store.getSnapshot();
      const row = snap.memories.find((m) => m.id === ctx.input.memoryId);
      const retired = row?.retiredAt !== undefined;
      throwIfAborted(ctx.signal);
      return {
        verified: retired,
        message: retired
          ? "Memory claim is retired"
          : "Memory claim is still active",
        evidence: { id: ctx.input.memoryId, retiredAt: row?.retiredAt ?? null },
      };
    },
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ActionCancelledError();
}
