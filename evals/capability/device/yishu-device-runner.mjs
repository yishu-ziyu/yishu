#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectDeviceObservation } from "./quality-observation-collector.mjs";
import { validateDeviceObservation, verifyDeviceTrial } from "./trial-verifier.mjs";

export const FORMAL_APP_PATH = "/Applications/奕枢.app";
export const FORMAL_APP_EXECUTABLE = `${FORMAL_APP_PATH}/Contents/MacOS/奕枢`;
export const EXPECTED_BUNDLE_IDENTIFIER = "com.yishu.yishu-buddy";
export const QUALITY_LOG_RELATIVE_PATH = "Library/Application Support/Yishu/Diagnostics/quality.jsonl";
export const DEVICE_RUNNER_STATE_SCHEMA_VERSION = 1;
export const ARM_MODE = "arm";
export const CLOSE_MODE = "close";
export const REPLAY_MODE = "replay";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CANONICAL_RUNNER_ROOT = path.join(ROOT, "evals/capability/device");
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const TRIAL_PATTERN = /^[1-9][0-9]{0,8}$/u;
const SAFE_METADATA_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
const SCENARIO_CONTRACTS = Object.freeze({
  "device.t1.ptt": "t1.ptt",
  "device.t2.ax": "t2.ax",
  "device.t3.memory": "t3.memory",
});
export const DEVICE_SCENARIO_CONTRACTS = SCENARIO_CONTRACTS;
const CONTRACTS = new Set(Object.values(SCENARIO_CONTRACTS));
const PROVENANCE_FIELDS = new Set([
  "evidenceKind",
  "runnerPath",
  "runnerSha256",
  "executionDependencies",
  "executionSetSha256",
  "generatedAt",
  "commit",
  "appBundleHash",
  "bundleIdentityAlgorithm",
  "appPath",
  "bundleIdentifier",
  "deviceId",
  "osVersion",
]);
const EXECUTION_DEPENDENCY_PATHS = Object.freeze([
  "evals/capability/device/quality-observation-collector.mjs",
  "evals/capability/device/trial-verifier.mjs",
]);
const STATE_FIELDS = new Set([
  "schemaVersion",
  "scenario",
  "trial",
  "contract",
  "trialId",
  "startOffset",
  "qualityPrefixSha256",
  "appPid",
  "provenanceSha256",
  "provenancePath",
]);
const FORBIDDEN_FIELDS = new Set([
  "transcript",
  "screenshot",
  "screenshots",
  "path",
  "windowtitle",
  "sourcewindowtitle",
  "memorytext",
  "passed",
  "taskterminal",
  "receipts",
  "prompt",
  "url",
  "cookie",
  "authorization",
  "apikey",
  "token",
  "password",
  "email",
  "username",
  "label",
  "filepath",
  "credential",
  "credentials",
  "secret",
  "secrets",
]);
const RESTRICTED_ENV = Object.freeze({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LC_ALL: "C.UTF-8",
});

export class DeviceRunnerError extends Error {
  constructor(code) {
    super(code);
    this.name = "DeviceRunnerError";
    this.code = code;
  }
}

function fail(code) {
  throw new DeviceRunnerError(code);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeFieldName(value) {
  return value.toLowerCase().replace(/[_\-\s]/gu, "");
}

function ensureAbsolutePath(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096
    || value.includes("\0") || !path.isAbsolute(value)) {
    fail(code);
  }
  return value;
}

function isWithin(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function isHash(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isDateTime(value) {
  return typeof value === "string"
    && DATE_TIME_PATTERN.test(value)
    && Number.isFinite(Date.parse(value));
}

function requireScenario(value) {
  if (typeof value !== "string" || !Object.hasOwn(SCENARIO_CONTRACTS, value)) fail("scenario_invalid");
  return value;
}

function requireTrial(value) {
  const asString = typeof value === "number" ? String(value) : value;
  if (typeof asString !== "string" || !TRIAL_PATTERN.test(asString)) fail("trial_invalid");
  const trial = Number(asString);
  if (!Number.isSafeInteger(trial) || trial < 1) fail("trial_invalid");
  return trial;
}

function checkClosedObject(value, allowed, code) {
  if (!isRecord(value)) fail(code);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code);
  }
}

function scanForbiddenFields(value, code = "forbidden_field") {
  if (Array.isArray(value)) {
    for (const item of value) scanForbiddenFields(item, code);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.has(normalizeFieldName(key))) fail(code);
    scanForbiddenFields(child, code);
  }
}

function toBuffer(value, code) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  fail(code);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertRegularFile(filePath, code, { privateMode = false } = {}) {
  ensureAbsolutePath(filePath, `${code}_path_invalid`);
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch {
    fail(`${code}_unreadable`);
  }
  if (stats.isSymbolicLink()) fail(`${code}_symlink`);
  if (!stats.isFile()) fail(`${code}_not_file`);
  if (privateMode && (stats.mode & 0o777) !== 0o600) fail(`${code}_mode_invalid`);
  return stats;
}

function readBytes(filePath, code, options = {}) {
  assertRegularFile(filePath, code, options);
  let bytes;
  try {
    bytes = Buffer.from(readFileSync(filePath));
  } catch {
    fail(`${code}_unreadable`);
  }
  return bytes;
}

function readJsonFile(filePath, code, options = {}) {
  const bytes = readBytes(filePath, code, options);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${code}_utf8_invalid`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`${code}_json_invalid`);
  }
  return { value, bytes };
}

function writeExclusiveJson(filePath, value, code) {
  ensureAbsolutePath(filePath, `${code}_path_invalid`);
  const payload = `${JSON.stringify(value)}\n`;
  try {
    writeFileSync(filePath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(filePath, 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") fail(`${code}_exists`);
    fail(`${code}_write_failed`);
  }
}

function defaultQualityLogPath() {
  const home = os.homedir();
  if (typeof home !== "string" || !path.isAbsolute(home)) fail("quality_log_home_unavailable");
  return path.join(home, QUALITY_LOG_RELATIVE_PATH);
}

function currentRunnerPath() {
  try {
    return realpathSync(fileURLToPath(import.meta.url));
  } catch {
    fail("runner_identity_unavailable");
  }
}

function currentRunnerIdentity(input = {}, deps = {}) {
  const runnerPath = input.runnerPath ?? deps.runnerPath ?? currentRunnerPath();
  ensureAbsolutePath(runnerPath, "runner_path_invalid");
  const runnerSha256 = input.runnerSha256 ?? deps.runnerSha256 ?? sha256(readBytes(runnerPath, "runner"));
  if (!isHash(runnerSha256)) fail("runner_hash_invalid");
  const canonical = (() => {
    try {
      return realpathSync(runnerPath);
    } catch {
      return runnerPath;
    }
  })();
  if (input.runnerPath === undefined && deps.runnerPath === undefined && !isWithin(CANONICAL_RUNNER_ROOT, canonical)) {
    fail("runner_not_canonical");
  }
  return { runnerPath: canonical, runnerSha256 };
}

/**
 * Validates only the provenance identity needed by this runner. It returns a
 * reason object so tests and callers can inspect a safe code without exposing
 * the provenance contents.
 */
export function validateRunnerProvenance(provenance, { runnerPath, runnerSha256 } = {}) {
  if (!isRecord(provenance)) return { ok: false, reason: "provenance_shape_invalid" };
  for (const key of Object.keys(provenance)) {
    if (!PROVENANCE_FIELDS.has(key)) return { ok: false, reason: "provenance_unknown_field" };
  }
  if (provenance.evidenceKind !== "device") return { ok: false, reason: "provenance_evidence_kind_invalid" };
  if (typeof provenance.runnerPath !== "string" || !path.isAbsolute(provenance.runnerPath)) {
    return { ok: false, reason: "provenance_runner_path_invalid" };
  }
  if (runnerPath !== undefined && provenance.runnerPath !== runnerPath) {
    return { ok: false, reason: "provenance_runner_path_mismatch" };
  }
  if (!isHash(provenance.runnerSha256)) return { ok: false, reason: "provenance_runner_hash_invalid" };
  if (runnerSha256 !== undefined && provenance.runnerSha256 !== runnerSha256) {
    return { ok: false, reason: "provenance_runner_hash_mismatch" };
  }
  if (!Array.isArray(provenance.executionDependencies)
    || provenance.executionDependencies.length !== EXECUTION_DEPENDENCY_PATHS.length
    || provenance.executionDependencies.some((entry, index) => (
      !isRecord(entry)
      || Object.keys(entry).length !== 2
      || entry.path !== EXECUTION_DEPENDENCY_PATHS[index]
      || !isHash(entry.sha256)
    ))) {
    return { ok: false, reason: "provenance_execution_dependencies_invalid" };
  }
  if (!isHash(provenance.executionSetSha256)) {
    return { ok: false, reason: "provenance_execution_set_hash_invalid" };
  }
  if (!isDateTime(provenance.generatedAt)) return { ok: false, reason: "provenance_generated_at_invalid" };
  if (typeof provenance.commit !== "string" || !COMMIT_PATTERN.test(provenance.commit)) {
    return { ok: false, reason: "provenance_commit_invalid" };
  }
  if (!isHash(provenance.appBundleHash)) return { ok: false, reason: "provenance_app_bundle_hash_invalid" };
  if (provenance.bundleIdentityAlgorithm !== "yishu-app-bundle-v1") {
    return { ok: false, reason: "provenance_bundle_identity_algorithm_invalid" };
  }
  if (provenance.appPath !== FORMAL_APP_PATH
    || provenance.bundleIdentifier !== EXPECTED_BUNDLE_IDENTIFIER) {
    return { ok: false, reason: "provenance_app_identity_invalid" };
  }
  if (typeof provenance.deviceId !== "string" || !SAFE_METADATA_PATTERN.test(provenance.deviceId)) {
    return { ok: false, reason: "provenance_device_id_invalid" };
  }
  if (typeof provenance.osVersion !== "string" || !SAFE_METADATA_PATTERN.test(provenance.osVersion)) {
    return { ok: false, reason: "provenance_os_version_invalid" };
  }
  return { ok: true };
}

function assertValidProvenance(provenance, identity) {
  const result = validateRunnerProvenance(provenance, identity);
  if (!result.ok) fail(result.reason);
}

function processOutput(result) {
  if (!result || result.error || result.status !== 0 || typeof result.stdout !== "string") {
    fail("formal_app_process_unavailable");
  }
  return result.stdout;
}

/**
 * Finds exactly one formal-App process using a fixed absolute system utility.
 * Only the executable path and numeric PID are retained.
 */
export function discoverFormalAppPids({ spawn = spawnSync } = {}) {
  let result;
  try {
    result = spawn("/bin/ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      env: RESTRICTED_ENV,
    });
  } catch {
    fail("formal_app_process_unavailable");
  }
  const stdout = processOutput(result);
  const pids = new Set();
  for (const line of stdout.split("\n")) {
    const match = /^\s*([0-9]+)\s+(.+?)\s*$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const executable = match[2].split(/\s+/u, 1)[0];
    if (Number.isSafeInteger(pid) && pid > 0 && executable === FORMAL_APP_EXECUTABLE) pids.add(pid);
  }
  if (pids.size !== 1) fail("formal_app_pid_count_invalid");
  return [...pids];
}

function resolveFormalAppPid(deps = {}) {
  let raw;
  try {
    if (typeof deps.getFormalAppPids === "function") raw = deps.getFormalAppPids();
    else if (typeof deps.getFormalAppPid === "function") raw = deps.getFormalAppPid();
    else raw = discoverFormalAppPids(deps);
  } catch (error) {
    if (error instanceof DeviceRunnerError) throw error;
    fail("formal_app_pid_unavailable");
  }
  const pids = Array.isArray(raw) ? raw : [raw];
  if (pids.length !== 1 || !Number.isSafeInteger(pids[0]) || pids[0] < 1) {
    fail("formal_app_pid_count_invalid");
  }
  return pids[0];
}

function readQualitySnapshot(qualityLogPath, deps = {}) {
  const resolvedPath = ensureAbsolutePath(qualityLogPath ?? defaultQualityLogPath(), "quality_log_path_invalid");
  let before;
  try {
    before = assertRegularFile(resolvedPath, "quality_log");
  } catch (error) {
    throw error;
  }
  let bytes;
  try {
    bytes = toBuffer(
      typeof deps.readQualityLog === "function"
        ? deps.readQualityLog(resolvedPath)
        : readFileSync(resolvedPath),
      "quality_log_invalid",
    );
  } catch (error) {
    if (error instanceof DeviceRunnerError) throw error;
    fail("quality_log_unreadable");
  }
  let after;
  try {
    after = statSync(resolvedPath);
  } catch {
    fail("quality_log_changed_during_read");
  }
  if (before.size !== after.size || bytes.length !== after.size
    || before.ino !== after.ino || before.dev !== after.dev
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    fail("quality_log_changed_during_read");
  }
  return bytes;
}

function validateState(state) {
  checkClosedObject(state, STATE_FIELDS, "state_shape_invalid");
  if (state.schemaVersion !== DEVICE_RUNNER_STATE_SCHEMA_VERSION) fail("state_schema_version_invalid");
  const scenario = requireScenario(state.scenario);
  const trial = requireTrial(state.trial);
  const contract = SCENARIO_CONTRACTS[scenario];
  if (state.contract !== contract) fail("state_contract_invalid");
  if (state.trialId !== `${scenario}-${trial}`) fail("state_trial_id_invalid");
  if (!Number.isSafeInteger(state.startOffset) || state.startOffset < 0) fail("state_start_offset_invalid");
  if (!isHash(state.qualityPrefixSha256)) fail("state_quality_hash_invalid");
  if (!Number.isSafeInteger(state.appPid) || state.appPid < 1) fail("state_app_pid_invalid");
  if (!isHash(state.provenanceSha256)) fail("state_provenance_hash_invalid");
  if (typeof state.provenancePath !== "string" || !path.isAbsolute(state.provenancePath)) {
    fail("state_provenance_path_invalid");
  }
  return { ...state, scenario, trial, contract };
}

function readState(statePath) {
  const { value } = readJsonFile(statePath, "state", { privateMode: true });
  return validateState(value);
}

function readProvenance(provenancePath, identity) {
  const resolvedPath = ensureAbsolutePath(provenancePath, "provenance_path_invalid");
  const { value, bytes } = readJsonFile(resolvedPath, "provenance", { privateMode: true });
  assertValidProvenance(value, identity);
  return { value, bytes, path: resolvedPath };
}

function readExternalSafe(externalSafePath, contract, expectedObservation) {
  const { value } = readJsonFile(externalSafePath, "external_safe", { privateMode: true });
  scanForbiddenFields(value, "external_safe_forbidden_field");
  let rawEvents;
  if (Array.isArray(value)) {
    rawEvents = value;
  } else if (isRecord(value)) {
    const keys = new Set(Object.keys(value));
    const validEnvelope = keys.size === 1 && keys.has("events");
    const versionedEnvelope = keys.size === 2 && keys.has("schemaVersion") && keys.has("events")
      && value.schemaVersion === DEVICE_RUNNER_STATE_SCHEMA_VERSION;
    if (!validEnvelope && !versionedEnvelope) fail("external_safe_shape_invalid");
    rawEvents = value.events;
  } else {
    fail("external_safe_shape_invalid");
  }
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) fail("external_safe_events_invalid");

  const normalized = rawEvents.map((event) => normalizeExternalEvent(event, contract, expectedObservation));
  const counts = new Map();
  for (const event of normalized) counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
  if (contract === "t1.ptt" && normalized.length !== 1) fail("external_safe_event_count_invalid");
  if (contract === "t1.ptt" && counts.get("human_judgment") !== 1) fail("human_judgment_missing");
  if (contract === "t2.ax" && (normalized.length !== 2
    || normalized.filter((event) => event.kind === "finder_state" && event.phase === "before").length !== 1
    || normalized.filter((event) => event.kind === "finder_state" && event.phase === "after").length !== 1)) {
    fail("finder_before_after_missing");
  }
  if (contract === "t3.memory" && (normalized.length !== 2
    || normalized.filter((event) => event.kind === "human_judgment" && event.phase === "recall_before_forget").length !== 1
    || normalized.filter((event) => event.kind === "human_judgment" && event.phase === "absence_after_restart").length !== 1)) {
    fail("human_judgment_missing");
  }
  return normalized;
}

function normalizeExternalEvent(event, contract, expectedObservation) {
  if (!isRecord(event)) fail("external_safe_event_invalid");
  const allowedCommon = new Set(["kind", "sequence", "observedAt"]);
  if (typeof event.kind !== "string") fail("external_safe_event_kind_invalid");
  if (!isDateTime(event.observedAt)) fail("external_safe_timestamp_invalid");
  if (Object.hasOwn(event, "sequence")
    && (!Number.isSafeInteger(event.sequence) || event.sequence < 1)) fail("external_safe_sequence_invalid");

  if (contract === "t1.ptt") {
    checkClosedObject(event, new Set([...allowedCommon, "phase", "outcome", "source"]), "external_safe_field_invalid");
    if (event.kind !== "human_judgment"
      || event.phase !== "latest_screen_answer"
      || !["correct", "incorrect"].includes(event.outcome)
      || event.source !== "human") fail("human_judgment_invalid");
    return {
      kind: event.kind,
      observedAt: event.observedAt,
      phase: event.phase,
      outcome: event.outcome,
      source: event.source,
    };
  }

  if (contract === "t2.ax") {
    checkClosedObject(
      event,
      new Set([...allowedCommon, "phase", "opaqueStateHash", "finderInstanceHash", "relation", "source"]),
      "external_safe_field_invalid",
    );
    if (event.kind !== "finder_state" || !["before", "after"].includes(event.phase)
      || !isHash(event.opaqueStateHash) || !isHash(event.finderInstanceHash)
      || event.source !== "finder") fail("finder_state_invalid");
    if (event.phase === "before" && Object.hasOwn(event, "relation")) fail("finder_before_relation_invalid");
    if (event.phase === "after" && !["direct_parent", "same", "unknown"].includes(event.relation)) {
      fail("finder_relation_invalid");
    }
    if (event.phase === "before") {
      return {
        kind: event.kind,
        observedAt: event.observedAt,
        phase: event.phase,
        opaqueStateHash: event.opaqueStateHash,
        finderInstanceHash: event.finderInstanceHash,
        source: event.source,
      };
    }
    return {
      kind: event.kind,
      observedAt: event.observedAt,
      phase: event.phase,
      opaqueStateHash: event.opaqueStateHash,
      finderInstanceHash: event.finderInstanceHash,
      relation: event.relation,
      source: event.source,
    };
  }

  checkClosedObject(
    event,
    new Set([...allowedCommon, "phase", "outcome", "source", "memoryIdHash", "scopeHash"]),
    "external_safe_field_invalid",
  );
  if (event.kind !== "human_judgment"
    || !["recall_before_forget", "absence_after_restart"].includes(event.phase)
    || !["correct", "incorrect"].includes(event.outcome)
    || event.source !== "human"
    || !isHash(event.memoryIdHash)
    || !isHash(event.scopeHash)) fail("human_judgment_invalid");
  if (expectedObservation
    && (event.memoryIdHash !== expectedObservation.memoryIdHash
      || event.scopeHash !== expectedObservation.scopeHash)) {
    fail("external_memory_identity_mismatch");
  }
  return {
    kind: event.kind,
    observedAt: event.observedAt,
    phase: event.phase,
    outcome: event.outcome,
    source: event.source,
    memoryIdHash: event.memoryIdHash,
    scopeHash: event.scopeHash,
  };
}

function eventRank(contract, event) {
  const ranks = {
    "t1.ptt": {
      ptt_pressed: 10,
      ptt_released: 20,
      context_recaptured: 30,
      terminal: 40,
      human_judgment: 50,
    },
    "t2.ax": {
      finder_before: 10,
      ax_action: 20,
      action_receipt: 30,
      finder_after: 40,
      terminal: 50,
    },
    "t3.memory": {
      remembered: 10,
      used: 20,
      recall_before_forget: 30,
      forgotten: 40,
      app_restart: 50,
      notUsedAfterRestart: 60,
      absence_after_restart: 70,
      resurrected: 80,
    },
  };
  if (contract === "t2.ax" && event.kind === "finder_state") return ranks[contract][`finder_${event.phase}`] ?? 999;
  if (contract === "t3.memory" && event.kind === "human_judgment") return ranks[contract][event.phase] ?? 999;
  if (contract === "t3.memory" && event.kind === "memory_state") return ranks[contract][event.state] ?? 999;
  return ranks[contract]?.[event.kind] ?? 999;
}

/** Merges untrusted external events and assigns a fresh strict sequence. */
export function mergeObservationEvents(observation, externalEvents) {
  if (!isRecord(observation) || !Array.isArray(observation.events)) fail("observation_shape_invalid");
  if (!Array.isArray(externalEvents)) fail("external_events_invalid");
  const contract = observation.contract;
  if (!CONTRACTS.has(contract)) fail("contract_invalid");
  const all = [
    ...observation.events.map((event, index) => ({ event, index, origin: 0 })),
    ...externalEvents.map((event, index) => ({ event, index, origin: 1 })),
  ];
  all.sort((left, right) => {
    const time = Date.parse(left.event.observedAt) - Date.parse(right.event.observedAt);
    if (time !== 0) return time;
    const rank = eventRank(contract, left.event) - eventRank(contract, right.event);
    if (rank !== 0) return rank;
    if (left.origin !== right.origin) return left.origin - right.origin;
    return left.index - right.index;
  });
  return {
    ...observation,
    events: all.map(({ event }, index) => ({ ...event, sequence: index + 1 })),
  };
}

function assertQualityPrefix(state, bytes) {
  if (bytes.length < state.startOffset) fail("quality_log_truncated");
  if (state.startOffset > 0 && bytes[state.startOffset - 1] !== 0x0a) {
    fail("quality_log_offset_not_line_boundary");
  }
  if (sha256(bytes.subarray(0, state.startOffset)) !== state.qualityPrefixSha256) {
    fail("quality_log_truncated");
  }
}

function assertCurrentProvenance(state, identity) {
  const provenance = readProvenance(state.provenancePath, identity);
  if (sha256(provenance.bytes) !== state.provenanceSha256) fail("provenance_changed");
  return provenance;
}

/** Arms a bounded quality-log window for one formal-App trial. */
export function armDeviceRunner(input, deps = {}) {
  if (!isRecord(input)) fail("arm_input_invalid");
  const scenario = requireScenario(input.scenario);
  const trial = requireTrial(input.trial);
  const provenancePath = ensureAbsolutePath(input.provenancePath, "provenance_path_invalid");
  const statePath = ensureAbsolutePath(input.statePath, "state_path_invalid");
  const identity = currentRunnerIdentity(input, deps);
  const provenance = readProvenance(provenancePath, identity);
  const qualityLogPath = input.qualityLogPath ?? defaultQualityLogPath();
  const quality = readQualitySnapshot(qualityLogPath, deps);
  if (quality.length > 0 && quality.at(-1) !== 0x0a) fail("quality_log_offset_not_line_boundary");
  const appPid = resolveFormalAppPid(deps);
  const state = {
    schemaVersion: DEVICE_RUNNER_STATE_SCHEMA_VERSION,
    scenario,
    trial,
    contract: SCENARIO_CONTRACTS[scenario],
    trialId: `${scenario}-${trial}`,
    startOffset: quality.length,
    qualityPrefixSha256: sha256(quality),
    appPid,
    provenanceSha256: sha256(provenance.bytes),
    provenancePath: provenance.path,
  };
  writeExclusiveJson(statePath, state, "state");
  return { status: "armed" };
}

/** Closes a bounded window, merges safe human/Finder evidence, and writes raw observation. */
export function closeDeviceRunner(input, deps = {}) {
  if (!isRecord(input)) fail("close_input_invalid");
  const statePath = ensureAbsolutePath(input.statePath, "state_path_invalid");
  const externalSafePath = ensureAbsolutePath(input.externalSafePath, "external_safe_path_invalid");
  const outputPath = ensureAbsolutePath(input.outputPath, "output_path_invalid");
  const state = readState(statePath);
  const identity = currentRunnerIdentity(input, deps);
  assertCurrentProvenance(state, identity);
  const quality = readQualitySnapshot(input.qualityLogPath ?? defaultQualityLogPath(), deps);
  assertQualityPrefix(state, quality);
  const currentPid = resolveFormalAppPid(deps);
  if (state.contract === "t3.memory") {
    if (currentPid === state.appPid) fail("restart_pid_not_changed");
  } else if (currentPid !== state.appPid) {
    fail("formal_app_pid_changed");
  }

  const collected = collectDeviceObservation({
    qualityJsonl: quality,
    trialStartByteOffset: state.startOffset,
    appPid: state.appPid,
    ...(state.contract === "t3.memory" ? { expectedRestartedPid: currentPid } : {}),
    contract: state.contract,
    trialId: state.trialId,
  });
  if (collected.status !== "valid") fail(`collector_invalid:${collected.reasons[0] ?? "unknown"}`);
  const external = readExternalSafe(externalSafePath, state.contract, collected.observation);
  const observation = mergeObservationEvents(collected.observation, external);
  const verification = verifyDeviceTrial(observation);
  if (verification.status === "invalid") fail(`observation_invalid:${verification.reasons[0] ?? "schema"}`);
  writeExclusiveJson(outputPath, observation, "observation");
  return { status: "closed", verificationStatus: verification.status };
}

function observationFilename(scenario, trial) {
  return `${scenario}-${trial}.json`;
}

function resolveObservationPath(observationDirectory, scenario, trial) {
  const directory = ensureAbsolutePath(observationDirectory, "observation_directory_invalid");
  let root;
  try {
    const stats = lstatSync(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) fail("observation_directory_invalid");
    root = realpathSync(directory);
  } catch (error) {
    if (error instanceof DeviceRunnerError) throw error;
    fail("observation_directory_unreadable");
  }
  const candidate = path.join(root, observationFilename(scenario, trial));
  if (!isWithin(root, candidate)) fail("observation_path_invalid");
  assertRegularFile(candidate, "observation", { privateMode: true });
  let realCandidate;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    fail("observation_path_invalid");
  }
  if (!isWithin(root, realCandidate)) fail("observation_path_escape");
  return candidate;
}

/** Replays exactly one private observation file from the bounded observation directory. */
export function replayDeviceObservation(input, deps = {}) {
  if (!isRecord(input)) fail("replay_input_invalid");
  const scenario = requireScenario(input.scenario);
  const trial = requireTrial(input.trial);
  const identity = currentRunnerIdentity(input, deps);
  if (!input.provenancePath) fail("provenance_path_required");
  readProvenance(input.provenancePath, identity);
  const directory = input.observationDirectory ?? process.env.YISHU_DEVICE_OBSERVATION_DIR;
  if (!directory) fail("observation_directory_required");
  const observationPath = resolveObservationPath(directory, scenario, trial);
  const { value } = readJsonFile(observationPath, "observation", { privateMode: true });
  if (value?.trialId !== `${scenario}-${trial}`) fail("observation_trial_mismatch");
  if (value?.contract !== SCENARIO_CONTRACTS[scenario]) fail("observation_contract_mismatch");
  const schemaResult = validateDeviceObservation(value);
  if (schemaResult.status === "invalid") fail(`observation_invalid:${schemaResult.reasons[0] ?? "schema"}`);
  const verification = verifyDeviceTrial(value);
  if (verification.status === "invalid") fail(`observation_invalid:${verification.reasons[0] ?? "schema"}`);
  return { status: "replayed", observation: value, verificationStatus: verification.status };
}

function parseFlagValue(rawArguments, index, flag) {
  const value = rawArguments[index + 1];
  if (!value || value.startsWith("-")) fail(`missing_${flag.slice(2)}`);
  return value;
}

/** Parses arm, close, and default run-capability replay invocations. */
export function parseRunnerArguments(rawArguments) {
  if (!Array.isArray(rawArguments)) fail("arguments_invalid");
  let mode;
  const values = {};
  for (let index = 0; index < rawArguments.length; index += 1) {
    const argument = rawArguments[index];
    if (argument === "--help" || argument === "-h") {
      if (rawArguments.length !== 1) fail("help_must_be_standalone");
      return { help: true };
    }
    if (argument === "--arm" || argument === "--close") {
      if (mode !== undefined) fail("mode_conflict");
      mode = argument.slice(2);
      continue;
    }
    if (!["--scenario", "--trial", "--provenance", "--state", "--external-safe", "--output"].includes(argument)) {
      fail("unknown_argument");
    }
    const value = parseFlagValue(rawArguments, index, argument);
    index += 1;
    if (Object.hasOwn(values, argument)) fail(`duplicate_${argument.slice(2).replaceAll("-", "_")}`);
    values[argument] = value;
  }
  const scenario = values["--scenario"] === undefined ? undefined : requireScenario(values["--scenario"]);
  const trial = values["--trial"] === undefined ? undefined : requireTrial(values["--trial"]);
  const provenancePath = values["--provenance"] === undefined
    ? undefined
    : ensureAbsolutePath(values["--provenance"], "provenance_path_invalid");
  const statePath = values["--state"] === undefined
    ? undefined
    : ensureAbsolutePath(values["--state"], "state_path_invalid");
  const externalSafePath = values["--external-safe"] === undefined
    ? undefined
    : ensureAbsolutePath(values["--external-safe"], "external_safe_path_invalid");
  const outputPath = values["--output"] === undefined
    ? undefined
    : ensureAbsolutePath(values["--output"], "output_path_invalid");

  if (mode === ARM_MODE) {
    if (scenario === undefined || trial === undefined || provenancePath === undefined || statePath === undefined) {
      fail("arm_arguments_required");
    }
    if (externalSafePath !== undefined || outputPath !== undefined) fail("arm_argument_invalid");
    return { mode, scenario, trial, provenancePath, statePath };
  }
  if (mode === CLOSE_MODE) {
    if (statePath === undefined || externalSafePath === undefined || outputPath === undefined) {
      fail("close_arguments_required");
    }
    if (scenario !== undefined || trial !== undefined || provenancePath !== undefined) fail("close_argument_invalid");
    return { mode, statePath, externalSafePath, outputPath };
  }
  if (scenario === undefined || trial === undefined || provenancePath === undefined) fail("replay_arguments_required");
  if (statePath !== undefined || externalSafePath !== undefined || outputPath !== undefined) fail("replay_argument_invalid");
  return { mode: REPLAY_MODE, scenario, trial, provenancePath };
}

function printHelp() {
  process.stdout.write([
    "Usage:",
    "  yishu-device-runner.mjs --arm --scenario ID --trial N --provenance PATH --state NEW_PATH",
    "  yishu-device-runner.mjs --close --state PATH --external-safe PATH --output NEW_PATH",
    "  yishu-device-runner.mjs --scenario ID --trial N --provenance PATH",
    "",
  ].join("\n"));
}

function errorCode(error) {
  if (!(error instanceof DeviceRunnerError) || !/^[a-z0-9_.:-]+$/u.test(error.code)) return "runner_failed";
  const lower = error.code.toLowerCase();
  if ([...FORBIDDEN_FIELDS].some((term) => lower.includes(term))) return "input_rejected";
  return error.code;
}

function main() {
  try {
    const options = parseRunnerArguments(process.argv.slice(2));
    if (options.help) {
      printHelp();
      return;
    }
    if (options.mode === ARM_MODE) {
      armDeviceRunner(options);
      process.stderr.write("device runner: armed\n");
      return;
    }
    if (options.mode === CLOSE_MODE) {
      closeDeviceRunner(options);
      process.stderr.write("device runner: closed\n");
      return;
    }
    const result = replayDeviceObservation(options);
    process.stdout.write(`${JSON.stringify(result.observation)}\n`);
  } catch (error) {
    process.stderr.write(`device runner blocked: ${errorCode(error)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
