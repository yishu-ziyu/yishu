import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import {
  resolveWorkspacePath,
  createBuiltinTools,
} from "../src/tools/builtin.js";
import { FileMemoryStore } from "../src/memory/store.js";

const dir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".tmp-sandbox",
);

describe("path sandbox", () => {
  it("blocks path escape", async () => {
    await fs.mkdir(dir, { recursive: true });
    assert.throws(() => resolveWorkspacePath(dir, "../../etc/passwd"), {
      message: /escapes workspace/,
    });
    assert.throws(() => resolveWorkspacePath(dir, "../outside.txt"), {
      message: /escapes workspace/,
    });

    const memory = new FileMemoryStore(path.join(dir, "m.json"));
    await memory.load();
    const tools = createBuiltinTools({ workspaceDir: dir, memory });
    const read = tools.find((t) => t.name === "read_file");
    assert.ok(read);
    const result = await read.execute({ path: "../../../etc/passwd" });
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("escapes"));
  });

  it("allows relative path inside workspace", () => {
    const abs = resolveWorkspacePath(dir, "notes/a.txt");
    assert.ok(abs.startsWith(path.resolve(dir)));
  });
});
