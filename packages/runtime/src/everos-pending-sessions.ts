import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface EverOSPendingSession {
  readonly sessionId: string;
  readonly scopeKey: string;
}

export interface EverOSPendingSessionStore {
  list(): Promise<readonly EverOSPendingSession[]>;
  add(input: EverOSPendingSession): Promise<void>;
  remove(input: EverOSPendingSession): Promise<void>;
}

interface PendingState {
  readonly version: 1;
  readonly sessions: readonly EverOSPendingSession[];
}

function pendingKey(input: EverOSPendingSession): string {
  return `${input.scopeKey}\u0000${input.sessionId}`;
}

function validPart(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

/** Content-free crash recovery for EverOS buffers: IDs and scopes only. */
export class FileEverOSPendingSessionStore implements EverOSPendingSessionStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {}

  list(): Promise<readonly EverOSPendingSession[]> {
    return this.serial(async () => this.read());
  }

  add(input: EverOSPendingSession): Promise<void> {
    return this.serial(async () => {
      const current = await this.read();
      if (current.some((row) => pendingKey(row) === pendingKey(input))) return;
      await this.write([...current, input]);
    });
  }

  remove(input: EverOSPendingSession): Promise<void> {
    return this.serial(async () => {
      const current = await this.read();
      const next = current.filter((row) => pendingKey(row) !== pendingKey(input));
      if (next.length === current.length) return;
      await this.write(next);
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async read(): Promise<EverOSPendingSession[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let raw: Partial<PendingState>;
    try {
      raw = JSON.parse(text) as Partial<PendingState>;
    } catch {
      throw new Error("everos_pending_sessions_invalid");
    }
    if (raw.version !== 1 || !Array.isArray(raw.sessions)) {
      throw new Error("everos_pending_sessions_invalid");
    }
    const rows: EverOSPendingSession[] = [];
    for (const value of raw.sessions) {
      if (
        typeof value !== "object"
        || value === null
        || !validPart((value as { sessionId?: unknown }).sessionId)
        || !validPart((value as { scopeKey?: unknown }).scopeKey)
      ) {
        throw new Error("everos_pending_sessions_invalid");
      }
      rows.push({
        sessionId: (value as { sessionId: string }).sessionId,
        scopeKey: (value as { scopeKey: string }).scopeKey,
      });
    }
    return rows;
  }

  private async write(sessions: readonly EverOSPendingSession[]): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    const state: PendingState = {
      version: 1,
      sessions: [...sessions].sort((left, right) =>
        pendingKey(left).localeCompare(pendingKey(right))),
    };
    try {
      await writeFile(temporary, `${JSON.stringify(state)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
