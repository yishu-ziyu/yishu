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
  EvaluatorAccountingError,
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

function evaluateClosed(events) {
  return evaluate(events, { closedWindow: true });
}

function assertInvariants(report) {
  assert.ok(report.operations_reconstructed >= 0);
  assert.ok(report.operations_unreconstructable >= 0);
  assert.ok(report.lifecycle_integrity_failures >= 0);
  assert.ok(report.semantic_lifecycle_failures >= 0);
  assert.ok(report.observability_integrity_failures >= 0);
  assert.ok(report.pending_operations >= 0);
  assert.equal(
    report.operations_reconstructed + report.operations_unreconstructable,
    report.operations.length,
  );
  assert.equal(report.logical_operations_count, report.operations.length);
  assert.equal(
    report.lifecycle_integrity_failures,
    report.semantic_lifecycle_failures + report.observability_integrity_failures,
  );
  assert.ok(report.lifecycle_integrity_failures <= report.logical_operations_count);
  assert.equal(report.unique_observability_gaps, report.observability_gaps.length);
  if (report.reconstructability_rate != null) {
    assert.ok(report.reconstructability_rate >= 0);
    assert.ok(report.reconstructability_rate <= 1);
  }
}

test("good-success reconstructs voice and runtime with zero semantic failures", () => {
  const report = evaluate(load("good-success.jsonl"));
  assertInvariants(report);
  assert.equal(report.semantic_lifecycle_failures, 0);
  assert.equal(report.lifecycle_integrity_failures, 0);
  assert.equal(report.operations_reconstructed, 2);
  assert.equal(report.by_family.voice_capture.operations_reconstructed, 1);
  assert.equal(report.by_family.runtime_turn.operations_reconstructed, 1);
  assert.equal(runCli(["--expect-zero", join(FIX, "good-success.jsonl")]).status, 0);
});

test("explicit failure is a valid terminal", () => {
  const report = evaluate(load("explicit-failure.jsonl"));
  assertInvariants(report);
  assert.equal(report.semantic_lifecycle_failures, 0);
  assert.equal(report.operations[0].terminal_kind, "failure");
  assert.equal(runCli(["--expect-zero", join(FIX, "explicit-failure.jsonl")]).status, 0);
});

test("cancellation is a valid terminal", () => {
  const report = evaluate(load("cancellation.jsonl"));
  assertInvariants(report);
  assert.equal(report.semantic_lifecycle_failures, 0);
  assert.equal(report.operations[0].terminal_kind, "cancelled");
});

test("missing terminal is a semantic failure only in a closed window", () => {
  const closed = evaluateClosed(load("missing-terminal.jsonl"));
  assertInvariants(closed);
  assert.ok(closed.semantic_lifecycle_failures >= 1);
  assert.ok(closed.started_without_terminal_outcome >= 1);
  assert.equal(closed.pending_operations, 0);
  assert.equal(
    runCli(["--closed-window", "--expect-zero", join(FIX, "missing-terminal.jsonl")]).status,
    1,
  );

  const open = evaluate(load("missing-terminal.jsonl"));
  assertInvariants(open);
  assert.equal(open.semantic_lifecycle_failures, 0);
  assert.ok(open.pending_operations >= 1);
  assert.equal(runCli(["--expect-zero", join(FIX, "missing-terminal.jsonl")]).status, 0);
});

test("live tail open operation is not a semantic failure", () => {
  const report = evaluate(load("live-tail.jsonl"));
  assertInvariants(report);
  assert.equal(report.observation_window, "open");
  assert.equal(report.semantic_lifecycle_failures, 0);
  assert.ok(report.pending_operations >= 1);
  assert.equal(runCli(["--expect-zero", join(FIX, "live-tail.jsonl")]).status, 0);
});

test("closed window same open start is a semantic failure", () => {
  const report = evaluateClosed(load("closed-window.jsonl"));
  assertInvariants(report);
  assert.equal(report.observation_window, "closed");
  assert.ok(report.semantic_lifecycle_failures >= 1);
  assert.equal(report.pending_operations, 0);
  assert.equal(
    runCli(["--closed-window", "--expect-zero", join(FIX, "closed-window.jsonl")]).status,
    1,
  );
});

test("duplicate canonical terminal is a semantic failure", () => {
  const report = evaluate(load("duplicate-terminal.jsonl"));
  assertInvariants(report);
  assert.ok(report.semantic_lifecycle_failures >= 1);
  assert.ok(report.duplicate_terminal_outcomes >= 1);
});

test("orphan terminal is a semantic failure when the same source has starts", () => {
  const report = evaluate(load("orphan-terminal.jsonl"));
  assertInvariants(report);
  assert.ok(report.terminal_without_start >= 1);
  assert.ok(report.semantic_lifecycle_failures >= 1);
  assert.equal(report.by_family.voice_capture.operations_reconstructed, 1);
});

test("terminal without usable id is observability debt plus open-start semantic failure", () => {
  const report = evaluateClosed(load("missing-correlation.jsonl"));
  assertInvariants(report);
  assert.ok(report.uncorrelated_terminal_events >= 1);
  assert.ok(report.started_without_terminal_outcome >= 2);
  assert.ok(report.semantic_lifecycle_failures >= 1);
  assert.ok(report.lifecycle_integrity_failures <= report.logical_operations_count);
});

test("three interleaved captures reconstruct with zero failures", () => {
  const report = evaluate(load("concurrent.jsonl"));
  assertInvariants(report);
  assert.equal(report.semantic_lifecycle_failures, 0);
  assert.equal(report.operations_reconstructed, 3);
});

test("empty log does not report perfect reconstructability", () => {
  const report = evaluate(load("empty.jsonl"));
  assertInvariants(report);
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
  assertInvariants(report);
  assert.ok(report.observability_gaps.length >= 1);
  assert.ok(report.operations_unreconstructable >= 1);
  const silentlyGreen =
    report.semantic_lifecycle_failures === 0 &&
    report.observability_integrity_failures === 0 &&
    report.pending_operations === 0 &&
    report.observability_gaps.length === 0;
  assert.equal(silentlyGreen, false);
});

test("does not infer success from missing errors", () => {
  const report = evaluateClosed(load("missing-terminal.jsonl"));
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
  assertInvariants(report);
  assert.equal(report.semantic_lifecycle_failures, 0);
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
  const report = evaluateClosed(events);
  assertInvariants(report);
  assert.ok(report.semantic_lifecycle_failures >= 1);
  assert.ok(report.started_without_terminal_outcome >= 1);
});

test("anti-gaming: duplicating a canonical terminal cannot stay green", () => {
  const events = load("good-success.jsonl");
  const extra = events.find((event) => event.name === "ptt.key_up");
  const report = evaluate([...events, { ...extra, occurredAt: "2026-09-06T10:00:09.000Z" }]);
  assertInvariants(report);
  assert.ok(report.semantic_lifecycle_failures >= 1);
  assert.ok(report.duplicate_terminal_outcomes >= 1);
});

test("anti-gaming: removing an operation id cannot stay green", () => {
  const events = load("good-success.jsonl").map((event) =>
    event.name === "ptt.key_up" ? { ...event, operationId: null } : event,
  );
  const report = evaluateClosed(events);
  assertInvariants(report);
  assert.ok(report.uncorrelated_terminal_events >= 1);
  assert.ok(report.semantic_lifecycle_failures >= 1);
});

test("anti-gaming: unknown terminal category cannot stay green", () => {
  const events = load("good-success.jsonl").map((event) =>
    event.name === "ptt.key_up" ? { ...event, outcome: "unknown" } : event,
  );
  const report = evaluate(events);
  assertInvariants(report);
  assert.ok(report.ambiguous_terminal_outcomes >= 1);
  assert.ok(report.semantic_lifecycle_failures >= 1);
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
  const report = evaluateClosed(events);
  assertInvariants(report);
  assert.ok(report.started_without_terminal_outcome >= 1);
  assert.ok(report.semantic_lifecycle_failures >= 1);
  const openOne = report.operations.find((op) => op.operation_id === "open-1");
  assert.equal(openOne.terminal_kind, null);
});

test("json output is machine readable and omits raw content", () => {
  const cli = runCli(["--json", join(FIX, "good-success.jsonl")]);
  assert.equal(cli.status, 0, cli.stderr);
  const body = JSON.parse(cli.stdout);
  assert.equal(body.semantic_lifecycle_failures, 0);
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

test("ASR production shape: repeated request_sent is not a false semantic failure", () => {
  const report = evaluate(load("asr-production-shape.jsonl"));
  assertInvariants(report);
  assert.equal(report.semantic_lifecycle_failures, 0);
  assert.ok(report.observability_integrity_failures >= 1);
  assert.equal(report.by_family.asr.started_without_terminal_outcome, 0);
  const asrOps = report.operations.filter((op) => op.family === "asr" && op.operation_id === "t1");
  assert.equal(asrOps.length, 1);
  assert.equal(asrOps[0].terminal_kind, "success");
  assert.ok(report.uncorrelated_terminal_events >= 1);
});

test("id-less alias events do not inflate an operation-count primary", () => {
  const report = evaluate(load("asr-production-shape.jsonl"));
  assertInvariants(report);
  assert.ok(report.uncorrelated_terminal_events >= 1);
  assert.ok(report.low_fidelity_alias_events >= 1);
  assert.equal(report.operations.filter((op) => op.family === "asr").length, 1);
  assert.ok(report.lifecycle_integrity_failures <= report.logical_operations_count);
  assert.equal(
    report.lifecycle_integrity_failures,
    report.semantic_lifecycle_failures + report.observability_integrity_failures,
  );
});

test("runtime cross-source: correlated done reconstructs; id-less completed is observability", () => {
  const report = evaluateFiles([
    join(FIX, "runtime-cross-source-quality.jsonl"),
    join(FIX, "runtime-cross-source-timing.jsonl"),
  ]);
  assertInvariants(report);
  assert.equal(report.semantic_lifecycle_failures, 0);
  assert.equal(report.by_family.runtime_turn.operations_reconstructed, 1);
  assert.ok(report.uncorrelated_terminal_events >= 1);
  assert.ok(report.low_fidelity_alias_events >= 1);
  assert.equal(report.operations.filter((op) => op.family === "runtime_turn").length, 1);
  assert.equal(report.lifecycle_integrity_failures, 0);
});

test("computer_result current shape is observability debt, not two semantic failures", () => {
  const report = evaluate(load("computer-result-current.jsonl"));
  assertInvariants(report);
  assert.equal(report.semantic_lifecycle_failures, 0);
  assert.equal(report.observability_integrity_failures, 0);
  assert.equal(report.lifecycle_integrity_failures, 0);
  assert.equal(report.by_family.computer_result.operations_reconstructed, 0);
  assert.equal(report.operations.filter((op) => op.family === "computer_result").length, 0);
  assert.ok(report.unique_observability_gaps >= 1);
  assert.ok(report.observability_gaps.some((gap) => gap.family === "computer_result"));
});

test("conflicting correlated terminals are a semantic failure", () => {
  const report = evaluate(load("conflicting-terminal.jsonl"));
  assertInvariants(report);
  assert.ok(report.semantic_lifecycle_failures >= 1);
  assert.equal(report.by_family.runtime_turn.operations_reconstructed, 0);
});

test("equivalent correlated success aliases are one semantic terminal", () => {
  const report = evaluate(load("equivalent-aliases.jsonl"));
  assertInvariants(report);
  assert.equal(report.semantic_lifecycle_failures, 0);
  assert.equal(report.by_family.runtime_turn.operations_reconstructed, 1);
  assert.ok(report.equivalent_terminal_aliases >= 1);
  assert.equal(report.duplicate_terminal_outcomes, 0);
});

test("orphan duplicate preserves non-negative aggregates", () => {
  const report = evaluate(load("orphan-duplicate.jsonl"));
  assertInvariants(report);
  assert.ok(report.duplicate_terminal_outcomes >= 1);
});

test("modern instrumentation does not turn a legacy orphan into a product failure", () => {
  const report = evaluateFiles([
    join(FIX, "legacy-orphan.jsonl"),
    join(FIX, "modern-valid.jsonl"),
  ]);
  assertInvariants(report);
  assert.equal(report.by_family.voice_capture.operations_reconstructed, 1);
  assert.equal(report.by_family.runtime_turn.operations_reconstructed, 1);
  assert.equal(report.by_family.asr.semantic_lifecycle_failures, 0);
  assert.ok(report.by_family.asr.observability_integrity_failures >= 1);
  assert.equal(report.semantic_lifecycle_failures, 0);
});

test("primary metric stays at or below the logical operation count", () => {
  for (const name of [
    "good-success.jsonl",
    "asr-production-shape.jsonl",
    "missing-correlation.jsonl",
    "computer-result-current.jsonl",
    "live-tail.jsonl",
    "orphan-duplicate.jsonl",
  ]) {
    const report = evaluateClosed(load(name));
    assertInvariants(report);
    assert.ok(
      report.lifecycle_integrity_failures <= report.logical_operations_count,
      `${name}: ${report.lifecycle_integrity_failures} > ${report.logical_operations_count}`,
    );
  }
});

test("evaluator invariant violation fails loudly, never clamps", () => {
  const negative = () =>
    evaluate(load("good-success.jsonl"), {
      injectInvalidAccounting(report) {
        report.operations_reconstructed = -1;
      },
    });
  assert.throws(negative, EvaluatorAccountingError);
  try {
    negative();
    assert.fail("expected throw");
  } catch (err) {
    assert.equal(err.name, "EvaluatorAccountingError");
    assert.match(err.message, /operations_reconstructed=-1/);
    assert.equal(err.report.operations_reconstructed, -1);
  }

  const rate = () =>
    evaluate(load("good-success.jsonl"), {
      injectInvalidAccounting(report) {
        report.reconstructability_rate = 1.5;
      },
    });
  try {
    rate();
    assert.fail("expected throw");
  } catch (err) {
    assert.equal(err.report.reconstructability_rate, 1.5);
    assert.match(err.message, /reconstructability_rate=1\.5/);
  }

  const overcount = () =>
    evaluate(load("good-success.jsonl"), {
      injectInvalidAccounting(report) {
        report.lifecycle_integrity_failures = report.logical_operations_count + 3;
        report.semantic_lifecycle_failures = report.lifecycle_integrity_failures;
        report.observability_integrity_failures = 0;
      },
    });
  try {
    overcount();
    assert.fail("expected throw");
  } catch (err) {
    assert.ok(err.report.lifecycle_integrity_failures > err.report.logical_operations_count);
    assert.match(err.message, /lifecycle_integrity_failures=/);
  }
});

test("deterministic evaluator suite is wired into product verification", () => {
  const script = readFileSync(join(ROOT, "script/verify-product.sh"), "utf8");
  assert.match(
    script,
    /node --test evals\/observability\/check-lifecycle-integrity\.test\.mjs/,
  );
  assert.doesNotMatch(script, /quality\.sample\.jsonl --expect-zero/);
});
