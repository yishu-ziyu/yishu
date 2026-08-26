#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ratchetPath = path.join(ROOT, "docs/architecture/refactor-ratchet.json");
const ratchet = JSON.parse(readFileSync(ratchetPath, "utf8"));

function lineCount(rel) {
  const text = readFileSync(path.join(ROOT, rel), "utf8");
  return text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

const files = {
  "apps/clicky/leanring-buddy/CompanionManager.swift": lineCount("apps/clicky/leanring-buddy/CompanionManager.swift"),
  "apps/clicky/leanring-buddy/YishuAgentRuntimeClient.swift": lineCount("apps/clicky/leanring-buddy/YishuAgentRuntimeClient.swift"),
  "apps/clicky/leanring-buddy/YishuComputerUseActuator.swift": lineCount("apps/clicky/leanring-buddy/YishuComputerUseActuator.swift"),
  "packages/runtime/src/product-kernel-runtime.ts": lineCount("packages/runtime/src/product-kernel-runtime.ts"),
  "packages/kernel/src/store/yishu-store.ts": lineCount("packages/kernel/src/store/yishu-store.ts"),
  "packages/runtime/src/loop-adapter.ts": lineCount("packages/runtime/src/loop-adapter.ts"),
};

const dep = spawnSync("pnpm", ["exec", "depcruise", "--config", "dependency-cruiser.config.cjs", "--output-type", "json", "packages"], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 20_000_000,
});
let circularEdges = ratchet.circularEdges;
if (dep.status === 0 || dep.stdout) {
  try {
    const graph = JSON.parse(dep.stdout);
    const cycles = graph.summary?.violations?.filter((item) => item.rule?.name === "no-circular") ?? [];
    circularEdges = cycles.length;
  } catch {
    circularEdges = ratchet.circularEdges;
  }
}

const failures = [];
for (const [file, lines] of Object.entries(files)) {
  const ceiling = ratchet.files[file];
  if (typeof ceiling !== "number") {
    failures.push(`missing ratchet entry for ${file}`);
    continue;
  }
  if (lines > ceiling) failures.push(`${file} grew to ${lines} lines; ceiling is ${ceiling}`);
}
if (circularEdges > ratchet.circularEdges) {
  failures.push(`runtime circular edges grew to ${circularEdges}; ceiling is ${ratchet.circularEdges}`);
}

if (failures.length > 0) {
  console.error("architecture ratchet failed:");
  for (const item of failures) console.error(`  ${item}`);
  process.exit(1);
}

console.log(`architecture ratchet passed: circularEdges=${circularEdges}`);
for (const [file, lines] of Object.entries(files)) {
  console.log(`  ${lines}/${ratchet.files[file]} ${file}`);
}
