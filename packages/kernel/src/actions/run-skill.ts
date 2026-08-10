import { z } from "zod";
import { defineYishuAction } from "../action/define.js";
import {
  buildContextCapsule,
  serializeContextCapsule,
  type ContextCapsule,
} from "../context/capsule.js";
import type { ContextTrail } from "../context/trail.js";
import type { TrailSourceFrame } from "../context/sanitize.js";
import type { YishuStorePort } from "../store/yishu-store.js";
import type { SkillStep, VerifiedSkill } from "../store/types.js";
import { verifyProcedureAgainstTrail } from "../store/skill-verify.js";

const runSkillInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phrase: z.string().trim().min(1).max(200).optional(),
  userIntent: z.string().trim().min(1).max(2000).optional(),
  /** When no skill matches, build a ContextCapsule instead. Default true. */
  fallbackShareContext: z.boolean().default(true),
  recentMinutes: z.number().int().positive().max(60).default(10),
});

export type RunSkillInput = z.infer<typeof runSkillInputSchema>;

export interface RunSkillResult {
  mode: "skill" | "capsule_fallback";
  skillName?: string;
  skillId?: string;
  steps?: SkillStep[];
  conditions?: Record<string, string>;
  /** Fresh trail-replay against current trail for the skill conditions. */
  revalidated: boolean;
  revalidateConfidence: number;
  capsule?: ContextCapsule;
  capsuleJson?: string;
  capsuleReady: boolean;
  message: string;
}

function scorePhrase(skill: VerifiedSkill, phrase: string): number {
  const p = phrase.toLowerCase();
  let score = 0;
  if (skill.triggerPhrase && p.includes(skill.triggerPhrase.toLowerCase())) {
    score += 3;
  }
  if (p.includes(skill.name.toLowerCase())) score += 2;
  // Soft token overlap with trigger phrase words
  const tokens = (skill.triggerPhrase ?? skill.name)
    .toLowerCase()
    .split(/[\s,，、]+/)
    .filter((t) => t.length >= 2);
  for (const t of tokens) {
    if (p.includes(t)) score += 0.5;
  }
  // Common handoff phrases
  if (/codex/i.test(p) && /codex/i.test(skill.name + (skill.triggerPhrase ?? ""))) {
    score += 1;
  }
  return score;
}

/**
 * Resolve a VerifiedSkill by name/phrase and revalidate against live trail.
 * If none match and fallbackShareContext, builds a ContextCapsule for handoff.
 */
export function createRunSkillAction(deps: {
  store: YishuStorePort;
  trail: ContextTrail;
}) {
  const { store, trail } = deps;

  return defineYishuAction({
    name: "run_skill",
    description:
      "Run a verified procedural skill, or fall back to a ContextCapsule handoff.",
    inputSchema: runSkillInputSchema,
    authority: "reversible",
    risk: "low",
    context: "trail",
    run: async (ctx): Promise<RunSkillResult> => {
      const skills = await store.listVerifiedSkills();
      let matched: VerifiedSkill | null = null;

      if (ctx.input.name) {
        const byName = skills.find((s) => s.name === ctx.input.name);
        if (byName) matched = byName;
      }
      if (!matched && ctx.input.phrase) {
        const ranked = skills
          .map((s) => ({ s, score: scorePhrase(s, ctx.input.phrase!) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score);
        matched = ranked[0]?.s ?? null;
      }

      const frame =
        ctx.contextFrame !== undefined
          ? (ctx.contextFrame as TrailSourceFrame)
          : undefined;
      const recent = trail.recentMinutes(ctx.input.recentMinutes, ctx.now);

      if (matched) {
        const report = verifyProcedureAgainstTrail(matched, recent, {
          threshold: 0.5,
        });

        let capsule: ContextCapsule | undefined;
        let capsuleJson: string | undefined;
        // Handoff-style skills always refresh a capsule for the peer agent.
        const wantsCapsule =
          /codex|claude|cursor|handoff|capsule|交给/i.test(
            `${matched.name} ${matched.triggerPhrase ?? ""} ${ctx.input.phrase ?? ""}`,
          ) || matched.steps.some((s) => /capsule|codex|交付/i.test(s.description));

        if (wantsCapsule) {
          const buildInput: Parameters<typeof buildContextCapsule>[0] = {
            trail,
            recentMinutes: ctx.input.recentMinutes,
            now: ctx.now,
            userIntent:
              ctx.input.userIntent ??
              ctx.input.phrase ??
              matched.triggerPhrase ??
              matched.name,
          };
          if (frame !== undefined) buildInput.frame = frame;
          capsule = buildContextCapsule(buildInput);
          capsuleJson = serializeContextCapsule(capsule);
        }

        const result: RunSkillResult = {
          mode: "skill",
          skillName: matched.name,
          skillId: matched.id,
          steps: matched.steps,
          conditions: matched.conditions,
          revalidated: report.verified,
          revalidateConfidence: report.confidence,
          capsuleReady: capsule !== undefined,
          message: report.verified
            ? `Skill ${matched.name} revalidated against trail`
            : `Skill ${matched.name} loaded; trail revalidation weak (${report.confidence})`,
        };
        if (capsule !== undefined) result.capsule = capsule;
        if (capsuleJson !== undefined) result.capsuleJson = capsuleJson;
        return result;
      }

      if (!ctx.input.fallbackShareContext) {
        throw new Error("No verified skill matched and fallbackShareContext is false");
      }

      const buildInput: Parameters<typeof buildContextCapsule>[0] = {
        trail,
        recentMinutes: ctx.input.recentMinutes,
        now: ctx.now,
      };
      if (frame !== undefined) buildInput.frame = frame;
      if (ctx.input.userIntent !== undefined) {
        buildInput.userIntent = ctx.input.userIntent;
      } else if (ctx.input.phrase !== undefined) {
        buildInput.userIntent = ctx.input.phrase;
      }
      const capsule = buildContextCapsule(buildInput);
      return {
        mode: "capsule_fallback",
        revalidated: false,
        revalidateConfidence: 0,
        capsule,
        capsuleJson: serializeContextCapsule(capsule),
        capsuleReady: true,
        message: "No verified skill matched; ContextCapsule prepared for handoff",
      };
    },
    verify: async (ctx) => {
      const result = ctx.output as RunSkillResult;
      if (result.mode === "skill") {
        return {
          verified: result.skillId != null && (result.steps?.length ?? 0) > 0,
          message: result.message,
          evidence: {
            skillId: result.skillId,
            revalidated: result.revalidated,
            confidence: result.revalidateConfidence,
          },
        };
      }
      return {
        verified: result.capsuleReady === true,
        message: result.message,
        evidence: { capsuleId: result.capsule?.capsuleId ?? null },
      };
    },
  });
}
