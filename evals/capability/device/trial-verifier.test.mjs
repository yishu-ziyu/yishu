import assert from "node:assert/strict";
import schema from "./device-observation.schema.json" with { type: "json" };
import test from "node:test";
import {
  verifyDeviceTrial,
  validateDeviceObservation,
} from "./trial-verifier.mjs";

const T1_BASE = {
  schemaVersion: 1,
  contract: "t1.ptt",
  trialId: "t1-001",
  events: [
    { kind: "ptt_pressed", sequence: 1, observedAt: "2026-08-29T00:00:00Z" },
    { kind: "ptt_released", sequence: 2, observedAt: "2026-08-29T00:00:05Z", durationMs: 5500 },
    {
      kind: "context_recaptured",
      sequence: 3,
      observedAt: "2026-08-29T00:00:06Z",
      reason: "recaptureSceneChanged",
      sourceDimensionsAvailable: true,
    },
    { kind: "terminal", sequence: 4, observedAt: "2026-08-29T00:00:06Z", state: "completed" },
    { kind: "human_judgment", sequence: 5, observedAt: "2026-08-29T00:00:06Z", phase: "latest_screen_answer", outcome: "correct", source: "human" },
  ],
};

const T2_BASE = {
  schemaVersion: 1,
  contract: "t2.ax",
  trialId: "t2-001",
  events: [
    {
      kind: "finder_state",
      sequence: 1,
      observedAt: "2026-08-29T00:00:00Z",
      phase: "before",
      opaqueStateHash: "b".repeat(64),
      finderInstanceHash: "f".repeat(64),
      source: "finder",
    },
    {
      kind: "ax_action",
      sequence: 2,
      observedAt: "2026-08-29T00:00:01Z",
      status: "verified",
      method: "ax_press",
      code: "verified_accessibility",
      verified: true,
      retryCount: 0,
    },
    { kind: "action_receipt", sequence: 3, observedAt: "2026-08-29T00:00:02Z", receiptIdHash: "a".repeat(64) },
    {
      kind: "finder_state",
      sequence: 4,
      observedAt: "2026-08-29T00:00:03Z",
      phase: "after",
      opaqueStateHash: "c".repeat(64),
      finderInstanceHash: "f".repeat(64),
      relation: "direct_parent",
      source: "finder",
    },
    {
      kind: "terminal",
      sequence: 5,
      observedAt: "2026-08-29T00:00:04Z",
      state: "verified",
      receiptIdHash: "a".repeat(64),
    },
  ],
};

const T3_BASE = {
  schemaVersion: 1,
  contract: "t3.memory",
  trialId: "t3-001",
  memoryIdHash: "d".repeat(64),
  scopeHash: "e".repeat(64),
  events: [
    { kind: "memory_state", sequence: 1, observedAt: "2026-08-29T00:00:00.000Z", state: "remembered", memoryIdHash: "d".repeat(64), scopeHash: "e".repeat(64) },
    { kind: "memory_state", sequence: 2, observedAt: "2026-08-29T00:00:01.000Z", state: "used", memoryIdHash: "d".repeat(64), scopeHash: "e".repeat(64) },
    { kind: "human_judgment", sequence: 3, observedAt: "2026-08-29T00:00:02.000Z", phase: "recall_before_forget", outcome: "correct", source: "human", memoryIdHash: "d".repeat(64), scopeHash: "e".repeat(64) },
    { kind: "memory_state", sequence: 4, observedAt: "2026-08-29T00:00:03.000Z", state: "forgotten", memoryIdHash: "d".repeat(64), scopeHash: "e".repeat(64) },
    { kind: "app_restart", sequence: 5, observedAt: "2026-08-29T00:00:04.000Z", memoryIdHash: "d".repeat(64), scopeHash: "e".repeat(64) },
    { kind: "memory_state", sequence: 6, observedAt: "2026-08-29T00:00:05.000Z", state: "notUsedAfterRestart", memoryIdHash: "d".repeat(64), scopeHash: "e".repeat(64) },
    { kind: "human_judgment", sequence: 7, observedAt: "2026-08-29T00:00:06.000Z", phase: "absence_after_restart", outcome: "correct", source: "human", memoryIdHash: "d".repeat(64), scopeHash: "e".repeat(64) },
  ],
};

function clone(value) {
  return structuredClone(value);
}

test("T1 accepts one PTT with a completed answer and correct human judgment", () => {
  const result = verifyDeviceTrial(clone(T1_BASE));
  assert.equal(result.status, "pass");
  assert.deepEqual(result.reasons, []);
});

test("T1 accepts a short monotonic key-up hold when the event is otherwise valid", () => {
  const observation = clone(T1_BASE);
  observation.events.find((event) => event.kind === "ptt_released").durationMs = 5499;
  const result = verifyDeviceTrial(observation);
  assert.equal(result.status, "pass");
  assert.deepEqual(result.reasons, []);
});

test("T1 rejects a release that precedes the press", () => {
  const observation = clone(T1_BASE);
  const pressed = observation.events.find((event) => event.kind === "ptt_pressed");
  const released = observation.events.find((event) => event.kind === "ptt_released");
  pressed.sequence = 2;
  released.sequence = 1;
  observation.events.sort((left, right) => left.sequence - right.sequence);

  const result = verifyDeviceTrial(observation);
  assert.equal(result.status, "fail");
  assert.ok(result.reasons.includes("ptt_order_invalid"));
});

test("T1 still rejects a negative monotonic key-up duration", () => {
  const observation = clone(T1_BASE);
  observation.events.find((event) => event.kind === "ptt_released").durationMs = -1;
  const result = verifyDeviceTrial(observation);
  assert.equal(result.status, "invalid");
  assert.ok(result.reasons.includes("ptt_duration_invalid:events[1]"));
});

test("T1 uses monotonic key-up duration, not second-level occurredAt subtraction", () => {
  const observation = clone(T1_BASE);
  observation.events.find((event) => event.kind === "ptt_pressed").observedAt = "2026-08-29T00:00:05Z";
  observation.events.find((event) => event.kind === "ptt_released").observedAt = "2026-08-29T00:00:05Z";
  const result = verifyDeviceTrial(observation);
  assert.equal(result.status, "pass");
});

test("T1 rejects direct aggregate truth fields and content-bearing fields", () => {
  const observation = clone(T1_BASE);
  observation.passed = true;
  observation.taskTerminal = "verified";
  observation.receipts = ["action_receipt"];
  observation.events[0].transcript = "do not accept";
  const result = verifyDeviceTrial(observation);
  assert.equal(result.status, "invalid");
  assert.ok(result.reasons.includes("forbidden_field:passed"));
  assert.ok(result.reasons.includes("forbidden_field:taskTerminal"));
  assert.ok(result.reasons.includes("forbidden_field:receipts"));
  assert.ok(result.reasons.includes("forbidden_field:transcript"));
});

test("T1 cannot carry a T2 action receipt on its terminal", () => {
  const observation = clone(T1_BASE);
  observation.events.find((event) => event.kind === "terminal").receiptIdHash = "a".repeat(64);

  const result = verifyDeviceTrial(observation);
  assert.equal(result.status, "invalid");
  assert.ok(result.reasons.includes("unknown_field:events[3].receiptIdHash"));
});

test("T1 fails without a completed terminal or with a failure event", () => {
  const observation = clone(T1_BASE);
  observation.events.find((event) => event.kind === "terminal").state = "failed";
  observation.events.push({ kind: "failure", sequence: 5, observedAt: "2026-08-29T00:00:06.100Z", code: "turn_failed" });
  const result = verifyDeviceTrial(observation);
  assert.equal(result.status, "fail");
  assert.ok(result.reasons.includes("completed_terminal_missing"));
  assert.ok(result.reasons.includes("failure_event_present"));
});

test("T1 requires a human judgment of the latest-screen answer", () => {
  const observation = clone(T1_BASE);
  observation.events = observation.events.filter((event) => event.kind !== "human_judgment");
  const result = verifyDeviceTrial(observation);
  assert.equal(result.status, "fail");
  assert.ok(result.reasons.includes("human_judgment_missing"));

  observation.events.push({ kind: "human_judgment", sequence: 5, observedAt: "2026-08-29T00:00:06.200Z", phase: "latest_screen_answer", outcome: "incorrect", source: "human" });
  const incorrect = verifyDeviceTrial(observation);
  assert.equal(incorrect.status, "fail");
  assert.ok(incorrect.reasons.includes("human_judgment_not_correct"));
});

test("T1 enforces the post-ASR context recapture order", () => {
  const observation = clone(T1_BASE);
  const context = observation.events.find((event) => event.kind === "context_recaptured");
  const release = observation.events.find((event) => event.kind === "ptt_released");
  context.sequence = release.sequence - 1;
  const result = verifyDeviceTrial(observation);
  assert.equal(result.status, "fail");
  assert.ok(result.reasons.includes("context_order_invalid"));
});

test("T1 uses the runtime recapture reason spelling", () => {
  const observation = clone(T1_BASE);
  observation.events.find((event) => event.kind === "context_recaptured").reason = "SceneChanged";
  const result = verifyDeviceTrial(observation);
  assert.equal(result.status, "invalid");
  assert.ok(result.reasons.some((reason) => reason.startsWith("context_reason_invalid:")));
});

test("T1 requires fresh source dimensions with the recapture", () => {
  const unavailable = clone(T1_BASE);
  unavailable.events.find((event) => event.kind === "context_recaptured").sourceDimensionsAvailable = false;
  const unavailableResult = verifyDeviceTrial(unavailable);
  assert.equal(unavailableResult.status, "invalid");
  assert.ok(unavailableResult.reasons.includes("context_source_dimensions_unavailable:events[2]"));

  const missing = clone(T1_BASE);
  delete missing.events.find((event) => event.kind === "context_recaptured").sourceDimensionsAvailable;
  const missingResult = verifyDeviceTrial(missing);
  assert.equal(missingResult.status, "invalid");
  assert.ok(missingResult.reasons.includes("context_source_dimensions_unavailable:events[2]"));
});

test("T2 accepts one verified AX action and one opaque Finder parent transition", () => {
  const result = verifyDeviceTrial(clone(T2_BASE));
  assert.equal(result.status, "pass");
  assert.deepEqual(result.reasons, []);
});

test("T2 requires exactly one receipt and rejects retry or unknown commit", () => {
  const observation = clone(T2_BASE);
  observation.events.push(
    { kind: "action_receipt", sequence: 5, observedAt: "2026-08-29T00:00:04.000Z", receiptIdHash: "f".repeat(64) },
    { kind: "retry", sequence: 6, observedAt: "2026-08-29T00:00:05.000Z" },
    { kind: "unknown_commit", sequence: 7, observedAt: "2026-08-29T00:00:06.000Z" },
  );
  const result = verifyDeviceTrial(observation);
  assert.equal(result.status, "fail");
  assert.ok(result.reasons.includes("receipt_count_not_one"));
  assert.ok(result.reasons.includes("retry_detected"));
  assert.ok(result.reasons.includes("unknown_commit_detected"));
});

test("T2 requires the terminal to carry the same opaque action receipt", () => {
  const observation = clone(T2_BASE);
  observation.events.find((event) => event.kind === "terminal").receiptIdHash = "9".repeat(64);

  const result = verifyDeviceTrial(observation);
  assert.equal(result.status, "fail");
  assert.ok(result.reasons.includes("terminal_receipt_mismatch"));

  const missing = clone(T2_BASE);
  delete missing.events.find((event) => event.kind === "terminal").receiptIdHash;
  const missingResult = verifyDeviceTrial(missing);
  assert.equal(missingResult.status, "invalid");
  assert.ok(missingResult.reasons.includes("terminal_receipt_hash_invalid:events[4]"));
});

test("T2 does not accept the caller's receipts array or a non-opaque Finder value", () => {
  const observation = clone(T2_BASE);
  observation.receipts = ["action_receipt"];
  observation.events.find((event) => event.kind === "finder_state" && event.phase === "before").opaqueStateHash = "/Users/name/Desktop";
  const result = verifyDeviceTrial(observation);
  assert.equal(result.status, "invalid");
  assert.ok(result.reasons.includes("forbidden_field:receipts"));
  assert.ok(result.reasons.includes("opaque_hash_invalid"));
});

test("T2 requires an external Finder before/after direct_parent relation", () => {
  const observation = clone(T2_BASE);
  observation.events.find((event) => event.kind === "finder_state" && event.phase === "after").relation = "same";
  const result = verifyDeviceTrial(observation);
  assert.equal(result.status, "fail");
  assert.ok(result.reasons.includes("finder_relation_not_direct_parent"));
});

test("T2 requires before and after states from the same Finder instance", () => {
  const missing = clone(T2_BASE);
  delete missing.events.find((event) => event.kind === "finder_state" && event.phase === "before").finderInstanceHash;
  const missingResult = verifyDeviceTrial(missing);
  assert.equal(missingResult.status, "invalid");
  assert.ok(missingResult.reasons.includes("finder_instance_hash_invalid:events[0]"));

  const mismatch = clone(T2_BASE);
  mismatch.events.find((event) => event.kind === "finder_state" && event.phase === "after").finderInstanceHash = "1".repeat(64);
  const mismatchResult = verifyDeviceTrial(mismatch);
  assert.equal(mismatchResult.status, "fail");
  assert.ok(mismatchResult.reasons.includes("finder_instance_mismatch"));
});

test("T2 requires a verified terminal and rejects failure or false completion events", () => {
  const observation = clone(T2_BASE);
  observation.events.find((event) => event.kind === "terminal").state = "unknown";
  observation.events.push(
    { kind: "failure", sequence: 6, observedAt: "2026-08-29T00:00:05.000Z", code: "action_failed" },
    { kind: "false_completion", sequence: 7, observedAt: "2026-08-29T00:00:06.000Z", code: "spoken_without_readback" },
  );
  const result = verifyDeviceTrial(observation);
  assert.equal(result.status, "fail");
  assert.ok(result.reasons.includes("verified_terminal_missing"));
  assert.ok(result.reasons.includes("failure_event_present"));
  assert.ok(result.reasons.includes("false_completion_event_present"));
});

test("T2 requires the production computer.action.completed fields", () => {
  for (const [field, value] of [
    ["status", "failed"],
    ["status", "unverified"],
    ["status", "unknown"],
    ["method", "unknown"],
    ["code", "ax_press_failed"],
    ["verified", false],
    ["retryCount", 1],
  ]) {
    const observation = clone(T2_BASE);
    observation.events.find((event) => event.kind === "ax_action")[field] = value;
    const result = verifyDeviceTrial(observation);
    assert.notEqual(result.status, "pass", field);
    assert.ok(result.reasons.includes("verified_ax_action_missing"), field);
  }

  const missingStatus = clone(T2_BASE);
  delete missingStatus.events.find((event) => event.kind === "ax_action").status;
  const missingStatusResult = verifyDeviceTrial(missingStatus);
  assert.equal(missingStatusResult.status, "invalid");
  assert.ok(missingStatusResult.reasons.includes("ax_status_invalid:events[1]"));
});

test("T3 accepts the complete same-id, same-scope memory lifecycle", () => {
  const result = verifyDeviceTrial(clone(T3_BASE));
  assert.equal(result.status, "pass");
  assert.deepEqual(result.reasons, []);
});

test("T3 fails a memory id or scope mismatch and detects resurrection after restart", () => {
  const observation = clone(T3_BASE);
  observation.events[1].memoryIdHash = "1".repeat(64);
  observation.events.push({
    kind: "memory_state",
    sequence: 6,
    observedAt: "2026-08-29T00:00:05.000Z",
    state: "resurrected",
    memoryIdHash: "d".repeat(64),
    scopeHash: "e".repeat(64),
  });
  const result = verifyDeviceTrial(observation);
  assert.equal(result.status, "fail");
  assert.ok(result.reasons.includes("memory_id_mismatch"));
  assert.ok(result.reasons.includes("memory_resurrection_detected"));
});

test("T3 requires notUsedAfterRestart and rejects a used event after restart", () => {
  const observation = clone(T3_BASE);
  observation.events = observation.events.filter((event) => event.state !== "notUsedAfterRestart");
  observation.events.push({
    kind: "memory_state",
    sequence: 8,
    observedAt: "2026-08-29T00:00:07.000Z",
    state: "used",
    memoryIdHash: "d".repeat(64),
    scopeHash: "e".repeat(64),
  });
  const result = verifyDeviceTrial(observation);
  assert.equal(result.status, "fail");
  assert.ok(result.reasons.includes("not_used_after_restart_missing"));
  assert.ok(result.reasons.includes("memory_resurrection_detected"));
});

test("T3 requires correct human recall and post-restart absence judgments", () => {
  const observation = clone(T3_BASE);
  observation.events.find((event) => event.phase === "recall_before_forget").outcome = "incorrect";
  const result = verifyDeviceTrial(observation);
  assert.equal(result.status, "fail");
  assert.ok(result.reasons.includes("human_judgment_not_correct:recall_before_forget"));

  const missing = clone(T3_BASE);
  missing.events = missing.events.filter((event) => event.phase !== "absence_after_restart");
  const missingResult = verifyDeviceTrial(missing);
  assert.equal(missingResult.status, "fail");
  assert.ok(missingResult.reasons.includes("human_judgment_missing:absence_after_restart"));
});

test("schema validation fails closed for unknown critical fields and malformed input", () => {
  const unknown = clone(T1_BASE);
  unknown.events[0].madeUpCriticalEvidence = true;
  const unknownResult = validateDeviceObservation(unknown);
  assert.equal(unknownResult.status, "invalid");
  assert.ok(unknownResult.reasons.includes("unknown_field:events[0].madeUpCriticalEvidence"));

  for (const value of [null, [], "not-json-object", { schemaVersion: 1, contract: "t1.ptt", trialId: "x", events: "no" }]) {
    assert.equal(validateDeviceObservation(value).status, "invalid");
  }

  const malformedTimestamp = clone(T1_BASE);
  malformedTimestamp.events[0].observedAt = "2026-08-29";
  assert.equal(validateDeviceObservation(malformedTimestamp).status, "invalid");

  const prototypeContract = clone(T1_BASE);
  prototypeContract.contract = "__proto__";
  assert.equal(verifyDeviceTrial(prototypeContract).status, "invalid");
});

test("forbidden field scanning folds separators and matches quality-event sensitive names", () => {
  for (const key of [
    "transcript",
    "screen_shot",
    "window-title",
    "memory text",
    "prompt",
    "prompt_text",
    "url",
    "label",
    "file-path",
    "api_key",
    "api-key-value",
    "token",
    "password",
    "cookie",
    "authorization",
    "email",
    "username",
    "source_window_title",
  ]) {
    const observation = clone(T1_BASE);
    observation.events[0][key] = "sensitive-value";
    const result = verifyDeviceTrial(observation);
    assert.equal(result.status, "invalid", key);
    assert.ok(result.reasons.includes(`forbidden_field:${key}`), key);
  }
});

test("verification is pure and repeatable", () => {
  const observation = clone(T3_BASE);
  const before = clone(observation);
  const first = verifyDeviceTrial(observation);
  const second = verifyDeviceTrial(observation);
  assert.deepEqual(observation, before);
  assert.deepEqual(second, first);
});

test("the published JSON schema is closed at every event/object definition", () => {
  assert.equal(schema.unevaluatedProperties, false);
  assert.equal(schema.oneOf.length, 3);
  for (const definition of Object.values(schema.$defs)) {
    if (definition.type === "object") assert.equal(definition.additionalProperties, false);
  }
});
