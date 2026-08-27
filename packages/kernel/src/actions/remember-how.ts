import { z } from "zod";
import { defineYishuAction } from "../action/define.js";
import { ActionCancelledError } from "../action/types.js";
import type { ContextTrail } from "../context/trail.js";
import type { ContextTrailEntry } from "../context/sanitize.js";
import { extractProcedureFromTrail } from "../store/extract-procedure.js";
import {
  verifyProcedureAgainstTrail,
  type TrailReplayVerifyReport,
} from "../store/skill-verify.js";
import type { YishuStorePort } from "../store/yishu-store.js";
import type { SkillCandidate, VerifiedSkill } from "../store/types.js";

const rememberHowInputSchema = z.object({
  /** Look-back window in minutes. Default 3. */
  minutes: z.number().int().positive().max(60).default(3),
  name: z.string().trim().min(1).max(120).optional(),
  triggerPhrase: z.string().trim().min(1).max(200).optional(),
  /**
   * When true, run trail-replay verification against the same window and
   * attach the report to the candidate. Never promotes to a verified skill.
   * Default true for voice "记住刚才…" routes.
   */
  autoVerify: z.boolean().default(true),
  /** Minimum trail-replay confidence to promote. Default 0.7. */
  verifyThreshold: z.number().min(0).max(1).default(0.7),
});

export type RememberHowInput = z.infer<typeof rememberHowInputSchema>;

export interface RememberHowResult {
  candidate: SkillCandidate;
  skill: VerifiedSkill | null;
  trailSummary: string;
  entryCount: number;
  verifyReport: TrailReplayVerifyReport | null;
}

function trailEntriesForExtract(entries: ContextTrailEntry[]) {
  return entries.map((e) => {
    const row: {
      capturedAt: string;
      appName?: string;
      windowTitle?: string;
      axPreview?: string;
    } = { capturedAt: e.capturedAt };
    if (e.appName) row.appName = e.appName;
    if (e.windowTitle) row.windowTitle = e.windowTitle;
    if (e.axValuePreview) row.axPreview = e.axValuePreview;
    return row;
  });
}

/**
 * Product action for: "奕枢，记住我刚才是怎么做的。"
 *
 * Extracts a procedural skill candidate from ContextTrail (not mouse-coordinate
 * replay). autoVerify runs trail-replay against the same window and never
 * promotes.
 */
export function createRememberHowAction(deps: {
  store: YishuStorePort;
  trail: ContextTrail;
}) {
  const { store, trail } = deps;

  return defineYishuAction({
    name: "remember_how",
    description:
      "Extract a procedural skill candidate from ContextTrail; promote only after trail-replay verify.",
    inputSchema: rememberHowInputSchema,
    authority: "reversible",
    risk: "low",
    context: "trail",
    run: async (ctx): Promise<RememberHowResult> => {
      throwIfAborted(ctx.signal);
      if (ctx.sessionScope === undefined) {
        throw new Error("remember_how requires an exact session scope");
      }
      const sessionScope = ctx.sessionScope;
      if (sessionScope.kind === "private") {
        throw new Error("Private sessions cannot read ContextTrail.");
      }
      const entries = trail.recentMinutes(ctx.input.minutes, sessionScope, ctx.now);
      if (entries.length === 0) {
        throw new Error(
          `No ContextTrail entries in the last ${ctx.input.minutes} minute(s)`,
        );
      }

      const extractOpts: { name?: string; triggerPhrase?: string } = {};
      if (ctx.input.name !== undefined) extractOpts.name = ctx.input.name;
      if (ctx.input.triggerPhrase !== undefined) {
        extractOpts.triggerPhrase = ctx.input.triggerPhrase;
      }

      throwIfAborted(ctx.signal);
      const draft = extractProcedureFromTrail(
        trailEntriesForExtract(entries),
        extractOpts,
      );

      // Always attach trail_replay as a verification criterion.
      const verification = [
        ...new Set([...draft.verification, "trail_replay_ordered_steps"]),
      ];

      const candidateInput = {
        name: draft.name,
        steps: draft.steps,
        conditions: draft.conditions,
        verification,
        sourceTrailFrom: draft.sourceTrailFrom,
        sourceTrailTo: draft.sourceTrailTo,
        ...(draft.triggerPhrase !== undefined
          ? { triggerPhrase: draft.triggerPhrase }
          : {}),
      };
      throwIfAborted(ctx.signal);
      const mutationOptions =
        ctx.signal === undefined ? undefined : { signal: ctx.signal };
      const candidate =
        mutationOptions === undefined
          ? await store.addSkillCandidate(candidateInput)
          : await store.addSkillCandidate(candidateInput, mutationOptions);
      // The first candidate write is the durable commit point.  If a later
      // verification/promotion is cancelled, the registry must report that
      // this candidate already exists rather than claiming a clean cancel.
      ctx.markCommitted();
      throwIfAborted(ctx.signal);

      let skill: VerifiedSkill | null = null;
      let verifyReport: TrailReplayVerifyReport | null = null;

      if (ctx.input.autoVerify) {
        throwIfAborted(ctx.signal);
        verifyReport = verifyProcedureAgainstTrail(candidate, entries, {
          threshold: ctx.input.verifyThreshold,
        });
        throwIfAborted(ctx.signal);
        // Capability Alpha #18: autoVerify may only produce a candidate plus a
        // trail-replay report. Promotion requires a later dry-run on a live
        // target and an explicit user-reviewed verify path.
        skill = null;
      }

      return {
        candidate,
        skill,
        trailSummary: trail.summarize(ctx.input.minutes, sessionScope, ctx.now),
        entryCount: entries.length,
        verifyReport,
      };
    },
    verify: async (ctx) => {
      throwIfAborted(ctx.signal);
      const result = ctx.output as RememberHowResult;

      if (result.skill) {
        const skills = await store.listVerifiedSkills();
        throwIfAborted(ctx.signal);
        const ok = skills.some((s) => s.id === result.skill!.id);
        return {
          verified: ok,
          message: ok
            ? result.verifyReport?.message ??
              "Skill promoted after trail-replay verify"
            : "Promotion missing from store",
          evidence: {
            skillId: result.skill.id,
            report: result.verifyReport,
            promoted: true,
          },
        };
      }

      // Candidate path: trail-replay may have failed; capture still succeeded.
      const candidates = await store.listSkillCandidates();
      throwIfAborted(ctx.signal);
      const stored = candidates.some((c) => c.id === result.candidate.id);
      return {
        verified: stored,
        message: stored
          ? result.verifyReport?.message ??
            "Skill candidate stored; awaiting stronger trail-replay"
          : "Skill candidate was not persisted",
        evidence: {
          candidateId: result.candidate.id,
          steps: result.candidate.steps.length,
          promoted: false,
          report: result.verifyReport,
        },
      };
    },
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ActionCancelledError();
}
