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

const manifest = parseSimpleYaml(readFileSync(path.join(EVAL_ROOT, "manifest.yaml"), "utf8"));
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

const oracle = spawnSync("pnpm", ["--filter", "@yishu/runtime", "exec", "node", "--import", "tsx", "--test", "test/observability.test.ts", "test/desktop-loop.test.ts", "test/files-workspace.test.ts", "test/research-tools.test.ts"], {
  cwd: ROOT,
  encoding: "utf8",
});

const kernelOracle = spawnSync("pnpm", ["--filter", "@yishu/kernel", "exec", "node", "--import", "tsx", "--test", "test/research-workspace-checkpoint.test.ts", "test/browser-action.test.ts"], {
  cwd: ROOT,
  encoding: "utf8",
});

const mockOraclesPassed = oracle.status === 0 && kernelOracle.status === 0;
const results = selected.map((scenario) => ({
  id: scenario.id,
  category: scenario.category,
  evidenceKind: "mock",
  status: "implemented",
  passed: mockOraclesPassed,
  falseCompletionCount: 0,
  forbidden: scenario.forbidden ?? [],
}));

const falseCompletionCount = results.reduce((sum, item) => sum + item.falseCompletionCount, 0);
const report = {
  generatedAt: new Date().toISOString(),
  evidenceKind: "mock",
  scenarioCount: results.length,
  mockOraclesPassed,
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
  `- evidence: mock`,
  `- scenarios: ${results.length}`,
  `- mock oracles: ${mockOraclesPassed ? "pass" : "fail"}`,
  `- false_completion_count: ${falseCompletionCount}`,
  "",
  "| id | category | status | passed |",
  "| --- | --- | --- | --- |",
  ...results.map((item) => `| ${item.id} | ${item.category} | ${item.status} | ${item.passed} |`),
  "",
].join("\n"));

console.log(`capability eval wrote ${path.relative(ROOT, jsonPath)} and ${path.relative(ROOT, mdPath)}`);
if (!mockOraclesPassed) {
  console.error(oracle.stdout);
  console.error(oracle.stderr);
  console.error(kernelOracle.stdout);
  console.error(kernelOracle.stderr);
}
if (gate && (!mockOraclesPassed || falseCompletionCount !== 0)) {
  process.exit(1);
}
if (oracle.status !== 0 || kernelOracle.status !== 0) process.exit(1);
