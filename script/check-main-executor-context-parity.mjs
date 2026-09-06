#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Production rendering seams import @yishu/kernel, whose package exports
// point at dist/. Runtime tests use the same pretest build. This wrapper
// owns that compile so product:boundaries can run on a clean checkout
// before the later kernel build step in verify-product.sh.
const kernelBuild = spawnSync(
  "pnpm",
  ["--filter", "@yishu/kernel", "build"],
  { stdio: "inherit", cwd: root, env: process.env },
);
if (kernelBuild.error) {
  console.error("context parity checker FAILED: could not spawn kernel build");
  console.error(kernelBuild.error);
  process.exit(2);
}
if (kernelBuild.status !== 0) {
  console.error("context parity checker FAILED: @yishu/kernel build exited", kernelBuild.status);
  process.exit(kernelBuild.status ?? 2);
}

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
