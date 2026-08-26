import { readFile, stat } from "node:fs/promises";

export const FILE_READ_MAX_BYTES = 64 * 1024;
export const FILE_READ_MAX_LINES = 400;

export interface TextReadResult {
  text: string;
  truncated: boolean;
  size: number;
  sha256: string;
}

export async function sha256Of(buffer: Buffer): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(buffer).digest("hex");
}

export async function readWorkspaceText(input: {
  fullPath: string;
  startLine?: number;
  endLine?: number;
}): Promise<TextReadResult> {
  const info = await stat(input.fullPath);
  const raw = await readFile(input.fullPath);
  const sha256 = await sha256Of(raw);
  if (raw.includes(0)) {
    return { text: "", truncated: true, size: info.size, sha256 };
  }
  const text = raw.toString("utf8");
  const lines = text.split("\n");
  const start = Math.max(1, input.startLine ?? 1);
  const end = Math.min(lines.length, input.endLine ?? start + FILE_READ_MAX_LINES - 1);
  const slice = lines.slice(start - 1, end).join("\n");
  const truncated = slice.length > FILE_READ_MAX_BYTES || end < lines.length || start > 1;
  return {
    text: slice.slice(0, FILE_READ_MAX_BYTES),
    truncated,
    size: info.size,
    sha256,
  };
}
