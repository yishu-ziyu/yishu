import { Type } from "typebox";
import { copyFile, mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionScope } from "@yishu/kernel";
import { grantIsActive, requireActiveGrant, type WorkspaceLedger } from "@yishu/kernel";
import type { ToolDefinition } from "../model-loop/types.js";
import { evaluateFileOp, type FileOp } from "./file-policy.js";
import { applyPatchAtomically, StalePatchError, writeTextAtomically } from "./patch-applier.js";
import { assertPathInsideWorkspace, isSensitiveWorkspacePath, joinWorkspacePath } from "./path-guard.js";
import { readWorkspaceText } from "./text-reader.js";
import type { FileReceipt } from "./file-receipt.js";

const fileParameters = Type.Union([
  Type.Object({ op: Type.Literal("list_workspaces") }),
  Type.Object({ op: Type.Literal("list"), workspaceId: Type.String(), path: Type.String(), depth: Type.Optional(Type.Number()) }),
  Type.Object({ op: Type.Literal("stat"), workspaceId: Type.String(), path: Type.String() }),
  Type.Object({ op: Type.Literal("search"), workspaceId: Type.String(), query: Type.String(), glob: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
  Type.Object({ op: Type.Literal("read_text"), workspaceId: Type.String(), path: Type.String(), startLine: Type.Optional(Type.Number()), endLine: Type.Optional(Type.Number()) }),
  Type.Object({ op: Type.Literal("create_text"), workspaceId: Type.String(), path: Type.String(), content: Type.String() }),
  Type.Object({ op: Type.Literal("apply_patch"), workspaceId: Type.String(), path: Type.String(), baseSha256: Type.String(), patch: Type.String() }),
  Type.Object({ op: Type.Literal("mkdir"), workspaceId: Type.String(), path: Type.String() }),
  Type.Object({ op: Type.Literal("copy"), workspaceId: Type.String(), from: Type.String(), to: Type.String() }),
  Type.Object({ op: Type.Literal("move"), workspaceId: Type.String(), from: Type.String(), to: Type.String() }),
  Type.Object({ op: Type.Literal("trash"), workspaceId: Type.String(), path: Type.String() }),
  Type.Object({ op: Type.Literal("restore_from_trash"), receiptId: Type.String() }),
  Type.Object({ op: Type.Literal("open_in_app"), workspaceId: Type.String(), path: Type.String(), bundleId: Type.Optional(Type.String()) }),
]);

export interface FileToolContext {
  ledger: WorkspaceLedger;
  resolveRoot: (reference: string) => string;
  scope: SessionScope;
  now?: () => Date;
  approved?: boolean | ((op: FileOp, workspaceId: string) => boolean);
  trashDir?: string;
  /** Delegated child sessions are read-only even when the grant includes writes. */
  writeAccess?: boolean;
}

export function createFileTool(context: FileToolContext): ToolDefinition {
  const trash = new Map<string, { from: string; to: string }>();
  return {
    name: "files",
    label: "Workspace files",
    description: "Read and edit files inside a user-granted workspace. Call list_workspaces to discover workspaceId values. Never accept raw absolute paths as a new grant.",
    promptSnippet: "Use files only inside an authorized workspaceId from list_workspaces.",
    promptGuidelines: [
      "Call list_workspaces before other file ops if you do not already have a workspaceId.",
      "Do not guess absolute paths.",
      "apply_patch must reuse the sha256 from the last read.",
      "trash is recoverable and may need the user to allow it in 设置.",
    ],
    parameters: fileParameters,
    executionMode: "sequential",
    async execute(_id, params) {
      const receipt = await performFileOp(context, params as FileOpPayload, trash);
      if (receipt.status === "denied" || receipt.status === "failed" || receipt.status === "blocked" || receipt.status === "stale") {
        throw new Error(receipt.message);
      }
      return {
        content: [{ type: "text", text: receipt.message }],
        details: receipt,
      };
    },
  };
}

type FileOpPayload = {
  op: FileOp;
  workspaceId?: string;
  path?: string;
  from?: string;
  to?: string;
  content?: string;
  baseSha256?: string;
  patch?: string;
  receiptId?: string;
  query?: string;
  glob?: string;
  depth?: number;
  startLine?: number;
  endLine?: number;
};

async function performFileOp(
  context: FileToolContext,
  params: FileOpPayload,
  trash: Map<string, { from: string; to: string }>,
): Promise<FileReceipt> {
  const now = context.now?.() ?? new Date();
  if (context.writeAccess === false && !isReadFileOp(params.op)) {
    return receipt(params.op, params.workspaceId ?? "", "denied", false, false, "Delegated child sessions are read-only for files.");
  }
  if (params.op === "list_workspaces") {
    const grants = context.ledger.list(context.scope).filter((grant) => grantIsActive(grant, now));
    if (grants.length === 0) {
      return receipt(
        "list_workspaces",
        "",
        "verified",
        false,
        true,
        "No folder workspace is granted. Ask the user to add one in 设置.",
      );
    }
    const lines = grants.map((grant) => `${grant.id} ${grant.displayName}`);
    return receipt("list_workspaces", "", "verified", false, true, lines.join("\n"));
  }
  if (params.op === "restore_from_trash") {
    const saved = params.receiptId === undefined ? undefined : trash.get(params.receiptId);
    if (saved === undefined) {
      return receipt("restore_from_trash", "", "failed", false, false, "Unknown trash receipt.");
    }
    await rename(saved.to, saved.from);
    trash.delete(params.receiptId!);
    return receipt("restore_from_trash", "", "verified", true, true, "Restored from trash.");
  }
  if (params.workspaceId === undefined) {
    return receipt(params.op, "", "failed", false, false, "workspaceId is required.");
  }
  let grant;
  try {
    grant = requireActiveGrant(context.ledger, params.workspaceId, context.scope, now);
  } catch (error) {
    return receipt(params.op, params.workspaceId, "denied", false, false, error instanceof Error ? error.message : "Grant denied.");
  }
  const decision = evaluateFileOp({
    op: params.op,
    scope: context.scope,
    capabilities: grant.capabilities,
    grantRevoked: grant.revokedAt !== undefined,
    overwriteExisting: false,
  });
  if (decision.decision === "deny") {
    return receipt(params.op, grant.id, "denied", false, false, decision.reason);
  }
  if (decision.decision === "approval_required" && !isFileOpApproved(context, params.op, grant.id)) {
    return receipt(params.op, grant.id, "needs_approval", false, false, decision.reason);
  }
  const root = context.resolveRoot(grant.rootPathReference);
  const relative = params.path ?? params.from ?? "";
  if (isSensitiveWorkspacePath(relative)) {
    return receipt(params.op, grant.id, "denied", false, false, "Sensitive files are not readable.");
  }
  try {
    if (params.op === "mkdir") {
      await mkdir(await assertPathInsideWorkspace(root, relative), { recursive: true });
      return receipt(params.op, grant.id, "verified", true, true, "Directory created.");
    }
    if (params.op === "create_text") {
      const fullPath = joinWorkspacePath(root, relative);
      await mkdir(path.dirname(fullPath), { recursive: true });
      try {
        await readFile(fullPath);
        return receipt(params.op, grant.id, "needs_approval", false, false, "Refusing to overwrite an existing file.");
      } catch {
        const after = await writeTextAtomically(fullPath, params.content ?? "");
        return { ...receipt(params.op, grant.id, "verified", true, true, "Created file."), afterSha256: after };
      }
    }
    if (params.op === "apply_patch") {
      const fullPath = await assertPathInsideWorkspace(root, relative);
      try {
        const applied = await applyPatchAtomically({
          fullPath,
          baseSha256: params.baseSha256 ?? "",
          patch: params.patch ?? "",
        });
        return {
          ...receipt(params.op, grant.id, "verified", true, true, "Patched file."),
          beforeSha256: applied.beforeSha256,
          afterSha256: applied.afterSha256,
        };
      } catch (error) {
        if (error instanceof StalePatchError) {
          return receipt(params.op, grant.id, "stale", false, false, error.message);
        }
        throw error;
      }
    }
    if (params.op === "read_text") {
      const fullPath = await assertPathInsideWorkspace(root, relative);
      const read = await readWorkspaceText({
        fullPath,
        ...(params.startLine === undefined ? {} : { startLine: params.startLine }),
        ...(params.endLine === undefined ? {} : { endLine: params.endLine }),
      });
      return {
        ...receipt(params.op, grant.id, "verified", false, true, read.text),
        afterSha256: read.sha256,
        bytes: read.size,
      };
    }
    if (params.op === "trash") {
      const fullPath = await assertPathInsideWorkspace(root, relative);
      const trashRoot = context.trashDir ?? path.join(root, ".yishu-trash");
      await mkdir(trashRoot, { recursive: true });
      const dest = path.join(trashRoot, `${randomUUID()}-${path.basename(fullPath)}`);
      await rename(fullPath, dest);
      const restoreId = randomUUID();
      trash.set(restoreId, { from: fullPath, to: dest });
      return {
        ...receipt(params.op, grant.id, "verified", true, true, "Moved to trash."),
        restoreRef: restoreId,
      };
    }
    if (params.op === "list") {
      const fullPath = await assertPathInsideWorkspace(root, relative || ".");
      const names = await listWorkspaceEntries(fullPath, params.depth ?? 1);
      return { ...receipt(params.op, grant.id, "verified", false, true, names.join("\n") || "(empty)"), bytes: names.length };
    }
    if (params.op === "stat") {
      const fullPath = await assertPathInsideWorkspace(root, relative);
      const info = await stat(fullPath);
      return {
        ...receipt(params.op, grant.id, "verified", false, true, JSON.stringify({
          size: info.size,
          directory: info.isDirectory(),
          mtime: info.mtime.toISOString(),
        })),
        bytes: info.size,
      };
    }
    if (params.op === "search") {
      const fullPath = await assertPathInsideWorkspace(root, relative || ".");
      const hits = await searchWorkspace(fullPath, params.query ?? "", params.glob);
      return { ...receipt(params.op, grant.id, "verified", false, true, hits.join("\n") || "(no matches)"), bytes: hits.length };
    }
    if (params.op === "copy" || params.op === "move") {
      const fromRel = params.from ?? "";
      const toRel = params.to ?? "";
      const fromPath = await assertPathInsideWorkspace(root, fromRel);
      const toPath = joinWorkspacePath(root, toRel);
      await mkdir(path.dirname(toPath), { recursive: true });
      if (params.op === "copy") await copyFile(fromPath, toPath);
      else await rename(fromPath, toPath);
      return receipt(params.op, grant.id, "verified", true, true, params.op === "copy" ? "Copied file." : "Moved file.");
    }
    return receipt(params.op, grant.id, "blocked", false, false, "File operation is not implemented in this slice.");
  } catch (error) {
    return receipt(params.op, grant.id, "failed", false, false, error instanceof Error ? error.message : "File operation failed.");
  }
}

const READ_FILE_OPS: ReadonlySet<FileOp> = new Set(["list_workspaces", "list", "stat", "search", "read_text"]);

function isFileOpApproved(context: FileToolContext, op: FileOp, workspaceId: string): boolean {
  if (typeof context.approved === "function") return context.approved(op, workspaceId);
  return context.approved === true;
}

function isReadFileOp(op: FileOp): boolean {
  return READ_FILE_OPS.has(op);
}

async function listWorkspaceEntries(fullPath: string, depth: number): Promise<string[]> {
  const entries = await readdir(fullPath, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    names.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
    if (depth > 1 && entry.isDirectory()) {
      const nested = await listWorkspaceEntries(path.join(fullPath, entry.name), depth - 1);
      names.push(...nested.map((name) => `${entry.name}/${name}`));
    }
  }
  return names.slice(0, 200);
}

async function searchWorkspace(fullPath: string, query: string, glob?: string): Promise<string[]> {
  const needle = query.trim().toLowerCase();
  const hits: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    if (hits.length >= 80) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (hits.length >= 80) return;
      if (entry.name.startsWith(".")) continue;
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), nextRel);
        continue;
      }
      if (glob !== undefined && glob.length > 0 && !entry.name.includes(glob.replaceAll("*", ""))) {
        continue;
      }
      const filePath = path.join(dir, entry.name);
      if (needle.length === 0 || nextRel.toLowerCase().includes(needle) || entry.name.toLowerCase().includes(needle)) {
        hits.push(nextRel);
        continue;
      }
      try {
        const body = await readFile(filePath);
        if (body.length === 0 || body.length > 256_000 || body.includes(0)) continue;
        if (body.toString("utf8").toLowerCase().includes(needle)) hits.push(nextRel);
      } catch {
        continue;
      }
    }
  }
  await walk(fullPath, "");
  return hits;
}

function receipt(
  op: string,
  workspaceId: string,
  status: FileReceipt["status"],
  committed: boolean,
  verified: boolean,
  message: string,
): FileReceipt {
  return {
    receiptId: randomUUID(),
    workspaceId,
    op,
    status,
    committed,
    verified,
    message,
  };
}
