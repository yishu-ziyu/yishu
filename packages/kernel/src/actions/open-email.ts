import { z } from "zod";
import { defineYishuAction } from "../action/define.js";
import type { OpenEmailRequest, OpenEmailResult } from "../action/email-types.js";

const openEmailInputSchema = z.object({
  provider: z.literal("google").optional(),
  intentId: z.string().uuid(),
  attemptId: z.string().uuid(),
  basisFrameId: z.string().uuid(),
}).strict();

export type OpenEmailInput = z.infer<typeof openEmailInputSchema>;

/** Resolve one personal email destination, open it once, then learn it only after verification. */
export function createOpenEmailAction() {
  return defineYishuAction({
    name: "open_email",
    description: "Open the user's learned default email destination in the macOS default browser.",
    inputSchema: openEmailInputSchema,
    authority: "reversible",
    risk: "low",
    context: "current-frame",
    run: async (ctx): Promise<OpenEmailResult> => {
      const defaults = ctx.deps?.emailDefaults;
      const provider = ctx.input.provider ?? await defaults?.resolve(ctx.signal);
      if (provider === undefined) {
        return {
          succeeded: false,
          verified: false,
          needsClarification: true,
          status: "blocked",
          code: "email_provider_required",
          method: "unknown",
          message: "The user's default email provider is not known yet.",
        };
      }

      const executor = ctx.deps?.openEmail;
      if (executor === undefined) {
        return {
          succeeded: false,
          verified: false,
          provider,
          status: "failed",
          code: "runtime_error",
          method: "unknown",
          message: "The macOS email destination bridge is unavailable.",
        };
      }

      const request: OpenEmailRequest = {
        provider,
        intentId: ctx.input.intentId,
        attemptId: ctx.input.attemptId,
        basisFrameId: ctx.input.basisFrameId,
      };
      const result = await executor.perform(request, ctx.signal);
      if (result.succeeded) ctx.markCommitted();

      let learned = false;
      if (result.verified && ctx.input.provider !== undefined && defaults !== undefined) {
        learned = await defaults.remember(provider, ctx.signal);
      }
      return { ...result, provider, learned };
    },
    verify: async (ctx) => ({
      verified: ctx.output.verified,
      message: ctx.output.verified
        ? "The canonical email destination was opened by macOS."
        : ctx.output.needsClarification
          ? "The email provider must be clarified before opening."
          : "The email destination was not verified as opened.",
    }),
  });
}
