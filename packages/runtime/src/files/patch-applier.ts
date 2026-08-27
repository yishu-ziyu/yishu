import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256Of } from "./text-reader.js";

export class StalePatchError extends Error {
  readonly code = "STALE_PATCH" as const;

  constructor(message: string) {
    super(message);
    this.name = "StalePatchError";
  }
}

export interface AppliedPatch {
  beforeSha256: string;
  afterSha256: string;
  changedLineCount: number;
  unifiedDiff: string;
}

function applyUnifiedDiff(original: string, patch: string): string {
  if (!patch.includes("@@")) {
    throw new Error("Patch must be a unified diff.");
  }
  const originalLines = original.split("\n");
  const result: string[] = [];
  let cursor = 0;
  const hunks = patch.split(/^@@ /m).slice(1);
  if (hunks.length === 0) throw new Error("Patch contains no hunks.");
  for (const hunk of hunks) {
    const headerEnd = hunk.indexOf("@@");
    const header = headerEnd >= 0 ? hunk.slice(0, headerEnd) : hunk;
    const body = headerEnd >= 0 ? hunk.slice(headerEnd + 2) : "";
    const match = /^-(\d+)/.exec(header.replaceAll(" ", ""));
    const start = match ? Number(match[1]) - 1 : cursor;
    while (cursor < start && cursor < originalLines.length) {
      result.push(originalLines[cursor]!);
      cursor += 1;
    }
    for (const line of body.split("\n")) {
      if (line.length === 0) continue;
      const marker = line[0];
      const content = line.slice(1);
      if (marker === " ") {
        if (originalLines[cursor] !== content) {
          throw new StalePatchError("Patch context does not match the current file.");
        }
        result.push(content);
        cursor += 1;
      } else if (marker === "-") {
        if (originalLines[cursor] !== content) {
          throw new StalePatchError("Patch deletion does not match the current file.");
        }
        cursor += 1;
      } else if (marker === "+") {
        result.push(content);
      }
    }
  }
  while (cursor < originalLines.length) {
    result.push(originalLines[cursor]!);
    cursor += 1;
  }
  return result.join("\n");
}

export async function applyPatchAtomically(input: {
  fullPath: string;
  baseSha256: string;
  patch: string;
}): Promise<AppliedPatch> {
  const before = await readFile(input.fullPath);
  const beforeSha256 = await sha256Of(before);
  if (beforeSha256 !== input.baseSha256) {
    throw new StalePatchError("File changed since it was read.");
  }
  const next = applyUnifiedDiff(before.toString("utf8"), input.patch);
  const afterBuffer = Buffer.from(next, "utf8");
  const afterSha256 = await sha256Of(afterBuffer);
  const temp = `${input.fullPath}.${process.pid}.tmp`;
  await writeFile(temp, afterBuffer);
  await rename(temp, input.fullPath);
  const changedLineCount = input.patch.split("\n").filter((line) => line.startsWith("+") || line.startsWith("-")).length;
  return {
    beforeSha256,
    afterSha256,
    changedLineCount,
    unifiedDiff: input.patch,
  };
}

export async function writeTextAtomically(fullPath: string, content: string): Promise<string> {
  const directory = path.dirname(fullPath);
  const temp = path.join(directory, `.${path.basename(fullPath)}.${process.pid}.tmp`);
  const buffer = Buffer.from(content, "utf8");
  await writeFile(temp, buffer);
  await rename(temp, fullPath);
  return sha256Of(buffer);
}
