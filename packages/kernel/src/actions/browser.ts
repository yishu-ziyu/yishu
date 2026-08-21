import { z } from "zod";
import { defineYishuAction } from "../action/define.js";
import type { BrowserRequest, BrowserResult } from "../action/types.js";

const targetIdSchema = z.string().regex(/^[1-9][0-9]?$/, "targetId must be 1-50");

const browserInputSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("goto"),
    url: z.string().trim().min(1).max(2_048),
  }).strict(),
  z.object({
    op: z.literal("observe"),
  }).strict(),
  z.object({
    op: z.literal("click"),
    targetId: targetIdSchema,
  }).strict(),
  z.object({
    op: z.literal("type"),
    targetId: targetIdSchema,
    text: z.string().min(1).max(2_000),
  }).strict(),
  z.object({
    op: z.literal("close"),
  }).strict(),
]);

export type BrowserInput = z.infer<typeof browserInputSchema>;

export function isAllowedBrowserUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  return true;
}

function unavailable(): BrowserResult {
  return {
    succeeded: false,
    verified: false,
    message: "The browser action bridge is unavailable.",
  };
}

function rejectedUrl(): BrowserResult {
  return {
    succeeded: false,
    verified: false,
    message: "Only http and https URLs are allowed.",
  };
}

/**
 * Drive the agent-owned isolated browser. Observe returns numbered targets;
 * click and type use those ids. This does not control the user's live Chrome.
 */
export function createBrowserAction() {
  return defineYishuAction({
    name: "browser",
    description:
      "Drive the agent-owned isolated browser. Observe numbered page targets, then click or type by id. Not the user's frontmost window.",
    inputSchema: browserInputSchema,
    authority: "reversible",
    risk: "medium",
    context: "none",
    run: async (ctx): Promise<BrowserResult> => {
      const executor = ctx.deps?.browser;
      if (!executor) return unavailable();
      if (ctx.input.op === "goto" && !isAllowedBrowserUrl(ctx.input.url)) {
        return rejectedUrl();
      }
      const request = ctx.input as BrowserRequest;
      const result = await executor.perform(request, ctx.signal);
      if (result.succeeded && ctx.input.op !== "observe") ctx.markCommitted();
      return result;
    },
    verify: async (ctx) => ({
      verified: ctx.output.verified,
      message: ctx.output.verified
        ? ctx.output.message
        : (ctx.output.message || "Browser action was not verified."),
      ...(ctx.output.targets === undefined && ctx.output.url === undefined
        ? {}
        : {
            evidence: {
              ...(ctx.output.url === undefined ? {} : { url: ctx.output.url }),
              targetCount: ctx.output.targets?.length ?? 0,
            },
          }),
    }),
  });
}
