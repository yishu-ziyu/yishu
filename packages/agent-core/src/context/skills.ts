import { promises as fs } from "node:fs";
import path from "node:path";
import type { Skill } from "../types.js";

interface Frontmatter {
  name?: string;
  description?: string;
}

function parseFrontmatter(raw: string): {
  meta: Frontmatter;
  body: string;
} {
  if (!raw.startsWith("---")) {
    return { meta: {}, body: raw };
  }
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: raw };
  const fm = raw.slice(4, end).trim();
  const body = raw.slice(end + 4).replace(/^\s*\n/, "");
  const meta: Frontmatter = {};
  for (const line of fm.split("\n")) {
    const m = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (!m) continue;
    const key = m[1];
    const val = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (!val) continue;
    if (key === "name") meta.name = val;
    if (key === "description") meta.description = val;
  }
  return { meta, body };
}

async function walkSkillFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkSkillFiles(full)));
    } else if (e.isFile() && e.name === "SKILL.md") {
      out.push(full);
    }
  }
  return out;
}

export async function loadSkills(skillsDir: string): Promise<Skill[]> {
  const files = await walkSkillFiles(skillsDir);
  const skills: Skill[] = [];
  for (const file of files) {
    const raw = await fs.readFile(file, "utf8");
    const { meta, body } = parseFrontmatter(raw);
    const fallbackName = path.basename(path.dirname(file));
    skills.push({
      name: meta.name ?? fallbackName,
      description: meta.description ?? "",
      body,
      path: file,
    });
  }
  return skills;
}

export interface MatchedSkills {
  /** Name + description for all (catalog). */
  catalog: Array<{ name: string; description: string }>;
  /** Full body for task-matched skills. */
  matched: Skill[];
}

/**
 * Progressive disclosure: always return name+desc for all skills;
 * include full body only for skills whose name/desc/body keywords match the task.
 */
export function matchSkills(task: string, skills: Skill[]): MatchedSkills {
  const lower = task.toLowerCase();
  const catalog = skills.map((s) => ({
    name: s.name,
    description: s.description,
  }));

  const matched = skills.filter((s) => {
    const hay = `${s.name} ${s.description}`.toLowerCase();
    const tokens = hay.split(/[\s/_-]+/).filter((t) => t.length > 2);
    if (tokens.some((t) => lower.includes(t))) return true;
    // Chinese / domain hooks
    if (s.name === "research" && /查|搜|research|search/i.test(task))
      return true;
    if (s.name === "coding" && /代码|code|算|计算|math|写文件/i.test(task))
      return true;
    if (s.name === "memory" && /记忆|记住|偏好|memory|记得/i.test(task))
      return true;
    return false;
  });

  return { catalog, matched };
}

export function formatSkillsForPrompt(matched: MatchedSkills): string {
  const lines: string[] = ["## Available skills"];
  for (const c of matched.catalog) {
    lines.push(`- ${c.name}: ${c.description}`);
  }
  if (matched.matched.length > 0) {
    lines.push("", "## Loaded skill bodies");
    for (const s of matched.matched) {
      lines.push(`### ${s.name}`, s.body.trim(), "");
    }
  }
  return lines.join("\n");
}
