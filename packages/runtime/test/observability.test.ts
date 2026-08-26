import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { QualityEventRejectedError } from "../src/observability/quality-event.js";
import { sanitizeQualityAttributes } from "../src/observability/quality-redaction.js";
import { createQualityRecorder } from "../src/observability/quality-recorder.js";
import { percentile, startQualitySpan } from "../src/observability/quality-span.js";
import { detectFalseCompletions, speechClaimsCompletion } from "../src/observability/false-completion.js";
import { buildDiagnosticsPackContents, writeDiagnosticsPack } from "../src/observability/diagnostics-pack.js";

test("quality attributes reject transcript, path, url, and unknown keys", () => {
  assert.throws(() => sanitizeQualityAttributes({ transcript: "hi" }), QualityEventRejectedError);
  assert.throws(() => sanitizeQualityAttributes({ file_path: "/tmp/x" }), QualityEventRejectedError);
  assert.throws(() => sanitizeQualityAttributes({ url: "https://example.com" }), QualityEventRejectedError);
  assert.throws(() => sanitizeQualityAttributes({ notAField: "x" }), QualityEventRejectedError);
  assert.deepEqual(sanitizeQualityAttributes({ actionKind: "press", verified: true }), {
    actionKind: "press",
    verified: true,
  });
});

test("recorder never throws and can be paused", async () => {
  const recorder = createQualityRecorder();
  const event = await recorder.record({
    name: "ptt.key_down",
    sessionId: "s1",
    attributes: { actionKind: "ptt" },
  });
  assert.equal(event?.name, "ptt.key_down");
  recorder.pause();
  assert.equal(await recorder.record({ name: "ptt.key_up", sessionId: "s1" }), null);
  recorder.resume();
  assert.equal((await recorder.record({ name: "ptt.key_up", sessionId: "s1" }))?.name, "ptt.key_up");
  assert.equal((await recorder.record({ name: "ptt.key_down", sessionId: "s1", attributes: { transcript: "secret" } as never })), null);
});

test("spans share request and parent ids across start and end", async () => {
  const recorder = createQualityRecorder();
  const span = startQualitySpan({
    recorder,
    name: "model.request_started",
    sessionId: "s1",
    requestId: "r1",
    traceId: "t1",
  });
  await span.end("ok", { providerId: "local" });
  const events = await recorder.list();
  assert.equal(events.length, 2);
  assert.equal(events[0]?.requestId, "r1");
  assert.equal(events[1]?.spanId, span.spanId);
  assert.equal(events[1]?.traceId, "t1");
  assert.ok((events[1]?.durationMs ?? -1) >= 0);
});

test("false completion detector catches speech without truth and unverified receipts", () => {
  assert.equal(speechClaimsCompletion("点好了。"), true);
  const findings = detectFalseCompletions({
    tasks: [{
      taskId: "t1",
      status: "verified",
      verified: true,
      hasTrustedReceipt: false,
      receiptStatus: "delivered",
    }],
    utterances: [{ text: "做好了", taskId: "missing" }],
  });
  assert.ok(findings.some((item) => item.code === "verified_without_trusted_receipt"));
  assert.ok(findings.some((item) => item.code === "unverified_receipt_reported_complete"));
  assert.ok(findings.some((item) => item.code === "speech_without_terminal_task"));
});

test("diagnostics pack blocks credential-like content", async () => {
  const blocked = buildDiagnosticsPackContents({
    appVersion: "0",
    runtimeVersion: "0",
    osVersion: "15",
    arch: "arm64",
    events: [],
    permissionFlags: { accessibility: true },
    schemaMigration: "sk-abcdefghijkl",
  });
  assert.equal(blocked.blocked, true);
  const dir = await mkdtemp(path.join(tmpdir(), "yishu-diag-"));
  const manifest = await writeDiagnosticsPack(dir, {
    appVersion: "0.0.1",
    runtimeVersion: "0.0.1",
    osVersion: "15.0",
    arch: "arm64",
    events: [],
    permissionFlags: { microphone: false },
  });
  assert.equal(manifest.blocked, false);
  const versions = await readFile(path.join(dir, "versions.json"), "utf8");
  assert.match(versions, /0\.0\.1/);
});

test("percentile is defined for a populated series", () => {
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([], 95), undefined);
});
