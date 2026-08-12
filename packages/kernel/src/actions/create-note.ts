import { z } from "zod";
import { defineYishuAction } from "../action/define.js";
import type { CreateNoteRequest, CreateNoteResult } from "../action/types.js";

const createNoteInputSchema = z.object({
  content: z.string().trim().min(1).max(5_000),
  title: z.string().trim().min(1).max(120),
  targetBundleId: z.literal("com.apple.Notes"),
  intentId: z.string().uuid(),
  attemptId: z.string().uuid(),
  basisFrameId: z.string().uuid(),
}).strict();

export type CreateNoteInput = z.infer<typeof createNoteInputSchema>;

/** Create one new note. Editing, deleting, appending, and retries are outside this action. */
export function createNoteAction() {
  return defineYishuAction({
    name: "create_note",
    description: "Create exactly one new Apple Note and read back that exact note.",
    inputSchema: createNoteInputSchema,
    authority: "explicit_approval",
    risk: "medium",
    reversible: false,
    context: "current-frame",
    run: async (ctx): Promise<CreateNoteResult> => {
      const executor = ctx.deps?.createNote;
      if (!executor) {
        return {
          succeeded: false,
          verified: false,
          status: "failed",
          code: "runtime_error",
          method: "unknown",
          message: "The Notes bridge is unavailable.",
        };
      }
      const request: CreateNoteRequest = ctx.input;
      const result = await executor.perform(request, ctx.signal);
      if (result.succeeded) ctx.markCommitted();
      return { ...result, verified: isVerifiedCreateNoteResult(result) };
    },
    verify: async (ctx) => {
      const verified = isVerifiedCreateNoteResult(ctx.output);
      return {
        verified,
        message: verified
          ? "The exact created note was read back."
          : "The created note could not be read back exactly; it will not be retried.",
        ...(ctx.output.evidence === undefined
          ? {}
          : { evidence: ctx.output.evidence }),
      };
    },
  });
}

function isVerifiedCreateNoteResult(result: CreateNoteResult): boolean {
  return result.succeeded === true
    && result.verified === true
    && result.status === "verified"
    && result.method === "native_command"
    && result.code === "verified_accessibility";
}
