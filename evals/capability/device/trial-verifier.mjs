import schema from "./device-observation.schema.json" with { type: "json" };

export const DEVICE_OBSERVATION_SCHEMA = schema;
export const DEVICE_OBSERVATION_SCHEMA_VERSION = 1;

const CONTRACTS = new Set(["t1.ptt", "t2.ax", "t3.memory"]);
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const TRIAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
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

const EVENT_FIELDS = {
  ptt_pressed: ["kind", "sequence", "observedAt"],
  ptt_released: ["kind", "sequence", "observedAt", "durationMs"],
  context_recaptured: ["kind", "sequence", "observedAt", "reason", "sourceDimensionsAvailable"],
  terminal: ["kind", "sequence", "observedAt", "state"],
  failure: ["kind", "sequence", "observedAt", "code"],
  false_completion: ["kind", "sequence", "observedAt", "code"],
  human_judgment: ["kind", "sequence", "observedAt", "phase", "outcome", "source"],
  ax_action: ["kind", "sequence", "observedAt", "status", "method", "code", "verified", "retryCount"],
  action_receipt: ["kind", "sequence", "observedAt", "receiptIdHash"],
  finder_state: ["kind", "sequence", "observedAt", "phase", "opaqueStateHash", "finderInstanceHash", "relation", "source"],
  retry: ["kind", "sequence", "observedAt"],
  unknown_commit: ["kind", "sequence", "observedAt"],
  memory_state: ["kind", "sequence", "observedAt", "state", "memoryIdHash", "scopeHash"],
  app_restart: ["kind", "sequence", "observedAt", "memoryIdHash", "scopeHash"],
};

const CONTRACT_EVENTS = {
  "t1.ptt": new Set(["ptt_pressed", "ptt_released", "context_recaptured", "terminal", "failure", "false_completion", "human_judgment"]),
  "t2.ax": new Set(["ax_action", "action_receipt", "finder_state", "retry", "unknown_commit", "terminal", "failure", "false_completion"]),
  "t3.memory": new Set(["memory_state", "app_restart", "human_judgment"]),
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pushUnique(reasons, reason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function fieldPath(parent, key) {
  return parent ? `${parent}.${key}` : key;
}

function normalizeFieldName(key) {
  return key.toLowerCase().replace(/[_\-\s]/gu, "");
}

function scanForbidden(value, reasons, path = "") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbidden(item, reasons, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeFieldName(key);
    if ([...FORBIDDEN_FIELDS].some((forbidden) => normalized.includes(forbidden))) {
      pushUnique(reasons, `forbidden_field:${key}`);
    }
    scanForbidden(child, reasons, fieldPath(path, key));
  }
}

function checkAllowedFields(value, allowed, reasons, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) pushUnique(reasons, `unknown_field:${fieldPath(path, key)}`);
  }
}

function isDateTime(value) {
  return typeof value === "string" && DATE_TIME_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function isHash(value) {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function checkEventShape(event, reasons, path, contract) {
  if (!isRecord(event)) {
    pushUnique(reasons, `event_invalid:${path}`);
    return null;
  }
  if (typeof event.kind !== "string" || !Object.hasOwn(EVENT_FIELDS, event.kind)) {
    pushUnique(reasons, `unknown_event_kind:${event.kind ?? "missing"}`);
    return null;
  }
  const fields = event.kind === "human_judgment" && contract === "t3.memory"
    ? [...EVENT_FIELDS[event.kind], "memoryIdHash", "scopeHash"]
    : event.kind === "terminal" && contract === "t2.ax"
      ? [...EVENT_FIELDS[event.kind], "receiptIdHash"]
      : EVENT_FIELDS[event.kind];
  checkAllowedFields(event, fields, reasons, path);
  if (!Number.isInteger(event.sequence) || event.sequence < 1) {
    pushUnique(reasons, `event_sequence_invalid:${path}`);
  }
  if (!isDateTime(event.observedAt)) pushUnique(reasons, `event_timestamp_invalid:${path}`);

  switch (event.kind) {
    case "ptt_released":
      if (!Number.isSafeInteger(event.durationMs) || event.durationMs < 0) {
        pushUnique(reasons, `ptt_duration_invalid:${path}`);
      }
      break;
    case "context_recaptured":
      if (event.reason !== "recaptureStale" && event.reason !== "recaptureSceneChanged") {
        pushUnique(reasons, `context_reason_invalid:${path}`);
      }
      if (event.sourceDimensionsAvailable !== true) {
        pushUnique(reasons, `context_source_dimensions_unavailable:${path}`);
      }
      break;
    case "terminal":
      if (!["verified", "failed", "unknown"].includes(event.state)) {
        pushUnique(reasons, `terminal_state_invalid:${path}`);
      }
      if (contract === "t2.ax" && !isHash(event.receiptIdHash)) {
        pushUnique(reasons, `terminal_receipt_hash_invalid:${path}`);
      }
      break;
    case "failure":
    case "false_completion":
      if (typeof event.code !== "string" || !CODE_PATTERN.test(event.code)) {
        pushUnique(reasons, `event_code_invalid:${path}`);
      }
      break;
    case "ax_action":
      if (!["verified", "delivered", "unverified", "blocked", "failed", "unknown"].includes(event.status)) {
        pushUnique(reasons, `ax_status_invalid:${path}`);
      }
      if (!["ax_press", "ax_set_value", "quartz", "native_command", "shortcut", "unknown"].includes(event.method)) {
        pushUnique(reasons, `ax_method_invalid:${path}`);
      }
      if (typeof event.code !== "string" || !CODE_PATTERN.test(event.code)) {
        pushUnique(reasons, `ax_code_invalid:${path}`);
      }
      if (typeof event.verified !== "boolean") pushUnique(reasons, `ax_verified_invalid:${path}`);
      if (!Number.isSafeInteger(event.retryCount) || event.retryCount < 0) {
        pushUnique(reasons, `ax_retry_count_invalid:${path}`);
      }
      break;
    case "action_receipt":
      if (!isHash(event.receiptIdHash)) pushUnique(reasons, "opaque_hash_invalid");
      break;
    case "finder_state":
      if (!["before", "after"].includes(event.phase)) pushUnique(reasons, `finder_phase_invalid:${path}`);
      if (!isHash(event.opaqueStateHash)) pushUnique(reasons, "opaque_hash_invalid");
      if (!isHash(event.finderInstanceHash)) {
        pushUnique(reasons, `finder_instance_hash_invalid:${path}`);
      }
      if (event.source !== "finder") pushUnique(reasons, `finder_source_invalid:${path}`);
      if (event.phase === "before" && Object.hasOwn(event, "relation")) {
        pushUnique(reasons, `unknown_field:${path}.relation`);
      }
      if (event.phase === "after" && !["direct_parent", "same", "unknown"].includes(event.relation)) {
        pushUnique(reasons, `finder_relation_invalid:${path}`);
      }
      break;
    case "human_judgment":
      if (contract === "t1.ptt" && event.phase !== "latest_screen_answer") {
        pushUnique(reasons, `human_judgment_phase_invalid:${path}`);
      }
      if (contract === "t3.memory"
        && event.phase !== "recall_before_forget"
        && event.phase !== "absence_after_restart") {
        pushUnique(reasons, `human_judgment_phase_invalid:${path}`);
      }
      if (!["correct", "incorrect"].includes(event.outcome)) {
        pushUnique(reasons, `human_judgment_outcome_invalid:${path}`);
      }
      if (event.source !== "human") pushUnique(reasons, `human_judgment_source_invalid:${path}`);
      if (contract === "t3.memory" && (!isHash(event.memoryIdHash) || !isHash(event.scopeHash))) {
        pushUnique(reasons, "opaque_hash_invalid");
      }
      break;
    case "memory_state":
      if (!["remembered", "used", "forgotten", "notUsedAfterRestart", "resurrected"].includes(event.state)) {
        pushUnique(reasons, `memory_state_invalid:${path}`);
      }
      if (!isHash(event.memoryIdHash) || !isHash(event.scopeHash)) pushUnique(reasons, "opaque_hash_invalid");
      break;
    case "app_restart":
      if (!isHash(event.memoryIdHash) || !isHash(event.scopeHash)) pushUnique(reasons, "opaque_hash_invalid");
      break;
    default:
      break;
  }
  return event;
}

function validateCommon(input, reasons, allowed) {
  checkAllowedFields(input, allowed, reasons, "");
  if (input.schemaVersion !== DEVICE_OBSERVATION_SCHEMA_VERSION) pushUnique(reasons, "schema_version_unsupported");
  if (!CONTRACTS.has(input.contract)) pushUnique(reasons, "contract_unsupported");
  if (typeof input.trialId !== "string" || !TRIAL_ID_PATTERN.test(input.trialId)) {
    pushUnique(reasons, "trial_id_invalid");
  }
  if (!Array.isArray(input.events)) pushUnique(reasons, "events_invalid");
}

export function validateDeviceObservation(input) {
  const reasons = [];
  scanForbidden(input, reasons);
  if (!isRecord(input)) return { status: "invalid", reasons: ["schema_root_invalid", ...reasons] };

  validateCommon(input, reasons, input.contract === "t3.memory"
    ? ["schemaVersion", "contract", "trialId", "memoryIdHash", "scopeHash", "events"]
    : ["schemaVersion", "contract", "trialId", "events"]);

  if (input.contract === "t3.memory") {
    if (!isHash(input.memoryIdHash)) pushUnique(reasons, "opaque_hash_invalid");
    if (!isHash(input.scopeHash)) pushUnique(reasons, "opaque_hash_invalid");
  }

  if (Array.isArray(input.events)) {
    const allowedEvents = Object.hasOwn(CONTRACT_EVENTS, input.contract)
      ? CONTRACT_EVENTS[input.contract]
      : null;
    input.events.forEach((event, index) => {
      const parsed = checkEventShape(event, reasons, `events[${index}]`, input.contract);
      if (parsed && allowedEvents && !allowedEvents.has(parsed.kind)) {
        pushUnique(reasons, `event_kind_not_allowed:${parsed.kind}`);
      }
    });
  }
  return reasons.length === 0 ? { status: "valid", reasons: [] } : { status: "invalid", reasons };
}

function sequenceIssues(events) {
  const reasons = [];
  let previous = 0;
  for (const event of events) {
    if (event.sequence <= previous) {
      pushUnique(reasons, "event_sequence_not_strict");
      break;
    }
    previous = event.sequence;
  }
  return reasons;
}

function byKind(events, kind) {
  return events.filter((event) => event.kind === kind);
}

function checkT1(input) {
  const events = input.events;
  const reasons = sequenceIssues(events);
  const pressed = byKind(events, "ptt_pressed");
  const released = byKind(events, "ptt_released");
  const contexts = byKind(events, "context_recaptured");
  const terminals = byKind(events, "terminal");
  const judgments = byKind(events, "human_judgment");
  if (pressed.length !== 1 || released.length !== 1) pushUnique(reasons, "ptt_event_count_invalid");
  if (contexts.length !== 1) pushUnique(reasons, "context_event_count_invalid");
  if (terminals.length !== 1 || terminals[0]?.state !== "verified") pushUnique(reasons, "verified_terminal_missing");
  if (judgments.length !== 1) pushUnique(reasons, "human_judgment_missing");
  if (judgments.length === 1 && judgments[0].outcome !== "correct") {
    pushUnique(reasons, "human_judgment_not_correct");
  }
  if (pressed.length === 1 && released.length === 1) {
    if (released[0].durationMs < 5_500) pushUnique(reasons, "ptt_duration_below_minimum");
    if (contexts.length === 1 && contexts[0].sequence <= released[0].sequence) {
      pushUnique(reasons, "context_order_invalid");
    }
    if (terminals.length === 1 && contexts.length === 1 && terminals[0].sequence <= contexts[0].sequence) {
      pushUnique(reasons, "terminal_order_invalid");
    }
    if (judgments.length === 1 && terminals.length === 1 && judgments[0].sequence <= terminals[0].sequence) {
      pushUnique(reasons, "human_judgment_order_invalid");
    }
  }
  if (byKind(events, "failure").length > 0) pushUnique(reasons, "failure_event_present");
  if (byKind(events, "false_completion").length > 0) pushUnique(reasons, "false_completion_event_present");
  return reasons;
}

function checkT2(input) {
  const events = input.events;
  const reasons = sequenceIssues(events);
  const actions = byKind(events, "ax_action");
  const receipts = byKind(events, "action_receipt");
  const before = events.filter((event) => event.kind === "finder_state" && event.phase === "before");
  const after = events.filter((event) => event.kind === "finder_state" && event.phase === "after");
  const terminals = byKind(events, "terminal");
  const action = actions.length === 1 ? actions[0] : undefined;
  const productionActionVerified = action !== undefined
    && action.status === "verified"
    && action.method === "ax_press"
    && action.code === "verified_accessibility"
    && action.verified === true
    && action.retryCount === 0;
  if (!productionActionVerified) pushUnique(reasons, "verified_ax_action_missing");
  if (receipts.length !== 1) pushUnique(reasons, "receipt_count_not_one");
  if (before.length !== 1 || after.length !== 1) pushUnique(reasons, "finder_before_after_missing");
  if (after.length === 1 && after[0].relation !== "direct_parent") pushUnique(reasons, "finder_relation_not_direct_parent");
  if (terminals.length !== 1 || terminals[0]?.state !== "verified") pushUnique(reasons, "verified_terminal_missing");
  if (receipts.length === 1 && terminals.length === 1
    && receipts[0].receiptIdHash !== terminals[0].receiptIdHash) {
    pushUnique(reasons, "terminal_receipt_mismatch");
  }
  if (before.length === 1 && after.length === 1 && before[0].opaqueStateHash === after[0].opaqueStateHash) {
    pushUnique(reasons, "finder_state_not_changed");
  }
  if (before.length === 1 && after.length === 1
    && before[0].finderInstanceHash !== after[0].finderInstanceHash) {
    pushUnique(reasons, "finder_instance_mismatch");
  }
  if (byKind(events, "retry").length > 0) pushUnique(reasons, "retry_detected");
  if (byKind(events, "unknown_commit").length > 0) pushUnique(reasons, "unknown_commit_detected");
  if (actions.length === 1 && receipts.length === 1 && receipts[0].sequence <= actions[0].sequence) {
    pushUnique(reasons, "receipt_order_invalid");
  }
  if (actions.length === 1 && before.length === 1 && after.length === 1
    && !(before[0].sequence < actions[0].sequence && actions[0].sequence < after[0].sequence)) {
    pushUnique(reasons, "finder_action_order_invalid");
  }
  if (terminals.length === 1 && after.length === 1 && terminals[0].sequence <= after[0].sequence) {
    pushUnique(reasons, "terminal_order_invalid");
  }
  if (byKind(events, "failure").length > 0) pushUnique(reasons, "failure_event_present");
  if (byKind(events, "false_completion").length > 0) pushUnique(reasons, "false_completion_event_present");
  return reasons;
}

function checkT3(input) {
  const events = input.events;
  const reasons = sequenceIssues(events);
  const states = new Map();
  for (const state of ["remembered", "used", "forgotten", "notUsedAfterRestart", "resurrected"]) {
    states.set(state, byKind(events, "memory_state").filter((event) => event.state === state));
  }
  const restarts = byKind(events, "app_restart");
  const judgments = byKind(events, "human_judgment");
  const recallJudgments = judgments.filter((event) => event.phase === "recall_before_forget");
  const absenceJudgments = judgments.filter((event) => event.phase === "absence_after_restart");
  const expectedStates = ["remembered", "used", "forgotten", "notUsedAfterRestart"];
  for (const state of expectedStates) {
    if (states.get(state).length !== 1) {
      pushUnique(reasons, state === "notUsedAfterRestart"
        ? "not_used_after_restart_missing"
        : `memory_state_count_invalid:${state}`);
    }
  }
  if (restarts.length !== 1) pushUnique(reasons, "app_restart_count_invalid");
  if (recallJudgments.length !== 1) pushUnique(reasons, "human_judgment_missing:recall_before_forget");
  if (absenceJudgments.length !== 1) pushUnique(reasons, "human_judgment_missing:absence_after_restart");
  if (recallJudgments.length === 1 && recallJudgments[0].outcome !== "correct") {
    pushUnique(reasons, "human_judgment_not_correct:recall_before_forget");
  }
  if (absenceJudgments.length === 1 && absenceJudgments[0].outcome !== "correct") {
    pushUnique(reasons, "human_judgment_not_correct:absence_after_restart");
  }

  for (const event of events) {
    if (event.memoryIdHash !== input.memoryIdHash) pushUnique(reasons, "memory_id_mismatch");
    if (event.scopeHash !== input.scopeHash) pushUnique(reasons, "scope_mismatch");
  }
  if (states.get("resurrected").length > 0) pushUnique(reasons, "memory_resurrection_detected");

  const ordered = [
    states.get("remembered")[0],
    states.get("used")[0],
    states.get("forgotten")[0],
    restarts[0],
    states.get("notUsedAfterRestart")[0],
  ];
  if (ordered.some((event) => !event) || ordered.some((event, index) => index > 0 && event.sequence <= ordered[index - 1].sequence)) {
    pushUnique(reasons, "memory_lifecycle_order_invalid");
  }
  if (restarts.length === 1) {
    const restartSequence = restarts[0].sequence;
    if (byKind(events, "memory_state").some((event) => event.state === "used" && event.sequence > restartSequence)) {
      pushUnique(reasons, "memory_resurrection_detected");
    }
  }
  if (recallJudgments.length === 1 && states.get("used").length === 1 && states.get("forgotten").length === 1
    && !(states.get("used")[0].sequence < recallJudgments[0].sequence
      && recallJudgments[0].sequence < states.get("forgotten")[0].sequence)) {
    pushUnique(reasons, "human_judgment_order_invalid:recall_before_forget");
  }
  if (absenceJudgments.length === 1 && states.get("notUsedAfterRestart").length === 1
    && absenceJudgments[0].sequence <= states.get("notUsedAfterRestart")[0].sequence) {
    pushUnique(reasons, "human_judgment_order_invalid:absence_after_restart");
  }
  return reasons;
}

export function verifyDeviceTrial(input) {
  const schemaResult = validateDeviceObservation(input);
  if (schemaResult.status === "invalid") {
    return { status: "invalid", reasons: schemaResult.reasons };
  }
  const reasons = input.contract === "t1.ptt"
    ? checkT1(input)
    : input.contract === "t2.ax"
      ? checkT2(input)
      : checkT3(input);
  return reasons.length === 0
    ? { status: "pass", reasons: [] }
    : { status: "fail", reasons };
}

export const evaluateDeviceTrial = verifyDeviceTrial;
