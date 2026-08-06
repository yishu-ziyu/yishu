import { promises as fs } from "node:fs";
import path from "node:path";
import type { Trajectory, TrajectoryStep } from "../types.js";

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
}

function toolSequence(steps: TrajectoryStep[]): string[] {
  const seq: string[] = [];
  for (const s of steps) {
    if (s.kind === "tool_call") {
      const name = (s.data as { name?: string }).name;
      if (name) seq.push(name);
    }
  }
  return seq;
}

/** Collapse consecutive duplicates and summarize as procedural steps. */
function proceduralSteps(tools: string[]): string[] {
  if (tools.length === 0) {
    return ["1. Reason about the task and answer from available context."];
  }

  // Collapse runs of the same tool: a,a,b,b,b,c → a,b,c
  const collapsed: string[] = [];
  for (const t of tools) {
    if (collapsed[collapsed.length - 1] !== t) collapsed.push(t);
  }

  // Detect simple repeated pairs (e.g. read_file, write_file, read_file, write_file)
  const pairHint = detectRepeatedPair(tools);

  const lines: string[] = [];
  collapsed.forEach((name, i) => {
    lines.push(`${i + 1}. Call \`${name}\` when the task requires that capability.`);
  });
  if (pairHint) {
    lines.push(
      `${collapsed.length + 1}. Repeat the \`${pairHint[0]}\` → \`${pairHint[1]}\` sequence when iterating.`,
    );
  }
  lines.push(
    `${lines.length + 1}. Emit a final answer grounded in tool evidence only.`,
  );
  return lines;
}

function detectRepeatedPair(tools: string[]): [string, string] | null {
  if (tools.length < 4) return null;
  const pairs = new Map<string, number>();
  for (let i = 0; i < tools.length - 1; i++) {
    const key = `${tools[i]}→${tools[i + 1]}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [k, c] of pairs) {
    if (c > bestCount) {
      best = k;
      bestCount = c;
    }
  }
  if (!best || bestCount < 2) return null;
  const [a, b] = best.split("→");
  if (!a || !b || a === b) return null;
  return [a, b];
}

function slugify(task: string): string {
  const ascii = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (ascii.length >= 2) return ascii;
  // Fallback for pure CJK / short tasks
  return "from-trajectory";
}

/**
 * Turn a finished trajectory into a markdown skill draft (book ch8 experience→skill).
 */
export function draftSkillFromTrajectory(trajectory: Trajectory): SkillDraft {
  const tools = toolSequence(trajectory.steps);
  const unique = [...new Set(tools)];
  const nameBase = slugify(trajectory.task);
  const name = `generated-${nameBase}`;

  const toolList =
    unique.length > 0 ? unique.map((t) => `\`${t}\``).join(", ") : "none";

  const description =
    unique.length > 0
      ? `Auto-drafted from trajectory ${trajectory.id.slice(0, 8)} using ${unique.join(", ")}`
      : `Auto-drafted from trajectory ${trajectory.id.slice(0, 8)} (no tools)`;

  const steps = proceduralSteps(tools);
  const taskPreview = trajectory.task.replace(/\s+/g, " ").slice(0, 120);

  const body = [
    `# ${name}`,
    "",
    `Source task: ${taskPreview}`,
    "",
    `Tools observed: ${toolList}`,
    "",
    "## Procedure",
    "",
    ...steps,
    "",
    "## Notes",
    "",
    `- Trajectory status: ${trajectory.status}`,
    `- Source id: ${trajectory.id}`,
    "- Review before promoting this draft into a permanent skill.",
    "",
  ].join("\n");

  return { name, description, body };
}

export interface WriteSkillDraftOptions {
  /** When false, do not write. Default true. */
  accepted?: boolean;
}

/**
 * Write draft to `skillsDir/generated-<name>/SKILL.md` when accepted.
 * Returns written path, or null if skipped.
 */
export async function writeSkillDraft(
  skillsDir: string,
  draft: SkillDraft,
  options?: WriteSkillDraftOptions,
): Promise<string | null> {
  const accepted = options?.accepted ?? true;
  if (!accepted) return null;

  // Prefer folder name without double "generated-" if draft.name already has it
  const folder = draft.name.startsWith("generated-")
    ? draft.name
    : `generated-${draft.name}`;
  const dir = path.join(skillsDir, folder);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  const md = [
    "---",
    `name: ${draft.name}`,
    `description: ${JSON.stringify(draft.description)}`,
    "---",
    "",
    draft.body.trim(),
    "",
  ].join("\n");
  await fs.writeFile(file, md, "utf8");
  return file;
}
