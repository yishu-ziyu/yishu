import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  BUILD_PROVENANCE_SCHEMA_VERSION,
  sourceInputHash,
} from "./build-provenance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "script/verify-installed-yishu-app.mjs");
const CURRENT_HEAD = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
  cwd: ROOT,
  encoding: "utf8",
}).stdout.trim();
const CURRENT_SOURCE_INPUT_HASH = sourceInputHash(ROOT);
const tempRoots = [];

test.afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeExecutable(filePath, content) {
  writeFileSync(filePath, content, "utf8");
  chmodSync(filePath, 0o755);
}

function makeProvenanceRepoFixture(repoRoot) {
  const appSource = path.join(repoRoot, "apps", "clicky", "leanring-buddy");
  mkdirSync(appSource, { recursive: true });
  writeFileSync(path.join(appSource, "Fixture.swift"), "struct Fixture {}\n", "utf8");
  writeFileSync(path.join(appSource, "Info.plist"), "fixture plist\n", "utf8");
  writeFileSync(path.join(appSource, "Fixture.entitlements"), "fixture entitlements\n", "utf8");
  mkdirSync(path.join(repoRoot, "apps", "clicky", "leanring-buddy.xcodeproj"), { recursive: true });
  writeFileSync(
    path.join(repoRoot, "apps", "clicky", "leanring-buddy.xcodeproj", "project.pbxproj"),
    "fixture project\n",
    "utf8",
  );
  mkdirSync(path.join(repoRoot, "packages", "runtime", "src"), { recursive: true });
  writeFileSync(
    path.join(repoRoot, "packages", "runtime", "src", "assistant-output.ts"),
    "export const fixture = true;\n",
    "utf8",
  );
  mkdirSync(path.join(repoRoot, "packages", "kernel", "src"), { recursive: true });
  writeFileSync(path.join(repoRoot, "packages", "kernel", "src", "fixture.ts"), "export {};\n", "utf8");
  const worker = path.join(repoRoot, "apps", "clicky", "worker");
  mkdirSync(worker, { recursive: true });
  writeFileSync(path.join(worker, "local-server.mjs"), "fixture voice proxy\n", "utf8");
  writeFileSync(path.join(worker, "stepfun-hotwords.mjs"), "fixture hotwords\n", "utf8");
}

function makeFixture({
  bundleIdentifier = "com.yishu.yishu-buddy",
  bundleVersion = "1",
  shortVersion = "0.0.1",
  executableName = "奕枢",
  includeRuntime = true,
  provenance = {},
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "yishu-installed-app-test-"));
  tempRoots.push(root);
  const appPath = path.join(root, "Fixture.app");
  const repoRoot = path.join(root, "repo");
  makeProvenanceRepoFixture(repoRoot);
  const contents = path.join(appPath, "Contents");
  const macOS = path.join(contents, "MacOS");
  const resources = path.join(contents, "Resources");
  mkdirSync(macOS, { recursive: true });
  mkdirSync(resources, { recursive: true });
  writeFileSync(
    path.join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleIdentifier}</string>
<key>CFBundleShortVersionString</key><string>${shortVersion}</string>
<key>CFBundleVersion</key><string>${bundleVersion}</string>
<key>CFBundleExecutable</key><string>${executableName}</string>
</dict></plist>
`,
    "utf8",
  );
  makeExecutable(path.join(macOS, executableName), "fixture executable\n");

  const runtimeRoot = path.join(resources, "YishuRuntime");
  const runtimeSrc = path.join(runtimeRoot, "runtime", "src");
  if (includeRuntime) {
    mkdirSync(path.join(runtimeRoot, "bin"), { recursive: true });
    mkdirSync(path.join(runtimeRoot, "runtime", "dist"), { recursive: true });
    mkdirSync(runtimeSrc, { recursive: true });
    makeExecutable(path.join(runtimeRoot, "bin", "node"), "fixture node\n");
    writeFileSync(path.join(runtimeRoot, "runtime", "package.json"), "{\"name\":\"fixture-runtime\"}\n", "utf8");
    writeFileSync(path.join(runtimeRoot, "runtime", "dist", "stdio-server.js"), "fixture runtime\n", "utf8");
    writeFileSync(path.join(runtimeSrc, "assistant-output.ts"), "export const fixture = true;\n", "utf8");
    writeFileSync(path.join(runtimeSrc, "generated.map"), "fixture generated output\n", "utf8");
  }
  const voiceProxy = path.join(resources, "YishuVoiceProxy");
  mkdirSync(voiceProxy, { recursive: true });
  writeFileSync(path.join(voiceProxy, "local-server.mjs"), "fixture voice proxy\n", "utf8");
  writeFileSync(path.join(voiceProxy, "stepfun-hotwords.mjs"), "fixture hotwords\n", "utf8");
  writeFileSync(
    path.join(resources, "YishuBuildManifest.json"),
    `${JSON.stringify({
      schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION,
      commit: CURRENT_HEAD,
      worktreeDirty: false,
      sourceInputHash: CURRENT_SOURCE_INPUT_HASH,
      ...provenance,
    })}\n`,
    "utf8",
  );

  const commandDir = path.join(root, "commands");
  mkdirSync(commandDir, { recursive: true });
  makeExecutable(
    path.join(commandDir, "plutil"),
    `#!/usr/bin/env node
const key = process.argv.find((value) => ["CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion", "CFBundleExecutable"].includes(value));
const values = {
  CFBundleIdentifier: process.env.MOCK_BUNDLE_ID,
  CFBundleShortVersionString: process.env.MOCK_SHORT_VERSION,
  CFBundleVersion: process.env.MOCK_BUNDLE_VERSION,
  CFBundleExecutable: process.env.MOCK_EXECUTABLE,
};
if (!key || values[key] === undefined) process.exit(1);
process.stdout.write(values[key] + "\\n");
`,
  );
  makeExecutable(
    path.join(commandDir, "codesign"),
    "#!/usr/bin/env node\nprocess.exit(Number(process.env.MOCK_CODESIGN_STATUS || 0));\n",
  );
  makeExecutable(
    path.join(commandDir, "pgrep"),
    "#!/usr/bin/env node\nprocess.stdout.write(process.env.MOCK_PGREP_OUTPUT || \"\");\nprocess.exit(Number(process.env.MOCK_PGREP_STATUS || (process.env.MOCK_PGREP_OUTPUT ? 0 : 1)));\n",
  );
  makeExecutable(
    path.join(commandDir, "git"),
    `#!/usr/bin/env node
if (process.argv.includes("rev-parse")) {
  process.stdout.write(${JSON.stringify(CURRENT_HEAD)} + "\\n");
} else if (process.argv.includes("status")) {
  process.stdout.write("\\n");
} else {
  process.exit(1);
}
`,
  );

  return {
    root,
    appPath,
    commandDir,
    repoRoot: path.join(root, "repo"),
    env: {
      PATH: `${commandDir}:${process.env.PATH ?? ""}`,
      MOCK_BUNDLE_ID: bundleIdentifier,
      MOCK_SHORT_VERSION: shortVersion,
      MOCK_BUNDLE_VERSION: bundleVersion,
      MOCK_EXECUTABLE: executableName,
      MOCK_CODESIGN_STATUS: "0",
      MOCK_PGREP_STATUS: "1",
      MOCK_PGREP_OUTPUT: "",
    },
  };
}

function runVerifier(fixture, extraArgs = [], extraEnv = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, fixture.appPath, ...extraArgs], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...fixture.env, ...extraEnv },
  });
  return {
    ...result,
    report: result.stdout.trim() ? JSON.parse(result.stdout) : null,
  };
}

function updateManifest(fixture, repoRoot, overrides = {}) {
  writeFileSync(
    path.join(fixture.appPath, "Contents", "Resources", "YishuBuildManifest.json"),
    `${JSON.stringify({
      schemaVersion: BUILD_PROVENANCE_SCHEMA_VERSION,
      commit: CURRENT_HEAD,
      worktreeDirty: false,
      sourceInputHash: sourceInputHash(repoRoot),
      ...overrides,
    })}\n`,
    "utf8",
  );
}

function assertNoPrivateContent(report) {
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /transcript|screenshot|password|authorization|token|stderr|stdout/i);
}

test("fails closed when the requested app does not exist", () => {
  const fixture = makeFixture();
  const result = runVerifier({ ...fixture, appPath: path.join(fixture.root, "Missing.app") });

  assert.notEqual(result.status, 0, result.output);
  assert.equal(result.report?.ok, false);
  assert.equal(result.report?.checks?.app?.status, "failed");
  assertNoPrivateContent(result.report);
});

test("accepts a complete static fixture and emits only safe installation evidence", () => {
  const fixture = makeFixture();
  const result = runVerifier(fixture);

  assert.equal(result.status, 0, result.output);
  assert.equal(result.report?.ok, true);
  assert.equal(result.report?.bundleIdentifier, "com.yishu.yishu-buddy");
  assert.equal(result.report?.version, "0.0.1");
  assert.equal(result.report?.checks?.codeSignature?.status, "passed");
  assert.equal(result.report?.checks?.runtime?.status, "passed");
  assert.equal(result.report?.checks?.node?.status, "passed");
  assert.equal(result.report?.checks?.voiceProxy?.status, "passed");
  assert.equal(result.report?.checks?.runtime?.files?.voiceProxyHotwords?.status, "passed");
  assert.equal(result.report?.checks?.provenance?.status, "passed");
  assert.equal(result.report?.checks?.provenance?.worktreeDirty, false);
  assert.equal(result.report?.checks?.singleInstance?.status, "passed");
  assert.equal(result.report?.runningPidCount, 0);
  assertNoPrivateContent(result.report);
});

test("fails closed on a bad signature, missing runtime, or more than one running pid", () => {
  const signatureFixture = makeFixture();
  const badSignature = runVerifier(signatureFixture, [], { MOCK_CODESIGN_STATUS: "1" });
  assert.notEqual(badSignature.status, 0, badSignature.output);
  assert.equal(badSignature.report?.ok, false);
  assert.equal(badSignature.report?.checks?.codeSignature?.status, "failed");

  const runtimeFixture = makeFixture({ includeRuntime: false });
  const missingRuntime = runVerifier(runtimeFixture);
  assert.notEqual(missingRuntime.status, 0, missingRuntime.output);
  assert.equal(missingRuntime.report?.ok, false);
  assert.equal(missingRuntime.report?.checks?.runtime?.status, "failed");

  const voiceProxyFixture = makeFixture();
  rmSync(
    path.join(
      voiceProxyFixture.appPath,
      "Contents",
      "Resources",
      "YishuVoiceProxy",
      "stepfun-hotwords.mjs",
    ),
    { force: true },
  );
  const missingVoiceProxyDependency = runVerifier(voiceProxyFixture);
  assert.notEqual(missingVoiceProxyDependency.status, 0, missingVoiceProxyDependency.output);
  assert.equal(missingVoiceProxyDependency.report?.ok, false);
  assert.equal(
    missingVoiceProxyDependency.report?.checks?.runtime?.files?.voiceProxyHotwords?.status,
    "failed",
  );

  const processFixture = makeFixture();
  const duplicate = runVerifier(processFixture, [], { MOCK_PGREP_STATUS: "0", MOCK_PGREP_OUTPUT: "123\n456\n" });
  assert.notEqual(duplicate.status, 0, duplicate.output);
  assert.equal(duplicate.report?.ok, false);
  assert.equal(duplicate.report?.runningPidCount, 2);
  assert.equal(duplicate.report?.checks?.singleInstance?.status, "failed");
});

test("fails closed on an unexpected bundle id or missing main executable", () => {
  const identityFixture = makeFixture({ bundleIdentifier: "com.example.other" });
  const wrongIdentity = runVerifier(identityFixture);
  assert.notEqual(wrongIdentity.status, 0, wrongIdentity.output);
  assert.equal(wrongIdentity.report?.ok, false);
  assert.equal(wrongIdentity.report?.checks?.bundleIdentifier?.status, "failed");

  const executableFixture = makeFixture();
  rmSync(path.join(executableFixture.appPath, "Contents", "MacOS", "奕枢"), { force: true });
  const missingExecutable = runVerifier(executableFixture);
  assert.notEqual(missingExecutable.status, 0, missingExecutable.output);
  assert.equal(missingExecutable.report?.ok, false);
  assert.equal(missingExecutable.report?.checks?.mainExecutable?.status, "failed");
});

test("fails closed when the signed app has no build provenance manifest", () => {
  const fixture = makeFixture();
  rmSync(
    path.join(fixture.appPath, "Contents", "Resources", "YishuBuildManifest.json"),
    { force: true },
  );
  const result = runVerifier(fixture);

  assert.notEqual(result.status, 0, result.output);
  assert.equal(result.report?.ok, false);
  assert.equal(result.report?.checks?.provenance?.status, "failed");
  assert.equal(result.report?.checks?.provenance?.reason, "manifest_missing");
});

test("rejects a manifest from another commit or with a changed source hash", () => {
  const commitFixture = makeFixture({ provenance: { commit: "0".repeat(40) } });
  const wrongCommit = runVerifier(commitFixture);
  assert.notEqual(wrongCommit.status, 0, wrongCommit.output);
  assert.equal(wrongCommit.report?.ok, false);
  assert.equal(wrongCommit.report?.checks?.provenance?.reason, "commit_mismatch");
  assert.equal(wrongCommit.report?.checks?.provenance?.commit?.status, "failed");

  const hashFixture = makeFixture({ provenance: { sourceInputHash: "0".repeat(64) } });
  const wrongHash = runVerifier(hashFixture);
  assert.notEqual(wrongHash.status, 0, wrongHash.output);
  assert.equal(wrongHash.report?.ok, false);
  assert.equal(wrongHash.report?.checks?.provenance?.reason, "source_hash_mismatch");
  assert.equal(wrongHash.report?.checks?.provenance?.sourceInputHash?.status, "failed");
});

test("reports a dirty local manifest but rejects it when clean provenance is required", () => {
  const fixture = makeFixture({ provenance: { worktreeDirty: true } });
  const allowed = runVerifier(fixture);
  assert.equal(allowed.status, 0, allowed.output);
  assert.equal(allowed.report?.ok, true);
  assert.equal(allowed.report?.checks?.provenance?.worktreeDirty, true);
  assert.equal(allowed.report?.checks?.provenance?.clean?.status, "passed");

  const rejected = runVerifier(fixture, ["--require-clean-provenance"]);
  assert.notEqual(rejected.status, 0, rejected.output);
  assert.equal(rejected.report?.ok, false);
  assert.equal(rejected.report?.checks?.provenance?.reason, "worktree_dirty");
  assert.equal(rejected.report?.checks?.provenance?.clean?.status, "failed");
});

test("allows zero static pids but enforces --require-running", () => {
  const fixture = makeFixture();
  const staticResult = runVerifier(fixture);
  assert.equal(staticResult.status, 0, staticResult.output);
  assert.equal(staticResult.report?.runningPidCount, 0);

  const requiredResult = runVerifier(fixture, ["--require-running"]);
  assert.notEqual(requiredResult.status, 0, requiredResult.output);
  assert.equal(requiredResult.report?.ok, false);
  assert.equal(requiredResult.report?.checks?.running?.status, "failed");

  const runningResult = runVerifier(fixture, ["--require-running"], {
    MOCK_PGREP_STATUS: "0",
    MOCK_PGREP_OUTPUT: "123\n",
  });
  assert.equal(runningResult.status, 0, runningResult.output);
  assert.equal(runningResult.report?.runningPidCount, 1);
});

test("compares bundle runtime source with --repo-root and ignores generated maps", () => {
  const fixture = makeFixture();
  updateManifest(fixture, fixture.repoRoot);
  const repoSrc = path.join(fixture.repoRoot, "packages/runtime/src");
  mkdirSync(repoSrc, { recursive: true });
  writeFileSync(path.join(repoSrc, "assistant-output.ts"), "export const fixture = true;\n", "utf8");
  writeFileSync(path.join(repoSrc, "generated.map"), "different generated output\n", "utf8");
  updateManifest(fixture, fixture.repoRoot);

  const matching = runVerifier(fixture, ["--repo-root", fixture.repoRoot]);
  assert.equal(matching.status, 0, matching.output);
  assert.equal(matching.report?.checks?.runtimeSource?.status, "passed");

  writeFileSync(path.join(repoSrc, "assistant-output.ts"), "export const fixture = false;\n", "utf8");
  const mismatched = runVerifier(fixture, ["--repo-root", fixture.repoRoot]);
  assert.notEqual(mismatched.status, 0, mismatched.output);
  assert.equal(mismatched.report?.ok, false);
  assert.equal(mismatched.report?.checks?.runtimeSource?.status, "failed");
  assert.deepEqual(
    mismatched.report?.checks?.runtimeSource?.changed?.map((entry) => entry.path),
    ["assistant-output.ts"],
  );
});
