#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const status = JSON.parse(readFileSync(path.join(ROOT, "evals/capability/status.json"), "utf8"));
const matrix = readFileSync(path.join(ROOT, "docs/capabilities/CAPABILITY_MATRIX.md"), "utf8");
const toolFiles = [
  "packages/runtime/src/computer-control-tool.ts",
  "packages/runtime/src/browser-tool.ts",
  "packages/runtime/src/web-search-tool.ts",
  "packages/runtime/src/desktop/desktop-tool.ts",
  "packages/runtime/src/files/file-tool.ts",
  "packages/runtime/src/research/research-tools.ts",
];

const missing = [];
for (const file of toolFiles) {
  const source = readFileSync(path.join(ROOT, file), "utf8");
  const names = [...source.matchAll(/name:\s*"([a-z0-9_]+)"/g)].map((match) => match[1]);
  if (names.length === 0) missing.push(`${file}: no tool name`);
}

const scenarioCount = readdirSync(path.join(ROOT, "evals/capability/scenarios")).filter((name) => name.endsWith(".yaml")).length;
if (scenarioCount !== 30) missing.push(`expected 30 scenarios, found ${scenarioCount}`);
if (Object.keys(status.capabilities).length !== 30) missing.push("status.json must list all 30 scenarios");
if (!matrix.includes("screen.identify_frontmost")) missing.push("matrix missing screen.identify_frontmost");

if (missing.length > 0) {
  console.error("capability tool/status gate failed:");
  for (const item of missing) console.error(`  ${item}`);
  process.exit(1);
}
console.log("capability tool/status gate passed");
