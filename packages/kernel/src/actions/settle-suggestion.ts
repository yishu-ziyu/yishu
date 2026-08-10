import { z } from "zod";
import { defineYishuAction } from "../action/define.js";
import { ActionCancelledError } from "../action/types.js";
import type { YishuStorePort } from "../store/yishu-store.js";
import type { SuggestionRecord } from "../store/types.js";

const settleSuggestionInputSchema = z.object({
  suggestionId: z.string().trim().min(1).max(120),
  status: z.enum(["adopted", "ignored", "succeeded", "failed", "unknown"]),
  note: z.string().trim().min(1).max(500).optional(),
  taskId: z.string().trim().min(1).max(120).optional(),
});

export type SettleSuggestionInput = z.infer<typeof settleSuggestionInputSchema>;

/** Record whether a prior suggestion was adopted and how it turned out. */
export function createSettleSuggestionAction(store: YishuStorePort) {
  return defineYishuAction({
    name: "settle_suggestion",
    description:
      "Record adoption or outcome for a durable suggestion so repeated patterns can teach the mind.",
    inputSchema: settleSuggestionInputSchema,
    authority: "reversible",
    risk: "low",
    context: "none",
    run: async (ctx): Promise<SuggestionRecord> => {
      throwIfAborted(ctx.signal);
      const input = ctx.input;
      const payload: Parameters<YishuStorePort["recordSuggestionOutcome"]>[0] = {
        suggestionId: input.suggestionId,
        status: input.status,
      };
      if (input.note !== undefined) payload.note = input.note;
      if (input.taskId !== undefined) payload.taskId = input.taskId;
      const mutationOptions =
        ctx.signal === undefined ? undefined : { signal: ctx.signal };
      const record =
        mutationOptions === undefined
          ? await store.recordSuggestionOutcome(payload)
          : await store.recordSuggestionOutcome(payload, mutationOptions);
      ctx.markCommitted();
      return record;
    },
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ActionCancelledError();
}
