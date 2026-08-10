import { z } from "zod";
import { defineYishuAction } from "../action/define.js";
import { ActionCancelledError } from "../action/types.js";
import type { YishuStorePort } from "../store/yishu-store.js";
import type { MindLearnResult } from "../store/types.js";

const learnMindInputSchema = z.object({
  patternKey: z.string().trim().min(1).max(120),
  lesson: z.string().trim().min(1).max(1000).optional(),
  /** Default 2: once is coincidence. */
  minEvidence: z.number().int().min(1).max(20).optional(),
});

export type LearnMindInput = z.infer<typeof learnMindInputSchema>;

/**
 * Append a lesson under "What you've learned" only when the same suggestion
 * pattern has enough settled outcomes.
 */
export function createLearnMindFromPatternAction(store: YishuStorePort) {
  return defineYishuAction({
    name: "learn_mind_from_pattern",
    description:
      "Write a repeated suggestion-outcome lesson into Yishu Mind when the evidence bar is met.",
    inputSchema: learnMindInputSchema,
    authority: "reversible",
    risk: "low",
    context: "none",
    run: async (ctx): Promise<MindLearnResult> => {
      throwIfAborted(ctx.signal);
      const input = ctx.input;
      const payload: Parameters<YishuStorePort["learnMindFromPattern"]>[0] = {
        patternKey: input.patternKey,
      };
      if (input.lesson !== undefined) payload.lesson = input.lesson;
      if (input.minEvidence !== undefined) payload.minEvidence = input.minEvidence;
      const mutationOptions =
        ctx.signal === undefined ? undefined : { signal: ctx.signal };
      const result =
        mutationOptions === undefined
          ? await store.learnMindFromPattern(payload)
          : await store.learnMindFromPattern(payload, mutationOptions);
      if (result.wrote) {
        ctx.markCommitted();
      }
      return result;
    },
    verify: async (ctx) => {
      throwIfAborted(ctx.signal);
      const output = ctx.output as MindLearnResult;
      if (!output.wrote) {
        return {
          verified: true,
          message: `No mind write: ${output.reason}`,
          evidence: {
            wrote: false,
            reason: output.reason,
            evidenceCount: output.evidenceCount,
          },
        };
      }
      const mind = await store.getMind();
      const hasLesson =
        output.lesson !== undefined && mind.markdown.includes(output.lesson);
      return {
        verified: hasLesson,
        message: hasLesson
          ? "Learned lesson is present in Yishu Mind"
          : "Learned lesson missing from Yishu Mind",
        evidence: {
          wrote: true,
          patternKey: output.patternKey,
          hasLesson,
        },
      };
    },
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ActionCancelledError();
}
