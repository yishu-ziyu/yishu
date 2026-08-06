import { promises as fs } from "node:fs";
import path from "node:path";
import type { ScoreboardEntry } from "./types.js";

export async function appendScoreboard(
  scoreboardPath: string,
  entry: ScoreboardEntry,
): Promise<void> {
  await fs.mkdir(path.dirname(scoreboardPath), { recursive: true });
  let list: ScoreboardEntry[] = [];
  try {
    const raw = await fs.readFile(scoreboardPath, "utf8");
    list = JSON.parse(raw) as ScoreboardEntry[];
    if (!Array.isArray(list)) list = [];
  } catch {
    list = [];
  }
  list.push(entry);
  await fs.writeFile(scoreboardPath, `${JSON.stringify(list, null, 2)}\n`, "utf8");
}

export async function loadScoreboard(
  scoreboardPath: string,
): Promise<ScoreboardEntry[]> {
  try {
    const raw = await fs.readFile(scoreboardPath, "utf8");
    const list = JSON.parse(raw) as ScoreboardEntry[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
