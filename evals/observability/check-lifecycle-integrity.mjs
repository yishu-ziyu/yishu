#!/usr/bin/env node
/**
 * Lifecycle Integrity evaluator.
 *
 * Read-only. Metadata only. Does not infer success from the absence of errors.
 * Distinguishes semantic lifecycle failures from observability debt.
 *
 *   node evals/observability/check-lifecycle-integrity.mjs <files...>
 *   node evals/observability/check-lifecycle-integrity.mjs --json <files...>
 *   node evals/observability/check-lifecycle-integrity.mjs --expect-zero <files...>
 *
 * --expect-zero fails only on semantic_lifecycle_failures.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const CONTENT_KEY = /transcript|prompt|screenshot|windowtitle|filepath|url|cookie|authorization|apikey|token|password|email|username|label|audio|body|text|memory/i;

/**
 * Family catalog for current main (`9f84fff` telemetry).
 *
 * ASR is utterance-shaped at the terminal (`asr.final`) but has no
 * utterance-level start. `asr.request_sent` is a per-request observation
 * sharing `turnId`; it is not a request id and not a lifecycle start.
 *
 * computer_result is observability-only: production sending/sent rows
 * do not carry requestId / traceId / receiptHash.
 */
export const FAMILIES = {
  voice_capture: {
    mode: "semantic",
    owner: "YishuVoiceSessionController / ClickyAnalytics PTT",
    start: ["ptt.key_down"],
    observations: [],
    success: ["ptt.key_up"],
    successAliases: [],
    failure: [],
    cancel: [],
    idFields: ["turnId", "turn_id"],
  },
  asr: {
    mode: "semantic",
    owner: "transcription provider / ClickyAnalytics",
    start: [],
    observations: ["asr.request_sent", "asr.first_sse", "asr.first_partial"],
    success: ["asr.final"],
    successAliases: ["asr.completed"],
    failure: [],
    cancel: [],
    idFields: ["turnId", "turn_id"],
    missingStart: "utterance-level ASR start (asr.request_sent is per-request, not a start)",
  },
  runtime_turn: {
    mode: "semantic",
    owner: "YishuForegroundRuntimeExecution",
    start: ["turn.start", "turn.started"],
    observations: [],
    success: ["model.completed", "model.done"],
    successAliases: ["model.completed", "model.done"],
    failure: ["turn.failed"],
    cancel: [],
    idFields: ["turnId", "turn_id"],
  },
  computer_result: {
    mode: "observability_only",
    owner: "YishuAgentRuntimeClient.completeComputerAction",
    start: ["computer.result.sending"],
    observations: [],
    success: ["computer.result.sent"],
    successAliases: [],
    failure: [],
    cancel: [],
    idFields: ["requestId", "traceId", "receiptHash"],
    missingStart: "correlation id on computer.result.sending/sent",
  },
};

const NAME_TO_FAMILY = new Map();
for (const [family, spec] of Object.entries(FAMILIES)) {
  for (const name of [
    ...spec.start,
    ...spec.observations,
    ...spec.success,
    ...spec.successAliases,
    ...spec.failure,
    ...spec.cancel,
  ]) {
    NAME_TO_FAMILY.set(name, family);
  }
}

function emptyMetrics() {
  return {
    started_without_terminal_outcome: 0,
    duplicate_terminal_outcomes: 0,
    terminal_without_start: 0,
    uncorrelated_terminal_events: 0,
    ambiguous_terminal_outcomes: 0,
    equivalent_terminal_aliases: 0,
  };
}

function emptyFamilyBucket() {
  return {
    operations_reconstructed: 0,
    operations_unreconstructable: 0,
    lifecycle_integrity_failures: 0,
    semantic_lifecycle_failures: 0,
    observability_integrity_failures: 0,
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
  const idFields = family
    ? FAMILIES[family].idFields
    : ["turnId", "turn_id", "requestId", "traceId", "receiptHash"];
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
    actionKind: attrs.actionKind ?? top.actionKind ?? null,
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

export function roleOf(event) {
  if (!event?.name || !event.family) return null;
  const spec = FAMILIES[event.family];
  if (spec.start.includes(event.name)) return "start";
  if (spec.observations.includes(event.name)) return "observation";
  if (
    spec.success.includes(event.name) ||
    spec.successAliases.includes(event.name) ||
    spec.failure.includes(event.name) ||
    spec.cancel.includes(event.name)
  ) {
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
  const spec = FAMILIES[event.family];
  if (spec.failure.includes(event.name)) return "failure";
  if (spec.cancel.includes(event.name)) return "cancelled";
  if (spec.success.includes(event.name) || spec.successAliases.includes(event.name)) return "success";
  return "unknown";
}

function relationToExistingTerminal(operation, event, kind) {
  if (!operation.terminal_kind) return "first";
  if (kind === "unknown" || operation.terminal_kind === "unknown") return "ambiguous";
  if (kind !== operation.terminal_kind) return "conflict";
  if (operation.terminal_names.includes(event.name)) return "duplicate";
  return "alias";
}

function gapKey(family, missing, domain) {
  return `${family}::${domain}::${missing}`;
}

function addGap(report, family, missing, domain) {
  const key = gapKey(family, missing, domain);
  if (report._gapKeys.has(key)) return;
  report._gapKeys.add(key);
  const gap = { family, missing, domain };
  report.observability_gaps.push(gap);
  report.by_family[family].observability_gaps.push(gap);
}

function bump(report, family, field, n = 1) {
  report[field] += n;
  report.by_family[family][field] += n;
}

function markSemantic(report, family, operation) {
  if (operation.failure_class === "semantic") return;
  if (operation.failure_class === "observability") {
    bump(report, family, "observability_integrity_failures", -1);
    bump(report, family, "semantic_lifecycle_failures");
    operation.failure_class = "semantic";
    operation.counted_as = "unreconstructable";
    operation.correlation_quality = "semantic_failure";
    return;
  }
  if (operation.counted_as === "reconstructed") {
    bump(report, family, "operations_reconstructed", -1);
    bump(report, family, "operations_unreconstructable");
  } else if (operation.counted_as !== "unreconstructable") {
    bump(report, family, "operations_unreconstructable");
  }
  bump(report, family, "semantic_lifecycle_failures");
  bump(report, family, "lifecycle_integrity_failures");
  operation.failure_class = "semantic";
  operation.counted_as = "unreconstructable";
  operation.correlation_quality = "semantic_failure";
}

function markObservability(report, family, operation) {
  if (operation.failure_class === "semantic" || operation.failure_class === "observability") return;
  if (operation.counted_as === "reconstructed") {
    bump(report, family, "operations_reconstructed", -1);
    bump(report, family, "operations_unreconstructable");
  } else if (operation.counted_as !== "unreconstructable") {
    bump(report, family, "operations_unreconstructable");
  }
  bump(report, family, "observability_integrity_failures");
  bump(report, family, "lifecycle_integrity_failures");
  operation.failure_class = "observability";
  operation.counted_as = "unreconstructable";
  operation.correlation_quality = "observability";
}

function markReconstructed(report, family, operation) {
  operation.counted_as = "reconstructed";
  operation.failure_class = null;
  operation.correlation_quality = "id";
  bump(report, family, "operations_reconstructed");
}

function assertNonNegative(report) {
  const fields = [
    "operations_reconstructed",
    "operations_unreconstructable",
    "lifecycle_integrity_failures",
    "semantic_lifecycle_failures",
    "observability_integrity_failures",
    ...Object.keys(emptyMetrics()),
  ];
  for (const field of fields) {
    if (report[field] < 0) report[field] = 0;
    for (const bucket of Object.values(report.by_family)) {
      if (bucket[field] < 0) bucket[field] = 0;
    }
  }
}

export function evaluate(events, options = {}) {
  const sourceFiles = options.sourceFiles ?? [];
  const report = {
    operations_reconstructed: 0,
    operations_unreconstructable: 0,
    lifecycle_integrity_failures: 0,
    semantic_lifecycle_failures: 0,
    observability_integrity_failures: 0,
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

  const startsByDomain = new Set();
  for (const event of indexed) {
    if (event.family && roleOf(event) === "start") {
      startsByDomain.add(`${event.family}::${event.sourceFile}`);
    }
  }

  const open = new Map();
  const closed = new Map();
  const observations = new Map();
  const observabilityOnlyDomains = new Set();
  const keyFor = (family, id) => `${family}::${id}`;

  const pushOp = (operation) => {
    if (!operation._pushed) {
      report.operations.push(operation);
      operation._pushed = true;
    }
  };

  const attach = (operation, event) => {
    operation.events.push(summarize(event));
    if (!operation.source_files.includes(event.sourceFile)) {
      operation.source_files.push(event.sourceFile);
    }
  };

  const rememberTerminalName = (operation, event) => {
    if (event.name && !operation.terminal_names.includes(event.name)) {
      operation.terminal_names.push(event.name);
    }
  };

  const takeObservations = (family, id) => observations.get(keyFor(family, id)) ?? [];

  for (const event of indexed) {
    if (!event.family) continue;
    const family = event.family;
    const spec = FAMILIES[family];
    const role = roleOf(event);
    if (!role) continue;

    if (spec.mode === "observability_only") {
      const domain = event.sourceFile;
      addGap(report, family, spec.missingStart || "correlation_id", domain);
      if (!observabilityOnlyDomains.has(`${family}::${domain}`)) {
        observabilityOnlyDomains.add(`${family}::${domain}`);
        const operation = {
          family,
          operation_id: event.operationId,
          started_at: null,
          terminal_at: event.occurredAt,
          terminal_kind: null,
          terminal_names: [],
          events: [summarize(event)],
          correlation_quality: "observability",
          source_files: [domain],
          counted_as: null,
          failure_class: null,
        };
        markObservability(report, family, operation);
        pushOp(operation);
      } else {
        const existing = report.operations.find(
          (op) => op.family === family && op.source_files.includes(domain),
        );
        if (existing) attach(existing, event);
      }
      continue;
    }

    if (role === "observation") {
      if (!event.operationId) {
        addGap(report, family, "correlation_id", event.sourceFile);
        continue;
      }
      const ok = keyFor(family, event.operationId);
      const list = observations.get(ok) ?? [];
      list.push(event);
      observations.set(ok, list);
      const current = open.get(ok) || closed.get(ok);
      if (current) attach(current, event);
      continue;
    }

    if (role === "start") {
      if (!event.operationId) {
        addGap(report, family, "correlation_id", event.sourceFile);
        const operation = {
          family,
          operation_id: null,
          started_at: event.occurredAt,
          terminal_at: null,
          terminal_kind: null,
          terminal_names: [],
          events: [summarize(event)],
          source_files: [event.sourceFile],
          counted_as: null,
          failure_class: null,
        };
        bump(report, family, "started_without_terminal_outcome");
        markSemantic(report, family, operation);
        pushOp(operation);
        continue;
      }
      const key = keyFor(family, event.operationId);
      const existing = open.get(key);
      if (existing) {
        bump(report, family, "started_without_terminal_outcome");
        markSemantic(report, family, existing);
        open.delete(key);
        closed.set(key, existing);
      }
      const operation = {
        family,
        operation_id: event.operationId,
        started_at: event.occurredAt,
        terminal_at: null,
        terminal_kind: null,
        terminal_names: [],
        events: [summarize(event), ...takeObservations(family, event.operationId).map(summarize)],
        source_files: [event.sourceFile],
        counted_as: null,
        failure_class: null,
      };
      open.set(key, operation);
      continue;
    }

    const kind = classifyTerminal(event);
    if (kind === "unknown") bump(report, family, "ambiguous_terminal_outcomes");

    if (!event.operationId) {
      addGap(report, family, "correlation_id", event.sourceFile);
      bump(report, family, "uncorrelated_terminal_events");
      addGap(report, family, `low-fidelity alias ${event.name}`, event.sourceFile);
      bump(report, family, "observability_integrity_failures");
      bump(report, family, "lifecycle_integrity_failures");
      continue;
    }

    const key = keyFor(family, event.operationId);
    let current = open.get(key);
    if (current) {
      attach(current, event);
      const relation = relationToExistingTerminal(current, event, kind);
      rememberTerminalName(current, event);
      if (relation === "first") {
        current.terminal_kind = kind;
        current.terminal_at = event.occurredAt;
        if (kind === "unknown") {
          open.delete(key);
          closed.set(key, current);
          pushOp(current);
          markSemantic(report, family, current);
        } else {
          open.delete(key);
          closed.set(key, current);
          pushOp(current);
          markReconstructed(report, family, current);
        }
      } else if (relation === "alias") {
        bump(report, family, "equivalent_terminal_aliases");
      } else if (relation === "duplicate") {
        bump(report, family, "duplicate_terminal_outcomes");
        open.delete(key);
        closed.set(key, current);
        pushOp(current);
        markSemantic(report, family, current);
      } else if (relation === "conflict" || relation === "ambiguous") {
        if (relation === "conflict") bump(report, family, "duplicate_terminal_outcomes");
        open.delete(key);
        closed.set(key, current);
        pushOp(current);
        markSemantic(report, family, current);
      }
      continue;
    }

    current = closed.get(key);
    if (current) {
      attach(current, event);
      const relation = relationToExistingTerminal(current, event, kind);
      rememberTerminalName(current, event);
      if (relation === "alias") {
        bump(report, family, "equivalent_terminal_aliases");
        continue;
      }
      if (relation === "duplicate") {
        bump(report, family, "duplicate_terminal_outcomes");
        markSemantic(report, family, current);
        continue;
      }
      if (relation === "conflict" || relation === "ambiguous") {
        if (relation === "conflict") bump(report, family, "duplicate_terminal_outcomes");
        markSemantic(report, family, current);
        continue;
      }
    }

    const domainHasStart = startsByDomain.has(`${family}::${event.sourceFile}`);
    addGap(report, family, spec.missingStart || `start:${spec.start.join("|") || "(none)"}`, event.sourceFile);
    bump(report, family, "terminal_without_start");
    const orphan = {
      family,
      operation_id: event.operationId,
      started_at: null,
      terminal_at: event.occurredAt,
      terminal_kind: kind,
      terminal_names: [event.name],
      events: [...takeObservations(family, event.operationId).map(summarize), summarize(event)],
      source_files: [event.sourceFile],
      counted_as: null,
      failure_class: null,
    };
    closed.set(key, orphan);
    pushOp(orphan);
    if (domainHasStart && spec.start.length > 0) {
      markSemantic(report, family, orphan);
    } else {
      markObservability(report, family, orphan);
    }
  }

  for (const operation of open.values()) {
    bump(report, operation.family, "started_without_terminal_outcome");
    pushOp(operation);
    markSemantic(report, operation.family, operation);
  }

  assertNonNegative(report);
  const denom = report.operations_reconstructed + report.operations_unreconstructable;
  report.reconstructability_rate = denom === 0 ? null : report.operations_reconstructed / denom;
  if (report.reconstructability_rate != null) {
    if (report.reconstructability_rate < 0) report.reconstructability_rate = 0;
    if (report.reconstructability_rate > 1) report.reconstructability_rate = 1;
  }
  delete report._gapKeys;
  for (const operation of report.operations) {
    delete operation._pushed;
  }
  return report;
}

function summarize(event) {
  return {
    name: event.name,
    occurredAt: event.occurredAt,
    status: event.status,
    outcome: event.outcome,
    errorCode: event.errorCode,
    actionKind: event.actionKind ?? null,
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
    `semantic_lifecycle_failures: ${report.semantic_lifecycle_failures}`,
    `observability_integrity_failures: ${report.observability_integrity_failures}`,
    "",
    `started_without_terminal_outcome: ${report.started_without_terminal_outcome}`,
    `duplicate_terminal_outcomes: ${report.duplicate_terminal_outcomes}`,
    `terminal_without_start: ${report.terminal_without_start}`,
    `uncorrelated_terminal_events: ${report.uncorrelated_terminal_events}`,
    `ambiguous_terminal_outcomes: ${report.ambiguous_terminal_outcomes}`,
    `equivalent_terminal_aliases: ${report.equivalent_terminal_aliases}`,
    "",
    `reconstructability_rate: ${formatRate(report)}`,
  ];
  if (report.empty_input) lines.push("empty_input: true");
  lines.push("", "by_family:");
  for (const [family, bucket] of Object.entries(report.by_family)) {
    lines.push(`  ${family}:`);
    lines.push(`    reconstructed: ${bucket.operations_reconstructed}`);
    lines.push(`    unreconstructable: ${bucket.operations_unreconstructable}`);
    lines.push(`    semantic_failures: ${bucket.semantic_lifecycle_failures}`);
    lines.push(`    observability_failures: ${bucket.observability_integrity_failures}`);
  }
  if (report.observability_gaps.length) {
    lines.push("", "observability_gaps:");
    for (const gap of report.observability_gaps) {
      lines.push(`  - ${gap.family} [${gap.domain}]: missing ${gap.missing}`);
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
      failure_class: op.failure_class,
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
    else if (a.startsWith("-")) args.unknown = a;
    else args.files.push(a);
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
  if (args.expectZero && report.semantic_lifecycle_failures !== 0) process.exit(1);
}

const invoked = process.argv[1] && basename(process.argv[1]) === "check-lifecycle-integrity.mjs";
if (invoked) main(process.argv.slice(2));
