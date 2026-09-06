/**
 * Narrow completion receipts for user-confirmed forget.
 *
 * A receipt proves a prior forget finished for this id+scope. It never
 * stores claim plaintext. Only forgetMemoryClaim reads or writes these.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const FORGET_RECEIPT_FILE_NAME = ".yishu-forget-receipts.json";

const FINGERPRINT = /^[a-f0-9]{64}$/u;
const pathLocks = new Map<string, Promise<unknown>>();

export interface MemoryForgetReceipt {
  readonly id: string;
  readonly scope: string;
  readonly visibleFingerprint?: string;
  readonly truthFactId?: string;
}

interface ReceiptFile {
  readonly version: 1;
  readonly receipts: readonly MemoryForgetReceipt[];
}

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

function receiptFilePath(directory: string): string {
  return path.join(directory, FORGET_RECEIPT_FILE_NAME);
}

function asReceipt(value: unknown): MemoryForgetReceipt | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const row = value as {
    id?: unknown;
    scope?: unknown;
    visibleFingerprint?: unknown;
    truthFactId?: unknown;
  };
  if (typeof row.id !== "string" || row.id.length === 0) return undefined;
  if (typeof row.scope !== "string" || row.scope.trim().length === 0) return undefined;
  const receipt: MemoryForgetReceipt = {
    id: row.id,
    scope: row.scope.trim(),
  };
  if (typeof row.visibleFingerprint === "string") {
    if (!FINGERPRINT.test(row.visibleFingerprint)) return undefined;
    return {
      ...receipt,
      visibleFingerprint: row.visibleFingerprint,
      ...(typeof row.truthFactId === "string" && row.truthFactId.length > 0
        ? { truthFactId: row.truthFactId }
        : {}),
    };
  }
  if (typeof row.truthFactId === "string" && row.truthFactId.length > 0) {
    return { ...receipt, truthFactId: row.truthFactId };
  }
  return receipt;
}

async function readReceiptFile(filePath: string): Promise<MemoryForgetReceipt[]> {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as {
      receipts?: unknown;
    };
    if (!Array.isArray(raw.receipts)) return [];
    const receipts: MemoryForgetReceipt[] = [];
    for (const item of raw.receipts) {
      const parsed = asReceipt(item);
      if (parsed !== undefined) receipts.push(parsed);
    }
    return receipts;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

export async function readForgetReceipt(
  directory: string,
  id: string,
): Promise<MemoryForgetReceipt | undefined> {
  const filePath = receiptFilePath(directory);
  return withPathLock(filePath, async () => {
    const receipts = await readReceiptFile(filePath);
    return receipts.find((row) => row.id === id);
  });
}

export async function writeForgetReceipt(
  directory: string,
  receipt: MemoryForgetReceipt,
): Promise<void> {
  const filePath = receiptFilePath(directory);
  await withPathLock(filePath, async () => {
    const existing = await readReceiptFile(filePath);
    const next = existing.filter((row) => row.id !== receipt.id);
    next.push(receipt);
    next.sort((left, right) => left.id.localeCompare(right.id));
    const body: ReceiptFile = { version: 1, receipts: next };
    await mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(body)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, filePath);
  });
}
