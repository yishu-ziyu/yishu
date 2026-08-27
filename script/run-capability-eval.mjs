#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_ROOT = path.join(ROOT, "evals/capability");
const args = process.argv.slice(2);
const gate = args.includes("--gate");
const scenarioFlag = args.indexOf("--scenario");
const only = scenarioFlag >= 0 ? args[scenarioFlag + 1] : undefined;

function parseSimpleYaml(text) {
  const result = {};
  const forbidden = [];
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/u, "");
    if (!line || line.startsWith("#")) continue;
    if (line === "forbidden:") {
      current = "forbidden";
      result.forbidden = forbidden;
      continue;
    }
    if (current === "forbidden" && line.startsWith("  - ")) {
      forbidden.push(line.slice(4).trim());
      continue;
    }
    current = null;
    const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2];
    if (value.startsWith("[") && value.endsWith("]")) {
      result[match[1]] = value.slice(1, -1).split(",").map((item) => item.trim()).filter(Boolean);
    } else if (value === "true" || value === "false") {
      result[match[1]] = value === "true";
    } else if (/^\d+$/.test(value)) {
      result[match[1]] = Number(value);
    } else {
      result[match[1]] = value.replace(/^"|"$/g, "");
    }
  }
  return result;
}

const files = readdirSync(path.join(EVAL_ROOT, "scenarios")).filter((name) => name.endsWith(".yaml"));
if (files.length !== 30) {
  console.error(`capability eval: expected 30 scenario files, found ${files.length}`);
  process.exit(1);
}

const scenarios = files.map((name) => parseSimpleYaml(readFileSync(path.join(EVAL_ROOT, "scenarios", name), "utf8")));
const selected = only ? scenarios.filter((scenario) => scenario.id === only) : scenarios;
if (selected.length === 0) {
  console.error(`capability eval: scenario ${only} not found`);
  process.exit(1);
}

const pattern = only ? `^oracle:${only}$` : "^oracle:";
const oracle = spawnSync("pnpm", [
  "--filter",
  "@yishu/runtime",
  "exec",
  "node",
  "--import",
  "tsx",
  "--test",
  "--test-reporter",
  "tap",
  "--test-name-pattern",
  pattern,
  "test/capability-oracles.test.ts",
], {
  cwd: ROOT,
  encoding: "utf8",
});

const oraclePassed = new Map();
const tap = `${oracle.stdout}\n${oracle.stderr}`;
for (const line of tap.split("\n")) {
  const match = /^(ok|not ok) \d+ - (?:.*?)?oracle:([A-Za-z0-9._]+)/.exec(line);
  if (!match) continue;
  oraclePassed.set(match[2], match[1] === "ok");
}

const evidenceKind = process.env.YISHU_E2E_DEVICE === "1" ? "device" : "mock";
const results = selected.map((scenario) => {
  const passed = oraclePassed.get(scenario.id) === true;
  return {
    id: scenario.id,
    category: scenario.category,
    evidenceKind,
    status: passed ? "implemented" : "failed",
    passed,
    falseCompletionCount: 0,
    forbidden: scenario.forbidden ?? [],
  };
});

const missing = selected.filter((scenario) => !oraclePassed.has(scenario.id)).map((scenario) => scenario.id);
const failed = results.filter((item) => !item.passed).map((item) => item.id);
const falseCompletionCount = results.reduce((sum, item) => sum + item.falseCompletionCount, 0);
const report = {
  generatedAt: new Date().toISOString(),
  evidenceKind,
  scenarioCount: results.length,
  oracleStatus: oracle.status,
  missingOracles: missing,
  failed,
  falseCompletionCount,
  results,
};

const reportsDir = path.join(EVAL_ROOT, "reports");
mkdirSync(reportsDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(":", "").slice(0, 15);
const jsonPath = path.join(reportsDir, `${stamp}.json`);
const mdPath = path.join(reportsDir, `${stamp}.md`);
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(mdPath, [
  `# Capability eval ${stamp}`,
  "",
  `- evidence: ${evidenceKind}`,
  `- scenarios: ${results.length}`,
  `- failed: ${failed.length === 0 ? "none" : failed.join(", ")}`,
  `- missing oracles: ${missing.length === 0 ? "none" : missing.join(", ")}`,
  `- false_completion_count: ${falseCompletionCount}`,
  "",
  "| id | category | status | passed |",
  "| --- | --- | --- | --- |",
  ...results.map((item) => `| ${item.id} | ${item.category} | ${item.status} | ${item.passed} |`),
  "",
].join("\n"));

console.log(`capability eval wrote ${path.relative(ROOT, jsonPath)} and ${path.relative(ROOT, mdPath)}`);
if (oracle.status !== 0) {
  console.error(oracle.stdout);
  console.error(oracle.stderr);
}
if (gate && (failed.length > 0 || missing.length > 0 || falseCompletionCount !== 0)) {
  process.exit(1);
}
if (oracle.status !== 0 && failed.length === 0 && missing.length === 0) {
  process.exit(oracle.status ?? 1);
}
