import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BUNDLE_IDENTITY_ALGORITHM,
  EXPECTED_BUNDLE_IDENTIFIER,
  FORMAL_APP_PATH,
  computeBundleIdentityHash,
  createDeviceEvalProvenance,
  parseCreateArguments,
  resolveCommittedDeviceExecution,
  resolveCommittedRunner,
  validateDeviceProvenance,
  validateInstalledAppReport,
  writeProvenanceFile,
} from "./create-device-eval-provenance.mjs";

const CURRENT_COMMIT = "1".repeat(40);
const SOURCE_INPUT_HASH = "2".repeat(64);
const BUNDLE_HASH = "3".repeat(64);
const RUNNER_HASH = "4".repeat(64);
const COLLECTOR_HASH = "6".repeat(64);
const VERIFIER_HASH = "7".repeat(64);
const EXECUTION_SET_HASH = "8".repeat(64);
const PROVENANCE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "create-device-eval-provenance.mjs");

function makeInstallation() {
  return {
    appPath: FORMAL_APP_PATH,
    bundleIdentifier: EXPECTED_BUNDLE_IDENTIFIER,
    version: "0.0.1",
    runningPidCount: 1,
    bundleIdentityAlgorithm: BUNDLE_IDENTITY_ALGORITHM,
    appBundleHash: BUNDLE_HASH,
    buildManifest: {
      commit: CURRENT_COMMIT,
      sourceInputHash: SOURCE_INPUT_HASH,
      worktreeDirty: false,
    },
  };
}

function makeProvenance(overrides = {}) {
  return {
    evidenceKind: "device",
    runnerPath: "/tmp/device-runner",
    runnerSha256: RUNNER_HASH,
    executionDependencies: [
      { path: "evals/capability/device/quality-observation-collector.mjs", sha256: COLLECTOR_HASH },
      { path: "evals/capability/device/trial-verifier.mjs", sha256: VERIFIER_HASH },
    ],
    executionSetSha256: EXECUTION_SET_HASH,
    generatedAt: "2026-08-29T00:00:00.000Z",
    commit: CURRENT_COMMIT,
    appBundleHash: BUNDLE_HASH,
    bundleIdentityAlgorithm: BUNDLE_IDENTITY_ALGORITHM,
    appPath: FORMAL_APP_PATH,
    bundleIdentifier: EXPECTED_BUNDLE_IDENTIFIER,
    deviceId: "test-device",
    osVersion: "test-os",
    ...overrides,
  };
}

function makeInstalledAppReport() {
  return {
    schemaVersion: 1,
    ok: true,
    appPath: FORMAL_APP_PATH,
    version: "0.0.1",
    bundleIdentifier: EXPECTED_BUNDLE_IDENTIFIER,
    runningPidCount: 1,
    hashes: { mainExecutable: "5".repeat(64) },
    checks: {
      app: { status: "passed" },
      bundleIdentifier: { status: "passed" },
      version: { status: "passed" },
      mainExecutable: { status: "passed" },
      codeSignature: { status: "passed" },
      runtime: { status: "passed" },
      node: { status: "passed" },
      voiceProxy: { status: "passed" },
      singleInstance: { status: "passed", max: 1 },
      running: { status: "passed", required: true },
      provenance: {
        status: "passed",
        manifest: {
          status: "passed",
          commit: CURRENT_COMMIT,
          worktreeDirty: false,
          sourceInputHash: SOURCE_INPUT_HASH,
        },
        commit: { status: "passed" },
        sourceInputHash: { status: "passed" },
        clean: { status: "passed", required: true },
      },
      runtimeSource: { status: "passed" },
    },
  };
}

test("device provenance accepts only the current formal installation identity", () => {
  const options = {
    runnerPath: "/tmp/device-runner",
    runnerSha256: RUNNER_HASH,
    executionDependencies: makeProvenance().executionDependencies,
    executionSetSha256: EXECUTION_SET_HASH,
    currentCommit: CURRENT_COMMIT,
    installation: makeInstallation(),
  };
  assert.deepEqual(validateDeviceProvenance(makeProvenance(), options), { ok: true });
  assert.equal(
    validateDeviceProvenance(makeProvenance({ appBundleHash: "not-empty-but-wrong" }), options).reason,
    "provenance_hash_invalid",
  );
  assert.equal(
    validateDeviceProvenance(makeProvenance({ appBundleHash: "9".repeat(64) }), options).reason,
    "provenance_app_bundle_hash_mismatch",
  );
  assert.equal(
    validateDeviceProvenance(makeProvenance({ appPath: "/tmp/other.app" }), options).reason,
    "provenance_app_path_mismatch",
  );
  assert.equal(
    validateDeviceProvenance(makeProvenance({ bundleIdentityAlgorithm: "other-v1" }), options).reason,
    "provenance_bundle_identity_algorithm_invalid",
  );
  assert.equal(
    validateDeviceProvenance(makeProvenance({
      executionDependencies: [{
        path: "evals/capability/device/quality-observation-collector.mjs",
        sha256: COLLECTOR_HASH,
      }],
    }), options).reason,
    "provenance_execution_dependencies_mismatch",
  );
  assert.equal(
    validateDeviceProvenance(makeProvenance({ executionSetSha256: "9".repeat(64) }), options).reason,
    "provenance_execution_set_hash_mismatch",
  );
});

test("provenance creator emits the exact safe identity contract", () => {
  const provenance = createDeviceEvalProvenance({
    runnerPath: "/tmp/device-runner",
    runnerSha256: RUNNER_HASH,
    executionDependencies: makeProvenance().executionDependencies,
    executionSetSha256: EXECUTION_SET_HASH,
    installation: makeInstallation(),
    deviceId: "host-test",
    osVersion: "darwin-24.6.0",
    generatedAt: "2026-08-29T00:00:00.000Z",
  });
  assert.deepEqual(provenance, {
    evidenceKind: "device",
    runnerPath: "/tmp/device-runner",
    runnerSha256: RUNNER_HASH,
    executionDependencies: makeProvenance().executionDependencies,
    executionSetSha256: EXECUTION_SET_HASH,
    generatedAt: "2026-08-29T00:00:00.000Z",
    commit: CURRENT_COMMIT,
    appBundleHash: BUNDLE_HASH,
    bundleIdentityAlgorithm: BUNDLE_IDENTITY_ALGORITHM,
    appPath: FORMAL_APP_PATH,
    bundleIdentifier: EXPECTED_BUNDLE_IDENTIFIER,
    deviceId: "host-test",
    osVersion: "darwin-24.6.0",
  });
});

test("device execution provenance binds runner, collector, and verifier to current HEAD bytes", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "yishu-device-execution-repo-"));
  const deviceRoot = path.join(repo, "evals/capability/device");
  const runner = path.join(deviceRoot, "runner.mjs");
  const collector = path.join(deviceRoot, "quality-observation-collector.mjs");
  const verifier = path.join(deviceRoot, "trial-verifier.mjs");
  try {
    mkdirSync(deviceRoot, { recursive: true });
    writeFileSync(runner, "#!/usr/bin/env node\nconsole.log('runner');\n");
    writeFileSync(collector, "export const collector = true;\n");
    writeFileSync(verifier, "export const verifier = true;\n");
    chmodSync(runner, 0o755);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "device-test@example.invalid"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Device Test"], { cwd: repo });
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });

    const resolved = resolveCommittedDeviceExecution(runner, repo);
    assert.equal(resolved.runnerPath, realpathSync(runner));
    assert.match(resolved.runnerSha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(resolved.executionDependencies.map((entry) => entry.path), [
      "evals/capability/device/quality-observation-collector.mjs",
      "evals/capability/device/trial-verifier.mjs",
    ]);
    assert.ok(resolved.executionDependencies.every((entry) => /^[0-9a-f]{64}$/u.test(entry.sha256)));
    assert.match(resolved.executionSetSha256, /^[0-9a-f]{64}$/u);

    writeFileSync(collector, "export const collector = false;\n");
    assert.throws(
      () => resolveCommittedDeviceExecution(runner, repo),
      /execution_dependency_not_current_commit/,
    );
    writeFileSync(collector, "export const collector = true;\n");
    writeFileSync(verifier, "export const verifier = false;\n");
    assert.throws(
      () => resolveCommittedDeviceExecution(runner, repo),
      /execution_dependency_not_current_commit/,
    );
    writeFileSync(verifier, "export const verifier = true;\n");
    writeFileSync(runner, "#!/usr/bin/env node\nconsole.log('changed');\n");
    assert.throws(
      () => resolveCommittedDeviceExecution(runner, repo),
      /runner_not_current_commit/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("provenance CLI arguments require absolute runner and output paths", () => {
  assert.deepEqual(
    parseCreateArguments(["--runner", "/tmp/runner", "--output", "/tmp/provenance.json"]),
    { help: false, runner: "/tmp/runner", output: "/tmp/provenance.json" },
  );
  assert.throws(() => parseCreateArguments(["--runner", "runner", "--output", "/tmp/p.json"]), /runner_must_be_absolute/);
  assert.throws(() => parseCreateArguments(["--runner", "/tmp/runner", "--output", "p.json"]), /output_must_be_absolute/);
});

test("provenance CLI exposes the safe create entrypoint", () => {
  const result = spawnSync(process.execPath, [PROVENANCE_SCRIPT, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--runner ABS_EXECUTABLE --output NEW_JSON_PATH/);
  assert.match(result.stdout, /tracked under evals\/capability\/device/);
});

test("provenance CLI refuses an uncommitted runner without creating output", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "yishu-device-cli-"));
  const runner = path.join(temp, "runner");
  const output = path.join(temp, "provenance.json");
  try {
    writeFileSync(runner, "#!/bin/sh\n");
    chmodSync(runner, 0o755);
    const result = spawnSync(process.execPath, [
      PROVENANCE_SCRIPT,
      "--runner",
      runner,
      "--output",
      output,
    ], { encoding: "utf8" });
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /runner_not_canonical/);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("provenance writer never overwrites an existing output", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "yishu-device-provenance-"));
  const output = path.join(temp, "provenance.json");
  try {
    writeFileSync(output, "keep\n");
    assert.throws(
      () => writeProvenanceFile(output, { evidenceKind: "device" }),
      /output_exists/,
    );
    assert.equal(readFileSync(output, "utf8"), "keep\n");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("provenance writer creates a private JSON file", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "yishu-device-provenance-"));
  const output = path.join(temp, "provenance.json");
  try {
    writeProvenanceFile(output, { evidenceKind: "device", deviceId: "hashed-device" });
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), {
      evidenceKind: "device",
      deviceId: "hashed-device",
    });
    assert.equal(statSync(output).mode & 0o777, 0o600);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("runner provenance rejects an executable outside the committed device runner tree", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "yishu-device-runner-"));
  const runner = path.join(temp, "runner");
  try {
    writeFileSync(runner, "#!/bin/sh\n");
    chmodSync(runner, 0o755);
    assert.throws(() => resolveCommittedRunner(runner), /runner_not_canonical/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("installed app report requires exactly one process and clean current build provenance", () => {
  const valid = validateInstalledAppReport(makeInstalledAppReport(), { currentCommit: CURRENT_COMMIT });
  assert.equal(valid.ok, true);
  assert.equal(valid.installation.bundleIdentityAlgorithm, BUNDLE_IDENTITY_ALGORITHM);

  const duplicate = makeInstalledAppReport();
  duplicate.runningPidCount = 2;
  duplicate.checks.singleInstance.status = "failed";
  assert.equal(
    validateInstalledAppReport(duplicate, { currentCommit: CURRENT_COMMIT }).reason,
    "installed_app_verification_failed",
  );

  const dirty = makeInstalledAppReport();
  dirty.checks.provenance.manifest.worktreeDirty = true;
  assert.equal(
    validateInstalledAppReport(dirty, { currentCommit: CURRENT_COMMIT }).reason,
    "installed_app_manifest_not_clean_current",
  );

  const stale = makeInstalledAppReport();
  stale.checks.provenance.manifest.commit = "9".repeat(40);
  assert.equal(
    validateInstalledAppReport(stale, { currentCommit: CURRENT_COMMIT }).reason,
    "installed_app_manifest_not_clean_current",
  );
});

test("bundle identity hash is deterministic and covers files, directories, and in-bundle symlinks", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "yishu-device-bundle-"));
  try {
    mkdirSync(path.join(temp, "Contents", "Resources"), { recursive: true });
    writeFileSync(path.join(temp, "Contents", "Info.plist"), "fixture-info\n");
    writeFileSync(path.join(temp, "Contents", "Resources", "data.txt"), "alpha\n");
    symlinkSync("../Info.plist", path.join(temp, "Contents", "Resources", "Info-link.plist"));
    const first = computeBundleIdentityHash(temp);
    assert.match(first, /^[0-9a-f]{64}$/u);
    assert.equal(first, computeBundleIdentityHash(temp));
    writeFileSync(path.join(temp, "Contents", "Resources", "data.txt"), "beta\n");
    assert.notEqual(first, computeBundleIdentityHash(temp));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("bundle identity hash rejects a symlink that escapes the app bundle", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "yishu-device-bundle-"));
  const outsideRoot = mkdtempSync(path.join(tmpdir(), "yishu-device-outside-"));
  const outside = path.join(outsideRoot, "outside.txt");
  try {
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, path.join(temp, "escape"));
    assert.throws(() => computeBundleIdentityHash(temp), /bundle_symlink_unreadable/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});
