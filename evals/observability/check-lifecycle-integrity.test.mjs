import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  classifyTerminal,
  evaluate,
  evaluateFiles,
  parseJSONL,
  publicReport,
} from "./check-lifecycle-integrity.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const SCRIPT = join(HERE, "check-lifecycle-integrity.mjs");
const FIX = join(HERE, "fixtures");

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    cwd: ROOT,
  });
}

function load(name) {
  return parseJSONL(readFileSync(join(FIX, name), "utf8"), name).events;
}

function writeTemp(events, fileName = "quality.jsonl") {
  const dir = mkdtempSync(join(tmpdir(), "yishu-lifecycle-"));
  const path = join(dir, fileName);
  const lines = events.map((event) => {
    if (typeof event === "string") return event;
    return JSON.stringify(event);
  });
  writeFileSync(path, lines.join("\n") + (lines.length ? "\n" : ""));
  return path;
}

test("good-success reconstructs four families with zero failures", () => {
  const report = evaluate(load("good-success.jsonl"));
  assert.equal(report.lifecycle_integrity_failures, 0);
  assert.equal(report.operations_reconstructed, 4);
  assert.equal(report.operations_unreconstructable, 0);
  assert.equal(report.by_family.voice_capture.operations_reconstructed, 1);
  assert.equal(report.by_family.asr.operations_reconstructed, 1);
  assert.equal(report.by_family.runtime_turn.operations_reconstructed, 1);
  assert.equal(report.by_family.computer_result.operations_reconstructed, 1);
  const cli = runCli(["--expect-zero", join(FIX, "good-success.jsonl")]);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
});

test("explicit failure is a valid terminal", () => {
  const report = evaluate(load("explicit-failure.jsonl"));
  assert.equal(report.lifecycle_integrity_failures, 0);
  assert.equal(report.operations_reconstructed, 1);
  assert.equal(report.operations[0].terminal_kind, "failure");
  assert.equal(runCli(["--expect-zero", join(FIX, "explicit-failure.jsonl")]).status, 0);
});

test("cancellation is a valid terminal", () => {
  const report = evaluate(load("cancellation.jsonl"));
  assert.equal(report.lifecycle_integrity_failures, 0);
  assert.equal(report.operations[0].terminal_kind, "cancelled");
  assert.equal(runCli(["--expect-zero", join(FIX, "cancellation.jsonl")]).status, 0);
});

test("missing terminal is a lifecycle failure", () => {
  const report = evaluate(load("missing-terminal.jsonl"));
  assert.ok(report.lifecycle_integrity_failures >= 1);
  assert.ok(report.started_without_terminal_outcome >= 1);
  assert.equal(runCli(["--expect-zero", join(FIX, "missing-terminal.jsonl")]).status, 1);
});

test("duplicate terminal is a lifecycle failure", () => {
  const report = evaluate(load("duplicate-terminal.jsonl"));
  assert.ok(report.lifecycle_integrity_failures >= 1);
  assert.ok(report.duplicate_terminal_outcomes >= 1);
});

test("orphan terminal is a lifecycle failure when the family has starts", () => {
  const report = evaluate(load("orphan-terminal.jsonl"));
  assert.ok(report.terminal_without_start >= 1);
  assert.ok(report.lifecycle_integrity_failures >= 1);
  assert.equal(report.by_family.voice_capture.operations_reconstructed, 1);
});

test("terminal without usable id is a correlation failure", () => {
  const report = evaluate(load("missing-correlation.jsonl"));
  assert.ok(report.uncorrelated_terminal_events >= 1);
  assert.ok(report.lifecycle_integrity_failures >= 1);
  assert.ok(report.started_without_terminal_outcome >= 2);
});

test("three interleaved captures reconstruct with zero failures", () => {
  const report = evaluate(load("concurrent.jsonl"));
  assert.equal(report.lifecycle_integrity_failures, 0);
  assert.equal(report.operations_reconstructed, 3);
  assert.equal(runCli(["--expect-zero", join(FIX, "concurrent.jsonl")]).status, 0);
});

test("empty log does not report perfect reconstructability", () => {
  const report = evaluate(load("empty.jsonl"));
  assert.equal(report.empty_input, true);
  assert.equal(report.reconstructability_rate, null);
  assert.equal(report.operations_reconstructed, 0);
  const cli = runCli([join(FIX, "empty.jsonl")]);
  assert.equal(cli.status, 0);
  assert.match(cli.stdout, /n\/a \(empty log\)/);
  assert.doesNotMatch(cli.stdout, /reconstructability_rate: 1/);
});

test("legacy incomplete log surfaces observability gaps and is not silently green", () => {
  const report = evaluate(load("legacy-incomplete.jsonl"));
  assert.ok(report.observability_gaps.length >= 1);
  assert.ok(report.operations_unreconstructable >= 1);
  assert.ok(report.reconstructability_rate === null || report.reconstructability_rate < 1);
  const silentlyGreen =
    report.lifecycle_integrity_failures === 0 &&
    report.operations_unreconstructable === 0 &&
    report.observability_gaps.length === 0;
  assert.equal(silentlyGreen, false);
});

test("does not infer success from missing errors", () => {
  const report = evaluate(load("missing-terminal.jsonl"));
  assert.equal(report.operations_reconstructed, 0);
  assert.ok(report.operations.every((op) => op.terminal_kind !== "success"));
});

test("runtime-timing model.done can close a quality turn.start by turnId", () => {
  const quality = writeTemp([
    {
      schemaVersion: 1,
      occurredAt: "2026-09-06T11:00:00.000Z",
      name: "turn.start",
      attributes: { turnId: "rt-1" },
    },
  ]);
  const timing = writeTemp(
    [{ turnId: "rt-1", name: "model.done", ms: 4100 }],
    "runtime-timing.jsonl",
  );
  const report = evaluateFiles([quality, timing]);
  assert.equal(report.lifecycle_integrity_failures, 0);
  assert.equal(report.by_family.runtime_turn.operations_reconstructed, 1);
});

test("privacy: content fields are ignored", () => {
  const { events } = parseJSONL(
    JSON.stringify({
      name: "ptt.key_down",
      occurredAt: "2026-09-06T12:00:00.000Z",
      transcript: "secret words",
      attributes: { turnId: "p1", prompt: "hidden", label: "nope" },
    }),
  );
  assert.equal(events[0].operationId, "p1");
  const dumped = JSON.stringify(events[0]);
  assert.doesNotMatch(dumped, /secret words/);
  assert.doesNotMatch(dumped, /hidden/);
});

test("unknown outcome is an ambiguous terminal", () => {
  assert.equal(
    classifyTerminal({
      name: "ptt.key_up",
      family: "voice_capture",
      outcome: "unknown",
    }),
    "unknown",
  );
});

test("anti-gaming: deleting a terminal cannot stay green", () => {
  const events = load("good-success.jsonl").filter((event) => event.name !== "model.completed");
  const report = evaluate(events);
  assert.ok(report.lifecycle_integrity_failures >= 1);
  assert.ok(report.started_without_terminal_outcome >= 1);
  assert.ok(report.by_family.runtime_turn.lifecycle_integrity_failures >= 1);
});

test("anti-gaming: duplicating a terminal cannot stay green", () => {
  const events = load("good-success.jsonl");
  const extra = events.find((event) => event.name === "ptt.key_up");
  const report = evaluate([...events, { ...extra, occurredAt: "2026-09-06T10:00:09.000Z" }]);
  assert.ok(report.lifecycle_integrity_failures >= 1);
  assert.ok(report.duplicate_terminal_outcomes >= 1);
});

test("anti-gaming: removing an operation id cannot stay green", () => {
  const events = load("good-success.jsonl").map((event) =>
    event.name === "ptt.key_up" ? { ...event, operationId: null } : event,
  );
  const report = evaluate(events);
  assert.ok(report.uncorrelated_terminal_events >= 1);
  assert.ok(report.lifecycle_integrity_failures >= 1);
});

test("anti-gaming: unknown terminal category cannot stay green", () => {
  const events = load("good-success.jsonl").map((event) =>
    event.name === "asr.final" ? { ...event, outcome: "unknown" } : event,
  );
  const report = evaluate(events);
  assert.ok(report.ambiguous_terminal_outcomes >= 1);
  assert.ok(report.lifecycle_integrity_failures >= 1);
});

test("anti-gaming: unrelated success does not close another operation", () => {
  const events = load("missing-terminal.jsonl").concat({
    name: "ptt.key_up",
    family: "voice_capture",
    operationId: "someone-else",
    occurredAt: "2026-09-06T10:03:09.000Z",
    sourceFile: "mutation",
    line: 99,
    outcome: null,
    status: null,
    errorCode: null,
  });
  const report = evaluate(events);
  assert.ok(report.started_without_terminal_outcome >= 1);
  assert.ok(report.lifecycle_integrity_failures >= 1);
  const openOne = report.operations.find((op) => op.operation_id === "open-1");
  assert.equal(openOne.terminal_kind, null);
});

test("json output is machine readable and omits raw content", () => {
  const cli = runCli(["--json", join(FIX, "good-success.jsonl")]);
  assert.equal(cli.status, 0, cli.stderr);
  const body = JSON.parse(cli.stdout);
  assert.equal(body.lifecycle_integrity_failures, 0);
  assert.ok(Array.isArray(body.operations));
  assert.ok(body.operations[0].event_names.includes("ptt.key_down"));
  assert.equal(JSON.stringify(body).includes("transcript"), false);
});

test("public report drops per-event payloads", () => {
  const report = publicReport(evaluate(load("good-success.jsonl")));
  assert.ok(report.operations[0].event_names);
  assert.equal(report.operations[0].events, undefined);
});

test("usage without files exits 2", () => {
  const cli = runCli([]);
  assert.equal(cli.status, 2);
});
