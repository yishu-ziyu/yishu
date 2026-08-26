import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspaceLedger } from "@yishu/kernel";
import { createFileTool } from "../src/files/file-tool.js";
import { evaluateFileOp } from "../src/files/file-policy.js";
import { assertPathInsideWorkspace, joinWorkspacePath } from "../src/files/path-guard.js";
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
