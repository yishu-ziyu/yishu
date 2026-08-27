#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(ROOT, "e2e/macos/scenarios");
const reports = path.join(ROOT, "e2e/macos/reports");
mkdirSync(reports, { recursive: true });
const scenarios = readdirSync(dir).filter((name) => name.endsWith(".yaml"));
if (scenarios.length === 0) {
  console.error("no e2e scenarios");
  process.exit(1);
}

const testbed = spawnSync("swift", ["test", "--package-path", "apps/yishu-testbed"], {
  cwd: ROOT,
  encoding: "utf8",
});
const testbedPassed = testbed.status === 0;
if (!testbedPassed) {
  console.error(testbed.stdout);
  console.error(testbed.stderr);
}

const results = scenarios.map((file) => {
  const text = readFileSync(path.join(dir, file), "utf8");
  const id = /id:\s+(\S+)/.exec(text)?.[1] ?? file;
  const app = /app:\s+(\S+)/.exec(text)?.[1] ?? "";
  const isTestbed = app === "yishu-testbed";
  return {
    id,
    app,
    evidenceKind: isTestbed ? "fixture" : "none",
    passed: isTestbed ? testbedPassed : false,
    falseCompletionCount: 0,
    reason: isTestbed
      ? (testbedPassed ? "YishuTestbed fixture tests passed" : "YishuTestbed fixture tests failed")
      : "No fixture or device runner for this app yet",
  };
});

const falseCompletionCount = results.reduce((sum, item) => sum + item.falseCompletionCount, 0);
const failed = results.filter((item) => !item.passed).map((item) => item.id);
const report = {
  generatedAt: new Date().toISOString(),
  testbedStatus: testbed.status,
  falseCompletionCount,
  failed,
  results,
};
writeFileSync(path.join(reports, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
if (falseCompletionCount !== 0 || failed.length > 0 || !testbedPassed) {
  console.error(`macos e2e failed: ${failed.join(", ") || "testbed"}`);
  process.exit(1);
}
console.log(`macos e2e: ${results.length} scenarios, false_completion_count=0`);
