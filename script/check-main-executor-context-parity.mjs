#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "packages/runtime/package.json"));
let tsx;
try {
  tsx = require.resolve("tsx");
} catch (error) {
  console.error("context parity checker FAILED: tsx is not installed for @yishu/runtime");
  console.error(error);
  process.exit(2);
}

const result = spawnSync(
  process.execPath,
  ["--import", tsx, path.join(root, "script/check-main-executor-context-parity.ts")],
  { stdio: "inherit", cwd: root, env: process.env },
);

if (result.error) {
  console.error(result.error);
  process.exit(2);
}
process.exit(result.status ?? 1);
