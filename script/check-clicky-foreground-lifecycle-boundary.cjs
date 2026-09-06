#!/usr/bin/env node
/**
 * Architecture ratchet: CompanionManager must not directly own or mutate
 * the foreground Runtime execution lifecycle.
 *
 * Metric: foreground_execution_ownership_violations
 *
 * Count one violation for each:
 * 1. direct call/definition of low-level foreground Runtime lifecycle
 *    mutation methods (startTurn, cancelTurn, interruptTurn, steerTurn)
 *    in any production CompanionManager*.swift file;
 * 2. mutable storage of the authoritative active Runtime request identity
 *    (activeRuntimeRequestId or an equivalent stored request-id property)
 *    in those files.
 *
 * Zero is the permanent ceiling. Do not raise, disable, exclude files,
 * rename around, or wrap-forward inside CompanionManager to pass.
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

function scanFile(file) {
  const rel = path.relative(ROOT, file);
  const source = fs.readFileSync(file, "utf8");
  const lines = source.split(/\r?\n/);
  const violations = [];
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
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

    const call = trimmed.match(LIFECYCLE_CALL_RE);
    if (call) {
      violations.push({
        file: rel,
        line: i + 1,
        kind: "lifecycle_call",
        symbol: call[1],
        text: trimmed,
      });
    }

    const storage = trimmed.match(IDENTITY_STORAGE_RE);
    if (storage) {
      violations.push({
        file: rel,
        line: i + 1,
        kind: "identity_storage",
        symbol: "activeRuntimeRequestId",
        text: trimmed,
      });
    }
  }

  return violations;
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

const violations = files.flatMap(scanFile);
const count = violations.length;

console.log(`foreground_execution_ownership_violations: ${count}`);
if (count === 0) {
  console.log(
    `scanned ${files.length} CompanionManager*.swift file(s); zero is the permanent ceiling.`,
  );
  process.exit(0);
}

for (const item of violations) {
  console.log(
    `  ${item.file}:${item.line} ${item.kind} ${item.symbol}  ${item.text}`,
  );
}
console.error(
  `foreground lifecycle boundary FAILED: ${count} violation(s); ceiling is 0.`,
);
process.exit(1);
