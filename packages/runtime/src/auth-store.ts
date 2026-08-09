import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** The only on-disk credential location owned by this product. */
export function resolveYishuAuthPath(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, "Library", "Application Support", "Yishu", "Auth", "auth.json");
}

export const YISHU_AUTH_PATH = resolveYishuAuthPath();

/**
 * A local structural copy of pi-ai's Credential types.  Keeping this file
 * independent of pi-ai's private package exports lets the product own its
 * storage contract while still satisfying ModelRuntime's CredentialStore
 * interface.
 */
export type YishuCredential =
  | {
      type: "api_key";
      key?: string;
      env?: Record<string, string>;
    }
  | {
      type: "oauth";
      refresh: string;
      access: string;
      expires: number;
      [key: string]: unknown;
    };

export interface YishuCredentialInfo {
  providerId: string;
  type: YishuCredential["type"];
}

export interface YishuCredentialStore {
  read(providerId: string): Promise<YishuCredential | undefined>;
  list(): Promise<readonly YishuCredentialInfo[]>;
  modify(
    providerId: string,
    fn: (current: YishuCredential | undefined) => Promise<YishuCredential | undefined>,
  ): Promise<YishuCredential | undefined>;
  delete(providerId: string): Promise<void>;
}

type CredentialMap = Record<string, YishuCredential>;

const AUTH_DIRECTORY_MODE = 0o700;
const AUTH_FILE_MODE = 0o600;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_WAIT_MS = 10_000;
const DEFAULT_LOCK_HEARTBEAT_MS = 10_000;
const TEMP_FILE_NAME = /^[^/]+\.[0-9]+\.[0-9a-f-]{36}\.tmp$/iu;

export interface ProductCredentialStoreOptions {
  authPath?: string;
  /** Defaults are deliberately conservative; tests can use short values. */
  lockStaleMs?: number;
  lockWaitMs?: number;
  lockHeartbeatMs?: number;
}

interface FileLockOptions {
  staleMs: number;
  waitMs: number;
  heartbeatMs: number;
}

interface LockMetadata {
  ownerId: string;
  pid: number;
  acquiredAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCredentialMap(content: string | undefined): CredentialMap {
  if (!content?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Auth storage is invalid.");
  }
  if (!isRecord(parsed)) throw new Error("Auth storage is invalid.");

  const result: CredentialMap = {};
  for (const [providerId, value] of Object.entries(parsed)) {
    if (!isRecord(value) || (value.type !== "oauth" && value.type !== "api_key")) {
      throw new Error("Auth storage is invalid.");
    }
    // Preserve Pi's OAuth extension fields (for example account metadata) but
    // reject obviously malformed credentials before they reach ModelRuntime.
    if (value.type === "oauth") {
      if (typeof value.access !== "string" || typeof value.refresh !== "string" || typeof value.expires !== "number") {
        throw new Error("Auth storage is invalid.");
      }
      result[providerId] = value as unknown as YishuCredential;
      continue;
    }
    if (value.key !== undefined && typeof value.key !== "string") {
      throw new Error("Auth storage is invalid.");
    }
    if (value.env !== undefined && (!isRecord(value.env) || Object.values(value.env).some((entry) => typeof entry !== "string"))) {
      throw new Error("Auth storage is invalid.");
    }
    result[providerId] = value as unknown as YishuCredential;
  }
  return result;
}

function serializeCredentialMap(data: CredentialMap): string {
  return JSON.stringify(data, null, 2);
}

async function ensureSecureDirectory(filePath: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: AUTH_DIRECTORY_MODE });
  // mkdir's mode is affected by umask and does not repair an existing path.
  await chmod(directory, AUTH_DIRECTORY_MODE);
}

async function readCredentialMap(filePath: string): Promise<CredentialMap> {
  try {
    const content = await readFile(filePath, "utf8");
    return parseCredentialMap(content);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeCredentialMap(filePath: string, data: CredentialMap): Promise<void> {
  await ensureSecureDirectory(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, serializeCredentialMap(data), { encoding: "utf8", mode: AUTH_FILE_MODE });
    await chmod(temporaryPath, AUTH_FILE_MODE);
    await rename(temporaryPath, filePath);
    await chmod(filePath, AUTH_FILE_MODE);
  } finally {
    if (existsSync(temporaryPath)) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

async function readLockMetadata(lockPath: string): Promise<LockMetadata | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (!isRecord(parsed)) return undefined;
    if (typeof parsed.ownerId !== "string" || !parsed.ownerId || typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) {
      return undefined;
    }
    return {
      ownerId: parsed.ownerId,
      pid: parsed.pid,
      acquiredAt: typeof parsed.acquiredAt === "number" ? parsed.acquiredAt : 0,
    };
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

/** Remove only old auth basename temp files, never arbitrary directory files. */
async function cleanupStaleTemporaryFiles(filePath: string, staleMs: number): Promise<void> {
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(`${basename}.`) || !entry.name.endsWith(".tmp") || !TEMP_FILE_NAME.test(entry.name)) {
      continue;
    }
    const temporaryPath = path.join(directory, entry.name);
    try {
      const temporaryStat = await stat(temporaryPath);
      if ((temporaryStat.mode & 0o777) !== AUTH_FILE_MODE) continue;
      if (Date.now() - temporaryStat.mtimeMs <= staleMs) continue;
      await rm(temporaryPath, { force: true });
    } catch {
      // Another process may have cleaned it; do not expose its path/content.
    }
  }
}

type LockRelease = () => Promise<void>;

/**
 * Small cross-process lock matching the semantics needed by ModelRuntime's
 * read-modify-write OAuth refresh path.  The lock file contains no credential
 * data and is removed in a finally block.
 */
async function acquireFileLock(filePath: string, options: FileLockOptions): Promise<LockRelease> {
  await ensureSecureDirectory(filePath);
  const lockPath = `${filePath}.lock`;
  const startedAt = Date.now();

  while (true) {
    try {
      const handle = await open(lockPath, "wx", AUTH_FILE_MODE);
      const metadata: LockMetadata = {
        ownerId: randomUUID(),
        pid: process.pid,
        acquiredAt: Date.now(),
      };
      await handle.writeFile(JSON.stringify(metadata), "utf8");
      await handle.close();
      await chmod(lockPath, AUTH_FILE_MODE);
      let released = false;
      const heartbeat = setInterval(() => {
        if (released) return;
        void (async () => {
          try {
            const current = await readLockMetadata(lockPath);
            if (current?.ownerId !== metadata.ownerId) {
              clearInterval(heartbeat);
              return;
            }
            const now = new Date();
            await utimes(lockPath, now, now);
          } catch {
            clearInterval(heartbeat);
          }
        })();
      }, options.heartbeatMs);
      heartbeat.unref?.();
      return async () => {
        released = true;
        clearInterval(heartbeat);
        const current = await readLockMetadata(lockPath);
        if (current?.ownerId === metadata.ownerId) {
          await rm(lockPath, { force: true });
        }
      };
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
      if (code !== "EEXIST") throw error;

      // A crashed process must not strand the store forever.  Only reclaim a
      // lock that is older than the stale threshold; active locks are waited
      // on for a bounded period so a hung auth refresh fails safely.
      try {
        const lockStat = await stat(lockPath);
        const metadata = await readLockMetadata(lockPath);
        const stale = Date.now() - lockStat.mtimeMs > options.staleMs;
        // A live owner is never reclaimed solely because a refresh is slow;
        // heartbeat normally keeps mtime fresh, and PID validation is the
        // final guard against deleting an active lock.
        if (stale && (!metadata || !isProcessAlive(metadata.pid))) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        // The owner may have released the lock between EEXIST and stat.
      }

      if (Date.now() - startedAt >= options.waitMs) {
        throw new Error("Auth storage is busy.");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
}

/**
 * Product CredentialStore backed by Yishu/Auth/auth.json.  It is lazy: merely
 * constructing the runtime does not create an auth file; the first write
 * creates the 0700 directory and 0600 file.
 */
export class ProductCredentialStore implements YishuCredentialStore {
  readonly authPath: string;
  private readonly lockOptions: FileLockOptions;

  constructor(authPathOrOptions: string | ProductCredentialStoreOptions = YISHU_AUTH_PATH) {
    const options = typeof authPathOrOptions === "string" ? { authPath: authPathOrOptions } : authPathOrOptions;
    this.authPath = options.authPath ?? YISHU_AUTH_PATH;
    const staleMs = Math.max(10, options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS);
    this.lockOptions = {
      staleMs,
      waitMs: Math.max(10, options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS),
      heartbeatMs: Math.max(5, Math.min(options.lockHeartbeatMs ?? DEFAULT_LOCK_HEARTBEAT_MS, Math.floor(staleMs / 2))),
    };
  }

  private async hardenExistingPath(): Promise<void> {
    if (!existsSync(this.authPath)) return;
    await chmod(path.dirname(this.authPath), AUTH_DIRECTORY_MODE);
    await chmod(this.authPath, AUTH_FILE_MODE);
  }

  async read(providerId: string): Promise<YishuCredential | undefined> {
    await this.hardenExistingPath();
    const data = await readCredentialMap(this.authPath);
    return data[providerId];
  }

  async list(): Promise<readonly YishuCredentialInfo[]> {
    await this.hardenExistingPath();
    const data = await readCredentialMap(this.authPath);
    return Object.entries(data).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: YishuCredential | undefined) => Promise<YishuCredential | undefined>,
  ): Promise<YishuCredential | undefined> {
    const release = await acquireFileLock(this.authPath, this.lockOptions);
    try {
      await cleanupStaleTemporaryFiles(this.authPath, this.lockOptions.staleMs);
      const data = await readCredentialMap(this.authPath);
      const next = await fn(data[providerId]);
      if (next === undefined) return data[providerId];
      data[providerId] = next;
      await writeCredentialMap(this.authPath, data);
      return next;
    } finally {
      await release();
    }
  }

  async delete(providerId: string): Promise<void> {
    const release = await acquireFileLock(this.authPath, this.lockOptions);
    try {
      await cleanupStaleTemporaryFiles(this.authPath, this.lockOptions.staleMs);
      const data = await readCredentialMap(this.authPath);
      delete data[providerId];
      await writeCredentialMap(this.authPath, data);
    } finally {
      await release();
    }
  }
}

/** In-memory implementation for tests; it never touches user auth paths. */
export class InMemoryCredentialStore implements YishuCredentialStore {
  private data: CredentialMap;
  private operation: Promise<void> = Promise.resolve();

  constructor(initial: CredentialMap = {}) {
    this.data = structuredClone(initial);
  }

  async read(providerId: string): Promise<YishuCredential | undefined> {
    return this.data[providerId];
  }

  async list(): Promise<readonly YishuCredentialInfo[]> {
    return Object.entries(this.data).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: YishuCredential | undefined) => Promise<YishuCredential | undefined>,
  ): Promise<YishuCredential | undefined> {
    let result: YishuCredential | undefined;
    const operation = this.operation.then(async () => {
      const next = await fn(this.data[providerId]);
      if (next !== undefined) this.data[providerId] = next;
      result = next ?? this.data[providerId];
    });
    this.operation = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async delete(providerId: string): Promise<void> {
    const operation = this.operation.then(() => {
      delete this.data[providerId];
    });
    this.operation = operation.catch(() => undefined);
    await operation;
  }
}

export function createYishuCredentialStore(options?: ProductCredentialStoreOptions): ProductCredentialStore {
  return new ProductCredentialStore(options ?? YISHU_AUTH_PATH);
}
