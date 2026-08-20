import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FileEverOSPendingSessionStore } from "../src/everos-pending-sessions.js";

test("pending session store is idempotent, content-free, and private", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "yishu-everos-pending-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "nested", "pending.json");
  const store = new FileEverOSPendingSessionStore(filePath);
  const row = { sessionId: "conversation-1", scopeKey: "personal" };
  await store.add(row);
  await store.add(row);
  assert.deepEqual(await store.list(), [row]);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(filePath))).mode & 0o777, 0o700);
  await store.remove(row);
  assert.deepEqual(await store.list(), []);
});
