import assert from "node:assert/strict";
import test from "node:test";

import { collectDeviceObservation } from "./quality-observation-collector.mjs";

const APP_PID = 41001;
const RESTARTED_PID = 41002;
const MEMORY_ID_HASH = "d".repeat(64);
const SCOPE_HASH = "e".repeat(64);

function qualityEvent({
  id,
  appPid = APP_PID,
  occurredAt = "2026-08-29T00:00:00Z",
  sessionId,
  name,
  attributes = {},
  status,
  durationMs,
}) {
  const event = {
    schemaVersion: 1,
    eventId: `event-${id}`,
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

function qualityJsonl(events) {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function t1Events(overrides = {}) {
  return [
    qualityEvent({ id: "t1-down", sessionId: "voice", name: "ptt.key_down" }),
    qualityEvent({
      id: "t1-up",
      sessionId: "voice",
      name: "ptt.key_up",
      durationMs: 6_400,
      occurredAt: "2026-08-29T00:00:00Z",
    }),
    qualityEvent({
      id: "t1-context",
      sessionId: "voice",
      name: "context.resolved",
      attributes: { reason: "recaptureSceneChanged", sourceDimensionsAvailable: true },
      occurredAt: "2026-08-29T00:00:01Z",
    }),
    qualityEvent({
      id: "t1-model",
      sessionId: "voice",
      name: "model.completed",
      attributes: { verified: true, taskTerminal: "verified" },
      occurredAt: "2026-08-29T00:00:02Z",
    }),
  ].map((event) => ({ ...event, ...overrides[event.name] }));
}

function t2Events() {
  return [
    qualityEvent({
      id: "t2-action",
      sessionId: "desktop",
      name: "computer.action.completed",
      status: "verified",
      attributes: {
        method: "ax_press",
        code: "verified_accessibility",
        verified: true,
        retryCount: 0,
        receiptHash: "a".repeat(64),
      },
    }),
    qualityEvent({
      id: "t2-result-sending",
      sessionId: "desktop",
      name: "computer.result.sending",
      attributes: { receiptStatus: "verified" },
    }),
    qualityEvent({
      id: "t2-result-sent",
      sessionId: "desktop",
      name: "computer.result.sent",
      attributes: { receiptStatus: "verified" },
    }),
    qualityEvent({
      id: "t2-model",
      sessionId: "voice",
      name: "model.completed",
      attributes: { verified: true, taskTerminal: "verified" },
      occurredAt: "2026-08-29T00:00:01Z",
    }),
  ];
}

function t3Events() {
  return [
    qualityEvent({
      id: "t3-remembered",
      sessionId: "memory",
      name: "memory.remembered",
      status: "ok",
      attributes: { memoryIdHash: MEMORY_ID_HASH, scopeHash: SCOPE_HASH },
    }),
    qualityEvent({
      id: "t3-used",
      sessionId: "memory",
      name: "memory.used",
      status: "ok",
      attributes: { memoryIdHash: MEMORY_ID_HASH, scopeHash: SCOPE_HASH },
      occurredAt: "2026-08-29T00:00:01Z",
    }),
    qualityEvent({
      id: "t3-forgotten",
      sessionId: "memory",
      name: "memory.forgotten",
      status: "ok",
      attributes: { memoryIdHash: MEMORY_ID_HASH, scopeHash: SCOPE_HASH },
      occurredAt: "2026-08-29T00:00:02Z",
    }),
    qualityEvent({
      id: "t3-restart",
      appPid: RESTARTED_PID,
      sessionId: "app",
      name: "app.ready",
      occurredAt: "2026-08-29T00:00:03Z",
    }),
    qualityEvent({
      id: "t3-post-restart-asr",
      appPid: RESTARTED_PID,
      sessionId: "voice",
      name: "asr.completed",
      occurredAt: "2026-08-29T00:00:03Z",
    }),
    qualityEvent({
      id: "t3-query-down",
      appPid: RESTARTED_PID,
      sessionId: "voice",
      name: "ptt.key_down",
      occurredAt: "2026-08-29T00:00:04Z",
    }),
    qualityEvent({
      id: "t3-query-up",
      appPid: RESTARTED_PID,
      sessionId: "voice",
      name: "ptt.key_up",
      occurredAt: "2026-08-29T00:00:05Z",
      durationMs: 6_400,
    }),
    qualityEvent({
      id: "t3-query-model",
      appPid: RESTARTED_PID,
      sessionId: "voice",
      name: "model.completed",
      attributes: { verified: true, taskTerminal: "verified" },
      occurredAt: "2026-08-29T00:00:06Z",
    }),
  ];
}

function collect({ events, contract, trialId, appPid = APP_PID, expectedRestartedPid, startOffset = 0 }) {
  return collectDeviceObservation({
    qualityJsonl: qualityJsonl(events),
    trialStartByteOffset: startOffset,
    appPid,
    ...(expectedRestartedPid === undefined ? {} : { expectedRestartedPid }),
    contract,
    trialId,
  });
}

test("collects T1 raw observations and preserves durationMs without using second-level timestamps", () => {
  const result = collect({ events: t1Events(), contract: "t1.ptt", trialId: "t1-raw" });

  assert.equal(result.status, "valid");
  assert.deepEqual(result.observation.events, [
    { kind: "ptt_pressed", sequence: 1, observedAt: "2026-08-29T00:00:00Z" },
    {
      kind: "ptt_released",
      sequence: 2,
      observedAt: "2026-08-29T00:00:00Z",
      durationMs: 6_400,
    },
    {
      kind: "context_recaptured",
      sequence: 3,
      observedAt: "2026-08-29T00:00:01Z",
      reason: "recaptureSceneChanged",
      sourceDimensionsAvailable: true,
    },
    { kind: "terminal", sequence: 4, observedAt: "2026-08-29T00:00:02Z", state: "completed" },
  ]);
  assert.equal("passed" in result.observation, false);
  assert.equal("taskTerminal" in result.observation, false);
  assert.equal("receipts" in result.observation, false);
});

test("requires context sourceDimensionsAvailable to be explicitly true", () => {
  for (const sourceDimensionsAvailable of [false, undefined]) {
    const events = t1Events();
    events[2] = {
      ...events[2],
      attributes: {
        reason: "recaptureSceneChanged",
        ...(sourceDimensionsAvailable === undefined ? {} : { sourceDimensionsAvailable }),
      },
    };
    const result = collect({
      events,
      contract: "t1.ptt",
      trialId: `t1-context-dimensions-${sourceDimensionsAvailable ?? "missing"}`,
    });

    assert.equal(result.status, "invalid");
    assert.ok(result.reasons.includes("context_shape_invalid"));
  }
});

test("T2 rejects a verified terminal that is not bound to the action receipt", () => {
  for (const [label, receiptHash] of [["missing", undefined], ["mismatch", "b".repeat(64)]]) {
    const events = t2Events();
    if (receiptHash !== undefined) events.at(-1).attributes.receiptHash = receiptHash;
    const result = collect({
      events,
      contract: "t2.ax",
      trialId: `t2-unbound-terminal-${label}`,
    });

    assert.equal(result.status, "invalid");
    assert.ok(result.reasons.includes("terminal_receipt_mismatch"));
  }
});

test("collects T2 action receipt details and terminal, leaving Finder evidence external", () => {
  const events = t2Events();
  events.at(-1).attributes.receiptHash = "a".repeat(64);
  const result = collect({ events, contract: "t2.ax", trialId: "t2-raw" });

  assert.equal(result.status, "valid");
  assert.deepEqual(result.observation.events, [
    {
      kind: "ax_action",
      sequence: 1,
      observedAt: "2026-08-29T00:00:00Z",
      status: "verified",
      method: "ax_press",
      code: "verified_accessibility",
      verified: true,
      retryCount: 0,
    },
    {
      kind: "action_receipt",
      sequence: 2,
      observedAt: "2026-08-29T00:00:00Z",
      receiptIdHash: "a".repeat(64),
    },
    {
      kind: "terminal",
      sequence: 3,
      observedAt: "2026-08-29T00:00:01Z",
      state: "verified",
      receiptIdHash: "a".repeat(64),
    },
  ]);
  assert.equal(result.observation.events.some((event) => event.kind === "finder_state"), false);
});

test("T2 does not map an informational completion to a verified action", () => {
  const events = t2Events();
  events.at(-1).attributes = {
    verified: false,
    taskTerminal: "unverified",
    receiptHash: "a".repeat(64),
  };
  const result = collect({ events, contract: "t2.ax", trialId: "t2-informational-terminal" });

  assert.equal(result.status, "invalid");
  assert.ok(result.reasons.includes("terminal_not_verified"));
});

test("does not derive a successful T2 action from a failed App status", () => {
  const events = t2Events();
  events[0] = { ...events[0], status: "failed" };
  const result = collect({ events, contract: "t2.ax", trialId: "t2-failed-status" });

  assert.equal(result.status, "invalid");
  assert.ok(result.reasons.includes("action_receipt_invalid"));
});

test("maps T3 memory hashes and only a changed expected PID app.ready into app_restart", () => {
  const result = collect({
    events: t3Events(),
    contract: "t3.memory",
    trialId: "t3-raw",
    expectedRestartedPid: RESTARTED_PID,
  });

  assert.equal(result.status, "valid");
  assert.equal(result.observation.memoryIdHash, MEMORY_ID_HASH);
  assert.equal(result.observation.scopeHash, SCOPE_HASH);
  assert.deepEqual(result.observation.events, [
    {
      kind: "memory_state",
      sequence: 1,
      observedAt: "2026-08-29T00:00:00Z",
      state: "remembered",
      memoryIdHash: MEMORY_ID_HASH,
      scopeHash: SCOPE_HASH,
    },
    {
      kind: "memory_state",
      sequence: 2,
      observedAt: "2026-08-29T00:00:01Z",
      state: "used",
      memoryIdHash: MEMORY_ID_HASH,
      scopeHash: SCOPE_HASH,
    },
    {
      kind: "memory_state",
      sequence: 3,
      observedAt: "2026-08-29T00:00:02Z",
      state: "forgotten",
      memoryIdHash: MEMORY_ID_HASH,
      scopeHash: SCOPE_HASH,
    },
    {
      kind: "app_restart",
      sequence: 4,
      observedAt: "2026-08-29T00:00:03Z",
      memoryIdHash: MEMORY_ID_HASH,
      scopeHash: SCOPE_HASH,
    },
    {
      kind: "memory_state",
      sequence: 5,
      observedAt: "2026-08-29T00:00:06Z",
      state: "notUsedAfterRestart",
      memoryIdHash: MEMORY_ID_HASH,
      scopeHash: SCOPE_HASH,
    },
  ]);
});

test("closes the T3 restart window with one real PTT/model query and rejects missing evidence", () => {
  const result = collect({
    events: t3Events().slice(0, 4),
    contract: "t3.memory",
    trialId: "t3-query-missing",
    expectedRestartedPid: RESTARTED_PID,
  });

  assert.equal(result.status, "invalid");
  assert.ok(result.reasons.includes("post_restart_query_missing"));
  assert.ok(result.reasons.includes("not_used_after_restart_missing"));
});

test("maps same-identity post-restart memory.used as resurrected evidence", () => {
  const events = [
    ...t3Events(),
    qualityEvent({
      id: "t3-resurrected",
      appPid: RESTARTED_PID,
      sessionId: "memory",
      name: "memory.used",
      status: "ok",
      attributes: { memoryIdHash: MEMORY_ID_HASH, scopeHash: SCOPE_HASH },
      occurredAt: "2026-08-29T00:00:07Z",
    }),
  ];
  const result = collect({
    events,
    contract: "t3.memory",
    trialId: "t3-resurrected",
    expectedRestartedPid: RESTARTED_PID,
  });

  assert.equal(result.status, "valid");
  assert.equal(result.observation.events.at(-1).state, "resurrected");
  assert.equal(result.observation.events.some((event) => event.state === "notUsedAfterRestart"), false);
});

test("rejects post-restart memory.used with a different identity instead of hiding contamination", () => {
  const events = [
    ...t3Events(),
    qualityEvent({
      id: "t3-other-memory-after-restart",
      appPid: RESTARTED_PID,
      sessionId: "memory",
      name: "memory.used",
      status: "ok",
      attributes: { memoryIdHash: "f".repeat(64), scopeHash: SCOPE_HASH },
      occurredAt: "2026-08-29T00:00:07Z",
    }),
  ];
  const result = collect({
    events,
    contract: "t3.memory",
    trialId: "t3-other-memory-after-restart",
    expectedRestartedPid: RESTARTED_PID,
  });

  assert.equal(result.status, "invalid");
  assert.ok(result.reasons.includes("post_restart_memory_identity_mismatch"));
});

test("rejects old and third PIDs after the expected restart instead of mixing their events", () => {
  for (const [id, appPid] of [["old-pid-after-restart", APP_PID], ["third-pid-after-restart", APP_PID + 99]]) {
    const events = [
      ...t3Events(),
      qualityEvent({
        id,
        appPid,
        sessionId: "voice",
        name: "ptt.key_down",
        occurredAt: "2026-08-29T00:00:07Z",
      }),
    ];
    const result = collect({
      events,
      contract: "t3.memory",
      trialId: `t3-${id}`,
      expectedRestartedPid: RESTARTED_PID,
    });

    assert.equal(result.status, "invalid");
    assert.ok(result.reasons.includes("app_pid_mismatch_after_restart"));
  }
});

test("rejects PID pollution instead of mixing another process into the observation", () => {
  const events = t1Events();
  events[2] = { ...events[2], appPid: APP_PID + 1 };
  const result = collect({ events, contract: "t1.ptt", trialId: "t1-pid" });

  assert.equal(result.status, "invalid");
  assert.ok(result.reasons.includes("app_pid_mismatch"));
});

test("rejects a stale offset that would consume an old critical event", () => {
  const oldEvent = qualityEvent({ id: "old-down", sessionId: "voice", name: "ptt.key_down" });
  const events = [oldEvent, ...t1Events()];
  const result = collect({ events, contract: "t1.ptt", trialId: "t1-stale-offset" });

  assert.equal(result.status, "invalid");
  assert.ok(result.reasons.includes("duplicate_critical_event:ptt.key_down"));
});

test("consumes only complete lines after the supplied byte offset", () => {
  const prefix = qualityJsonl([
    qualityEvent({ id: "before-trial", sessionId: "app", name: "app.launched" }),
  ]);
  const suffix = qualityJsonl(t1Events());
  const result = collectDeviceObservation({
    qualityJsonl: `${prefix}${suffix}`,
    trialStartByteOffset: Buffer.byteLength(prefix),
    appPid: APP_PID,
    contract: "t1.ptt",
    trialId: "t1-offset-boundary",
  });

  assert.equal(result.status, "valid");
  assert.equal(result.observation.events[0].kind, "ptt_pressed");

  const insideLine = collectDeviceObservation({
    qualityJsonl: suffix,
    trialStartByteOffset: 1,
    appPid: APP_PID,
    contract: "t1.ptt",
    trialId: "t1-offset-inside-line",
  });
  assert.equal(insideLine.status, "invalid");
  assert.ok(insideLine.reasons.includes("trial_start_offset_not_line_boundary"));
});

test("rejects sensitive fields even when they are nested in a quality event", () => {
  const events = t1Events();
  events[0] = { ...events[0], attributes: { transcript: "private" } };
  const result = collect({ events, contract: "t1.ptt", trialId: "t1-sensitive" });

  assert.equal(result.status, "invalid");
  assert.ok(result.reasons.includes("forbidden_field:attributes.transcript"));
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test("rejects malformed JSON and a partial trailing JSONL line", () => {
  const valid = qualityJsonl(t1Events());
  const malformed = collectDeviceObservation({
    qualityJsonl: `not-json\n`,
    trialStartByteOffset: 0,
    appPid: APP_PID,
    contract: "t1.ptt",
    trialId: "t1-malformed",
  });
  assert.equal(malformed.status, "invalid");
  assert.ok(malformed.reasons.includes("malformed_json:1"));

  const partial = collectDeviceObservation({
    qualityJsonl: `${valid}{"schemaVersion":1`,
    trialStartByteOffset: 0,
    appPid: APP_PID,
    contract: "t1.ptt",
    trialId: "t1-partial",
  });
  assert.equal(partial.status, "invalid");
  assert.ok(partial.reasons.includes("partial_trailing_line"));
});

test("accepts a completed informational answer whose correctness is judged externally", () => {
  const events = t1Events();
  events[3] = {
    ...events[3],
    status: "ok",
    attributes: { verified: false, taskTerminal: "unverified" },
  };
  const result = collect({ events, contract: "t1.ptt", trialId: "t1-unverified" });

  assert.equal(result.status, "valid");
  assert.equal(result.observation.events.at(-1)?.kind, "terminal");
  assert.equal(result.observation.events.at(-1)?.state, "completed");
});

test("rejects a failed forget instead of mapping it to forgotten", () => {
  const events = t3Events();
  events[2] = { ...events[2], status: "failed" };
  const result = collect({
    events,
    contract: "t3.memory",
    trialId: "t3-failed-forget",
    expectedRestartedPid: RESTARTED_PID,
  });

  assert.equal(result.status, "invalid");
  assert.ok(result.reasons.includes("memory_forget_not_confirmed"));
});

test("rejects different memory hashes rather than crossing memory identity", () => {
  const events = t3Events();
  events[1] = {
    ...events[1],
    attributes: { memoryIdHash: "f".repeat(64), scopeHash: SCOPE_HASH },
  };
  const result = collect({
    events,
    contract: "t3.memory",
    trialId: "t3-different-memory",
    expectedRestartedPid: RESTARTED_PID,
  });

  assert.equal(result.status, "invalid");
  assert.ok(result.reasons.includes("memory_id_mismatch"));
});

test("requires a changed expected restart PID and never accepts app.ready as a same-PID restart", () => {
  const samePidReady = qualityEvent({ id: "same-ready", sessionId: "app", name: "app.ready" });
  const result = collect({
    events: [...t3Events().slice(0, 3), samePidReady],
    contract: "t3.memory",
    trialId: "t3-same-pid",
    expectedRestartedPid: RESTARTED_PID,
  });

  assert.equal(result.status, "invalid");
  assert.ok(result.reasons.includes("app_restart_missing"));
});

test("rejects unknown event names and unknown fields instead of silently dropping them", () => {
  const unknownName = collect({
    events: [...t1Events(), qualityEvent({ id: "unknown", sessionId: "voice", name: "made.up.event" })],
    contract: "t1.ptt",
    trialId: "t1-unknown-name",
  });
  assert.equal(unknownName.status, "invalid");
  assert.ok(unknownName.reasons.includes("unknown_event_name"));

  const unknownFieldEvents = t1Events();
  unknownFieldEvents[0] = { ...unknownFieldEvents[0], madeUp: true };
  const unknownField = collect({ events: unknownFieldEvents, contract: "t1.ptt", trialId: "t1-unknown-field" });
  assert.equal(unknownField.status, "invalid");
  assert.ok(unknownField.reasons.includes("unknown_event_field:1.madeUp"));
});
