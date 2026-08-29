#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  aggregateDeviceTrials,
  DEVICE_GOLDEN_SCENARIOS,
  resolveCommittedDeviceExecution,
  validateDeviceProvenance,
  validateDeviceTrialEnvironment,
  verifyDeviceObservation,
  verifyFormalAppInstallation,
} from "./create-device-eval-provenance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_ROOT = path.join(ROOT, "evals/capability");
const args = process.argv.slice(2);
const gate = args.includes("--gate");
const scenarioFlag = args.indexOf("--scenario");
const only = scenarioFlag >= 0 ? args[scenarioFlag + 1] : undefined;
const deviceMode = process.env.YISHU_E2E_DEVICE === "1";

function optionValue(flag, envName) {
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1];
  return process.env[envName];
}

function blockedDevice(message) {
  console.error(`capability eval: device mode blocked: ${message}`);
  process.exit(2);
}

function parseRunnerJson(stdout, scenarioId) {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      return JSON.parse(line);
    } catch {
      // Runners may print human-readable progress before their final JSON line.
    }
  }
  blockedDevice(`runner produced no JSON result for ${scenarioId}`);
}

function loadDeviceConfig(selected) {
  const runnerInput = optionValue("--device-runner", "YISHU_CAPABILITY_DEVICE_RUNNER");
  const provenanceInput = optionValue("--device-provenance", "YISHU_CAPABILITY_DEVICE_PROVENANCE");
  if (!runnerInput || !provenanceInput) {
    blockedDevice(
      "requires YISHU_CAPABILITY_DEVICE_RUNNER and YISHU_CAPABILITY_DEVICE_PROVENANCE; refusing to promote mock oracle evidence",
    );
  }

  let execution;
  try {
    execution = resolveCommittedDeviceExecution(runnerInput, ROOT);
  } catch (error) {
    blockedDevice(`runner is not a readable executable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const {
    runnerPath,
    runnerSha256,
    executionDependencies,
    executionSetSha256,
  } = execution;

  let provenance;
  try {
    provenance = JSON.parse(readFileSync(provenanceInput, "utf8"));
  } catch {
    blockedDevice("provenance is not readable JSON");
  }

  let provenancePath;
  try {
    provenancePath = realpathSync(provenanceInput);
  } catch {
    blockedDevice("provenance path is not readable");
  }
  let installation;
  try {
    installation = verifyFormalAppInstallation(ROOT);
  } catch (error) {
    blockedDevice(error instanceof Error ? error.message : "formal_app_verification_failed");
  }
  const expectedCommit = installation.buildManifest.commit;
  const validated = validateDeviceProvenance(provenance, {
    runnerPath,
    runnerSha256,
    executionDependencies,
    executionSetSha256,
    currentCommit: expectedCommit,
    installation,
  });
  if (!validated.ok) blockedDevice(validated.reason);

  return {
    runnerPath,
    provenancePath,
    runnerSha256,
    executionDependencies,
    executionSetSha256,
    provenance: {
      evidenceKind: provenance.evidenceKind,
      runnerPath: provenance.runnerPath,
      runnerSha256: provenance.runnerSha256,
      executionDependencies: provenance.executionDependencies,
      executionSetSha256: provenance.executionSetSha256,
      generatedAt: provenance.generatedAt,
      commit: provenance.commit,
      appBundleHash: provenance.appBundleHash,
      bundleIdentityAlgorithm: provenance.bundleIdentityAlgorithm,
      appPath: provenance.appPath,
      bundleIdentifier: provenance.bundleIdentifier,
      deviceId: provenance.deviceId,
      osVersion: provenance.osVersion,
    },
    installation,
  };
}

function verifyCurrentDeviceTrialEnvironment(deviceConfig) {
  let currentExecution;
  try {
    currentExecution = resolveCommittedDeviceExecution(deviceConfig.runnerPath, ROOT);
  } catch {
    blockedDevice("device runner or execution dependency changed or is no longer committed");
  }
  if (currentExecution.runnerSha256 !== deviceConfig.runnerSha256
    || currentExecution.executionSetSha256 !== deviceConfig.executionSetSha256) {
    blockedDevice("device execution set changed after provenance verification");
  }

  let installation;
  try {
    installation = verifyFormalAppInstallation(ROOT);
  } catch (error) {
    blockedDevice(error instanceof Error ? error.message : "formal_app_verification_failed");
  }
  const validated = validateDeviceTrialEnvironment(deviceConfig.provenance, {
    execution: currentExecution,
    installation,
  });
  if (!validated.ok) blockedDevice(validated.reason);
  return { currentExecution, installation };
}

function runDeviceTrial(scenario, deviceConfig, trial) {
  verifyCurrentDeviceTrialEnvironment(deviceConfig);
  const runner = spawnSync(deviceConfig.runnerPath, [
    "--scenario",
    scenario.id,
    "--trial",
    String(trial),
    "--provenance",
    deviceConfig.provenancePath,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, YISHU_E2E_DEVICE: "1" },
  });
  verifyCurrentDeviceTrialEnvironment(deviceConfig);
  const payload = parseRunnerJson(`${runner.stdout}\n${runner.stderr}`, scenario.id);
  const verification = verifyDeviceObservation(payload, {
    scenarioId: scenario.id,
    expectedContract: scenario.deviceContract,
    trial,
  });
  if (!verification.ok) blockedDevice(verification.reason);
  if (runner.status !== 0 && verification.trialStatus === "pass") {
    blockedDevice(`runner exited ${runner.status} while reporting a verified observation for ${scenario.id}`);
  }
  return {
    trialStatus: verification.trialStatus,
    falseCompletionCount: verification.falseCompletionCount,
    runnerExitStatus: runner.status,
  };
}

function runDeviceScenario(scenario, deviceConfig) {
  if (!Number.isInteger(scenario.repeat) || scenario.repeat < 1) {
    blockedDevice(`scenario ${scenario.id} must define a positive repeat count`);
  }
  const trials = [];
  for (let trial = 1; trial <= scenario.repeat; trial += 1) {
    trials.push(runDeviceTrial(scenario, deviceConfig, trial));
  }
  return aggregateDeviceTrials(scenario, trials);
}

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
const goldenScenario = deviceMode && only
  ? DEVICE_GOLDEN_SCENARIOS.find((scenario) => scenario.id === only)
  : undefined;
const selected = goldenScenario
  ? [goldenScenario]
  : only
    ? scenarios.filter((scenario) => scenario.id === only)
    : scenarios;
if (selected.length === 0) {
  console.error(`capability eval: scenario ${only} not found`);
  process.exit(1);
}

if (deviceMode && selected.some((scenario) => !scenario.deviceContract)) {
  blockedDevice("device mode requires one explicit device-golden scenario: device.t1.ptt, device.t2.ax, or device.t3.memory");
}

const deviceConfig = deviceMode ? loadDeviceConfig(selected) : undefined;
let oracle;
let results;
let missing = [];
if (deviceConfig) {
  results = selected.map((scenario) => runDeviceScenario(scenario, deviceConfig));
} else {
  const pattern = only ? `^oracle:${only}$` : "^oracle:";
  oracle = spawnSync("pnpm", [
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

  results = selected.map((scenario) => {
    const passed = oraclePassed.get(scenario.id) === true;
    return {
      id: scenario.id,
      category: scenario.category,
      evidenceKind: "mock",
      status: passed ? "implemented" : "failed",
      passed,
      falseCompletionCount: 0,
      forbidden: scenario.forbidden ?? [],
    };
  });
  missing = selected.filter((scenario) => !oraclePassed.has(scenario.id)).map((scenario) => scenario.id);
}

const failed = results.filter((item) => !item.passed).map((item) => item.id);
const falseCompletionCount = results.reduce((sum, item) => sum + item.falseCompletionCount, 0);
const report = {
  generatedAt: new Date().toISOString(),
  evidenceKind: deviceConfig ? "device" : "mock",
  scenarioCount: results.length,
  oracleStatus: oracle?.status ?? null,
  ...(deviceConfig ? { deviceProvenance: deviceConfig.provenance } : {}),
  ...(deviceConfig ? { deviceInstallation: deviceConfig.installation } : {}),
  ...(deviceConfig ? {
    trialCount: results.reduce((sum, item) => sum + item.trialCount, 0),
    passCount: results.reduce((sum, item) => sum + item.passCount, 0),
  } : {}),
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
  `- evidence: ${report.evidenceKind}`,
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
if (oracle && oracle.status !== 0) {
  console.error(oracle.stdout);
  console.error(oracle.stderr);
}
if (gate && (failed.length > 0 || missing.length > 0 || falseCompletionCount !== 0)) {
  process.exit(1);
}
if (oracle && oracle.status !== 0 && failed.length === 0 && missing.length === 0) {
  process.exit(oracle.status ?? 1);
}
