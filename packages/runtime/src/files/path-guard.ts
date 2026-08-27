import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

export class WorkspacePathError extends Error {
  readonly code = "WORKSPACE_PATH_ESCAPE" as const;

  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

function normalizeRoot(rootPath: string): string {
  return path.resolve(rootPath);
}

export function joinWorkspacePath(rootPath: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new WorkspacePathError("Workspace paths must be relative to the granted root.");
  }
  const root = normalizeRoot(rootPath);
  const joined = path.resolve(root, relativePath);
  const relative = path.relative(root, joined);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkspacePathError("Path escapes the granted workspace.");
  }
  return joined;
}

export async function assertPathInsideWorkspace(
  rootPath: string,
  relativePath: string,
): Promise<string> {
  const candidate = joinWorkspacePath(rootPath, relativePath);
  const rootReal = await realpath(normalizeRoot(rootPath));
  let targetReal: string;
  try {
    targetReal = await realpath(candidate);
  } catch {
    const parent = path.dirname(candidate);
    const parentReal = await realpath(parent).catch(() => parent);
    targetReal = path.join(parentReal, path.basename(candidate));
  }
  const relative = path.relative(rootReal, targetReal);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkspacePathError("Resolved path escapes the granted workspace.");
  }
  return targetReal;
}

const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "id_rsa",
  "id_ed25519",
  "credentials.json",
  ".npmrc",
  ".netrc",
  "git-credentials",
]);

const SENSITIVE_SUFFIXES = [
  ".pem",
  ".p12",
  ".key",
];

export function isSensitiveWorkspacePath(relativePath: string): boolean {
  const base = path.basename(relativePath).toLowerCase();
  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (base.includes("keychain")) return true;
  if (relativePath.split(path.sep).some((part) => part === ".git" && base === "config")) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

export async function pathIsSymlink(fullPath: string): Promise<boolean> {
  try {
    const info = await lstat(fullPath);
    return info.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function pathExists(fullPath: string): Promise<boolean> {
  try {
    await stat(fullPath);
    return true;
  } catch {
    return false;
  }
}
