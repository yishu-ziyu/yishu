#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runner = path.join(ROOT, "e2e/macos/macos-desktop-e2e-clicky.ts");
const result = spawnSync(process.execPath, [
  "--experimental-strip-types",
  "--disable-warning=ExperimentalWarning",
  runner,
], {
  cwd: ROOT,
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status === 0 ? 0 : (result.status ?? 1));
