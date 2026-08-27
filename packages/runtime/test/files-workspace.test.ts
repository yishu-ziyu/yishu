import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspaceLedger } from "@yishu/kernel";
import { createFileTool } from "../src/files/file-tool.js";
import { evaluateFileOp } from "../src/files/file-policy.js";
import {
  assertPathInsideWorkspace,
  joinWorkspacePath,
  resolveWorkspaceRoot,
} from "../src/files/path-guard.js";
import { applyPatchAtomically, writeTextAtomically } from "../src/files/patch-applier.js";
import { sha256Of } from "../src/files/text-reader.js";

test("path guard rejects .. and symlink escape", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yishu-ws-"));
  await mkdir(path.join(root, "ok"));
  assert.equal(joinWorkspacePath(root, "ok/a.txt").startsWith(root), true);
  assert.throws(() => joinWorkspacePath(root, "../secret"), /escapes/);
  const outside = await mkdtemp(path.join(tmpdir(), "yishu-out-"));
  await writeFile(path.join(outside, "secret.txt"), "nope");
  await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
  await assert.rejects(() => assertPathInsideWorkspace(root, "link.txt"), /escapes/);
});

test("stale patch hash is rejected and original file remains", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yishu-patch-"));
  const file = path.join(root, "note.txt");
  await writeTextAtomically(file, "hello\n");
  const before = await sha256Of(await readFile(file));
  await assert.rejects(
    () => applyPatchAtomically({ fullPath: file, baseSha256: "deadbeef", patch: "@@ -1,1 +1,1 @@\n-hello\n+hi\n" }),
    /changed since/,
  );
  assert.equal((await readFile(file, "utf8")).startsWith("hello"), true);
  const applied = await applyPatchAtomically({
    fullPath: file,
    baseSha256: before,
    patch: "@@ -1,1 +1,1 @@\n-hello\n+hi\n",
  });
  assert.equal(applied.beforeSha256, before);
  assert.match(await readFile(file, "utf8"), /^hi/);
});

test("file tool refuses sensitive reads and private writes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yishu-files-"));
  await writeFile(path.join(root, ".env"), "SECRET=1");
  const ledger = createWorkspaceLedger();
  const grant = ledger.create({
    displayName: "demo",
    rootPathReference: root,
    scope: { kind: "personal" },
    capabilities: ["read", "create", "edit", "trash"],
  });
  const tool = createFileTool({
    ledger,
    resolveRoot: (ref) => ref,
    scope: { kind: "personal" },
  });
  await assert.rejects(
    () => tool.execute("1", { op: "read_text", workspaceId: grant.id, path: ".env" } as never),
    /Sensitive/,
  );
  assert.equal(evaluateFileOp({
    op: "create_text",
    scope: { kind: "private" },
    capabilities: ["create"],
  }).decision, "deny");
});

test("child file tool is read-only even with a write grant", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yishu-child-ws-"));
  await writeFile(path.join(root, "note.txt"), "hello");
  const ledger = createWorkspaceLedger();
  const grant = ledger.create({
    displayName: "demo",
    rootPathReference: root,
    scope: { kind: "personal" },
    capabilities: ["read", "create", "edit", "trash"],
  });
  const child = createFileTool({
    ledger,
    resolveRoot: (ref) => ref,
    scope: { kind: "personal" },
    writeAccess: false,
  });
  await assert.rejects(
    () => child.execute("1", { op: "create_text", workspaceId: grant.id, path: "x.txt", content: "no" } as never),
    /read-only/,
  );
  const listed = await child.execute("2", { op: "list", workspaceId: grant.id, path: "." } as never);
  assert.match(listed.content[0]?.type === "text" ? listed.content[0].text : "", /note\.txt/);
});

test("file tool completes find-read-edit-readback-trash-restore", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yishu-files-task-"));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs", "note.txt"), "alpha\n");
  const ledger = createWorkspaceLedger();
  const grant = ledger.create({
    displayName: "task",
    rootPathReference: root,
    scope: { kind: "personal" },
    capabilities: ["read", "create", "edit", "trash"],
  });
  const tool = createFileTool({
    ledger,
    resolveRoot: (ref) => ref,
    scope: { kind: "personal" },
    approved: true,
  });
  const found = await tool.execute("1", { op: "search", workspaceId: grant.id, query: "alpha" } as never);
  assert.match(found.content[0]?.type === "text" ? found.content[0].text : "", /note\.txt/);
  const read = await tool.execute("2", { op: "read_text", workspaceId: grant.id, path: "docs/note.txt" } as never);
  const before = (read.details as { afterSha256?: string }).afterSha256;
  assert.ok(before);
  const patched = await tool.execute("3", {
    op: "apply_patch",
    workspaceId: grant.id,
    path: "docs/note.txt",
    baseSha256: before,
    patch: "@@ -1,1 +1,1 @@\n-alpha\n+beta\n",
  } as never);
  assert.equal((patched.details as { verified?: boolean }).verified, true);
  const readback = await tool.execute("4", { op: "read_text", workspaceId: grant.id, path: "docs/note.txt" } as never);
  assert.match(readback.content[0]?.type === "text" ? readback.content[0].text : "", /^beta/);
  const trashed = await tool.execute("5", { op: "trash", workspaceId: grant.id, path: "docs/note.txt" } as never);
  const restoreRef = (trashed.details as { restoreRef?: string }).restoreRef;
  assert.ok(restoreRef);
  const restored = await tool.execute("6", { op: "restore_from_trash", receiptId: restoreRef } as never);
  assert.equal((restored.details as { verified?: boolean }).verified, true);
  const again = await tool.execute("7", { op: "read_text", workspaceId: grant.id, path: "docs/note.txt" } as never);
  assert.match(again.content[0]?.type === "text" ? again.content[0].text : "", /^beta/);
});

test("revoke stops further writes on the same ledger the file tool uses", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yishu-files-revoke-"));
  const ledger = createWorkspaceLedger();
  const grant = ledger.ingest({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    displayName: "task",
    rootPathReference: root,
    scope: { kind: "personal" },
    capabilities: ["read", "create", "edit"],
  });
  const tool = createFileTool({
    ledger,
    resolveRoot: resolveWorkspaceRoot,
    scope: { kind: "personal" },
  });
  const listed = await tool.execute("0", { op: "list_workspaces" } as never);
  assert.match(listed.content[0]?.type === "text" ? listed.content[0].text : "", /task/);
  await tool.execute("1", { op: "create_text", workspaceId: grant.id, path: "a.txt", content: "one" } as never);
  ledger.revoke(grant.id);
  await assert.rejects(
    () => tool.execute("2", { op: "create_text", workspaceId: grant.id, path: "b.txt", content: "two" } as never),
    /not active/,
  );
  const after = await tool.execute("3", { op: "list_workspaces" } as never);
  assert.match(after.content[0]?.type === "text" ? after.content[0].text : "", /No folder workspace/);
});

test("trash waits for live approval instead of throwing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yishu-files-trash-"));
  await writeFile(path.join(root, "note.txt"), "keep");
  const ledger = createWorkspaceLedger();
  const grant = ledger.create({
    displayName: "task",
    rootPathReference: root,
    scope: { kind: "personal" },
    capabilities: ["read", "trash"],
  });
  const allowed = new Set<string>();
  const tool = createFileTool({
    ledger,
    resolveRoot: resolveWorkspaceRoot,
    scope: { kind: "personal" },
    approved: (op, workspaceId) => op === "trash" && allowed.has(workspaceId),
  });
  const blocked = await tool.execute("1", { op: "trash", workspaceId: grant.id, path: "note.txt" } as never);
  assert.equal((blocked.details as { status?: string }).status, "needs_approval");
  assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "keep");
  allowed.add(grant.id);
  const trashed = await tool.execute("2", { op: "trash", workspaceId: grant.id, path: "note.txt" } as never);
  assert.equal((trashed.details as { status?: string }).status, "verified");
});
