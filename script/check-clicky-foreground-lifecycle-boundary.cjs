#!/usr/bin/env node
/**
 * Architecture ratchet: CompanionManager must not own foreground Runtime
 * execution lifecycle or the Runtime event-stream lifetime.
 *
 * Metric 1: foreground_execution_ownership_violations
 *   Count one violation for each:
 *   1. direct call/definition of low-level foreground Runtime lifecycle
 *      mutation methods (startTurn, cancelTurn, interruptTurn, steerTurn)
 *      in any production CompanionManager*.swift file;
 *   2. mutable storage of the authoritative active Runtime request identity
 *      (activeRuntimeRequestId or an equivalent stored request-id property)
 *      in those files.
 *
 * Metric 2: presentation_owned_runtime_event_lifetimes
 *   Count one violation for each Runtime execution/event-stream lifetime
 *   whose authoritative consumption or terminal settlement is owned by
 *   production CompanionManager*.swift:
 *   1. direct `turn.events` / Runtime event-stream consumption;
 *   2. execution terminal settlement (`settle(`) from presentation code;
 *   3. holding the raw `YishuRuntimeTurn` handle (the Runtime stream owner),
 *      as distinct from consuming typed `YishuRuntimeTurnEvent` values.
 *
 * Zero is the permanent ceiling for both. Do not raise, disable, exclude
 * files, rename around, or wrap-forward inside CompanionManager to pass.
 *
 * Usage: node script/check-clicky-foreground-lifecycle-boundary.cjs
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PRODUCT_SWIFT = path.join(ROOT, "apps/clicky/leanring-buddy");
const FILE_RE = /^CompanionManager.*\.swift$/;
const LIFECYCLE_CALL_RE = /\b(startTurn|cancelTurn|interruptTurn|steerTurn)\s*\(/;
const IDENTITY_STORAGE_RE =
  /\bvar\s+(?:(?:private|internal|fileprivate|public|open|package)\s+)*(?:(?:weak|unowned(?:\(unsafe\))?)\s+)?(?:activeRuntimeRequestId|(?:active|current|foreground)\w*RuntimeRequestId)\b/;
const TURN_EVENTS_RE = /\bturn\.events\b/;
const SETTLE_RE = /\.settle\s*\(/;
const RAW_TURN_TYPE_RE = /\bYishuRuntimeTurn\b/;
const TARGET = 0;

function collectCompanionManagerFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(
      `foreground lifecycle boundary FAILED: cannot read ${dir}: ${err.message}`,
    );
    process.exit(2);
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["Tests", "build", "DerivedSources"].includes(entry.name)) continue;
      collectCompanionManagerFiles(full, out);
    } else if (FILE_RE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function codeLines(source) {
  const lines = source.split(/\r?\n/);
  const out = [];
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let code = "";
    let inString = false;
    let stringQuote = "";
    let escaped = false;

    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const next = line[j + 1];

      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          j += 1;
        }
        continue;
      }
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === stringQuote) {
          inString = false;
          stringQuote = "";
        }
        continue;
      }
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        j += 1;
        continue;
      }
      if (ch === "/" && next === "/") {
        break;
      }
      if (ch === "\"" || ch === "'") {
        inString = true;
        stringQuote = ch;
        continue;
      }
      code += ch;
    }

    const trimmed = code.trim();
    if (!trimmed) continue;
    out.push({ line: i + 1, text: trimmed });
  }

  return out;
}

function scanOwnership(file, lines) {
  const rel = path.relative(ROOT, file);
  const violations = [];
  for (const { line, text } of lines) {
    const call = text.match(LIFECYCLE_CALL_RE);
    if (call) {
      violations.push({
        file: rel,
        line,
        kind: "lifecycle_call",
        symbol: call[1],
        text,
      });
    }
    if (IDENTITY_STORAGE_RE.test(text)) {
      violations.push({
        file: rel,
        line,
        kind: "identity_storage",
        symbol: "activeRuntimeRequestId",
        text,
      });
    }
  }
  return violations;
}

function scanEventLifetimes(file, lines) {
  const rel = path.relative(ROOT, file);
  const violations = [];
  for (const { line, text } of lines) {
    if (TURN_EVENTS_RE.test(text)) {
      violations.push({
        file: rel,
        line,
        kind: "runtime_event_consumption",
        symbol: "turn.events",
        text,
      });
    }
    if (SETTLE_RE.test(text)) {
      violations.push({
        file: rel,
        line,
        kind: "presentation_terminal_settle",
        symbol: "settle",
        text,
      });
    }
    if (RAW_TURN_TYPE_RE.test(text)) {
      violations.push({
        file: rel,
        line,
        kind: "raw_runtime_turn_handle",
        symbol: "YishuRuntimeTurn",
        text,
      });
    }
  }
  return violations;
}

function printMetric(name, violations) {
  const count = violations.length;
  console.log(`${name}: ${count}`);
  console.log(`target: ${TARGET}`);
  for (const item of violations) {
    console.log(
      `  ${item.file}:${item.line} ${item.kind} ${item.symbol}  ${item.text}`,
    );
  }
  return count;
}

if (!fs.existsSync(PRODUCT_SWIFT)) {
  console.error(
    `foreground lifecycle boundary FAILED: missing ${path.relative(ROOT, PRODUCT_SWIFT)}`,
  );
  process.exit(2);
}

const files = collectCompanionManagerFiles(PRODUCT_SWIFT).sort();
if (files.length === 0) {
  console.error(
    "foreground lifecycle boundary FAILED: no production CompanionManager*.swift files",
  );
  process.exit(2);
}

const scanned = files.map((file) => ({
  file,
  lines: codeLines(fs.readFileSync(file, "utf8")),
}));
const ownership = scanned.flatMap(({ file, lines }) =>
  scanOwnership(file, lines),
);
const lifetimes = scanned.flatMap(({ file, lines }) =>
  scanEventLifetimes(file, lines),
);

const ownershipCount = printMetric(
  "foreground_execution_ownership_violations",
  ownership,
);
const lifetimeCount = printMetric(
  "presentation_owned_runtime_event_lifetimes",
  lifetimes,
);

console.log(
  `scanned ${files.length} CompanionManager*.swift file(s); zero is the permanent ceiling for both metrics.`,
);

if (ownershipCount === 0 && lifetimeCount === 0) {
  process.exit(0);
}

if (ownershipCount > 0) {
  console.error(
    `foreground lifecycle boundary FAILED: ${ownershipCount} ownership violation(s); ceiling is 0.`,
  );
}
if (lifetimeCount > 0) {
  console.error(
    `foreground lifecycle boundary FAILED: ${lifetimeCount} presentation-owned Runtime event lifetime(s); ceiling is 0.`,
  );
}
process.exit(1);
