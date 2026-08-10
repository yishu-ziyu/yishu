import { z } from "zod";
import { defineYishuAction } from "../action/define.js";
import { ActionCancelledError } from "../action/types.js";
import type { YishuStorePort } from "../store/yishu-store.js";
import type { Learning } from "../store/types.js";

const recordLearningInputSchema = z.object({
  rule: z.string().trim().min(1).max(2000),
  scope: z.string().trim().min(1).max(200).default("global"),
  confidence: z.number().min(0).max(1).default(0.95),
  examples: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
});

export type RecordLearningInput = z.infer<typeof recordLearningInputSchema>;

/** Capture a user correction as a durable Learning rule. */
export function createRecordLearningAction(store: YishuStorePort) {
  return defineYishuAction({
    name: "record_learning",
    description:
      "Record a user correction as a durable learning rule for future behavior.",
    inputSchema: recordLearningInputSchema,
    authority: "reversible",
    risk: "low",
    context: "none",
    run: async (ctx): Promise<Learning> => {
      throwIfAborted(ctx.signal);
      const input = ctx.input;
      const payload: Parameters<YishuStorePort["addLearning"]>[0] = {
        rule: input.rule,
        scope: input.scope,
        confidence: input.confidence,
        capturedAt: ctx.now.toISOString(),
      };
      if (input.examples !== undefined) {
        payload.examples = input.examples;
      }
      const mutationOptions =
        ctx.signal === undefined ? undefined : { signal: ctx.signal };
      const learning = mutationOptions === undefined
        ? store.addLearning(payload)
        : store.addLearning(payload, mutationOptions);
      const committed = await learning;
      ctx.markCommitted();
      return committed;
    },
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ActionCancelledError();
}
