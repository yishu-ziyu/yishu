/**
 * Markdown memory truth layer (ADR 0013 #1, ADR 0016).
 *
 * Facts and episodes live as user-readable, user-editable markdown under the
 * memory root (default ~/Documents/Yishu/Memory). SQLite MemoryClaim rows are
 * rebuildable indexes pointing at these files. Writes are atomic
 * (tmp + rename) and serialized per path. Lines without machine markers are
 * user-authored and are preserved verbatim forever.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const EPISODE_SUMMARY_CHARS = 120;
const FACT_CLAIM_CHARS = 200;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Scope key -> safe single path segment (CWE-22 layer 1). */
export function memoryScopeSlug(scopeKey: string): string {
  const slug = scopeKey
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) return "default";
  if (slug.length > 64) return slug.slice(0, 64);
  return slug;
}

/**
 * CWE-22 layer 3: resolved path must stay inside the memory root.
 * Layer 2 is path.join of sanitized segments only.
 */
export function assertMemoryPathWithinRoot(rootDir: string, candidate: string): string {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(candidate);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw new Error("memory path escapes truth-layer root");
  }
  return resolved;
}

export interface EpisodeEntry {
  readonly turnId: string;
  readonly scopeKey: string;
  readonly utterance: string;
  readonly replyText: string;
  readonly capturedAt: string;
}

export interface FactWrite {
  /** Existing fact id to confirm, or undefined to create with a new id. */
  readonly id?: string;
  readonly claim: string;
  readonly source: string;
  readonly capturedAt: string;
  readonly confirmedAt: string;
}

export interface FactRecord {
  readonly id: string;
  readonly claim: string;
  readonly source: string;
  readonly capturedAt: string;
  readonly lastConfirmedAt: string;
}

export type FactWriteResult = "created" | "confirmed";

function episodeFileName(capturedAt: string): string {
  const day = capturedAt.slice(0, 10);
  return `${ISO_DAY.test(day) ? day : "unknown"}.md`;
}

function episodeLine(entry: EpisodeEntry): string {
  const time = entry.capturedAt.slice(11, 19) || "unknown";
  return `- ${time} [turn:${entry.turnId}] U: ${clip(entry.utterance, EPISODE_SUMMARY_CHARS)} A: ${clip(entry.replyText, EPISODE_SUMMARY_CHARS)}`;
}

function factLine(fact: { id: string; claim: string; source: string; confirmedAt: string }): string {
  const day = fact.confirmedAt.slice(0, 10) || "unknown";
  return `- [mem:${fact.id}|${day}|${fact.source}] ${fact.claim}`;
}

const FACT_LINE_PATTERN = /^- \[mem:([^\]|]+)\|([^\]|]*)\|([^\]]*)\] (.*)$/;
const TURN_MARKER_PATTERN = /\[turn:([^\]]+)\]/;

export function parseFactLine(line: string): { id: string; day: string; source: string; claim: string } | null {
  const match = FACT_LINE_PATTERN.exec(line.trim());
  if (!match) return null;
  return { id: match[1]!, day: match[2]!, source: match[3]!, claim: match[4]!.trim() };
}

function clip(value: string, max: number): string {
  const cleaned = value.replace(/\s+/gu, " ").trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`;
}

/**
 * Per-path async mutex so concurrent turn settles cannot interleave a
 * read-modify-write cycle on the same markdown file.
 */
const pathLocks = new Map<string, Promise<unknown>>();

async function withPathLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(filePath) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const settled = run.catch(() => undefined);
  pathLocks.set(filePath, settled);
  try {
    return await run;
  } finally {
    if (pathLocks.get(filePath) === settled) {
      pathLocks.delete(filePath);
    }
  }
}

export class MemoryTruthLayer {
  constructor(private readonly rootDir: string) {}

  get root(): string {
    return this.rootDir;
  }

  private scopePath(scopeKey: string, ...segments: string[]): string {
    return assertMemoryPathWithinRoot(
      this.rootDir,
      path.join(this.rootDir, memoryScopeSlug(scopeKey), ...segments),
    );
  }

  private async readText(filePath: string): Promise<string> {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  private async writeAtomic(filePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, filePath);
  }

  /** Append one episode line; idempotent per turn id (replay-safe). */
  async appendEpisode(entry: EpisodeEntry): Promise<boolean> {
    const filePath = this.scopePath(entry.scopeKey, "episodes", episodeFileName(entry.capturedAt));
    return withPathLock(filePath, async () => {
      const current = await this.readText(filePath);
      if (current.includes(`[turn:${entry.turnId}]`)) return false;
      const line = episodeLine(entry);
      const next = current.length === 0
        ? `# Episodes ${episodeFileName(entry.capturedAt).replace(/\.md$/, "")}\n\n${line}\n`
        : `${current.endsWith("\n") ? current : `${current}\n`}${line}\n`;
      await this.writeAtomic(filePath, next);
      return true;
    });
  }

  factsPath(scopeKey: string): string {
    return this.scopePath(scopeKey, "facts", "preferences.md");
  }

  /** All parsed fact entries in one scope, in file order. */
  async listFacts(scopeKey: string): Promise<FactRecord[]> {
    const filePath = this.factsPath(scopeKey);
    const content = await this.readText(filePath);
    const facts: FactRecord[] = [];
    for (const line of content.split("\n")) {
      const parsed = parseFactLine(line);
      if (!parsed) continue;
      facts.push({
        id: parsed.id,
        claim: parsed.claim,
        source: parsed.source,
        capturedAt: parsed.day,
        lastConfirmedAt: parsed.day,
      });
    }
    return facts;
  }

  /**
   * Create a fact or bump an existing one's confirmed day. The markdown line
   * is the truth; callers mirror the change into the store index.
   */
  async upsertFact(scopeKey: string, write: FactWrite): Promise<FactWriteResult> {
    const filePath = this.factsPath(scopeKey);
    return withPathLock(filePath, async () => {
      const current = await this.readText(filePath);
      const lines = current.split("\n");
      const existingIndex = write.id === undefined
        ? -1
        : lines.findIndex((line) => parseFactLine(line)?.id === write.id);
      const claim = clip(write.claim, FACT_CLAIM_CHARS);
      if (existingIndex >= 0) {
        lines[existingIndex] = factLine({
          id: write.id!,
          claim,
          source: write.source,
          confirmedAt: write.confirmedAt,
        });
        await this.writeAtomic(filePath, lines.join("\n"));
        return "confirmed";
      }
      const line = factLine({
        id: write.id ?? randomUUID(),
        claim,
        source: write.source,
        confirmedAt: write.confirmedAt,
      });
      const next = current.length === 0
        ? `# Preferences\n\n${line}\n`
        : `${current.endsWith("\n") ? current : `${current}\n`}${line}\n`;
      await this.writeAtomic(filePath, next);
      return "created";
    });
  }

  /** Remove one fact line (user-forget). Returns false when absent. */
  async removeFact(scopeKey: string, factId: string): Promise<boolean> {
    const filePath = this.factsPath(scopeKey);
    return withPathLock(filePath, async () => {
      const current = await this.readText(filePath);
      if (!current.includes(`[mem:${factId}|`)) return false;
      const lines = current.split("\n").filter(
        (line) => parseFactLine(line)?.id !== factId,
      );
      await this.writeAtomic(filePath, lines.join("\n"));
      return true;
    });
  }

  /** Stable truth pointer for the store index (ADR 0016 #2). */
  truthRefFor(scopeKey: string, factId: string): string {
    return `${memoryScopeSlug(scopeKey)}/facts/preferences.md#mem:${factId}`;
  }
}
