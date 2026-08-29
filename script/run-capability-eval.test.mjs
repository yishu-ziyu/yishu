import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BUNDLE_IDENTITY_ALGORITHM,
  DEVICE_GOLDEN_SCENARIOS,
  EXPECTED_BUNDLE_IDENTIFIER,
  FORMAL_APP_PATH,
  aggregateDeviceTrials,
  validateDeviceTrialEnvironment,
  validateDeviceProvenance,
  verifyDeviceObservation,
  verifyFormalAppInstallation,
} from "./create-device-eval-provenance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "script/run-capability-eval.mjs");
const REPORTS = path.join(ROOT, "evals/capability/reports");
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const FORMAL_APP_INSTALLATION = (() => {
  try {
    return verifyFormalAppInstallation(ROOT);
  } catch {
    return null;
  }
})();
const FORMAL_APP_BUNDLE_HASH = FORMAL_APP_INSTALLATION?.appBundleHash ?? null;
const FORMAL_APP_RUNNING = FORMAL_APP_INSTALLATION !== null;
const EXECUTION_DEPENDENCIES = [
  { path: "evals/capability/device/quality-observation-collector.mjs", sha256: "d".repeat(64) },
  { path: "evals/capability/device/trial-verifier.mjs", sha256: "e".repeat(64) },
];
const EXECUTION_SET_HASH = "f".repeat(64);

function reportFiles() {
  return new Set(readdirSync(REPORTS).filter((name) => name !== ".gitkeep"));
}

function runCli(env, extraArgs = [], scenarioId = "screen.identify_frontmost") {
  const startedAt = Date.now();
  const before = reportFiles();
  const childEnv = { ...process.env, ...env };
  for (const key of ["YISHU_E2E_DEVICE", "YISHU_CAPABILITY_DEVICE_RUNNER", "YISHU_CAPABILITY_DEVICE_PROVENANCE"]) {
    if (!(key in env)) delete childEnv[key];
  }
  const result = spawnSync(process.execPath, [
    SCRIPT,
    "--scenario",
    scenarioId,
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
  const result = runCli({ YISHU_E2E_DEVICE: "1" }, [], DEVICE_GOLDEN_SCENARIOS[0].id);

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /device.*runner|provenance/i);
  assert.deepEqual(result.created, [], "a rejected device eval must not write a passing report");
});

test("device mode rejects generic scenarios instead of inferring a golden contract from category", () => {
  const result = runCli({ YISHU_E2E_DEVICE: "1" }, [], "screen.identify_frontmost");

  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /explicit device-golden scenario/i);
  assert.deepEqual(result.created, []);
});

const DEVICE_SCENARIO = DEVICE_GOLDEN_SCENARIOS[0];

function makeT1Observation(trial) {
  return {
    schemaVersion: 1,
    contract: "t1.ptt",
    trialId: `${DEVICE_SCENARIO.id}-${trial}`,
    events: [
      { kind: "ptt_pressed", sequence: 1, observedAt: "2026-08-29T00:00:00.000Z" },
      { kind: "ptt_released", sequence: 2, observedAt: "2026-08-29T00:00:05.500Z" },
      { kind: "context_recaptured", sequence: 3, observedAt: "2026-08-29T00:00:06.000Z", reason: "recaptureSceneChanged" },
      { kind: "terminal", sequence: 4, observedAt: "2026-08-29T00:00:06.100Z", state: "verified" },
      { kind: "human_judgment", sequence: 5, observedAt: "2026-08-29T00:00:06.200Z", phase: "latest_screen_answer", outcome: "correct", source: "human" },
    ],
  };
}

test("device aggregation rejects false-completion evidence across ten trials", () => {
  const result = aggregateDeviceTrials(
    DEVICE_SCENARIO,
    Array.from({ length: DEVICE_SCENARIO.repeat }, () => ({
      trialStatus: "fail",
      falseCompletionCount: 2,
      runnerExitStatus: 0,
    })),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.passed, false);
  assert.equal(result.trialCount, 10);
  assert.equal(result.passCount, 0);
  assert.equal(result.falseCompletionCount, 20);
  assert.equal(result.runnerExitStatus, 0);
});

test("device gate rejects a forged passing aggregate from a runner", () => {
  const forged = makeT1Observation(1);
  forged.passed = true;
  forged.falseCompletionCount = 0;
  forged.taskTerminal = "verified";
  forged.receipts = ["action_receipt", "fresh_readback"];
  const temp = mkdtempSync(path.join(tmpdir(), "yishu-capability-forged-runner-"));
  try {
    const runnerPath = path.join(temp, "runner.mjs");
    writeFileSync(runnerPath, `console.log(${JSON.stringify(JSON.stringify(forged))});\n`);
    const runner = spawnSync(process.execPath, [runnerPath], { encoding: "utf8" });
    assert.equal(runner.status, 0, runner.stderr);
    const printed = JSON.parse(runner.stdout.trim());
    const result = verifyDeviceObservation(printed, {
      scenarioId: DEVICE_SCENARIO.id,
      expectedContract: DEVICE_SCENARIO.deviceContract,
      trial: 1,
    });

    assert.equal(result.ok, false);
    assert.match(result.reason, /device_observation_invalid:.*forbidden_field:passed/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("device gate does not infer a verifier contract from a generic category", () => {
  const result = verifyDeviceObservation(makeT1Observation(1), {
    scenarioId: DEVICE_SCENARIO.id,
    category: "screen",
    trial: 1,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "device_contract_required");
});

function makeTrialRunner() {
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
    "console.log(JSON.stringify({ schemaVersion: 1, contract: 't1.ptt', trialId: `${id}-${trial}`, events: [",
    "  { kind: 'ptt_pressed', sequence: 1, observedAt: '2026-08-29T00:00:00.000Z' },",
    "  { kind: 'ptt_released', sequence: 2, observedAt: '2026-08-29T00:00:05.500Z' },",
    "  { kind: 'context_recaptured', sequence: 3, observedAt: '2026-08-29T00:00:06.000Z', reason: 'recaptureSceneChanged' },",
    "  { kind: 'terminal', sequence: 4, observedAt: '2026-08-29T00:00:06.100Z', state: 'verified' },",
    "  { kind: 'human_judgment', sequence: 5, observedAt: '2026-08-29T00:00:06.200Z', phase: 'latest_screen_answer', outcome: 'correct', source: 'human' },",
    "] }));",
    "",
  ].join("\n"));
  chmodSync(runnerPath, 0o755);
  const hash = createHash("sha256").update(readFileSync(runnerPath)).digest("hex");
  const provenancePath = path.join(temp, "provenance.json");
  writeFileSync(provenancePath, JSON.stringify({
    evidenceKind: "device",
    runnerPath: realpathSync(runnerPath),
    runnerSha256: hash,
    executionDependencies: EXECUTION_DEPENDENCIES,
    executionSetSha256: EXECUTION_SET_HASH,
    generatedAt: new Date().toISOString(),
    commit: HEAD,
    appBundleHash: FORMAL_APP_BUNDLE_HASH ?? "b".repeat(64),
    bundleIdentityAlgorithm: BUNDLE_IDENTITY_ALGORITHM,
    appPath: FORMAL_APP_PATH,
    bundleIdentifier: EXPECTED_BUNDLE_IDENTIFIER,
    deviceId: "test-device",
    osVersion: "test-os",
  }), { mode: 0o600 });
  return { temp, runnerPath, provenancePath, counterPath };
}

test("device aggregation accepts exactly ten verified trials", () => {
  const result = aggregateDeviceTrials(
    DEVICE_SCENARIO,
    Array.from({ length: DEVICE_SCENARIO.repeat }, () => ({
      trialStatus: "pass",
      falseCompletionCount: 0,
      runnerExitStatus: 0,
    })),
  );

  assert.equal(result.status, "accepted");
  assert.equal(result.passed, true);
  assert.equal(result.trialCount, 10);
  assert.equal(result.passCount, 10);
  assert.equal(result.falseCompletionCount, 0);
});

test("device aggregation rejects a failure on the final trial", () => {
  const result = aggregateDeviceTrials(
    DEVICE_SCENARIO,
    Array.from({ length: DEVICE_SCENARIO.repeat }, (_, index) => ({
      trialStatus: index < DEVICE_SCENARIO.repeat - 1 ? "pass" : "fail",
      falseCompletionCount: index === DEVICE_SCENARIO.repeat - 1 ? 1 : 0,
      runnerExitStatus: 0,
    })),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.passed, false);
  assert.equal(result.trialCount, 10);
  assert.equal(result.passCount, 9);
  assert.equal(result.falseCompletionCount, 1);
  assert.equal(result.runnerExitStatus, 0);
});

test("device provenance rejects a result from another commit", () => {
  const result = validateDeviceProvenance({
    evidenceKind: "device",
    runnerPath: "/tmp/device-runner",
    runnerSha256: "c".repeat(64),
    executionDependencies: EXECUTION_DEPENDENCIES,
    executionSetSha256: EXECUTION_SET_HASH,
    generatedAt: "2026-08-29T00:00:00.000Z",
    commit: "d".repeat(40),
    appBundleHash: "b".repeat(64),
    bundleIdentityAlgorithm: BUNDLE_IDENTITY_ALGORITHM,
    appPath: FORMAL_APP_PATH,
    bundleIdentifier: EXPECTED_BUNDLE_IDENTIFIER,
    deviceId: "test-device",
    osVersion: "test-os",
  }, {
    runnerPath: "/tmp/device-runner",
    runnerSha256: "c".repeat(64),
    executionDependencies: EXECUTION_DEPENDENCIES,
    executionSetSha256: EXECUTION_SET_HASH,
    currentCommit: HEAD,
    installation: {
      appPath: FORMAL_APP_PATH,
      bundleIdentifier: EXPECTED_BUNDLE_IDENTIFIER,
      runningPidCount: 1,
      bundleIdentityAlgorithm: BUNDLE_IDENTITY_ALGORITHM,
      appBundleHash: "b".repeat(64),
      buildManifest: {
        commit: HEAD,
        sourceInputHash: "a".repeat(64),
        worktreeDirty: false,
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "provenance_commit_mismatch");
});

test("each device trial environment rejects dependency, app bundle, commit, or single-instance drift", () => {
  const installation = {
    appPath: FORMAL_APP_PATH,
    bundleIdentifier: EXPECTED_BUNDLE_IDENTIFIER,
    runningPidCount: 1,
    bundleIdentityAlgorithm: BUNDLE_IDENTITY_ALGORITHM,
    appBundleHash: "b".repeat(64),
    buildManifest: {
      commit: HEAD,
      sourceInputHash: "a".repeat(64),
      worktreeDirty: false,
    },
  };
  const execution = {
    runnerPath: "/tmp/device-runner",
    runnerSha256: "c".repeat(64),
    executionDependencies: EXECUTION_DEPENDENCIES,
    executionSetSha256: EXECUTION_SET_HASH,
  };
  const provenance = {
    evidenceKind: "device",
    runnerPath: execution.runnerPath,
    runnerSha256: execution.runnerSha256,
    executionDependencies: EXECUTION_DEPENDENCIES,
    executionSetSha256: EXECUTION_SET_HASH,
    generatedAt: "2026-08-29T00:00:00.000Z",
    commit: HEAD,
    appBundleHash: installation.appBundleHash,
    bundleIdentityAlgorithm: BUNDLE_IDENTITY_ALGORITHM,
    appPath: FORMAL_APP_PATH,
    bundleIdentifier: EXPECTED_BUNDLE_IDENTIFIER,
    deviceId: "test-device",
    osVersion: "test-os",
  };

  assert.deepEqual(validateDeviceTrialEnvironment(provenance, { execution, installation }), { ok: true });
  assert.equal(validateDeviceTrialEnvironment(provenance, {
    execution: { ...execution, executionSetSha256: "0".repeat(64) },
    installation,
  }).reason, "provenance_execution_set_hash_mismatch");
  assert.equal(validateDeviceTrialEnvironment(provenance, {
    execution,
    installation: { ...installation, appBundleHash: "0".repeat(64) },
  }).reason, "provenance_app_bundle_hash_mismatch");
  assert.equal(validateDeviceTrialEnvironment(provenance, {
    execution,
    installation: {
      ...installation,
      buildManifest: { ...installation.buildManifest, commit: "0".repeat(40) },
    },
  }).reason, "provenance_commit_mismatch");
  assert.equal(validateDeviceTrialEnvironment(provenance, {
    execution,
    installation: { ...installation, runningPidCount: 2 },
  }).reason, "installed_app_identity_or_manifest_invalid");
});

test("device CLI rejects an uncommitted runner even when the formal app is ready", { skip: !FORMAL_APP_RUNNING }, () => {
  const fixture = makeTrialRunner();
  try {
    const result = runCli({
      YISHU_E2E_DEVICE: "1",
      YISHU_CAPABILITY_DEVICE_RUNNER: fixture.runnerPath,
      YISHU_CAPABILITY_DEVICE_PROVENANCE: fixture.provenancePath,
      YISHU_DEVICE_TEST_COUNTER: fixture.counterPath,
    }, ["--gate"], DEVICE_GOLDEN_SCENARIOS[0].id);

    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /runner.*canonical|runner.*commit/i);
    assert.deepEqual(result.created, []);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
});
