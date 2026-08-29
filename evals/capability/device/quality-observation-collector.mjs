const OBSERVATION_SCHEMA_VERSION = 1;

const CONTRACTS = new Set(["t1.ptt", "t2.ax", "t3.memory"]);
const TRIAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const QUALITY_EVENT_FIELDS = new Set([
  "schemaVersion",
  "eventId",
  "occurredAt",
  "appPid",
  "sessionId",
  "name",
  "attributes",
  "status",
  "durationMs",
]);

const QUALITY_ATTRIBUTE_FIELDS = new Set([
  "appCategory",
  "actionKind",
  "providerId",
  "modelId",
  "errorCode",
  "stepCount",
  "verified",
  "permission",
  "milestone",
  "scenarioId",
  "receiptStatus",
  "toolName",
  "capabilityProfile",
  "taskTerminal",
  "committed",
  "durationMs",
  "retryCount",
  "spanKind",
  "memoryIdHash",
  "reason",
  "sourceDimensionsAvailable",
  "method",
  "code",
  "receiptHash",
  "scopeHash",
]);

const QUALITY_STATUS_VALUES = new Set([
  "ok",
  "verified",
  "delivered",
  "unverified",
  "blocked",
  "failed",
  "cancelled",
  "stale",
  "unknown",
]);

const FORBIDDEN_FIELDS = new Set([
  "transcript",
  "screenshot",
  "screenshots",
  "path",
  "windowtitle",
  "sourcewindowtitle",
  "title",
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

const KNOWN_EVENT_NAMES = new Set([
  "app.launched",
  "app.ready",
  "onboarding.started",
  "onboarding.step_completed",
  "onboarding.first_verified_action",
  "onboarding.completed",
  "permission.prompted",
  "permission.granted",
  "permission.denied",
  "permission.recovery_opened",
  "ptt.key_down",
  "ptt.listening_visible",
  "ptt.key_up",
  "asr.started",
  "asr.first_partial",
  "asr.completed",
  "context.capture_started",
  "context.capture_completed",
  "context.capture_warning",
  "context.resolved",
  "tts.requested",
  "tts.first_audio",
  "tts.interrupted",
  "model.request_started",
  "model.first_byte",
  "model.completed",
  "tool.started",
  "tool.completed",
  "desktop.action_committed",
  "action.receipt",
  "action.verified",
  "task.terminal",
  "false_completion_detected",
  "runtime.restarted",
  "runtime.recovery_completed",
  "provider.auth_transition",
  "computer.action.completed",
  "computer.result.sending",
  "computer.result.sent",
  "memory.remembered",
  "memory.used",
  "memory.forgotten",
]);

const CANDIDATE_EVENT_NAMES = {
  "t1.ptt": new Set([
    "ptt.key_down",
    "ptt.key_up",
    "context.resolved",
    "model.completed",
  ]),
  "t2.ax": new Set([
    "computer.action.completed",
    "model.completed",
  ]),
  "t3.memory": new Set([
    "memory.remembered",
    "memory.used",
    "memory.forgotten",
    "app.ready",
  ]),
};

const EXPECTED_SESSIONS = {
  "ptt.key_down": "voice",
  "ptt.key_up": "voice",
  "context.resolved": "voice",
  "model.completed": "voice",
  "computer.action.completed": "desktop",
  "memory.remembered": "memory",
  "memory.used": "memory",
  "memory.forgotten": "memory",
  "app.ready": "app",
};

const T1_ORDER = ["ptt.key_down", "ptt.key_up", "context.resolved", "model.completed"];
const T2_ORDER = ["computer.action.completed", "computer.action.completed", "model.completed"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pushUnique(reasons, reason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function invalid(reasons) {
  return { status: "invalid", reasons };
}

function normalizeFieldName(key) {
  return key.toLowerCase().replace(/[_\-\s]/gu, "");
}

function fieldPath(path, key) {
  return path ? `${path}.${key}` : key;
}

function isDateTime(value) {
  return typeof value === "string"
    && DATE_TIME_PATTERN.test(value)
    && Number.isFinite(Date.parse(value));
}

function isSafeHash(value) {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isSafeCode(value) {
  return typeof value === "string" && CODE_PATTERN.test(value);
}

function checkAllowedFields(value, allowed, reasons, path, reasonPrefix) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) pushUnique(reasons, `${reasonPrefix}:${fieldPath(path, key)}`);
  }
}

function scanForbidden(value, reasons, path, eventName) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbidden(item, reasons, `${path}[${index}]`, eventName));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeFieldName(key);
    const taskTerminalAttribute = eventName === "model.completed"
      && path === "attributes"
      && normalized === "taskterminal";
    if (FORBIDDEN_FIELDS.has(normalized) && !taskTerminalAttribute) {
      pushUnique(reasons, `forbidden_field:${fieldPath(path, key)}`);
    }
    scanForbidden(child, reasons, fieldPath(path, key), eventName);
  }
}

function validateQualityEvent(event, lineNumber, reasons, eventIds) {
  if (!isRecord(event)) {
    pushUnique(reasons, `malformed_event:${lineNumber}`);
    return false;
  }

  checkAllowedFields(event, QUALITY_EVENT_FIELDS, reasons, String(lineNumber), "unknown_event_field");
  if (event.schemaVersion !== OBSERVATION_SCHEMA_VERSION) {
    pushUnique(reasons, `event_schema_version_invalid:${lineNumber}`);
  }
  if (typeof event.eventId !== "string" || !EVENT_ID_PATTERN.test(event.eventId)) {
    pushUnique(reasons, `event_id_invalid:${lineNumber}`);
  } else if (eventIds.has(event.eventId)) {
    pushUnique(reasons, `duplicate_event_id:${lineNumber}`);
  } else {
    eventIds.add(event.eventId);
  }
  if (!isDateTime(event.occurredAt)) pushUnique(reasons, `event_timestamp_invalid:${lineNumber}`);
  if (!Number.isSafeInteger(event.appPid) || event.appPid < 1) {
    pushUnique(reasons, `event_app_pid_invalid:${lineNumber}`);
  }
  if (typeof event.sessionId !== "string" || event.sessionId.length === 0 || event.sessionId.length > 128) {
    pushUnique(reasons, `event_session_invalid:${lineNumber}`);
  }
  if (typeof event.name !== "string" || !KNOWN_EVENT_NAMES.has(event.name)) {
    pushUnique(reasons, "unknown_event_name");
  }
  if (!isRecord(event.attributes)) {
    pushUnique(reasons, `event_attributes_invalid:${lineNumber}`);
  } else {
    checkAllowedFields(
      event.attributes,
      QUALITY_ATTRIBUTE_FIELDS,
      reasons,
      `${lineNumber}.attributes`,
      "unknown_attribute_field",
    );
    for (const [key, value] of Object.entries(event.attributes)) {
      if (!QUALITY_ATTRIBUTE_FIELDS.has(key)) continue;
      const validType = typeof value === "string"
        || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value));
      if (!validType) pushUnique(reasons, `attribute_value_invalid:${lineNumber}.${key}`);
    }
  }
  if (event.status !== undefined
    && (typeof event.status !== "string" || !QUALITY_STATUS_VALUES.has(event.status))) {
    pushUnique(reasons, `event_status_invalid:${lineNumber}`);
  }
  if (event.durationMs !== undefined
    && (!Number.isSafeInteger(event.durationMs) || event.durationMs < 0)) {
    pushUnique(reasons, `event_duration_invalid:${lineNumber}`);
  }
  return true;
}

function decodeLinesAfterOffset(source, trialStartByteOffset, reasons) {
  let bytes;
  if (typeof source === "string") {
    bytes = Buffer.from(source, "utf8");
  } else if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    bytes = Buffer.from(source);
  } else {
    pushUnique(reasons, "quality_jsonl_invalid");
    return [];
  }

  if (!Number.isSafeInteger(trialStartByteOffset) || trialStartByteOffset < 0) {
    pushUnique(reasons, "trial_start_offset_invalid");
    return [];
  }
  if (trialStartByteOffset > bytes.length) {
    pushUnique(reasons, "trial_start_offset_out_of_range");
    return [];
  }
  if (trialStartByteOffset > 0 && bytes[trialStartByteOffset - 1] !== 0x0a) {
    pushUnique(reasons, "trial_start_offset_not_line_boundary");
    return [];
  }

  const suffix = bytes.subarray(trialStartByteOffset);
  if (suffix.length > 0 && suffix[suffix.length - 1] !== 0x0a) {
    pushUnique(reasons, "partial_trailing_line");
    return [];
  }
  if (suffix.length === 0) return [];

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const lines = [];
  let lineStart = trialStartByteOffset;
  let lineNumber = 1;
  for (let cursor = trialStartByteOffset; cursor < bytes.length; cursor += 1) {
    if (bytes[cursor] !== 0x0a) continue;
    const lineBytes = bytes.subarray(lineStart, cursor);
    const jsonBytes = lineBytes.length > 0 && lineBytes[lineBytes.length - 1] === 0x0d
      ? lineBytes.subarray(0, lineBytes.length - 1)
      : lineBytes;
    if (jsonBytes.length === 0) {
      pushUnique(reasons, `malformed_json:${lineNumber}`);
    } else {
      let text;
      try {
        text = decoder.decode(jsonBytes);
      } catch {
        pushUnique(reasons, `malformed_utf8:${lineNumber}`);
      }
      if (text !== undefined) {
        try {
          lines.push({ lineNumber, event: JSON.parse(text) });
        } catch {
          pushUnique(reasons, `malformed_json:${lineNumber}`);
        }
      }
    }
    lineStart = cursor + 1;
    lineNumber += 1;
  }
  return lines;
}

function validateInput(input, reasons) {
  if (!isRecord(input)) {
    pushUnique(reasons, "collector_input_invalid");
    return false;
  }
  checkAllowedFields(
    input,
    new Set(["qualityJsonl", "trialStartByteOffset", "appPid", "expectedRestartedPid", "contract", "trialId"]),
    reasons,
    "",
    "unknown_collector_field",
  );
  if (!CONTRACTS.has(input.contract)) pushUnique(reasons, "contract_invalid");
  if (typeof input.trialId !== "string" || !TRIAL_ID_PATTERN.test(input.trialId)) {
    pushUnique(reasons, "trial_id_invalid");
  }
  if (!Number.isSafeInteger(input.appPid) || input.appPid < 1) pushUnique(reasons, "app_pid_invalid");
  if (input.contract === "t3.memory") {
    if (!Number.isSafeInteger(input.expectedRestartedPid) || input.expectedRestartedPid < 1) {
      pushUnique(reasons, "expected_restart_pid_required");
    } else if (input.expectedRestartedPid === input.appPid) {
      pushUnique(reasons, "expected_restart_pid_not_changed");
    }
  } else if (input.expectedRestartedPid !== undefined
    && (!Number.isSafeInteger(input.expectedRestartedPid) || input.expectedRestartedPid < 1)) {
    pushUnique(reasons, "expected_restart_pid_invalid");
  }
  return reasons.length === 0;
}

function validateCandidateSession(event, reasons) {
  const expected = EXPECTED_SESSIONS[event.name];
  if (expected !== undefined && event.sessionId !== expected) {
    pushUnique(reasons, `event_session_mismatch:${event.name}`);
  }
}

function hasOnlyAttributes(event, required, optional = []) {
  if (!isRecord(event.attributes)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(event.attributes);
  return required.every((key) => Object.hasOwn(event.attributes, key))
    && keys.every((key) => allowed.has(key));
}

function pushMapped(mapped, event) {
  mapped.push({ ...event, sequence: mapped.length + 1 });
}

function modelTerminalIsVerified(event, reasons, reasonPrefix = "terminal", bindReceipt = false) {
  let valid = true;
  if (event.status !== undefined && !["ok", "verified"].includes(event.status)) {
    pushUnique(reasons, `${reasonPrefix}_status_not_accepted`);
    valid = false;
  }
  const requiredAttributes = bindReceipt
    ? ["verified", "taskTerminal", "receiptHash"]
    : ["verified", "taskTerminal"];
  if (!hasOnlyAttributes(event, requiredAttributes, [])) {
    pushUnique(reasons, `${reasonPrefix}_attributes_invalid`);
    valid = false;
  }
  if (event.attributes?.verified !== true || event.attributes?.taskTerminal !== "verified") {
    // taskTerminal is inspected only as an event-level assertion. It is never
    // copied to the raw observation because it is an aggregate truth field.
    pushUnique(reasons, reasonPrefix === "terminal" ? "terminal_not_verified" : `${reasonPrefix}_not_verified`);
    valid = false;
  }
  if (event.durationMs !== undefined) {
    pushUnique(reasons, `${reasonPrefix}_duration_unexpected`);
    valid = false;
  }
  return valid;
}

function mapModelTerminal(
  event,
  mapped,
  reasons,
  counts,
  expectedReceiptHash,
  requireReceiptBinding = false,
) {
  if (counts.modelCompleted > 0) {
    pushUnique(reasons, "duplicate_critical_event:model.completed");
    return;
  }
  counts.modelCompleted += 1;
  const receiptHash = event.attributes?.receiptHash;
  if (requireReceiptBinding && (!isSafeHash(receiptHash) || receiptHash !== expectedReceiptHash)) {
    pushUnique(reasons, "terminal_receipt_mismatch");
  }
  if (modelTerminalIsVerified(event, reasons, "terminal", requireReceiptBinding)
    && (!requireReceiptBinding || receiptHash === expectedReceiptHash)) {
    pushMapped(mapped, {
      kind: "terminal",
      observedAt: event.occurredAt,
      state: "verified",
      ...(requireReceiptBinding ? { receiptIdHash: receiptHash } : {}),
    });
  }
}

function mapT1(events, reasons) {
  const mapped = [];
  const counts = { pttDown: 0, pttUp: 0, context: 0, modelCompleted: 0 };
  for (const event of events) {
    if (!CANDIDATE_EVENT_NAMES["t1.ptt"].has(event.name)) continue;
    validateCandidateSession(event, reasons);
    switch (event.name) {
      case "ptt.key_down":
        if (counts.pttDown > 0) pushUnique(reasons, "duplicate_critical_event:ptt.key_down");
        counts.pttDown += 1;
        if (event.status !== undefined || event.durationMs !== undefined || !hasOnlyAttributes(event, [])) {
          pushUnique(reasons, "ptt_key_down_shape_invalid");
        } else {
          pushMapped(mapped, { kind: "ptt_pressed", observedAt: event.occurredAt });
        }
        break;
      case "ptt.key_up":
        if (counts.pttUp > 0) pushUnique(reasons, "duplicate_critical_event:ptt.key_up");
        counts.pttUp += 1;
        if (event.status !== undefined
          || event.durationMs === undefined
          || !hasOnlyAttributes(event, [])) {
          pushUnique(reasons, "ptt_key_up_shape_invalid");
        } else {
          pushMapped(mapped, {
            kind: "ptt_released",
            observedAt: event.occurredAt,
            durationMs: event.durationMs,
          });
        }
        break;
      case "context.resolved":
        if (counts.context > 0) pushUnique(reasons, "duplicate_critical_event:context.resolved");
        counts.context += 1;
        if (event.status !== undefined
          || event.durationMs !== undefined
          || !hasOnlyAttributes(event, ["reason"], ["sourceDimensionsAvailable"])
          || !["recaptureStale", "recaptureSceneChanged"].includes(event.attributes?.reason)
          || event.attributes?.sourceDimensionsAvailable !== true) {
          pushUnique(reasons, "context_shape_invalid");
        } else {
          pushMapped(mapped, {
            kind: "context_recaptured",
            observedAt: event.occurredAt,
            reason: event.attributes.reason,
            sourceDimensionsAvailable: event.attributes.sourceDimensionsAvailable,
          });
        }
        break;
      case "model.completed":
        mapModelTerminal(event, mapped, reasons, counts);
        break;
      default:
        break;
    }
  }
  if (counts.pttDown !== 1) pushUnique(reasons, "required_event_count:ptt.key_down");
  if (counts.pttUp !== 1) pushUnique(reasons, "required_event_count:ptt.key_up");
  if (counts.context !== 1) pushUnique(reasons, "required_event_count:context.resolved");
  if (counts.modelCompleted !== 1) pushUnique(reasons, "required_event_count:model.completed");
  if (mapped.length === T1_ORDER.length) {
    const kinds = mapped.map((event) => event.kind);
    const expected = ["ptt_pressed", "ptt_released", "context_recaptured", "terminal"];
    if (kinds.some((kind, index) => kind !== expected[index])) pushUnique(reasons, "critical_event_order_invalid");
  }
  return { mapped };
}

function mapT2(events, reasons) {
  const mapped = [];
  const counts = { action: 0, modelCompleted: 0 };
  let actionReceiptHash;
  for (const event of events) {
    if (!CANDIDATE_EVENT_NAMES["t2.ax"].has(event.name)) continue;
    validateCandidateSession(event, reasons);
    if (event.name === "computer.action.completed") {
      if (counts.action > 0) pushUnique(reasons, "duplicate_critical_event:computer.action.completed");
      counts.action += 1;
      const attributes = event.attributes ?? {};
      const valid = event.status === "verified"
        && event.durationMs === undefined
        && hasOnlyAttributes(event, ["method", "code", "verified", "retryCount", "receiptHash"])
        && isSafeCode(attributes.method)
        && isSafeCode(attributes.code)
        && attributes.verified === true
        && Number.isSafeInteger(attributes.retryCount)
        && attributes.retryCount >= 0
        && isSafeHash(attributes.receiptHash);
      if (!valid) {
        pushUnique(reasons, "action_receipt_invalid");
      } else {
        actionReceiptHash = attributes.receiptHash;
        // Keep every safe field from the formal App event. Its receiptHash
        // value is mapped to the verifier's opaque receiptIdHash field.
        pushMapped(mapped, {
          kind: "ax_action",
          observedAt: event.occurredAt,
          status: event.status,
          method: attributes.method,
          code: attributes.code,
          verified: attributes.verified,
          retryCount: attributes.retryCount,
        });
        pushMapped(mapped, {
          kind: "action_receipt",
          observedAt: event.occurredAt,
          receiptIdHash: attributes.receiptHash,
        });
      }
    } else {
      mapModelTerminal(event, mapped, reasons, counts, actionReceiptHash, true);
    }
  }
  if (counts.action !== 1) pushUnique(reasons, "required_event_count:computer.action.completed");
  if (counts.modelCompleted !== 1) pushUnique(reasons, "required_event_count:model.completed");
  if (mapped.length === T2_ORDER.length) {
    const kinds = mapped.map((event) => event.kind);
    if (kinds[0] !== "ax_action" || kinds[1] !== "action_receipt" || kinds[2] !== "terminal") {
      pushUnique(reasons, "critical_event_order_invalid");
    }
  }
  return { mapped };
}

function mapT3(events, input, reasons) {
  const mapped = [];
  const counts = { remembered: 0, used: 0, forgotten: 0, restart: 0 };
  const postQueryCounts = { pttDown: 0, pttUp: 0, modelCompleted: 0 };
  const memoryEventNames = new Set(["memory.remembered", "memory.used", "memory.forgotten"]);
  const postQueryEventNames = new Set(["ptt.key_down", "ptt.key_up", "model.completed"]);
  let memoryIdHash;
  let scopeHash;
  let restartSeen = false;
  let postQueryModel;
  let resurrectedSeen = false;

  function mapMemoryState(event) {
    const state = event.name.slice("memory.".length);
    counts[state] += 1;
    const attributes = event.attributes ?? {};
    const valid = event.status === "ok"
      && event.durationMs === undefined
      && hasOnlyAttributes(event, ["memoryIdHash", "scopeHash"])
      && isSafeHash(attributes.memoryIdHash)
      && isSafeHash(attributes.scopeHash);
    if (!valid) {
      if (state === "forgotten" && event.status !== "ok") {
        pushUnique(reasons, "memory_forget_not_confirmed");
      } else {
        pushUnique(reasons, "memory_event_invalid");
      }
      return;
    }
    if (memoryIdHash === undefined) memoryIdHash = attributes.memoryIdHash;
    if (scopeHash === undefined) scopeHash = attributes.scopeHash;
    if (attributes.memoryIdHash !== memoryIdHash) pushUnique(reasons, "memory_id_mismatch");
    if (attributes.scopeHash !== scopeHash) pushUnique(reasons, "scope_hash_mismatch");
    if (counts[state] > 1) {
      pushUnique(reasons, `duplicate_critical_event:memory.${state}`);
      return;
    }
    pushMapped(mapped, {
      kind: "memory_state",
      observedAt: event.occurredAt,
      state,
      memoryIdHash: attributes.memoryIdHash,
      scopeHash: attributes.scopeHash,
    });
  }

  function mapRestart(event) {
    validateAppReady(event);
    if (counts.restart > 0) {
      pushUnique(reasons, "duplicate_critical_event:app.ready");
      return;
    }
    counts.restart += 1;
    restartSeen = true;
    if (event.status !== undefined || event.durationMs !== undefined || !hasOnlyAttributes(event, [])) {
      pushUnique(reasons, "app_ready_shape_invalid");
    }
    if (memoryIdHash === undefined || scopeHash === undefined) {
      pushUnique(reasons, "app_restart_before_memory_identity");
      return;
    }
    pushMapped(mapped, {
      kind: "app_restart",
      observedAt: event.occurredAt,
      memoryIdHash,
      scopeHash,
    });
  }

  function validateAppReady(event) {
    validateCandidateSession(event, reasons);
    if (event.status !== undefined || event.durationMs !== undefined || !hasOnlyAttributes(event, [])) {
      pushUnique(reasons, "app_ready_shape_invalid");
    }
  }

  function observePostRestartMemory(event) {
    validateCandidateSession(event, reasons);
    if (event.name !== "memory.used") {
      pushUnique(reasons, "post_restart_memory_event_unexpected");
      return;
    }
    const attributes = event.attributes ?? {};
    const valid = event.status === "ok"
      && event.durationMs === undefined
      && hasOnlyAttributes(event, ["memoryIdHash", "scopeHash"])
      && isSafeHash(attributes.memoryIdHash)
      && isSafeHash(attributes.scopeHash);
    if (!valid) {
      pushUnique(reasons, "post_restart_memory_event_invalid");
      return;
    }
    if (attributes.memoryIdHash !== memoryIdHash) pushUnique(reasons, "memory_id_mismatch");
    if (attributes.scopeHash !== scopeHash) pushUnique(reasons, "scope_hash_mismatch");
    if (attributes.memoryIdHash !== memoryIdHash || attributes.scopeHash !== scopeHash) {
      pushUnique(reasons, "post_restart_memory_identity_mismatch");
      return;
    }
    if (resurrectedSeen) {
      pushUnique(reasons, "duplicate_critical_event:memory_after_restart");
      return;
    }
    resurrectedSeen = true;
    pushMapped(mapped, {
      kind: "memory_state",
      observedAt: event.occurredAt,
      state: "resurrected",
      memoryIdHash: attributes.memoryIdHash,
      scopeHash: attributes.scopeHash,
    });
  }

  function observePostRestartQuery(event) {
    validateCandidateSession(event, reasons);
    switch (event.name) {
      case "ptt.key_down":
        postQueryCounts.pttDown += 1;
        if (event.status !== undefined || event.durationMs !== undefined || !hasOnlyAttributes(event, [])) {
          pushUnique(reasons, "post_restart_ptt_key_down_invalid");
        }
        break;
      case "ptt.key_up":
        postQueryCounts.pttUp += 1;
        if (event.status !== undefined
          || event.durationMs === undefined
          || !hasOnlyAttributes(event, [])) {
          pushUnique(reasons, "post_restart_ptt_key_up_invalid");
        }
        break;
      case "model.completed":
        postQueryCounts.modelCompleted += 1;
        if (postQueryCounts.modelCompleted > 1) {
          pushUnique(reasons, "duplicate_critical_event:model.completed_after_restart");
        }
        if (modelTerminalIsVerified(event, reasons, "post_restart_terminal")) postQueryModel = event;
        break;
      default:
        break;
    }
  }

  for (const event of events) {
    const isMemoryEvent = memoryEventNames.has(event.name);
    const isAppReady = event.name === "app.ready";
    const isPostQueryEvent = postQueryEventNames.has(event.name);

    if (!restartSeen) {
      if (isAppReady && event.appPid === input.appPid) {
        validateAppReady(event);
        continue;
      }
      if (isAppReady && event.appPid === input.expectedRestartedPid) {
        mapRestart(event);
        continue;
      }
      if (event.appPid !== input.appPid) {
        pushUnique(reasons, "app_pid_mismatch");
        continue;
      }
      if (isMemoryEvent) {
        validateCandidateSession(event, reasons);
        mapMemoryState(event);
      }
      continue;
    }

    if (event.appPid !== input.expectedRestartedPid) {
      // Events from the pre-restart PID or a third process cannot establish
      // the bounded post-restart query window.
      pushUnique(reasons, "app_pid_mismatch_after_restart");
      continue;
    }
    if (isAppReady) {
      validateAppReady(event);
      pushUnique(reasons, "duplicate_critical_event:app.ready");
      continue;
    }
    if (isMemoryEvent) {
      observePostRestartMemory(event);
      continue;
    }
    if (isPostQueryEvent) observePostRestartQuery(event);
  }

  for (const state of ["remembered", "used", "forgotten"]) {
    if (counts[state] !== 1) pushUnique(reasons, `required_event_count:memory.${state}`);
  }
  if (counts.restart !== 1) pushUnique(reasons, "app_restart_missing");
  if (postQueryCounts.pttDown !== 1
    || postQueryCounts.pttUp !== 1
    || postQueryCounts.modelCompleted !== 1) {
    pushUnique(reasons, "post_restart_query_missing");
  }
  if (postQueryCounts.pttDown === 1 && postQueryCounts.pttUp === 1 && postQueryCounts.modelCompleted === 1) {
    const queryKinds = events
      .filter((event) => event.appPid === input.expectedRestartedPid && postQueryEventNames.has(event.name))
      .map((event) => event.name);
    if (queryKinds.join(",") !== "ptt.key_down,ptt.key_up,model.completed") {
      pushUnique(reasons, "post_restart_query_order_invalid");
    }
  }
  if (memoryIdHash === undefined || scopeHash === undefined) {
    pushUnique(reasons, "memory_identity_missing");
  }
  if (restartSeen && !resurrectedSeen && postQueryModel !== undefined) {
    pushMapped(mapped, {
      kind: "memory_state",
      observedAt: postQueryModel.occurredAt,
      state: "notUsedAfterRestart",
      memoryIdHash,
      scopeHash,
    });
  }
  if (mapped.length >= 4) {
    const kinds = mapped.map((event) => event.kind);
    const expected = ["memory_state", "memory_state", "memory_state", "app_restart"];
    if (kinds.slice(0, 4).some((kind, index) => kind !== expected[index])
      || mapped[0].state !== "remembered"
      || mapped[1].state !== "used"
      || mapped[2].state !== "forgotten") {
      pushUnique(reasons, "critical_event_order_invalid");
    }
    if (!resurrectedSeen && mapped[4]?.state !== "notUsedAfterRestart") {
      pushUnique(reasons, "not_used_after_restart_missing");
    }
  }
  if (!resurrectedSeen && mapped.length >= 4 && mapped[4] === undefined) {
    pushUnique(reasons, "not_used_after_restart_missing");
  }
  return { mapped, memoryIdHash, scopeHash };
}

/**
 * Collects content-safe raw evidence from the formal App's quality.jsonl.
 *
 * The returned observation is deliberately not an aggregate result. In
 * particular, `taskTerminal` is read only from a model.completed event and is
 * never copied, while `passed` and `receipts` are never accepted or emitted.
 * T2's receiptHash is retained as the verifier's opaque receiptIdHash; no
 * receipt collection or aggregate truth field is synthesized.
 */
export function collectDeviceObservation(input) {
  const reasons = [];
  if (!validateInput(input, reasons)) return invalid(reasons);

  const lines = decodeLinesAfterOffset(input.qualityJsonl, input.trialStartByteOffset, reasons);
  const eventIds = new Set();
  const events = [];
  for (const { lineNumber, event } of lines) {
    scanForbidden(event, reasons, "", event?.name);
    if (validateQualityEvent(event, lineNumber, reasons, eventIds)) events.push(event);
  }
  if (lines.length === 0 && reasons.length === 0) pushUnique(reasons, "no_quality_events");
  if (reasons.length > 0) return invalid(reasons);

  if (input.contract !== "t3.memory") {
    for (const event of events) {
      if (event.appPid !== input.appPid) pushUnique(reasons, "app_pid_mismatch");
    }
    if (reasons.length > 0) return invalid(reasons);
  }

  const result = input.contract === "t1.ptt"
    ? mapT1(events, reasons)
    : input.contract === "t2.ax"
      ? mapT2(events, reasons)
      : mapT3(events, input, reasons);
  if (reasons.length > 0) return invalid(reasons);

  const observation = {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    contract: input.contract,
    trialId: input.trialId,
    ...(input.contract === "t3.memory"
      ? { memoryIdHash: result.memoryIdHash, scopeHash: result.scopeHash }
      : {}),
    events: result.mapped,
  };
  return { status: "valid", observation };
}

export const collectQualityObservation = collectDeviceObservation;
