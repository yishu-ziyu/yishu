import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * PR-1 ratchet: history list/open/archive must not use the raw store.
 *
 * Remaining backdoors until later PRs finish the narrow-port migration:
 * - ProductKernelRuntime still has other kernel.store calls (cap 49)
 * - packages/runtime/src/delegation.ts: 2 kernel.store + 2 YishuStorePort
 * - suggestion-loop.ts holds YishuKernel and invokes registry
 *
 * Caps are ceilings: counts and allowlisted files may fall to zero. Only a
 * new file or a count above the ceiling fails.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(ROOT, "../..");
const SRC = path.join(ROOT, "src");
const PKR = path.join(SRC, "product-kernel-runtime.ts");
const STORE_TOKEN = /kernel\.store\b/g;
const STORE_PORT_TOKEN = /YishuStorePort\b/g;
const ALLOWED_STORE_FILES = new Set([
  "packages/runtime/src/product-kernel-runtime.ts",
  "packages/runtime/src/delegation.ts",
]);
const ALLOWED_STORE_PORT_FILES = new Set([
  "packages/runtime/src/delegation.ts",
]);
const HISTORY_METHODS = ["listHistory", "openHistory", "deleteHistory"] as const;
const PKR_STORE_MAX = 49;
const RUNTIME_SRC_STORE_MAX = 51;
const RUNTIME_SRC_STORE_PORT_MAX = 2;

function countStoreTokens(source: string): number {
  return source.match(STORE_TOKEN)?.length ?? 0;
}

function countStorePortTokens(source: string): number {
  return source.match(STORE_PORT_TOKEN)?.length ?? 0;
}

function extractAsyncMethodBody(source: string, methodName: string): string {
  const marker = `async ${methodName}(`;
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error(`missing async method ${methodName}`);
  }
  if (source.indexOf(marker, start + marker.length) !== -1) {
    throw new Error(`ambiguous async method ${methodName}`);
  }
  let index = start + marker.length;
  let paren = 1;
  let inString: '"' | "'" | "`" | null = null;
  while (index < source.length && paren > 0) {
    const char = source[index]!;
    const prev = source[index - 1];
    if (inString) {
      if (char === inString && prev !== "\\") inString = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      index += 1;
      continue;
    }
    if (char === "(") paren += 1;
    else if (char === ")") paren -= 1;
    index += 1;
  }
  while (index < source.length && source[index] !== "{") index += 1;
  if (source[index] !== "{") {
    throw new Error(`unopened body for ${methodName}`);
  }
  const bodyStart = index;
  let depth = 0;
  inString = null;
  for (; index < source.length; index += 1) {
    const char = source[index]!;
    const prev = source[index - 1];
    if (inString) {
      if (char === inString && prev !== "\\") inString = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }
  throw new Error(`unclosed body for ${methodName}`);
}

async function listTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

test("history methods do not use the raw store; remaining kernel.store stays capped", async () => {
  const pkrSource = await readFile(PKR, "utf8");
  for (const methodName of HISTORY_METHODS) {
    const body = extractAsyncMethodBody(pkrSource, methodName);
    assert.equal(
      countStoreTokens(body),
      0,
      `${methodName} must not contain kernel.store`,
    );
  }

  const pkrCount = countStoreTokens(pkrSource);
  assert.ok(
    pkrCount <= PKR_STORE_MAX,
    `product-kernel-runtime.ts kernel.store count ${pkrCount} exceeds ${PKR_STORE_MAX}`,
  );

  let srcCount = 0;
  let portCount = 0;
  const unexpected: string[] = [];
  const unexpectedPort: string[] = [];
  for (const file of await listTsFiles(SRC)) {
    const source = await readFile(file, "utf8");
    const rel = path.relative(REPO_ROOT, file);
    const count = countStoreTokens(source);
    if (count > 0) {
      srcCount += count;
      if (!ALLOWED_STORE_FILES.has(rel)) {
        unexpected.push(`${rel} (${count})`);
      }
    }
    const ports = countStorePortTokens(source);
    if (ports > 0) {
      portCount += ports;
      if (!ALLOWED_STORE_PORT_FILES.has(rel)) {
        unexpectedPort.push(`${rel} (${ports})`);
      }
    }
  }
  assert.equal(unexpected.length, 0, `kernel.store leaked into ${unexpected.join(", ")}`);
  assert.ok(
    srcCount <= RUNTIME_SRC_STORE_MAX,
    `packages/runtime/src kernel.store count ${srcCount} exceeds ${RUNTIME_SRC_STORE_MAX}`,
  );
  assert.equal(unexpectedPort.length, 0, `YishuStorePort leaked into ${unexpectedPort.join(", ")}`);
  assert.ok(
    portCount <= RUNTIME_SRC_STORE_PORT_MAX,
    `packages/runtime/src YishuStorePort count ${portCount} exceeds ${RUNTIME_SRC_STORE_PORT_MAX}`,
  );
});
