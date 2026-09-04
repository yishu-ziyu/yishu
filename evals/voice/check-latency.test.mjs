import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildPassingFixture,
  evaluate,
  groupTurns,
  interruptDeltas,
  parseArgs,
  parseJSONL,
  percentile,
  qualityEvent,
  REQUIRED_FIELDS,
  SPEECH_MIN_MS,
} from "./check-latency.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "check-latency.mjs");
const FIXTURE = join(HERE, "fixtures/quality.sample.jsonl");

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    cwd: join(HERE, "../.."),
  });
}

function writeTemp(events) {
  const dir = mkdtempSync(join(tmpdir(), "yishu-latency-"));
  const path = join(dir, "quality.jsonl");
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

test("parseArgs defaults last=30", () => {
  const args = parseArgs(["--require-fields", "--metric", "ack-before-tool", "--json"]);
  assert.equal(args.last, 30);
  assert.equal(args.requireFields, true);
  assert.equal(args.metric, "ack-before-tool");
  assert.equal(args.json, true);
});

test("percentile interpolates", () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([10], 95), 10);
  assert.equal(percentile([], 50), null);
});

test("shipped fixture passes default metrics and require-fields", () => {
  const result = runCli(["--fixture", FIXTURE, "--last", "30", "--require-fields"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /partial-before-keyup/);
  assert.match(result.stdout, /PASS/);
});

test("evaluate passing fixture meets card targets", () => {
  const events = buildPassingFixture();
  const report = evaluate(events, { last: 30, requireFields: true });
  assert.equal(report.n, 30);
  assert.equal(report.failed.length, 0, JSON.stringify(report.rows, null, 2));
  const byMetric = Object.fromEntries(report.rows.map((r) => [r.metric, r]));
  assert.equal(byMetric["require-fields"].pass, true);
  assert.equal(byMetric["partial-before-keyup"].pass, true);
  assert.equal(byMetric["ack-before-tool"].pass, true);
});

test("partial-before-keyup uses speech ≥2.5s and t_ms before key_up", () => {
  const base = Date.parse("2026-09-04T05:00:00.000Z");
  const events = [
    qualityEvent({
      id: "a-down",
      name: "ptt.key_down",
      turnId: "a",
      t_ms: -3000,
      occurredAt: new Date(base).toISOString(),
    }),
    qualityEvent({
      id: "a-partial",
      name: "asr.first_partial",
      turnId: "a",
      t_ms: -200,
      occurredAt: new Date(base + 2800).toISOString(),
    }),
    qualityEvent({
      id: "a-up",
      name: "ptt.key_up",
      turnId: "a",
      t_ms: 0,
      occurredAt: new Date(base + 3000).toISOString(),
      durationMs: 3000,
    }),
    qualityEvent({
      id: "b-down",
      name: "ptt.key_down",
      turnId: "b",
      t_ms: -1000,
      occurredAt: new Date(base + 10_000).toISOString(),
    }),
    qualityEvent({
      id: "b-partial",
      name: "asr.first_partial",
      turnId: "b",
      t_ms: 50,
      occurredAt: new Date(base + 11_050).toISOString(),
    }),
    qualityEvent({
      id: "b-up",
      name: "ptt.key_up",
      turnId: "b",
      t_ms: 0,
      occurredAt: new Date(base + 11_000).toISOString(),
      durationMs: 1000,
    }),
  ];
  const report = evaluate(events, { last: 30, metric: "partial-before-keyup" });
  assert.equal(report.rows[0].n, 1);
  assert.equal(report.rows[0].pass, true);
  assert.ok(SPEECH_MIN_MS === 2500);
});

test("ISO timestamps derive the same deltas as t_ms", () => {
  const base = Date.parse("2026-09-04T06:00:00.000Z");
  const events = [
    qualityEvent({
      id: "iso-down",
      name: "ptt.key_down",
      turnId: "iso",
      occurredAt: new Date(base).toISOString(),
    }),
    qualityEvent({
      id: "iso-up",
      name: "ptt.key_up",
      turnId: "iso",
      occurredAt: new Date(base + 2000).toISOString(),
      durationMs: 2000,
    }),
    qualityEvent({
      id: "iso-byte",
      name: "model.first_byte",
      turnId: "iso",
      occurredAt: new Date(base + 3200).toISOString(),
    }),
  ];
  const [turn] = groupTurns(events);
  assert.equal(turn.times["model.first_byte"], 1200);
});

test("require-fields fails when a timestamp is missing", () => {
  const events = buildPassingFixture().filter((e) => e.name !== "model.first_byte");
  const path = writeTemp(events);
  const result = runCli(["--fixture", path, "--last", "30", "--require-fields"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /require-fields/);
});

test("ack-before-tool fails when tool.started precedes response.delta", () => {
  const events = buildPassingFixture().map((event) => {
    if (event.name !== "response.delta" || event.turnId !== "t01") return event;
    return { ...event, t_ms: 3000, occurredAt: new Date(Date.parse(event.occurredAt) + 2000).toISOString() };
  });
  const report = evaluate(events, { last: 30, metric: "ack-before-tool" });
  assert.equal(report.rows[0].pass, false);
});

test("interrupt pairs key_down while TTS is playing with tts.stopped", () => {
  const base = Date.parse("2026-09-04T07:00:00.000Z");
  const events = [
    qualityEvent({
      id: "x-audio",
      name: "tts.first_audio",
      turnId: "x",
      occurredAt: new Date(base).toISOString(),
    }),
    qualityEvent({
      id: "y-down",
      name: "ptt.key_down",
      turnId: "y",
      occurredAt: new Date(base + 40).toISOString(),
    }),
    qualityEvent({
      id: "x-stop",
      name: "tts.stopped",
      turnId: "x",
      occurredAt: new Date(base + 70).toISOString(),
    }),
  ];
  assert.deepEqual(interruptDeltas(events), [30]);
});

test("listen-mode metric needs 10 turn.start without PTT", () => {
  const events = buildPassingFixture();
  const report = evaluate(events, { last: 30, metric: "listen-mode" });
  assert.equal(report.rows[0].pass, true);
  assert.equal(report.listen.streak, 10);
});

test("backchannel metric aligns with asr.first_partial and caps at 2", () => {
  const events = buildPassingFixture();
  const report = evaluate(events, { last: 30, metric: "backchannel" });
  assert.equal(report.rows[0].pass, true);
});

test("parseJSONL skips bad lines", () => {
  const { events, skipped } = parseJSONL('{"name":"ptt.key_up"}\nnot-json\n');
  assert.equal(events.length, 1);
  assert.equal(skipped, 1);
});

test("REQUIRED_FIELDS lists the seven card timestamps", () => {
  assert.deepEqual(REQUIRED_FIELDS, [
    "ptt.key_down",
    "ptt.key_up",
    "asr.first_partial",
    "asr.final",
    "turn.start",
    "model.first_byte",
    "tts.first_audio",
  ]);
});
