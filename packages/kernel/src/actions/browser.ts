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
    mode: z.enum(["interactive", "content", "both"]).optional(),
  }).strict(),
  z.object({
    op: z.literal("click"),
    targetId: targetIdSchema,
  }).strict(),
  z.object({
    op: z.literal("type"),
    targetId: targetIdSchema,
    text: z.string().min(1).max(2_000),
    mode: z.enum(["fill", "append"]).optional(),
  }).strict(),
  z.object({
    op: z.literal("select"),
    targetId: targetIdSchema,
    value: z.string().min(1).max(500),
  }).strict(),
  z.object({
    op: z.literal("check"),
    targetId: targetIdSchema,
    checked: z.boolean(),
  }).strict(),
  z.object({
    op: z.literal("scroll"),
    direction: z.enum(["up", "down"]),
    amount: z.enum(["small", "page", "end"]),
  }).strict(),
  z.object({ op: z.literal("back") }).strict(),
  z.object({ op: z.literal("forward") }).strict(),
  z.object({ op: z.literal("reload") }).strict(),
  z.object({
    op: z.literal("wait_for"),
    condition: z.enum(["url", "title", "target", "text", "network_idle", "download"]),
    timeoutMs: z.number().int().positive().max(30_000).optional(),
  }).strict(),
  z.object({
    op: z.literal("extract"),
    targetId: targetIdSchema.optional(),
    format: z.enum(["text", "markdown", "table"]),
  }).strict(),
  z.object({
    op: z.literal("open_tab"),
    url: z.string().trim().min(1).max(2_048).optional(),
  }).strict(),
  z.object({
    op: z.literal("switch_tab"),
    tabId: z.string().min(1).max(80),
  }).strict(),
  z.object({
    op: z.literal("close_tab"),
    tabId: z.string().min(1).max(80).optional(),
  }).strict(),
  z.object({
    op: z.literal("upload"),
    targetId: targetIdSchema,
    workspaceFileId: z.string().min(1).max(120),
  }).strict(),
  z.object({
    op: z.literal("download"),
    targetId: targetIdSchema,
  }).strict(),
  z.object({
    op: z.literal("close"),
  }).strict(),
]);

export type BrowserInput = z.infer<typeof browserInputSchema>;

const PRIVATE_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "metadata.google.internal"]);

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (PRIVATE_HOSTS.has(host)) return true;
  if (host === "169.254.169.254") return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return host.endsWith(".local");
}

export function isAllowedBrowserUrl(
  url: string,
  options: { allowPrivateNetwork?: boolean } = {},
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.port === "0") return false;
  if (!options.allowPrivateNetwork && isPrivateHostname(parsed.hostname)) return false;
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
      if (ctx.input.op === "open_tab" && ctx.input.url !== undefined && !isAllowedBrowserUrl(ctx.input.url)) {
        return rejectedUrl();
      }
      const request = ctx.input as BrowserRequest;
      const result = await executor.perform(request, ctx.signal);
      const readOnly = ctx.input.op === "observe"
        || ctx.input.op === "extract"
        || ctx.input.op === "wait_for";
      if (result.succeeded && !readOnly) ctx.markCommitted();
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
