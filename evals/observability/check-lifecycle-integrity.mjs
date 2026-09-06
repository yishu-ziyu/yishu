#!/usr/bin/env node
/**
 * Lifecycle Integrity evaluator.
 *
 * Read-only. Metadata only. Does not infer success from the absence of errors.
 *
 *   node evals/observability/check-lifecycle-integrity.mjs <files...>
 *   node evals/observability/check-lifecycle-integrity.mjs --json <files...>
 *   node evals/observability/check-lifecycle-integrity.mjs --expect-zero <files...>
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const CONTENT_KEY = /transcript|prompt|screenshot|windowtitle|filepath|url|cookie|authorization|apikey|token|password|email|username|label|audio|body|text|memory/i;

export const FAMILIES = {
  voice_capture: {
    owner: "YishuVoiceSessionController / ClickyAnalytics PTT",
    start: ["ptt.key_down"],
    success: ["ptt.key_up"],
    failure: [],
    cancel: [],
    idFields: ["turnId", "turn_id"],
  },
  asr: {
    owner: "transcription provider / ClickyAnalytics",
    start: ["asr.request_sent"],
    success: ["asr.final", "asr.completed"],
    failure: [],
    cancel: [],
    idFields: ["turnId", "turn_id"],
  },
  runtime_turn: {
    owner: "YishuForegroundRuntimeExecution",
    start: ["turn.start", "turn.started"],
    success: ["model.completed", "model.done"],
    failure: ["turn.failed"],
    cancel: [],
    idFields: ["turnId", "turn_id"],
  },
  computer_result: {
    owner: "YishuAgentRuntimeClient.completeComputerAction",
    start: ["computer.result.sending"],
    success: ["computer.result.sent"],
    failure: [],
    cancel: [],
    idFields: ["requestId", "traceId", "receiptHash"],
  },
};

const START_INDEX = indexByName("start");
const SUCCESS_INDEX = indexByName("success");
const FAILURE_INDEX = indexByName("failure");
const CANCEL_INDEX = indexByName("cancel");
const NAME_TO_FAMILY = new Map();
for (const [family, spec] of Object.entries(FAMILIES)) {
  for (const name of [...spec.start, ...spec.success, ...spec.failure, ...spec.cancel]) {
    NAME_TO_FAMILY.set(name, family);
  }
}

function indexByName(kind) {
  const map = new Map();
  for (const [family, spec] of Object.entries(FAMILIES)) {
    for (const name of spec[kind]) map.set(name, family);
  }
  return map;
}

function emptyMetrics() {
  return {
    started_without_terminal_outcome: 0,
    duplicate_terminal_outcomes: 0,
    terminal_without_start: 0,
    uncorrelated_terminal_events: 0,
    ambiguous_terminal_outcomes: 0,
  };
}

function emptyFamilyBucket() {
  return {
    operations_reconstructed: 0,
    operations_unreconstructable: 0,
    lifecycle_integrity_failures: 0,
    ...emptyMetrics(),
    observability_gaps: [],
  };
}

export function parseJSONL(text, sourceFile = "input") {
  const events = [];
  let skipped = 0;
  const lines = String(text).split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        skipped += 1;
        continue;
      }
      events.push(normalizeEvent(row, sourceFile, i + 1));
    } catch {
      skipped += 1;
    }
  }
  return { events, skipped };
}

function metadataObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (CONTENT_KEY.test(key)) continue;
    if (raw == null) continue;
    const t = typeof raw;
    if (t === "string" || t === "number" || t === "boolean") out[key] = raw;
  }
  return out;
}

function firstId(candidates) {
  for (const value of candidates) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

export function normalizeEvent(row, sourceFile, line) {
  const attrs = metadataObject(row.attributes);
  const top = metadataObject(row);
  const name = typeof row.name === "string" ? row.name : "";
  const family = NAME_TO_FAMILY.get(name) ?? null;
  const idFields = family ? FAMILIES[family].idFields : ["turnId", "turn_id", "requestId", "traceId", "receiptHash"];
  const id = firstId(idFields.map((field) => top[field] ?? attrs[field]));
  const occurredAt =
    typeof row.occurredAt === "string"
      ? row.occurredAt
      : typeof row.ts === "string"
        ? row.ts
        : null;
  const occurredAtMs = occurredAt ? Date.parse(occurredAt) : NaN;
  return {
    name,
    family,
    operationId: id,
    occurredAt,
    occurredAtMs: Number.isFinite(occurredAtMs) ? occurredAtMs : null,
    status: typeof row.status === "string" ? row.status : typeof attrs.status === "string" ? attrs.status : null,
    outcome:
      typeof attrs.outcome === "string"
        ? attrs.outcome
        : typeof row.outcome === "string"
          ? row.outcome
          : null,
    errorCode:
      typeof attrs.errorCode === "string"
        ? attrs.errorCode
        : typeof row.errorCode === "string"
          ? row.errorCode
          : null,
    providerId: attrs.providerId ?? top.providerId ?? null,
    modelId: attrs.modelId ?? top.modelId ?? null,
    sessionId: typeof row.sessionId === "string" ? row.sessionId : null,
    durationMs: Number.isFinite(row.durationMs) ? row.durationMs : null,
    eventId: typeof row.eventId === "string" ? row.eventId : null,
    sourceFile,
    line,
    order: 0,
  };
}

function roleOf(event) {
  if (!event.name) return null;
  if (START_INDEX.has(event.name)) return "start";
  if (SUCCESS_INDEX.has(event.name) || FAILURE_INDEX.has(event.name) || CANCEL_INDEX.has(event.name)) {
    return "terminal";
  }
  return null;
}

export function classifyTerminal(event) {
  if (!event || roleOf(event) !== "terminal") return null;
  const outcome = typeof event.outcome === "string" ? event.outcome.trim().toLowerCase() : "";
  if (outcome === "unknown") return "unknown";
  if (outcome === "success" || outcome === "failure" || outcome === "cancelled") return outcome;
  if (event.name === "model.completed" && event.status === "failed") return "failure";
  if (event.name === "turn.failed" && event.errorCode === "cancelled") return "cancelled";
  if (FAILURE_INDEX.has(event.name)) return "failure";
  if (CANCEL_INDEX.has(event.name)) return "cancelled";
  if (SUCCESS_INDEX.has(event.name)) return "success";
  return "unknown";
}

function gapKey(family, missing) {
  return `${family}::${missing}`;
}

function addGap(report, family, missing) {
  const key = gapKey(family, missing);
  if (report._gapKeys.has(key)) return;
  report._gapKeys.add(key);
  report.observability_gaps.push({ family, missing });
  report.by_family[family].observability_gaps.push({ family, missing });
}

function bump(report, family, field, n = 1) {
  report[field] += n;
  report.by_family[family][field] += n;
}

function markFailure(report, family) {
  bump(report, family, "lifecycle_integrity_failures");
  bump(report, family, "operations_unreconstructable");
}

function closeReconstructed(report, family, operation) {
  operation.terminal_at = operation.events.at(-1)?.occurredAt ?? null;
  operation.correlation_quality = "id";
  report.operations.push(operation);
  bump(report, family, "operations_reconstructed");
}

export function evaluate(events, options = {}) {
  const sourceFiles = options.sourceFiles ?? [];
  const report = {
    operations_reconstructed: 0,
    operations_unreconstructable: 0,
    lifecycle_integrity_failures: 0,
    ...emptyMetrics(),
    reconstructability_rate: null,
    empty_input: events.length === 0,
    observability_gaps: [],
    by_family: Object.fromEntries(Object.keys(FAMILIES).map((name) => [name, emptyFamilyBucket()])),
    operations: [],
    source_files: sourceFiles,
    _gapKeys: new Set(),
  };

  const indexed = events.map((event, index) => ({ ...event, order: index }));
  indexed.sort((a, b) => {
    const aTime = a.occurredAtMs;
    const bTime = b.occurredAtMs;
    if (aTime != null && bTime != null && aTime !== bTime) return aTime - bTime;
    if (aTime != null && bTime == null) return -1;
    if (aTime == null && bTime != null) return 1;
    return a.order - b.order;
  });

  const familyHasStart = Object.fromEntries(Object.keys(FAMILIES).map((name) => [name, false]));
  for (const event of indexed) {
    if (event.family && roleOf(event) === "start") familyHasStart[event.family] = true;
  }

  const open = new Map();
  const closed = new Map();
  const keyFor = (family, id) => `${family}::${id}`;

  const failOpen = (operation, field) => {
    bump(report, operation.family, field);
    markFailure(report, operation.family);
    operation.correlation_quality = "failed";
    report.operations.push(operation);
    if (operation.operation_id) closed.set(keyFor(operation.family, operation.operation_id), operation);
  };

  for (const event of indexed) {
    if (!event.family) continue;
    const family = event.family;
    const role = roleOf(event);
    if (!role) continue;

    if (role === "start") {
      if (!event.operationId) {
        addGap(report, family, "correlation_id");
        bump(report, family, "started_without_terminal_outcome");
        markFailure(report, family);
        report.operations.push({
          family,
          operation_id: null,
          started_at: event.occurredAt,
          terminal_at: null,
          terminal_kind: null,
          events: [summarize(event)],
          correlation_quality: "missing_id",
          source_files: [event.sourceFile],
        });
        continue;
      }
      const key = keyFor(family, event.operationId);
      const existing = open.get(key);
      if (existing) {
        failOpen(existing, "started_without_terminal_outcome");
        open.delete(key);
      }
      open.set(key, {
        family,
        operation_id: event.operationId,
        started_at: event.occurredAt,
        terminal_at: null,
        terminal_kind: null,
        events: [summarize(event)],
        correlation_quality: "open",
        source_files: [event.sourceFile],
      });
      continue;
    }

    const kind = classifyTerminal(event);
    if (kind === "unknown") bump(report, family, "ambiguous_terminal_outcomes");

    if (!event.operationId) {
      addGap(report, family, "correlation_id");
      bump(report, family, "uncorrelated_terminal_events");
      markFailure(report, family);
      report.operations.push({
        family,
        operation_id: null,
        started_at: null,
        terminal_at: event.occurredAt,
        terminal_kind: kind,
        events: [summarize(event)],
        correlation_quality: "uncorrelated",
        source_files: [event.sourceFile],
      });
      continue;
    }

    const key = keyFor(family, event.operationId);
    const current = open.get(key);
    if (!current) {
      const previous = closed.get(key);
      if (previous) {
        previous.events.push(summarize(event));
        if (previous.terminal_kind) {
          bump(report, family, "duplicate_terminal_outcomes");
          if (previous.correlation_quality !== "failed") {
            bump(report, family, "operations_reconstructed", -1);
            markFailure(report, family);
            previous.correlation_quality = "failed";
          }
        }
        continue;
      }
      addGap(report, family, `start:${FAMILIES[family].start.join("|")}`);
      bump(report, family, "terminal_without_start");
      const orphan = {
        family,
        operation_id: event.operationId,
        started_at: null,
        terminal_at: event.occurredAt,
        terminal_kind: kind,
        events: [summarize(event)],
        correlation_quality: "orphan",
        source_files: [event.sourceFile],
      };
      closed.set(key, orphan);
      report.operations.push(orphan);
      if (familyHasStart[family]) {
        markFailure(report, family);
      } else {
        bump(report, family, "operations_unreconstructable");
      }
      continue;
    }

    current.events.push(summarize(event));
    if (!current.source_files.includes(event.sourceFile)) {
      current.source_files.push(event.sourceFile);
    }
    if (current.terminal_kind) {
      bump(report, family, "duplicate_terminal_outcomes");
      continue;
    }
    if (kind === "unknown") {
      current.terminal_kind = "unknown";
      open.delete(key);
      current.correlation_quality = "failed";
      report.operations.push(current);
      closed.set(key, current);
      markFailure(report, family);
      continue;
    }
    current.terminal_kind = kind;
    open.delete(key);
    closed.set(key, current);
    closeReconstructed(report, family, current);
  }

  for (const operation of open.values()) {
    failOpen(operation, "started_without_terminal_outcome");
  }

  const denom = report.operations_reconstructed + report.operations_unreconstructable;
  report.reconstructability_rate = denom === 0 ? null : report.operations_reconstructed / denom;
  delete report._gapKeys;
  return report;
}

function summarize(event) {
  return {
    name: event.name,
    occurredAt: event.occurredAt,
    status: event.status,
    outcome: event.outcome,
    errorCode: event.errorCode,
    sourceFile: event.sourceFile,
    line: event.line,
  };
}

export function formatText(report) {
  const lines = [
    "Lifecycle Integrity",
    "",
    `operations_reconstructed: ${report.operations_reconstructed}`,
    `operations_unreconstructable: ${report.operations_unreconstructable}`,
    `lifecycle_integrity_failures: ${report.lifecycle_integrity_failures}`,
    "",
    `started_without_terminal_outcome: ${report.started_without_terminal_outcome}`,
    `duplicate_terminal_outcomes: ${report.duplicate_terminal_outcomes}`,
    `terminal_without_start: ${report.terminal_without_start}`,
    `uncorrelated_terminal_events: ${report.uncorrelated_terminal_events}`,
    `ambiguous_terminal_outcomes: ${report.ambiguous_terminal_outcomes}`,
    "",
    `reconstructability_rate: ${formatRate(report)}`,
  ];
  if (report.empty_input) {
    lines.push("empty_input: true");
  }
  lines.push("", "by_family:");
  for (const [family, bucket] of Object.entries(report.by_family)) {
    lines.push(`  ${family}:`);
    lines.push(`    reconstructed: ${bucket.operations_reconstructed}`);
    lines.push(`    unreconstructable: ${bucket.operations_unreconstructable}`);
    lines.push(`    failures: ${bucket.lifecycle_integrity_failures}`);
    lines.push(`    started_without_terminal: ${bucket.started_without_terminal_outcome}`);
    lines.push(`    duplicate_terminals: ${bucket.duplicate_terminal_outcomes}`);
    lines.push(`    terminal_without_start: ${bucket.terminal_without_start}`);
    lines.push(`    uncorrelated: ${bucket.uncorrelated_terminal_events}`);
    lines.push(`    ambiguous: ${bucket.ambiguous_terminal_outcomes}`);
  }
  if (report.observability_gaps.length) {
    lines.push("", "observability_gaps:");
    for (const gap of report.observability_gaps) {
      lines.push(`  - ${gap.family}: missing ${gap.missing}`);
    }
  }
  return lines.join("\n") + "\n";
}

function formatRate(report) {
  if (report.reconstructability_rate == null) {
    return report.empty_input ? "n/a (empty log)" : "n/a (no operations)";
  }
  return report.reconstructability_rate.toFixed(4);
}

export function publicReport(report) {
  const { operations, ...rest } = report;
  return {
    ...rest,
    operations: operations.map((op) => ({
      family: op.family,
      operation_id: op.operation_id,
      started_at: op.started_at,
      terminal_at: op.terminal_at,
      terminal_kind: op.terminal_kind,
      correlation_quality: op.correlation_quality,
      source_files: op.source_files,
      event_names: op.events.map((event) => event.name),
    })),
  };
}

export function evaluateFiles(paths) {
  const events = [];
  const sourceFiles = [];
  for (const path of paths) {
    sourceFiles.push(path);
    const text = readFileSync(path, "utf8");
    const parsed = parseJSONL(text, basename(path));
    events.push(...parsed.events);
  }
  return evaluate(events, { sourceFiles });
}

export function parseArgs(argv) {
  const args = { json: false, expectZero: false, help: false, files: [] };
  for (const a of argv) {
    if (a === "--json") args.json = true;
    else if (a === "--expect-zero") args.expectZero = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a.startsWith("-")) {
      args.unknown = a;
    } else args.files.push(a);
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.unknown || args.files.length === 0) {
    const out = args.unknown ? process.stderr : process.stdout;
    out.write(
      "Usage: node evals/observability/check-lifecycle-integrity.mjs [--json] [--expect-zero] <files...>\n",
    );
    process.exit(args.help ? 0 : 2);
  }
  const report = evaluateFiles(args.files);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(publicReport(report), null, 2)}\n`);
  } else {
    process.stdout.write(formatText(report));
  }
  if (args.expectZero && report.lifecycle_integrity_failures !== 0) {
    process.exit(1);
  }
}

const invoked = process.argv[1] && basename(process.argv[1]) === "check-lifecycle-integrity.mjs";
if (invoked) {
  main(process.argv.slice(2));
}
