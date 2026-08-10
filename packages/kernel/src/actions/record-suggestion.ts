import { z } from "zod";
import { defineYishuAction } from "../action/define.js";
import { ActionCancelledError } from "../action/types.js";
import type { YishuStorePort } from "../store/yishu-store.js";
import type { SuggestionRecord } from "../store/types.js";

const recordSuggestionInputSchema = z.object({
  patternKey: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(500),
  conversationId: z.string().trim().min(1).max(120).optional(),
  turnId: z.string().trim().min(1).max(120).optional(),
  taskId: z.string().trim().min(1).max(120).optional(),
  note: z.string().trim().min(1).max(500).optional(),
});

export type RecordSuggestionInput = z.infer<typeof recordSuggestionInputSchema>;

/** Put a product suggestion into durable history so later outcomes can judge it. */
export function createRecordSuggestionAction(store: YishuStorePort) {
  return defineYishuAction({
    name: "record_suggestion",
    description:
      "Record a product suggestion in durable history for later outcome learning.",
    inputSchema: recordSuggestionInputSchema,
    authority: "automatic",
    risk: "low",
    context: "none",
    run: async (ctx): Promise<SuggestionRecord> => {
      throwIfAborted(ctx.signal);
      const input = ctx.input;
      const payload: Parameters<YishuStorePort["addSuggestion"]>[0] = {
        patternKey: input.patternKey,
        summary: input.summary,
        status: "proposed",
      };
      if (input.conversationId !== undefined) {
        payload.conversationId = input.conversationId;
      }
      if (input.turnId !== undefined) payload.turnId = input.turnId;
      if (input.taskId !== undefined) payload.taskId = input.taskId;
      if (input.note !== undefined) payload.note = input.note;
      const mutationOptions =
        ctx.signal === undefined ? undefined : { signal: ctx.signal };
      const record =
        mutationOptions === undefined
          ? await store.addSuggestion(payload)
          : await store.addSuggestion(payload, mutationOptions);
      ctx.markCommitted();
      return record;
    },
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ActionCancelledError();
}
