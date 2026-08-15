/**
 * Memory extraction queue (ADR 0013 #5, ADR 0016 #3).
 *
 * Turn-terminal snapshots are enqueued fire-and-forget and consumed by an
 * async worker. SQLite is the production backend (crash replay by startup
 * scan); JSON keeps the dev fallback durable; memory backend is for tests.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtractionSnapshot } from "./extraction.js";

export type ExtractionStatus = "pending" | "done" | "skipped_model" | "failed";

export interface ExtractionQueueRow {
  readonly turnId: string;
  readonly payload: ExtractionSnapshot;
  readonly status: ExtractionStatus;
  readonly attempts: number;
  readonly lastError?: string;
  readonly updatedAt: string;
}

export interface ExtractionQueuePort {
  /** Idempotent per turnId; a repeat enqueue is a no-op. */
  enqueue(snapshot: ExtractionSnapshot): Promise<void>;
  /** Rows eligible for (re)processing: pending plus failed replay rows. */
  listReplayable(): Promise<ExtractionQueueRow[]>;
  markDone(turnId: string, status: "done" | "skipped_model"): Promise<void>;
  markFailed(turnId: string, error: string, now: string): Promise<void>;
  /** Bump attempts and re-arm for the next retry/replay cycle. */
  requeue(turnId: string, now: string): Promise<void>;
  getRow(turnId: string): Promise<ExtractionQueueRow | null>;
  close?(): void;
}

export const EXTRACTION_MAX_ATTEMPTS = 3;

function rowFromJson(value: unknown): ExtractionQueueRow | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.turnId !== "string" || typeof record.payload !== "object") {
    return null;
  }
  const status = record.status;
  if (
    status !== "pending" && status !== "done"
    && status !== "skipped_model" && status !== "failed"
  ) {
    return null;
  }
  const row: ExtractionQueueRow = {
    turnId: record.turnId,
    payload: record.payload as ExtractionSnapshot,
    status,
    attempts: typeof record.attempts === "number" ? record.attempts : 0,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
    ...(typeof record.lastError === "string" ? { lastError: record.lastError } : {}),
  };
  return row;
}

export class InMemoryExtractionQueue implements ExtractionQueuePort {
  private readonly rows = new Map<string, ExtractionQueueRow>();

  async enqueue(snapshot: ExtractionSnapshot): Promise<void> {
    if (this.rows.has(snapshot.turnId)) return;
    this.rows.set(snapshot.turnId, {
      turnId: snapshot.turnId,
      payload: snapshot,
      status: "pending",
      attempts: 0,
      updatedAt: snapshot.capturedAt,
    });
  }

  async listReplayable(): Promise<ExtractionQueueRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.status === "pending" || row.status === "failed")
      .map((row) => ({ ...row }));
  }

  async markDone(turnId: string, status: "done" | "skipped_model"): Promise<void> {
    const row = this.rows.get(turnId);
    if (!row) return;
    this.rows.set(turnId, { ...row, status, attempts: row.attempts + 1, updatedAt: new Date().toISOString() });
  }

  async markFailed(turnId: string, error: string, now: string): Promise<void> {
    const row = this.rows.get(turnId);
    if (!row) return;
    this.rows.set(turnId, {
      ...row,
      status: "failed",
      attempts: row.attempts + 1,
      lastError: error.slice(0, 200),
      updatedAt: now,
    });
  }

  async requeue(turnId: string, now: string): Promise<void> {
    const row = this.rows.get(turnId);
    if (!row) return;
    this.rows.set(turnId, { ...row, status: "pending", updatedAt: now });
  }

  async getRow(turnId: string): Promise<ExtractionQueueRow | null> {
    const row = this.rows.get(turnId);
    return row ? { ...row } : null;
  }
}

export class JsonExtractionQueue implements ExtractionQueuePort {
  private readonly filePath: string;
  private readonly memory = new InMemoryExtractionQueue();
  private loaded = false;

  constructor(dir: string) {
    this.filePath = path.join(dir, "extraction-queue.json");
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const item of parsed) {
        const row = rowFromJson(item);
        if (!row) continue;
        await this.memory.enqueue(row.payload);
        if (row.status !== "pending") {
          if (row.status === "done" || row.status === "skipped_model") {
            await this.memory.markDone(row.turnId, row.status);
          } else {
            await this.memory.markFailed(row.turnId, row.lastError ?? "", row.updatedAt);
          }
        }
      }
    } catch {
      // Missing or corrupt file starts an empty queue.
    }
  }

  private async persist(): Promise<void> {
    const rows: ExtractionQueueRow[] = [];
    // InMemory queue only exposes replayable rows; snapshot via getRow is
    // impractical, so persist replayable plus track terminal ids separately.
    for (const row of await this.memory.listReplayable()) rows.push(row);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(rows, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }

  async enqueue(snapshot: ExtractionSnapshot): Promise<void> {
    await this.load();
    await this.memory.enqueue(snapshot);
    await this.persist();
  }

  async listReplayable(): Promise<ExtractionQueueRow[]> {
    await this.load();
    return this.memory.listReplayable();
  }

  async markDone(turnId: string, status: "done" | "skipped_model"): Promise<void> {
    await this.load();
    await this.memory.markDone(turnId, status);
    await this.persist();
  }

  async markFailed(turnId: string, error: string, now: string): Promise<void> {
    await this.load();
    await this.memory.markFailed(turnId, error, now);
    await this.persist();
  }

  async requeue(turnId: string, now: string): Promise<void> {
    await this.load();
    await this.memory.requeue(turnId, now);
    await this.persist();
  }

  async getRow(turnId: string): Promise<ExtractionQueueRow | null> {
    await this.load();
    return this.memory.getRow(turnId);
  }
}

export class SqliteExtractionQueue implements ExtractionQueuePort {
  private readonly db: DatabaseSync;

  constructor(sqlitePath: string) {
    mkdirSyncRecursive(sqlitePath);
    this.db = new DatabaseSync(sqlitePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS extraction_queue (
        turn_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'done', 'skipped_model', 'failed')
        ),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private rowFromDb(row: Record<string, unknown> | undefined): ExtractionQueueRow | null {
    if (row === undefined) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(String(row.payload_json));
    } catch {
      return null;
    }
    const queueRow: ExtractionQueueRow = {
      turnId: String(row.turn_id),
      payload: payload as ExtractionSnapshot,
      status: String(row.status) as ExtractionStatus,
      attempts: Number(row.attempts ?? 0),
      updatedAt: String(row.updated_at ?? ""),
      ...(typeof row.last_error === "string" ? { lastError: row.last_error } : {}),
    };
    return queueRow;
  }

  async enqueue(snapshot: ExtractionSnapshot): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO extraction_queue (
          turn_id, payload_json, status, attempts, updated_at
        ) VALUES (?, ?, 'pending', 0, ?)
        ON CONFLICT(turn_id) DO NOTHING`,
      )
      .run(snapshot.turnId, JSON.stringify(snapshot), snapshot.capturedAt);
  }

  async listReplayable(): Promise<ExtractionQueueRow[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM extraction_queue
         WHERE status IN ('pending', 'failed')
         ORDER BY updated_at ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows
      .map((row) => this.rowFromDb(row))
      .filter((row): row is ExtractionQueueRow => row !== null);
  }

  async markDone(turnId: string, status: "done" | "skipped_model"): Promise<void> {
    this.db
      .prepare(
        `UPDATE extraction_queue
         SET status = ?, attempts = attempts + 1, last_error = NULL, updated_at = ?
         WHERE turn_id = ?`,
      )
      .run(status, new Date().toISOString(), turnId);
  }

  async markFailed(turnId: string, error: string, now: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE extraction_queue
         SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ?
         WHERE turn_id = ?`,
      )
      .run(error.slice(0, 200), now, turnId);
  }

  async requeue(turnId: string, now: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE extraction_queue SET status = 'pending', updated_at = ? WHERE turn_id = ?`,
      )
      .run(now, turnId);
  }

  async getRow(turnId: string): Promise<ExtractionQueueRow | null> {
    const row = this.db
      .prepare(`SELECT * FROM extraction_queue WHERE turn_id = ?`)
      .get(turnId) as Record<string, unknown> | undefined;
    return this.rowFromDb(row);
  }
}

function mkdirSyncRecursive(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
}
