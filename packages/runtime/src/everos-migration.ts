import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  DEFAULT_EVEROS_IDENTITY,
  assertValidEverOSIdentity,
  type EverOSIdentity,
} from "@yishu/kernel";

export function shouldMigrateLegacyEverOS(env: NodeJS.ProcessEnv): boolean {
  if (env.YISHU_EVEROS_MIGRATE_LEGACY === "0") return false;
  if (env.YISHU_EVEROS_MIGRATE_LEGACY === "1") return true;
  return !env.YISHU_EVEROS_ROOT?.trim() && !env.EVEROS_ROOT?.trim();
}

async function directoryExists(filePath: string): Promise<boolean> {
  try {
    await readdir(filePath);
    return true;
  } catch {
    return false;
  }
}

async function markdownFiles(root: string, relative = ""): Promise<string[]> {
  const current = path.join(root, relative);
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...await markdownFiles(root, child));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(child);
    }
  }
  return files;
}

export async function migrateLegacyEverOSUserMemory(input: {
  readonly sourceUserRoot: string;
  readonly destinationRoot: string;
  readonly destinationIdentity?: EverOSIdentity;
  readonly markerPath?: string;
}): Promise<number> {
  const sourceUserRoot = safeMigrationRoot(input.sourceUserRoot);
  const destinationRoot = safeMigrationRoot(input.destinationRoot);
  const identity = input.destinationIdentity ?? DEFAULT_EVEROS_IDENTITY;
  assertValidEverOSIdentity(identity);
  if (input.markerPath && existsSync(input.markerPath)) return 0;
  const destinationUserRoot = path.join(
    destinationRoot,
    identity.appId,
    identity.personalProjectId,
    "users",
    identity.userId,
  );
  if (await directoryExists(destinationUserRoot)) {
    await writeMigrationMarker(input.markerPath);
    return 0;
  }
  const files = await markdownFiles(sourceUserRoot);
  if (files.length === 0) return 0;

  const parent = path.dirname(destinationUserRoot);
  const staging = path.join(parent, `.owner-migration-${randomUUID()}`);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    for (const relative of files) {
      const destination = path.join(staging, relative);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const source = await readFile(path.join(sourceUserRoot, relative), "utf8");
      const migrated = source.replace(
        /^user_id:\s*[^\r\n]+$/gmu,
        `user_id: ${identity.userId}`,
      );
      await writeFile(destination, migrated, { encoding: "utf8", mode: 0o600 });
    }
    await rename(staging, destinationUserRoot);
    await writeMigrationMarker(input.markerPath);
    return files.length;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return 0;
    }
    throw error;
  }
}

function safeMigrationRoot(value: string): string {
  const resolved = path.resolve(value);
  const home = path.resolve(homedir());
  if (
    resolved === path.parse(resolved).root
    || resolved === home
    || resolved === path.dirname(home)
    || resolved === path.resolve(process.cwd())
  ) {
    throw new Error("everos_migration_root_too_broad");
  }
  return resolved;
}

async function writeMigrationMarker(markerPath: string | undefined): Promise<void> {
  if (!markerPath) return;
  const directory = path.dirname(markerPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(markerPath, "everos-legacy-user-v1\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(markerPath, 0o600);
}
