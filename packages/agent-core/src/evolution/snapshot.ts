import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SnapshotMeta } from "./types.js";

/**
 * Snapshot mutable agent state before any self-modification.
 * Penguin rule: if snapshot fails, stop before changing state.
 */
export async function createSnapshot(options: {
  stateDir: string;
  snapshotsDir: string;
  version: number;
  relativePaths: string[];
}): Promise<SnapshotMeta> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const dir = path.join(options.snapshotsDir, `v${options.version}-${id.slice(0, 8)}`);
  await fs.mkdir(dir, { recursive: true });

  const saved: string[] = [];
  for (const rel of options.relativePaths) {
    const src = path.join(options.stateDir, rel);
    const dest = path.join(dir, rel);
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      saved.push(rel);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Missing file is valid (empty state); record as empty marker
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(`${dest}.__missing`, "", "utf8");
        saved.push(`${rel}.__missing`);
        continue;
      }
      throw err;
    }
  }

  const meta: SnapshotMeta = {
    id,
    version: options.version,
    dir,
    createdAt,
    files: saved,
  };
  await fs.writeFile(
    path.join(dir, "snapshot.json"),
    JSON.stringify(meta, null, 2),
    "utf8",
  );
  return meta;
}

/** Restore state files from a snapshot (rollback). */
export async function restoreSnapshot(options: {
  stateDir: string;
  snapshot: SnapshotMeta;
  relativePaths: string[];
}): Promise<void> {
  await fs.mkdir(options.stateDir, { recursive: true });
  for (const rel of options.relativePaths) {
    const dest = path.join(options.stateDir, rel);
    const src = path.join(options.snapshot.dir, rel);
    const missing = path.join(options.snapshot.dir, `${rel}.__missing`);
    try {
      await fs.access(missing);
      // Was missing at snapshot time → delete current if exists
      try {
        await fs.unlink(dest);
      } catch {
        // ignore
      }
      continue;
    } catch {
      // not a missing marker
    }
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        try {
          await fs.unlink(dest);
        } catch {
          // ignore
        }
        continue;
      }
      throw err;
    }
  }
}
