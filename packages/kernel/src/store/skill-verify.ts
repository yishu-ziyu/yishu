import type { ContextTrailEntry } from "../context/sanitize.js";
import type { SkillCandidate, SkillStep } from "./types.js";

export interface TrailReplayVerifyReport {
  verified: boolean;
  confidence: number;
  matchedStepIds: string[];
  missingStepIds: string[];
  ordered: boolean;
  message: string;
  /** Min confidence to promote; default 0.7 */
  threshold: number;
}

export interface SkillLike {
  steps: SkillStep[];
  conditions: Record<string, string>;
}

/**
 * Trail-replay verification: re-walk the recent ContextTrail and check that
 * procedural steps are observable in chronological order.
 *
 * This is not mouse-coordinate replay. It confirms app/window/segment evidence
 * still supports the extracted procedure before promotion to VerifiedSkill.
 */
export function verifyProcedureAgainstTrail(
  skill: SkillLike,
  entries: ContextTrailEntry[],
  options?: { threshold?: number },
): TrailReplayVerifyReport {
  const threshold = options?.threshold ?? 0.7;
  const steps = skill.steps.filter((s) => s.kind !== "other");
  if (steps.length === 0) {
    return {
      verified: false,
      confidence: 0,
      matchedStepIds: [],
      missingStepIds: [],
      ordered: true,
      message: "No verifiable steps",
      threshold,
    };
  }
  if (entries.length === 0) {
    return {
      verified: false,
      confidence: 0,
      matchedStepIds: [],
      missingStepIds: steps.map((s) => s.id),
      ordered: true,
      message: "Empty trail cannot verify procedure",
      threshold,
    };
  }

  const orderedEntries = [...entries].sort((a, b) =>
    a.capturedAt.localeCompare(b.capturedAt),
  );

  const matchedStepIds: string[] = [];
  const missingStepIds: string[] = [];
  let searchFrom = 0;
  let ordered = true;

  for (const step of steps) {
    const needles = stepNeedles(step, skill.conditions);
    let foundAt = -1;
    for (let i = searchFrom; i < orderedEntries.length; i++) {
      const entry = orderedEntries[i]!;
      if (entryMatches(entry, needles)) {
        foundAt = i;
        break;
      }
    }
    if (foundAt >= 0) {
      matchedStepIds.push(step.id);
      searchFrom = foundAt + 1;
    } else {
      // Fallback: any later match even if order breaks
      const anyIdx = orderedEntries.findIndex((e) => entryMatches(e, needles));
      if (anyIdx >= 0) {
        matchedStepIds.push(step.id);
        ordered = false;
        searchFrom = Math.max(searchFrom, anyIdx + 1);
      } else {
        missingStepIds.push(step.id);
      }
    }
  }

  const coverage = matchedStepIds.length / steps.length;
  const orderBonus = ordered ? 0.1 : 0;
  const multiAppBonus = distinctApps(orderedEntries).size >= 2 ? 0.05 : 0;
  const conditionBonus = conditionsSatisfied(skill.conditions, orderedEntries)
    ? 0.05
    : 0;
  const confidence = Math.min(
    1,
    Math.round((coverage + orderBonus + multiAppBonus + conditionBonus) * 100) /
      100,
  );
  const verified = confidence >= threshold && matchedStepIds.length > 0;

  return {
    verified,
    confidence,
    matchedStepIds,
    missingStepIds,
    ordered,
    message: verified
      ? `Trail replay verified ${matchedStepIds.length}/${steps.length} steps (confidence=${confidence})`
      : `Trail replay incomplete: ${matchedStepIds.length}/${steps.length} steps (confidence=${confidence}, need >= ${threshold})`,
    threshold,
  };
}

function stepNeedles(
  step: SkillStep,
  conditions: Record<string, string>,
): string[] {
  const raw = [
    step.description,
    conditions.app ?? "",
    conditions.windowOrDomain ?? "",
  ]
    .join(" ")
    .toLowerCase();
  const tokens = raw
    .split(/[\s:：/|·→,\-_()（）【】\[\]"']+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .filter((t) => !STOP.has(t));
  return [...new Set(tokens)].slice(0, 12);
}

function entryMatches(entry: ContextTrailEntry, needles: string[]): boolean {
  if (needles.length === 0) return true;
  const hay = [
    entry.appName ?? "",
    entry.bundleId ?? "",
    entry.windowTitle ?? "",
    entry.windowOwner ?? "",
    entry.axRole ?? "",
    entry.axTitle ?? "",
    entry.axValuePreview ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return needles.some((n) => hay.includes(n));
}

function distinctApps(entries: ContextTrailEntry[]): Set<string> {
  const set = new Set<string>();
  for (const e of entries) {
    if (e.appName) set.add(e.appName);
  }
  return set;
}

function conditionsSatisfied(
  conditions: Record<string, string>,
  entries: ContextTrailEntry[],
): boolean {
  const app = conditions.app?.toLowerCase();
  if (app && !entries.some((e) => (e.appName ?? "").toLowerCase().includes(app))) {
    return false;
  }
  const win = conditions.windowOrDomain?.toLowerCase();
  if (
    win &&
    !entries.some((e) => (e.windowTitle ?? "").toLowerCase().includes(win))
  ) {
    return false;
  }
  return true;
}

const STOP = new Set([
  "in",
  "the",
  "and",
  "for",
  "with",
  "from",
  "work",
  "open",
  "observe",
  "activity",
  "resolve",
  "act",
  "verify",
  "empty",
  "trail",
  "no",
  "observable",
  "steps",
  "当前",
  "打开",
  "观察",
  "工作",
  "活动",
]);

/** Convenience wrapper when the input is a full SkillCandidate. */
export function verifyCandidateAgainstTrail(
  candidate: SkillCandidate,
  entries: ContextTrailEntry[],
  options?: { threshold?: number },
): TrailReplayVerifyReport {
  return verifyProcedureAgainstTrail(candidate, entries, options);
}
