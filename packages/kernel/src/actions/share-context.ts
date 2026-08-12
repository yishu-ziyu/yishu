import { z } from "zod";
import { defineYishuAction } from "../action/define.js";
import {
  buildContextCapsule,
  serializeContextCapsule,
  type ContextCapsule,
} from "../context/capsule.js";
import type { ContextTrail } from "../context/trail.js";
import type { TrailSourceFrame } from "../context/sanitize.js";

const shareContextInputSchema = z.object({
  userIntent: z.string().trim().min(1).max(2000).optional(),
  projectHint: z.string().trim().min(1).max(200).optional(),
  recentMinutes: z.number().int().positive().max(60).default(5),
  /** Capsule TTL in seconds. Default 900 (15 min). */
  ttlSeconds: z.number().int().positive().max(86_400).default(900),
});

export type ShareContextInput = z.infer<typeof shareContextInputSchema>;

export interface ShareContextResult {
  capsule: ContextCapsule;
  json: string;
}

/**
 * Build a handoff ContextCapsule for Pi / Codex / Claude Code / Cua cells.
 * Never includes raw screenshots or credentials.
 */
export function createShareContextAction(trail: ContextTrail) {
  return defineYishuAction({
    name: "share_context",
    description:
      "Package current attention into a short-lived ContextCapsule for multi-agent handoff.",
    inputSchema: shareContextInputSchema,
    authority: "automatic",
    risk: "low",
    context: "capsule",
    run: async (ctx): Promise<ShareContextResult> => {
      if (ctx.sessionScope === undefined) {
        throw new Error("share_context requires an exact session scope");
      }
      const sessionScope = ctx.sessionScope;
      if (sessionScope.kind === "private") {
        throw new Error("Private sessions cannot share ContextTrail.");
      }
      const frame =
        ctx.contextFrame !== undefined
          ? (ctx.contextFrame as TrailSourceFrame)
          : undefined;

      const buildInput: Parameters<typeof buildContextCapsule>[0] = {
        trail,
        sessionScope,
        recentMinutes: ctx.input.recentMinutes,
        ttlMs: ctx.input.ttlSeconds * 1000,
        now: ctx.now,
      };
      if (frame !== undefined) buildInput.frame = frame;
      if (ctx.input.userIntent !== undefined) {
        buildInput.userIntent = ctx.input.userIntent;
      }
      if (ctx.input.projectHint !== undefined) {
        buildInput.projectHint = ctx.input.projectHint;
      }

      const capsule = buildContextCapsule(buildInput);
      return {
        capsule,
        json: serializeContextCapsule(capsule),
      };
    },
    verify: async (ctx) => {
      const result = ctx.output as ShareContextResult;
      const hasId = typeof result.capsule.capsuleId === "string";
      const noBytes = !JSON.stringify(result.capsule).includes("base64Data");
      const ok = hasId && noBytes && result.capsule.schemaVersion === 1;
      return {
        verified: ok,
        message: ok
          ? "ContextCapsule is structured and free of screenshot bytes"
          : "ContextCapsule failed structural checks",
        evidence: {
          capsuleId: result.capsule.capsuleId,
          trailEntryCount: result.capsule.provenance.trailEntryCount,
        },
      };
    },
  });
}
