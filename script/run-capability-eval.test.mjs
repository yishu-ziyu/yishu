import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "script/run-capability-eval.mjs");
const REPORTS = path.join(ROOT, "evals/capability/reports");
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();

function reportFiles() {
  return new Set(readdirSync(REPORTS).filter((name) => name !== ".gitkeep"));
}

function runCli(env, extraArgs = []) {
  const startedAt = Date.now();
  const before = reportFiles();
  const childEnv = { ...process.env, ...env };
  for (const key of ["YISHU_E2E_DEVICE", "YISHU_CAPABILITY_DEVICE_RUNNER", "YISHU_CAPABILITY_DEVICE_PROVENANCE"]) {
    if (!(key in env)) delete childEnv[key];
  }
  const result = spawnSync(process.execPath, [
    SCRIPT,
    "--scenario",
    "screen.identify_frontmost",
    ...extraArgs,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: childEnv,
  });
  const created = [...reportFiles()].filter((name) => !before.has(name));
  const reports = [...reportFiles()]
    .filter((name) => name.endsWith(".json"))
    .map((name) => readFileSync(path.join(REPORTS, name), "utf8"))
    .filter((text) => {
      try {
        return Date.parse(JSON.parse(text).generatedAt) >= startedAt - 1_000;
      } catch {
        return false;
      }
    });
  for (const name of created) rmSync(path.join(REPORTS, name), { force: true });
  return { ...result, created, reports, output: `${result.stdout}\n${result.stderr}` };
}

test("device mode rejects mock-only execution without runner provenance", () => {
  const result = runCli({ YISHU_E2E_DEVICE: "1" });

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /device.*runner|provenance/i);
  assert.deepEqual(result.created, [], "a rejected device eval must not write a passing report");
});

test("device report uses runner false-completion evidence", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "yishu-capability-device-"));
  try {
    const runnerPath = path.join(temp, "runner.mjs");
    writeFileSync(runnerPath, [
      "#!/usr/bin/env node",
      "const index = process.argv.indexOf('--scenario');",
      "const trialIndex = process.argv.indexOf('--trial');",
      "const id = process.argv[index + 1];",
      "const trial = Number(process.argv[trialIndex + 1]);",
      "console.log(JSON.stringify({ id, trial, evidenceKind: 'device', passed: false, falseCompletionCount: 2, taskTerminal: 'verified', receipts: ['action_receipt', 'fresh_readback'] }));",
      "",
    ].join("\n"));
    chmodSync(runnerPath, 0o755);
    const provenancePath = path.join(temp, "provenance.json");
    const hash = createHash("sha256").update(readFileSync(runnerPath)).digest("hex");
    writeFileSync(provenancePath, JSON.stringify({
      evidenceKind: "device",
      runnerPath: realpathSync(runnerPath),
      runnerSha256: hash,
      generatedAt: new Date().toISOString(),
      commit: HEAD,
      appBundleHash: "test-app-hash",
      deviceId: "test-device",
      osVersion: "test-os",
    }));

    const result = runCli({
      YISHU_E2E_DEVICE: "1",
      YISHU_CAPABILITY_DEVICE_RUNNER: runnerPath,
      YISHU_CAPABILITY_DEVICE_PROVENANCE: provenancePath,
    }, ["--gate"]);

    assert.equal(result.status, 1, result.output);
    assert.equal(result.reports.length, 1);
    const report = JSON.parse(result.reports[0]);
    assert.equal(report.evidenceKind, "device");
    assert.equal(report.deviceProvenance.runnerSha256, hash);
    assert.equal(report.trialCount, 10);
    assert.equal(report.passCount, 0);
    assert.equal(report.falseCompletionCount, 20);
    assert.deepEqual(report.failed, ["screen.identify_frontmost"]);
    assert.equal(report.results[0].falseCompletionCount, 20);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function makeTrialRunner({ failTrial = false } = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), "yishu-capability-device-trials-"));
  const runnerPath = path.join(temp, "runner.mjs");
  const counterPath = path.join(temp, "trials.json");
  writeFileSync(runnerPath, [
    "#!/usr/bin/env node",
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "const scenarioIndex = process.argv.indexOf('--scenario');",
    "const trialIndex = process.argv.indexOf('--trial');",
    "const id = process.argv[scenarioIndex + 1];",
    "const trial = Number(process.argv[trialIndex + 1]);",
    "const counter = process.env.YISHU_DEVICE_TEST_COUNTER;",
    "const trials = existsSync(counter) ? JSON.parse(readFileSync(counter, 'utf8')) : [];",
    "trials.push(trial);",
    "writeFileSync(counter, JSON.stringify(trials));",
    `const failed = ${failTrial ? "trial === 10" : "false"};`,
    "console.log(JSON.stringify({ id, trial, evidenceKind: 'device', passed: !failed, falseCompletionCount: failed ? 1 : 0, taskTerminal: 'verified', receipts: ['action_receipt', 'fresh_readback'] }));",
    "",
  ].join("\n"));
  chmodSync(runnerPath, 0o755);
  const hash = createHash("sha256").update(readFileSync(runnerPath)).digest("hex");
  const provenancePath = path.join(temp, "provenance.json");
  writeFileSync(provenancePath, JSON.stringify({
    evidenceKind: "device",
    runnerPath: realpathSync(runnerPath),
    runnerSha256: hash,
    generatedAt: new Date().toISOString(),
    commit: HEAD,
    appBundleHash: "test-app-hash",
    deviceId: "test-device",
    osVersion: "test-os",
  }));
  return { temp, runnerPath, provenancePath, counterPath };
}

test("device mode executes and reports every configured trial", () => {
  const fixture = makeTrialRunner();
  try {
    const result = runCli({
      YISHU_E2E_DEVICE: "1",
      YISHU_CAPABILITY_DEVICE_RUNNER: fixture.runnerPath,
      YISHU_CAPABILITY_DEVICE_PROVENANCE: fixture.provenancePath,
      YISHU_DEVICE_TEST_COUNTER: fixture.counterPath,
    }, ["--gate"]);

    assert.equal(result.status, 0, result.output);
    assert.deepEqual(JSON.parse(readFileSync(fixture.counterPath, "utf8")), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(result.reports.length, 1);
    const report = JSON.parse(result.reports[0]);
    assert.equal(report.trialCount, 10);
    assert.equal(report.passCount, 10);
    assert.equal(report.falseCompletionCount, 0);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test("device mode aggregates a final-trial failure", () => {
  const fixture = makeTrialRunner({ failTrial: true });
  try {
    const result = runCli({
      YISHU_E2E_DEVICE: "1",
      YISHU_CAPABILITY_DEVICE_RUNNER: fixture.runnerPath,
      YISHU_CAPABILITY_DEVICE_PROVENANCE: fixture.provenancePath,
      YISHU_DEVICE_TEST_COUNTER: fixture.counterPath,
    }, ["--gate"]);

    assert.equal(result.status, 1, result.output);
    assert.deepEqual(JSON.parse(readFileSync(fixture.counterPath, "utf8")), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const report = JSON.parse(result.reports.at(-1));
    assert.equal(report.trialCount, 10);
    assert.equal(report.passCount, 9);
    assert.equal(report.falseCompletionCount, 1);
    assert.deepEqual(report.failed, ["screen.identify_frontmost"]);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});

test("device mode blocks provenance from another commit", () => {
  const fixture = makeTrialRunner();
  try {
    const provenance = JSON.parse(readFileSync(fixture.provenancePath, "utf8"));
    provenance.commit = "different-commit";
    writeFileSync(fixture.provenancePath, JSON.stringify(provenance));
    const result = runCli({
      YISHU_E2E_DEVICE: "1",
      YISHU_CAPABILITY_DEVICE_RUNNER: fixture.runnerPath,
      YISHU_CAPABILITY_DEVICE_PROVENANCE: fixture.provenancePath,
      YISHU_DEVICE_TEST_COUNTER: fixture.counterPath,
    });

    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /commit.*HEAD|commit.*match|provenance/i);
    assert.deepEqual(result.created, []);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});
