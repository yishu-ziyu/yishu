#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyDeviceTrial } from "../evals/capability/device/trial-verifier.mjs";

export const FORMAL_APP_PATH = "/Applications/奕枢.app";
export const EXPECTED_BUNDLE_IDENTIFIER = "com.yishu.yishu-buddy";
export const BUNDLE_IDENTITY_ALGORITHM = "yishu-app-bundle-v1";
export const DEVICE_EXECUTION_IDENTITY_ALGORITHM = "yishu-device-execution-v1";
export const DEVICE_EXECUTION_DEPENDENCY_PATHS = Object.freeze([
  "evals/capability/device/quality-observation-collector.mjs",
  "evals/capability/device/trial-verifier.mjs",
]);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const DEVICE_CONTRACTS = new Set(["t1.ptt", "t2.ax", "t3.memory"]);

export const DEVICE_GOLDEN_SCENARIOS = Object.freeze([
  Object.freeze({ id: "device.t1.ptt", category: "device", deviceContract: "t1.ptt", repeat: 10, forbidden: [] }),
  Object.freeze({ id: "device.t2.ax", category: "device", deviceContract: "t2.ax", repeat: 10, forbidden: [] }),
  Object.freeze({ id: "device.t3.memory", category: "device", deviceContract: "t3.memory", repeat: 10, forbidden: [] }),
]);

function failedValidation(reason) {
  return { ok: false, reason };
}

/**
 * Verifies one runner observation before it can enter device trial aggregation.
 * The runner supplies only raw, content-safe events; the verifier derives pass
 * and failure signals and rejects caller-supplied aggregate truth fields.
 */
export function verifyDeviceObservation(
  observation,
  {
    scenarioId,
    expectedContract,
    trial,
  } = {},
) {
  if (typeof expectedContract !== "string") return failedValidation("device_contract_required");
  if (!DEVICE_CONTRACTS.has(expectedContract)) return failedValidation("device_contract_unsupported");
  if (observation?.contract !== expectedContract) {
    return failedValidation("device_observation_contract_mismatch");
  }
  if (observation?.trialId !== `${scenarioId}-${trial}`) {
    return failedValidation("device_observation_trial_mismatch");
  }
  const verification = verifyDeviceTrial(observation);
  if (verification.status === "invalid") {
    return failedValidation(`device_observation_invalid:${verification.reasons[0] ?? "schema"}`);
  }
  const falseCompletionCount = Array.isArray(observation.events)
    ? observation.events.filter((event) => event.kind === "false_completion").length
    : 0;
  return {
    ok: true,
    trialStatus: verification.status,
    falseCompletionCount,
    reasons: verification.reasons,
  };
}

/**
 * Hashes the sorted bundle tree (path, type, size/content digest, or symlink target).
 * It intentionally excludes mtimes and permissions so a copied signed bundle has
 * the same identity while any executable/resource bytes change the digest.
 */
export function computeBundleIdentityHash(appPath) {
  const requestedRoot = path.resolve(appPath);
  let rootPath = requestedRoot;
  const entries = [];

  function visit(currentPath, relativeDirectory) {
    let directoryEntries;
    try {
      directoryEntries = readdirSync(currentPath, { withFileTypes: true });
    } catch {
      throw new Error("bundle_directory_unreadable");
    }
    directoryEntries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of directoryEntries) {
      const relativePath = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        let target;
        try {
          target = readlinkSync(absolutePath);
          const resolvedTarget = realpathSync(absolutePath);
          const relativeTarget = path.relative(rootPath, resolvedTarget);
          if (relativeTarget === ".."
            || relativeTarget.startsWith(`..${path.sep}`)
            || path.isAbsolute(relativeTarget)) {
            throw new Error("bundle_symlink_outside");
          }
        } catch {
          throw new Error("bundle_symlink_unreadable");
        }
        entries.push({ type: "symlink", path: relativePath.split(path.sep).join("/"), target });
      } else if (entry.isDirectory()) {
        entries.push({ type: "directory", path: relativePath.split(path.sep).join("/") });
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        let bytes;
        try {
          bytes = readFileSync(absolutePath);
        } catch {
          throw new Error("bundle_file_unreadable");
        }
        entries.push({
          type: "file",
          path: relativePath.split(path.sep).join("/"),
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } else {
        throw new Error("bundle_entry_unsupported");
      }
    }
  }

  let rootStats;
  try {
    rootStats = lstatSync(requestedRoot);
  } catch {
    throw new Error("bundle_missing");
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("bundle_not_directory");
  }
  try {
    rootPath = realpathSync(requestedRoot);
  } catch {
    throw new Error("bundle_unreadable");
  }
  entries.push({ type: "directory", path: "" });
  visit(rootPath, "");
  entries.sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    return left.type < right.type ? -1 : left.type > right.type ? 1 : 0;
  });

  const digest = createHash("sha256");
  digest.update(`${BUNDLE_IDENTITY_ALGORITHM}\0`, "utf8");
  for (const entry of entries) digest.update(`${JSON.stringify(entry)}\n`, "utf8");
  return digest.digest("hex");
}

export function validateInstalledAppReport(
  report,
  {
    appPath = FORMAL_APP_PATH,
    bundleIdentifier = EXPECTED_BUNDLE_IDENTIFIER,
    currentCommit: expectedCommit,
  } = {},
) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return failedValidation("installed_app_report_invalid");
  }
  if (report.appPath !== appPath || report.bundleIdentifier !== bundleIdentifier) {
    return failedValidation("installed_app_identity_mismatch");
  }
  if (report.ok !== true || report.runningPidCount !== 1) {
    return failedValidation("installed_app_verification_failed");
  }
  const checks = report.checks;
  for (const name of [
    "app",
    "bundleIdentifier",
    "version",
    "mainExecutable",
    "codeSignature",
    "runtime",
    "node",
    "voiceProxy",
    "singleInstance",
    "running",
    "provenance",
    "runtimeSource",
  ]) {
    if (checks?.[name]?.status !== "passed") {
      return failedValidation(`installed_app_check_failed:${name}`);
    }
  }

  const buildProvenance = checks?.provenance;
  const manifest = buildProvenance?.manifest;
  const manifestPassed = checks.singleInstance?.max === 1
    && checks.running?.required === true
    && buildProvenance.commit?.status === "passed"
    && buildProvenance.sourceInputHash?.status === "passed"
    && buildProvenance.clean?.status === "passed"
    && buildProvenance.clean?.required === true
    && manifest?.status === "passed"
    && manifest?.commit === expectedCommit
    && manifest?.worktreeDirty === false
    && SHA256_PATTERN.test(manifest?.sourceInputHash ?? "");
  if (!manifestPassed) return failedValidation("installed_app_manifest_not_clean_current");

  return {
    ok: true,
    installation: {
      appPath,
      bundleIdentifier,
      version: report.version,
      runningPidCount: report.runningPidCount,
      bundleIdentityAlgorithm: BUNDLE_IDENTITY_ALGORITHM,
      buildManifest: {
        commit: manifest.commit,
        sourceInputHash: manifest.sourceInputHash,
        worktreeDirty: manifest.worktreeDirty,
      },
    },
  };
}

export function validateDeviceProvenance(
  provenance,
  {
    runnerPath,
    runnerSha256,
    executionDependencies,
    executionSetSha256,
    currentCommit: expectedCommit,
    installation,
  } = {},
) {
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    return failedValidation("provenance_shape_invalid");
  }
  if (provenance.evidenceKind !== "device") return failedValidation("provenance_evidence_kind_invalid");
  if (provenance.runnerPath !== runnerPath) return failedValidation("provenance_runner_path_mismatch");
  if (provenance.runnerSha256 !== runnerSha256) return failedValidation("provenance_runner_hash_mismatch");
  if (!Array.isArray(provenance.executionDependencies)
    || !Array.isArray(executionDependencies)
    || provenance.executionDependencies.length !== executionDependencies.length
    || provenance.executionDependencies.some((entry, index) => (
      !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || Object.keys(entry).length !== 2
      || entry.path !== executionDependencies[index]?.path
      || entry.sha256 !== executionDependencies[index]?.sha256
      || !SHA256_PATTERN.test(entry.sha256 ?? "")
    ))) {
    return failedValidation("provenance_execution_dependencies_mismatch");
  }
  if (provenance.executionSetSha256 !== executionSetSha256) {
    return failedValidation("provenance_execution_set_hash_mismatch");
  }
  for (const field of [
    "generatedAt",
    "commit",
    "appBundleHash",
    "bundleIdentityAlgorithm",
    "appPath",
    "bundleIdentifier",
    "deviceId",
    "osVersion",
  ]) {
    if (typeof provenance[field] !== "string" || provenance[field].length === 0) {
      return failedValidation(`provenance_field_missing:${field}`);
    }
  }
  if (!SHA256_PATTERN.test(provenance.runnerSha256)
    || !SHA256_PATTERN.test(provenance.executionSetSha256 ?? "")
    || !SHA256_PATTERN.test(provenance.appBundleHash)) {
    return failedValidation("provenance_hash_invalid");
  }
  if (provenance.bundleIdentityAlgorithm !== BUNDLE_IDENTITY_ALGORITHM) {
    return failedValidation("provenance_bundle_identity_algorithm_invalid");
  }
  if (!Number.isFinite(Date.parse(provenance.generatedAt))) {
    return failedValidation("provenance_generated_at_invalid");
  }
  if (provenance.commit !== expectedCommit) return failedValidation("provenance_commit_mismatch");
  if (!installation
    || installation.appPath !== FORMAL_APP_PATH
    || installation.bundleIdentifier !== EXPECTED_BUNDLE_IDENTIFIER
    || installation.runningPidCount !== 1
    || installation.bundleIdentityAlgorithm !== BUNDLE_IDENTITY_ALGORITHM
    || !SHA256_PATTERN.test(installation.appBundleHash ?? "")
    || installation.buildManifest?.commit !== expectedCommit
    || installation.buildManifest?.worktreeDirty !== false
    || !SHA256_PATTERN.test(installation.buildManifest?.sourceInputHash ?? "")) {
    return failedValidation("installed_app_identity_or_manifest_invalid");
  }
  if (provenance.appPath !== installation.appPath) {
    return failedValidation("provenance_app_path_mismatch");
  }
  if (provenance.bundleIdentifier !== installation.bundleIdentifier) {
    return failedValidation("provenance_bundle_identifier_mismatch");
  }
  if (provenance.appBundleHash !== installation.appBundleHash) {
    return failedValidation("provenance_app_bundle_hash_mismatch");
  }
  return { ok: true };
}

export function validateDeviceTrialEnvironment(
  provenance,
  {
    execution,
    installation,
  } = {},
) {
  if (!execution || !installation) return failedValidation("device_trial_environment_missing");
  return validateDeviceProvenance(provenance, {
    runnerPath: execution.runnerPath,
    runnerSha256: execution.runnerSha256,
    executionDependencies: execution.executionDependencies,
    executionSetSha256: execution.executionSetSha256,
    currentCommit: installation.buildManifest?.commit,
    installation,
  });
}

function sha256File(filePath) {
  try {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    throw new Error("runner_unreadable");
  }
}

function pathIsWithin(rootPath, candidatePath) {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath !== ""
    && relativePath !== ".."
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
}

function currentGitHead(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "--verify", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  const head = result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (!FULL_COMMIT_PATTERN.test(head)) throw new Error("current_head_unavailable");
  return head;
}

function verifierEnvironment() {
  return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
}

function committedFileSha256(repoRoot, relativePath, errorCode) {
  const result = spawnSync("git", ["-C", repoRoot, "cat-file", "blob", `HEAD:${relativePath}`], {
    cwd: repoRoot,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) throw new Error(errorCode);
  return createHash("sha256").update(result.stdout).digest("hex");
}

function executionSetHash(entries) {
  const digest = createHash("sha256");
  digest.update(`${DEVICE_EXECUTION_IDENTITY_ALGORITHM}\0`, "utf8");
  for (const entry of entries) digest.update(`${JSON.stringify(entry)}\n`, "utf8");
  return digest.digest("hex");
}

export function resolveCommittedRunner(runnerInput, repoRoot = DEFAULT_REPO_ROOT) {
  if (typeof runnerInput !== "string" || !path.isAbsolute(runnerInput)) {
    throw new Error("runner_must_be_absolute");
  }
  let runnerPath;
  try {
    const stats = lstatSync(runnerInput);
    if (!stats.isFile()) throw new Error("runner_not_file");
    accessSync(runnerInput, fsConstants.X_OK);
    runnerPath = realpathSync(runnerInput);
  } catch {
    throw new Error("runner_not_executable");
  }
  let canonicalRepoRoot;
  try {
    canonicalRepoRoot = realpathSync(repoRoot);
  } catch {
    throw new Error("repo_root_unreadable");
  }
  const canonicalRunnerRoot = path.resolve(canonicalRepoRoot, "evals/capability/device");
  if (!pathIsWithin(canonicalRunnerRoot, runnerPath)) throw new Error("runner_not_canonical");
  const runnerSha256 = sha256File(runnerPath);
  const relativeRunnerPath = path.relative(canonicalRepoRoot, runnerPath).split(path.sep).join("/");
  if (committedFileSha256(canonicalRepoRoot, relativeRunnerPath, "runner_not_current_commit") !== runnerSha256) {
    throw new Error("runner_not_current_commit");
  }
  return { runnerPath, runnerSha256 };
}

export function resolveCommittedDeviceExecution(runnerInput, repoRoot = DEFAULT_REPO_ROOT) {
  let canonicalRepoRoot;
  try {
    canonicalRepoRoot = realpathSync(repoRoot);
  } catch {
    throw new Error("repo_root_unreadable");
  }
  const runner = resolveCommittedRunner(runnerInput, canonicalRepoRoot);
  const executionDependencies = DEVICE_EXECUTION_DEPENDENCY_PATHS.map((relativePath) => {
    const dependencyPath = path.resolve(canonicalRepoRoot, relativePath);
    const canonicalDeviceRoot = path.resolve(canonicalRepoRoot, "evals/capability/device");
    let resolvedPath;
    try {
      const stats = lstatSync(dependencyPath);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("execution_dependency_not_file");
      resolvedPath = realpathSync(dependencyPath);
    } catch {
      throw new Error("execution_dependency_unreadable");
    }
    if (!pathIsWithin(canonicalDeviceRoot, resolvedPath)) {
      throw new Error("execution_dependency_not_canonical");
    }
    const sha256 = sha256File(resolvedPath);
    if (committedFileSha256(canonicalRepoRoot, relativePath, "execution_dependency_not_current_commit") !== sha256) {
      throw new Error("execution_dependency_not_current_commit");
    }
    return Object.freeze({ path: relativePath, sha256 });
  });
  const relativeRunnerPath = path.relative(canonicalRepoRoot, runner.runnerPath).split(path.sep).join("/");
  const executionSetSha256 = executionSetHash([
    { path: relativeRunnerPath, sha256: runner.runnerSha256 },
    ...executionDependencies,
  ]);
  return { ...runner, executionDependencies, executionSetSha256 };
}

export function verifyFormalAppInstallation(repoRoot = DEFAULT_REPO_ROOT) {
  let resolvedAppPath;
  try {
    resolvedAppPath = realpathSync(FORMAL_APP_PATH);
  } catch {
    throw new Error("formal_app_unreadable");
  }
  if (resolvedAppPath !== FORMAL_APP_PATH) throw new Error("formal_app_path_mismatch");

  const expectedCommit = currentGitHead(repoRoot);
  const verification = spawnSync(process.execPath, [
    path.join(repoRoot, "script/verify-installed-yishu-app.mjs"),
    "--app-path",
    FORMAL_APP_PATH,
    "--repo-root",
    repoRoot,
    "--require-running",
    "--require-clean-provenance",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: verifierEnvironment(),
    maxBuffer: 256 * 1024,
  });
  if (verification.error || verification.status === null) throw new Error("formal_app_verification_unavailable");
  if (verification.status !== 0) throw new Error("formal_app_verification_failed");

  let report;
  try {
    report = JSON.parse(verification.stdout);
  } catch {
    throw new Error("formal_app_report_invalid");
  }
  const validated = validateInstalledAppReport(report, {
    appPath: FORMAL_APP_PATH,
    bundleIdentifier: EXPECTED_BUNDLE_IDENTIFIER,
    currentCommit: expectedCommit,
  });
  if (!validated.ok) throw new Error(validated.reason);
  let appBundleHash;
  try {
    appBundleHash = computeBundleIdentityHash(FORMAL_APP_PATH);
  } catch {
    throw new Error("formal_app_bundle_hash_unavailable");
  }
  return { ...validated.installation, appBundleHash };
}

export function createDeviceEvalProvenance({
  runnerPath,
  runnerSha256,
  executionDependencies,
  executionSetSha256,
  installation,
  deviceId,
  osVersion,
  generatedAt = new Date().toISOString(),
}) {
  if (!installation || !deviceId || !osVersion) throw new Error("provenance_metadata_missing");
  return {
    evidenceKind: "device",
    runnerPath,
    runnerSha256,
    executionDependencies,
    executionSetSha256,
    generatedAt,
    commit: installation.buildManifest.commit,
    appBundleHash: installation.appBundleHash,
    bundleIdentityAlgorithm: installation.bundleIdentityAlgorithm,
    appPath: installation.appPath,
    bundleIdentifier: installation.bundleIdentifier,
    deviceId,
    osVersion,
  };
}

export function parseCreateArguments(rawArguments) {
  let runner;
  let output;
  for (let index = 0; index < rawArguments.length; index += 1) {
    const argument = rawArguments[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument !== "--runner" && argument !== "--output") throw new Error("unknown_argument");
    const value = rawArguments[index + 1];
    if (!value || value.startsWith("-")) throw new Error(`missing_${argument.slice(2)}`);
    if (argument === "--runner") {
      if (runner !== undefined) throw new Error("duplicate_runner");
      runner = value;
    } else {
      if (output !== undefined) throw new Error("duplicate_output");
      output = value;
    }
    index += 1;
  }
  if (!runner || !output) throw new Error("runner_and_output_required");
  if (!path.isAbsolute(runner)) throw new Error("runner_must_be_absolute");
  if (!path.isAbsolute(output)) throw new Error("output_must_be_absolute");
  return { help: false, runner, output };
}

function safeDeviceMetadata() {
  const host = os.hostname();
  if (!host) throw new Error("device_id_unavailable");
  const deviceId = `host-${createHash("sha256").update(host, "utf8").digest("hex").slice(0, 32)}`;
  const osVersion = `${os.platform()}-${os.release()}`;
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(osVersion)) throw new Error("os_version_unavailable");
  return { deviceId, osVersion };
}

export function writeProvenanceFile(outputPath, provenance) {
  try {
    lstatSync(outputPath);
    throw new Error("output_exists");
  } catch (error) {
    if (error instanceof Error && error.message === "output_exists") throw error;
    if (error?.code !== "ENOENT") throw new Error("output_unavailable");
  }
  try {
    writeFileSync(outputPath, `${JSON.stringify(provenance, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("output_exists");
    throw new Error("output_write_failed");
  }
}

export function aggregateDeviceTrials(scenario, trials) {
  const passCount = trials.filter((item) => item.trialStatus === "pass").length;
  const falseCompletionCount = trials.reduce((sum, item) => sum + item.falseCompletionCount, 0);
  const trialCount = trials.length;
  const passed = trialCount === scenario.repeat
    && passCount === trialCount
    && falseCompletionCount === 0;
  return {
    id: scenario.id,
    category: scenario.category,
    evidenceKind: "device",
    status: passed ? "accepted" : "failed",
    passed,
    trialCount,
    passCount,
    falseCompletionCount,
    forbidden: scenario.forbidden ?? [],
    runnerExitStatus: trials.at(-1)?.runnerExitStatus ?? null,
  };
}

function printCreateHelp() {
  process.stdout.write([
    "Usage: node script/create-device-eval-provenance.mjs --runner ABS_EXECUTABLE --output NEW_JSON_PATH",
    "",
    "The formal /Applications/奕枢.app must be running exactly once and have a clean current build manifest.",
    "The runner must be executable, tracked under evals/capability/device, and byte-identical to the current HEAD.",
    "The output is created with exclusive write semantics and is never overwritten.",
    "",
  ].join("\n"));
}

function main() {
  let options;
  try {
    options = parseCreateArguments(process.argv.slice(2));
    if (options.help) {
      printCreateHelp();
      return;
    }
    const {
      runnerPath,
      runnerSha256,
      executionDependencies,
      executionSetSha256,
    } = resolveCommittedDeviceExecution(options.runner, DEFAULT_REPO_ROOT);
    const installation = verifyFormalAppInstallation(DEFAULT_REPO_ROOT);
    const metadata = safeDeviceMetadata();
    const provenance = createDeviceEvalProvenance({
      runnerPath,
      runnerSha256,
      executionDependencies,
      executionSetSha256,
      installation,
      ...metadata,
    });
    writeProvenanceFile(options.output, provenance);
    process.stdout.write(`device provenance created at ${options.output}\n`);
  } catch (error) {
    process.stderr.write(`device provenance blocked: ${error instanceof Error ? error.message : "generation_failed"}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
