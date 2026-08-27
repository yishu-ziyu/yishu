import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("manifest lists 30 scenarios with setup, expected, and forbidden", () => {
  const files = readdirSync(path.join(root, "scenarios")).filter((name) => name.endsWith(".yaml"));
  assert.equal(files.length, 30);
  const status = JSON.parse(readFileSync(path.join(root, "status.json"), "utf8"));
  assert.equal(Object.keys(status.capabilities).length, 30);
  for (const file of files) {
    const text = readFileSync(path.join(root, "scenarios", file), "utf8");
    assert.match(text, /^id: /m);
    assert.match(text, /^setup:/m);
    assert.match(text, /^expected:/m);
    assert.match(text, /^forbidden:/m);
  }
});
