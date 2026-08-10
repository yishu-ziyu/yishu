/**
 * In-memory rolling context trail.
 *
 * Stores sanitized ContextTrailEntry rows only (no screenshot bytes).
 * Prunes by retention window and max entry count.
 */

import {
  expireScreenshotMetadata,
  toTrailEntry,
  type ContextTrailEntry,
  type TrailSourceFrame,
} from "./sanitize.js";

export interface ContextTrailOptions {
  /** Hard cap on retained entries. Default 500. */
  maxEntries?: number;
  /** How long entries stay queryable. Default 20 minutes. */
  retentionMs?: number;
  /** How long hasScreenshot metadata remains true. Default 30s. */
  screenshotTtlMs?: number;
}

export interface ContextTrailQuery {
  /** Look-back window in ms from "now". Default = retentionMs. */
  sinceMs?: number;
  /** Inclusive upper bound ISO timestamp. */
  until?: string;
  /** Max rows to return (newest last / chronological). */
  limit?: number;
  /** Case-insensitive match against app / window / AX fields. */
  query?: string;
}

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_RETENTION_MS = 20 * 60 * 1000;
const DEFAULT_SCREENSHOT_TTL_MS = 30_000;

export class ContextTrail {
  private readonly maxEntries: number;
  private readonly retentionMs: number;
  private readonly screenshotTtlMs: number;
  private entries: ContextTrailEntry[] = [];

  constructor(options: ContextTrailOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.screenshotTtlMs = options.screenshotTtlMs ?? DEFAULT_SCREENSHOT_TTL_MS;
  }

  append(frame: TrailSourceFrame, now: Date = new Date()): ContextTrailEntry {
    const entry = toTrailEntry(frame, {
      now,
      screenshotTtlMs: this.screenshotTtlMs,
    });
    this.entries.push(entry);
    this.prune(now);
    return entry;
  }

  query(options: ContextTrailQuery = {}, now: Date = new Date()): ContextTrailEntry[] {
    this.prune(now);

    const sinceMs = options.sinceMs ?? this.retentionMs;
    const sinceTs = now.getTime() - sinceMs;
    const untilTs = options.until != null ? Date.parse(options.until) : Number.POSITIVE_INFINITY;
    const needle = options.query?.trim().toLowerCase() ?? "";

    let results = this.entries.filter((entry) => {
      const ts = Date.parse(entry.capturedAt);
      if (!Number.isFinite(ts)) return false;
      if (ts < sinceTs) return false;
      if (ts > untilTs) return false;
      if (needle.length > 0 && !matchesQuery(entry, needle)) return false;
      return true;
    });

    // Chronological (oldest first). If limit set, keep the most recent N.
    if (options.limit != null && options.limit >= 0 && results.length > options.limit) {
      results = results.slice(results.length - options.limit);
    }

    // Refresh screenshot metadata flags for the returned view without dropping rows.
    return results.map((e) => expireScreenshotMetadata({ ...e }, now));
  }

  recentMinutes(minutes: number, now: Date = new Date()): ContextTrailEntry[] {
    const ms = Math.max(0, minutes) * 60_000;
    return this.query({ sinceMs: ms }, now);
  }

  /**
   * Human-readable bullet timeline for the last `minutes` (default 5).
   * Never includes image bytes.
   */
  summarize(minutes = 5, now: Date = new Date()): string {
    const rows = this.recentMinutes(minutes, now);
    if (rows.length === 0) {
      return `(no trail entries in last ${minutes}m)`;
    }

    const lines: string[] = [`Context trail (last ${minutes}m, ${rows.length} entries):`];
    for (const e of rows) {
      const time = formatTime(e.capturedAt);
      const parts: string[] = [];
      if (e.appName) parts.push(e.appName);
      if (e.windowTitle) parts.push(`"${e.windowTitle}"`);
      if (e.axRole || e.axTitle) {
        const ax = [e.axRole, e.axTitle].filter(Boolean).join("/");
        parts.push(`AX ${ax}`);
      }
      if (e.cursorRegion !== "unknown") parts.push(`cursor ${e.cursorRegion}`);
      if (e.hasScreenshot) parts.push("screenshot(meta)");
      if (e.warnings.length > 0) parts.push(`warnings=${e.warnings.length}`);
      lines.push(`- ${time}: ${parts.length > 0 ? parts.join(" · ") : "(empty frame)"}`);
    }
    return lines.join("\n");
  }

  /**
   * Drop entries older than retentionMs and enforce maxEntries.
   * Also expires screenshot metadata flags past screenshotTtlMs.
   * @returns number of entries removed
   */
  prune(now: Date = new Date()): number {
    const before = this.entries.length;
    const cutoff = now.getTime() - this.retentionMs;

    this.entries = this.entries.filter((entry) => {
      const ts = Date.parse(entry.capturedAt);
      if (!Number.isFinite(ts)) return false;
      return ts >= cutoff;
    });

    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(this.entries.length - this.maxEntries);
    }

    for (const entry of this.entries) {
      expireScreenshotMetadata(entry, now);
    }

    return before - this.entries.length;
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }

  listAll(): ContextTrailEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }
}

function matchesQuery(entry: ContextTrailEntry, needle: string): boolean {
  const haystacks: Array<string | null> = [
    entry.appName,
    entry.bundleId,
    entry.windowTitle,
    entry.windowOwner,
    entry.axRole,
    entry.axTitle,
    entry.axValuePreview,
    entry.cursorRegion,
    ...entry.warnings,
  ];
  return haystacks.some((h) => h != null && h.toLowerCase().includes(needle));
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(11, 19);
}
