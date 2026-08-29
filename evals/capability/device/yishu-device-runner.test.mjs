import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ARM_MODE,
  CLOSE_MODE,
  DEVICE_RUNNER_STATE_SCHEMA_VERSION,
  FORMAL_APP_EXECUTABLE,
  REPLAY_MODE,
  armDeviceRunner,
  closeDeviceRunner,
  discoverFormalAppPids,
  parseRunnerArguments,
  replayDeviceObservation,
} from "./yishu-device-runner.mjs";
import { verifyDeviceTrial } from "./trial-verifier.mjs";

const RUNNER_PATH = "/tmp/yishu-device-runner.mjs";
const RUNNER_SHA256 = "a".repeat(64);
const COMMIT = "b".repeat(40);
const BUNDLE_HASH = "c".repeat(64);
const APP_PID = 101;
const RESTARTED_PID = 202;
const MEMORY_HASH = "d".repeat(64);
const SCOPE_HASH = "e".repeat(64);

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "yishu-device-runner-test-"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writePrivate(filePath, value) {
  writeFileSync(filePath, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(filePath, 0o600);
}

function provenance(overrides = {}) {
  return {
    evidenceKind: "device",
    runnerPath: RUNNER_PATH,
    runnerSha256: RUNNER_SHA256,
    executionDependencies: [
      { path: "evals/capability/device/quality-observation-collector.mjs", sha256: "f".repeat(64) },
      { path: "evals/capability/device/trial-verifier.mjs", sha256: "0".repeat(64) },
    ],
    executionSetSha256: "1".repeat(64),
    generatedAt: "2026-08-29T00:00:00.000Z",
    commit: COMMIT,
    appBundleHash: BUNDLE_HASH,
    bundleIdentityAlgorithm: "yishu-app-bundle-v1",
    appPath: "/Applications/奕枢.app",
    bundleIdentifier: "com.yishu.yishu-buddy",
    deviceId: "host-test",
    osVersion: "darwin-test",
    ...overrides,
  };
}

function qualityEvent({
  id,
  name,
  sessionId,
  appPid = APP_PID,
  attributes = {},
  status,
  durationMs,
  occurredAt = "2026-08-29T00:00:00.000Z",
}) {
  const event = {
    schemaVersion: 1,
    eventId: id,
    occurredAt,
    appPid,
    sessionId,
    name,
    attributes,
  };
  if (status !== undefined) event.status = status;
  if (durationMs !== undefined) event.durationMs = durationMs;
  return event;
}

function jsonl(events) {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function t1Quality() {
  return jsonl([
    qualityEvent({ id: "t1-down", name: "ptt.key_down", sessionId: "voice", occurredAt: "2026-08-29T00:00:00.000Z" }),
    qualityEvent({ id: "t1-up", name: "ptt.key_up", sessionId: "voice", durationMs: 5500, occurredAt: "2026-08-29T00:00:05.500Z" }),
    qualityEvent({
      id: "t1-context",
      name: "context.resolved",
      sessionId: "voice",
      attributes: { reason: "recaptureSceneChanged", sourceDimensionsAvailable: true },
      occurredAt: "2026-08-29T00:00:06.000Z",
    }),
    qualityEvent({
      id: "t1-terminal",
      name: "model.completed",
      sessionId: "voice",
      attributes: { verified: true, taskTerminal: "verified" },
      occurredAt: "2026-08-29T00:00:06.100Z",
    }),
  ]);
}

function t2Quality() {
  return jsonl([
    qualityEvent({
      id: "t2-action",
      name: "computer.action.completed",
      sessionId: "desktop",
      status: "verified",
      attributes: {
        method: "ax_press",
        code: "verified_accessibility",
        verified: true,
        retryCount: 0,
        receiptHash: "f".repeat(64),
      },
      occurredAt: "2026-08-29T00:00:01.000Z",
    }),
    qualityEvent({
      id: "t2-terminal",
      name: "model.completed",
      sessionId: "voice",
      attributes: { verified: true, taskTerminal: "verified", receiptHash: "f".repeat(64) },
      occurredAt: "2026-08-29T00:00:04.000Z",
    }),
  ]);
}

function t3Quality() {
  const identity = { memoryIdHash: MEMORY_HASH, scopeHash: SCOPE_HASH };
  return jsonl([
    qualityEvent({ id: "t3-remembered", name: "memory.remembered", sessionId: "memory", attributes: identity, status: "ok", occurredAt: "2026-08-29T00:00:00.000Z" }),
    qualityEvent({ id: "t3-used", name: "memory.used", sessionId: "memory", attributes: identity, status: "ok", occurredAt: "2026-08-29T00:00:01.000Z" }),
    qualityEvent({ id: "t3-forgotten", name: "memory.forgotten", sessionId: "memory", attributes: identity, status: "ok", occurredAt: "2026-08-29T00:00:03.000Z" }),
    qualityEvent({ id: "t3-ready", name: "app.ready", sessionId: "app", appPid: RESTARTED_PID, occurredAt: "2026-08-29T00:00:04.000Z" }),
    qualityEvent({ id: "t3-down", name: "ptt.key_down", sessionId: "voice", appPid: RESTARTED_PID, occurredAt: "2026-08-29T00:00:05.000Z" }),
    qualityEvent({ id: "t3-up", name: "ptt.key_up", sessionId: "voice", appPid: RESTARTED_PID, durationMs: 5500, occurredAt: "2026-08-29T00:00:10.500Z" }),
    qualityEvent({
      id: "t3-terminal",
      name: "model.completed",
      sessionId: "voice",
      appPid: RESTARTED_PID,
      attributes: { verified: true, taskTerminal: "verified" },
      occurredAt: "2026-08-29T00:00:11.000Z",
    }),
  ]);
}

function externalT1(outcome = "correct") {
  return [{
    kind: "human_judgment",
    observedAt: "2026-08-29T00:00:06.200Z",
    phase: "latest_screen_answer",
    outcome,
    source: "human",
  }];
}

function externalT2() {
  return [
    {
      kind: "finder_state",
      observedAt: "2026-08-29T00:00:00.500Z",
      phase: "before",
      opaqueStateHash: "1".repeat(64),
      finderInstanceHash: "2".repeat(64),
      source: "finder",
    },
    {
      kind: "finder_state",
      observedAt: "2026-08-29T00:00:02.000Z",
      phase: "after",
      opaqueStateHash: "3".repeat(64),
      finderInstanceHash: "2".repeat(64),
      relation: "direct_parent",
      source: "finder",
    },
  ];
}

function externalT3() {
  return [
    {
      kind: "human_judgment",
      observedAt: "2026-08-29T00:00:02.000Z",
      phase: "recall_before_forget",
      outcome: "correct",
      source: "human",
      memoryIdHash: MEMORY_HASH,
      scopeHash: SCOPE_HASH,
    },
    {
      kind: "human_judgment",
      observedAt: "2026-08-29T00:00:12.000Z",
      phase: "absence_after_restart",
      outcome: "correct",
      source: "human",
      memoryIdHash: MEMORY_HASH,
      scopeHash: SCOPE_HASH,
    },
  ];
}

function makeFiles({ quality, external, observationDirectory = tempRoot() }) {
  const qualityPath = path.join(observationDirectory, "quality.jsonl");
  const provenancePath = path.join(observationDirectory, "provenance.json");
  const statePath = path.join(observationDirectory, "trial.state.json");
  const outputPath = path.join(observationDirectory, "observation.json");
  writePrivate(qualityPath, quality);
  writePrivate(provenancePath, JSON.stringify(provenance()));
  if (external !== undefined) writePrivate(path.join(observationDirectory, "external.json"), JSON.stringify(external));
  return {
    root: observationDirectory,
    qualityPath,
    provenancePath,
    statePath,
    outputPath,
    externalPath: path.join(observationDirectory, "external.json"),
  };
}

function deps({ pid = APP_PID, runnerPath = RUNNER_PATH, runnerSha256 = RUNNER_SHA256 } = {}) {
  return {
    getFormalAppPid: () => pid,
    runnerPath,
    runnerSha256,
  };
}

function arm(files, scenario, trial, overrides = {}) {
  return armDeviceRunner({
    scenario,
    trial,
    provenancePath: files.provenancePath,
    statePath: files.statePath,
    qualityLogPath: files.qualityPath,
    runnerPath: RUNNER_PATH,
    runnerSha256: RUNNER_SHA256,
    ...overrides,
  }, deps(overrides.deps));
}

function close(files, scenario, trial, externalPath, overrides = {}) {
  return closeDeviceRunner({
    statePath: files.statePath,
    externalSafePath: externalPath,
    outputPath: files.outputPath,
    qualityLogPath: files.qualityPath,
    runnerPath: RUNNER_PATH,
    runnerSha256: RUNNER_SHA256,
    ...overrides,
  }, deps(overrides.deps));
}

function appendQuality(files, quality) {
  writeFileSync(files.qualityPath, `${readFileSync(files.qualityPath, "utf8")}${quality}`, { encoding: "utf8", flag: "w" });
}

test("argument parser enforces one protocol mode and the closed path contract", () => {
  assert.deepEqual(
    parseRunnerArguments(["--arm", "--scenario", "device.t1.ptt", "--trial", "1", "--provenance", "/tmp/p", "--state", "/tmp/s"]),
    {
      mode: ARM_MODE,
      scenario: "device.t1.ptt",
      trial: 1,
      provenancePath: "/tmp/p",
      statePath: "/tmp/s",
    },
  );
  assert.deepEqual(
    parseRunnerArguments(["--close", "--state", "/tmp/s", "--external-safe", "/tmp/e", "--output", "/tmp/o"]),
    { mode: CLOSE_MODE, statePath: "/tmp/s", externalSafePath: "/tmp/e", outputPath: "/tmp/o" },
  );
  assert.deepEqual(
    parseRunnerArguments(["--scenario", "device.t1.ptt", "--trial", "1", "--provenance", "/tmp/p"]),
    { mode: REPLAY_MODE, scenario: "device.t1.ptt", trial: 1, provenancePath: "/tmp/p" },
  );
  assert.throws(
    () => parseRunnerArguments(["--arm", "--close", "--scenario", "device.t1.ptt", "--trial", "1"]),
    /mode_conflict/,
  );
  assert.throws(
    () => parseRunnerArguments(["--scenario", "../escape", "--trial", "1", "--provenance", "/tmp/p"]),
    /scenario_invalid/,
  );
  assert.throws(
    () => parseRunnerArguments(["--scenario", "device.t1.ptt", "--trial", "1", "--provenance", "/tmp/p", "--observation", "/tmp/x"]),
    /unknown_argument/,
  );
});

test("arm records only opaque state, binds the provenance bytes, and uses private exclusive output", () => {
  const root = tempRoot();
  try {
    const files = makeFiles({ quality: "existing\n", observationDirectory: root });
    const result = arm(files, "device.t1.ptt", 1);
    assert.equal(result.status, "armed");
    const state = JSON.parse(readFileSync(files.statePath, "utf8"));
    assert.equal(state.schemaVersion, DEVICE_RUNNER_STATE_SCHEMA_VERSION);
    assert.equal(state.scenario, "device.t1.ptt");
    assert.equal(state.trial, 1);
    assert.equal(state.contract, "t1.ptt");
    assert.equal(state.trialId, "device.t1.ptt-1");
    assert.equal(state.startOffset, Buffer.byteLength("existing\n"));
    assert.equal(state.appPid, APP_PID);
    assert.equal(state.provenanceSha256, sha256(readFileSync(files.provenancePath)));
    assert.equal(statSync(files.statePath).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(state), /transcript|screenshot|memoryText|taskTerminal|passed|receipts/u);
    assert.throws(() => arm(files, "device.t1.ptt", 1), /state_exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("arm rejects a provenance file that is not private", () => {
  const root = tempRoot();
  try {
    const files = makeFiles({ quality: "existing\n", observationDirectory: root });
    chmodSync(files.provenancePath, 0o644);
    assert.throws(
      () => arm(files, "device.t1.ptt", 1),
      /provenance_mode_invalid/,
    );
    assert.equal(existsSync(files.statePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("arm rejects a forged provenance identity before creating state", () => {
  const root = tempRoot();
  try {
    const files = makeFiles({ quality: "\n", observationDirectory: root });
    writeFileSync(files.provenancePath, JSON.stringify(provenance({ appPath: "/tmp/fake.app" })), { encoding: "utf8", flag: "w" });
    assert.throws(() => arm(files, "device.t1.ptt", 1), /provenance_app_identity_invalid/);
    assert.equal(existsSync(files.statePath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("close maps App quality events and external human judgment into raw T1 evidence", () => {
  const root = tempRoot();
  try {
    const files = makeFiles({ quality: "", external: externalT1(), observationDirectory: root });
    arm(files, "device.t1.ptt", 1);
    appendQuality(files, t1Quality());
    const result = close(files, "device.t1.ptt", 1, files.externalPath);
    assert.equal(result.status, "closed");
    const observation = JSON.parse(readFileSync(files.outputPath, "utf8"));
    assert.equal(verifyDeviceTrial(observation).status, "pass");
    assert.deepEqual(observation.events.map((event) => event.kind), [
      "ptt_pressed",
      "ptt_released",
      "context_recaptured",
      "terminal",
      "human_judgment",
    ]);
    assert.equal(statSync(files.outputPath).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(observation), /passed|taskTerminal|receipts|transcript|screenshot|path|url|memoryText/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("close orders opaque Finder before/after around the App action and never trusts input sequence", () => {
  const root = tempRoot();
  try {
    const files = makeFiles({ quality: "", external: externalT2(), observationDirectory: root });
    arm(files, "device.t2.ax", 1);
    appendQuality(files, t2Quality());
    const external = JSON.parse(readFileSync(files.externalPath, "utf8"));
    external[0].sequence = 999;
    external[1].sequence = 1;
    writeFileSync(files.externalPath, JSON.stringify(external), { encoding: "utf8", flag: "w" });
    const result = close(files, "device.t2.ax", 1, files.externalPath);
    assert.equal(result.status, "closed");
    const observation = JSON.parse(readFileSync(files.outputPath, "utf8"));
    assert.equal(verifyDeviceTrial(observation).status, "pass");
    assert.deepEqual(observation.events.map((event) => event.kind), [
      "finder_state",
      "ax_action",
      "action_receipt",
      "finder_state",
      "terminal",
    ]);
    assert.deepEqual(observation.events.map((event) => event.sequence), [1, 2, 3, 4, 5]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("close requires a changed live formal-App PID for T3 and retains collector's notUsedAfterRestart projection", () => {
  const root = tempRoot();
  try {
    const files = makeFiles({ quality: "", external: externalT3(), observationDirectory: root });
    arm(files, "device.t3.memory", 1);
    appendQuality(files, t3Quality());
    const result = close(files, "device.t3.memory", 1, files.externalPath, {
      deps: { pid: RESTARTED_PID },
    });
    assert.equal(result.status, "closed");
    const observation = JSON.parse(readFileSync(files.outputPath, "utf8"));
    assert.equal(verifyDeviceTrial(observation).status, "pass");
    assert.ok(observation.events.some((event) => event.kind === "memory_state" && event.state === "notUsedAfterRestart"));
    assert.equal(observation.memoryIdHash, MEMORY_HASH);
    assert.equal(observation.scopeHash, SCOPE_HASH);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("close fails closed for truncation, non-boundary offsets, partial JSONL, and PID pollution", () => {
  for (const variant of ["truncate", "partial", "pid"]) {
    const root = tempRoot();
    try {
      const files = makeFiles({ quality: "prefix\n", external: externalT1(), observationDirectory: root });
      arm(files, "device.t1.ptt", 1);
      appendQuality(files, t1Quality());
      if (variant === "truncate") {
        writeFileSync(files.qualityPath, t1Quality(), { encoding: "utf8", flag: "w" });
      } else if (variant === "partial") {
        writeFileSync(files.qualityPath, `${"prefix\n"}${t1Quality()}{"schemaVersion":1`, { encoding: "utf8", flag: "w" });
      } else {
        const polluted = JSON.parse(t1Quality().trim().split("\n")[0]);
        polluted.eventId = "polluted";
        polluted.appPid = 999;
        writeFileSync(files.qualityPath, `${"prefix\n"}${t1Quality()}${JSON.stringify(polluted)}\n`, { encoding: "utf8", flag: "w" });
      }
      assert.throws(() => close(files, "device.t1.ptt", 1, files.externalPath), /quality_|app_pid|collector_invalid/u, variant);
      assert.equal(existsSync(files.outputPath), false, variant);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("close rejects forged aggregates and arbitrary external-safe fields without writing observation", () => {
  const root = tempRoot();
  try {
    const files = makeFiles({ quality: "", external: [{ ...externalT1()[0], passed: true }], observationDirectory: root });
    arm(files, "device.t1.ptt", 1);
    appendQuality(files, t1Quality());
    assert.throws(() => close(files, "device.t1.ptt", 1, files.externalPath), /external_safe_field_invalid|forbidden/u);
    assert.equal(existsSync(files.outputPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("close rejects an external-safe file that is not private", () => {
  const root = tempRoot();
  try {
    const files = makeFiles({ quality: "", external: externalT1(), observationDirectory: root });
    arm(files, "device.t1.ptt", 1);
    appendQuality(files, t1Quality());
    chmodSync(files.externalPath, 0o644);
    assert.throws(
      () => close(files, "device.t1.ptt", 1, files.externalPath),
      /external_safe_mode_invalid/,
    );
    assert.equal(existsSync(files.outputPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replay accepts only the exact in-directory observation filename and rechecks provenance", () => {
  const root = tempRoot();
  try {
    const files = makeFiles({ quality: "\n", observationDirectory: root });
    const observation = {
      schemaVersion: 1,
      contract: "t1.ptt",
      trialId: "device.t1.ptt-1",
      events: [
        { kind: "ptt_pressed", sequence: 1, observedAt: "2026-08-29T00:00:00Z" },
        { kind: "ptt_released", sequence: 2, observedAt: "2026-08-29T00:00:05Z", durationMs: 5500 },
        { kind: "context_recaptured", sequence: 3, observedAt: "2026-08-29T00:00:06Z", reason: "recaptureSceneChanged", sourceDimensionsAvailable: true },
        { kind: "terminal", sequence: 4, observedAt: "2026-08-29T00:00:06Z", state: "completed" },
        { kind: "human_judgment", sequence: 5, observedAt: "2026-08-29T00:00:06Z", phase: "latest_screen_answer", outcome: "correct", source: "human" },
      ],
    };
    const observationPath = path.join(root, "device.t1.ptt-1.json");
    writePrivate(observationPath, JSON.stringify(observation));
    const result = replayDeviceObservation({
      scenario: "device.t1.ptt",
      trial: 1,
      provenancePath: files.provenancePath,
      observationDirectory: root,
      runnerPath: RUNNER_PATH,
      runnerSha256: RUNNER_SHA256,
    });
    assert.equal(result.status, "replayed");
    assert.deepEqual(result.observation, observation);
    assert.throws(() => replayDeviceObservation({
      scenario: "device.t1.ptt",
      trial: 1,
      provenancePath: files.provenancePath,
      observationDirectory: path.join(root, ".."),
      runnerPath: RUNNER_PATH,
      runnerSha256: RUNNER_SHA256,
    }), /observation_(not_found|unreadable)|observation_path_invalid/u);
    const escaped = path.join(root, "device.t1.ptt-2.json");
    writePrivate(escaped, JSON.stringify({ ...observation, trialId: "device.t1.ptt-1" }));
    assert.throws(() => replayDeviceObservation({
      scenario: "device.t1.ptt",
      trial: 2,
      provenancePath: files.provenancePath,
      observationDirectory: root,
      runnerPath: RUNNER_PATH,
      runnerSha256: RUNNER_SHA256,
    }), /observation_trial_mismatch|observation_invalid/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner constants keep the formal App identity narrow", () => {
  assert.equal(FORMAL_APP_EXECUTABLE, "/Applications/奕枢.app/Contents/MacOS/奕枢");
});

test("process discovery uses one fixed executable path and rejects duplicate or polluted processes", () => {
  const spawn = (command, args, options) => {
    assert.equal(command, "/bin/ps");
    assert.deepEqual(args, ["-axo", "pid=,command="]);
    assert.deepEqual(options.env, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C.UTF-8" });
    return {
      status: 0,
      stdout: [
        "  101 /Applications/奕枢.app/Contents/MacOS/奕枢 --psn_0_1",
        "  202 /Applications/Other.app/Contents/MacOS/Other",
      ].join("\n"),
    };
  };
  assert.deepEqual(discoverFormalAppPids({ spawn }), [101]);
  assert.throws(() => discoverFormalAppPids({
    spawn: () => ({
      status: 0,
      stdout: "101 /Applications/奕枢.app/Contents/MacOS/奕枢\n202 /Applications/奕枢.app/Contents/MacOS/奕枢",
    }),
  }), /formal_app_pid_count_invalid/);
});
