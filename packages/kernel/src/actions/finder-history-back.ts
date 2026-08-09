import { z } from "zod";
import { defineYishuAction } from "../action/define.js";
import type {
  FinderHistoryBackRequest,
  FinderHistoryBackResult,
} from "../action/types.js";

const finderHistoryBackInputSchema = z.object({
  targetBundleId: z.literal("com.apple.finder"),
  targetPid: z.number().int().positive(),
  intentId: z.string().uuid(),
  attemptId: z.string().uuid(),
  basisFrameId: z.string().uuid(),
}).strict();

export type FinderHistoryBackInput = z.infer<typeof finderHistoryBackInputSchema>;

/**
 * Route Finder's Back button through the product action registry instead of
 * letting a voice fast path issue a local, untracked AXPress.
 */
export function createFinderHistoryBackAction() {
  return defineYishuAction({
    name: "finder_history_back",
    description: "Press the current Finder window's enabled history Back control once.",
    inputSchema: finderHistoryBackInputSchema,
    authority: "reversible",
    risk: "low",
    context: "current-frame",
    run: async (ctx): Promise<FinderHistoryBackResult> => {
      const executor = ctx.deps?.finderHistoryBack;
      if (!executor) {
        return {
          succeeded: false,
          verified: false,
          status: "failed",
          code: "runtime_error",
          method: "unknown",
          message: "The Finder history action bridge is unavailable.",
        };
      }
      const request: FinderHistoryBackRequest = ctx.input;
      const result = await executor.perform(request, ctx.signal);
      // A delivered AXPress is a committed physical side effect even when its
      // post-condition is not yet verified. That prevents a cancellation from
      // pretending nothing happened.
      if (result.succeeded) ctx.markCommitted();
      return result;
    },
    verify: async (ctx) => ({
      verified: ctx.output.verified,
      message: ctx.output.verified
        ? "Finder returned to the exact expected location."
        : "Finder Back was not verified against the original window.",
      ...(ctx.output.evidence === undefined ? {} : { evidence: ctx.output.evidence }),
    }),
  });
}
