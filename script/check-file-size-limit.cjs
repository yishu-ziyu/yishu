#!/usr/bin/env node
/**
 * Class god-file red-line (ratchet).
 *
 * Guards against NEW class god-files: the real "change breaks everywhere" risk
 * is a single class accumulating many responsibilities over MAX_LINES. Pure
 * helper files (no class, no `this`, module-level functions/constants) are
 * reported but not counted -- they are a legitimate, low-risk product of
 * splitting a god file and often a transient refactor state.
 *
 * BASELINE is the current count of src .ts files that BOTH exceed MAX_LINES
 * AND define a class. If that count rises above BASELINE a new class god-file
 * was added and this fails, forcing it to be split. Shrinking a class god-file
 * lowers the count; lower BASELINE after a deliberate shrink so the ratchet
 * only ever moves down.
 *
 * Swift: CompanionManager.swift is the current product god-file at 4609 lines.
 * That number is a ceiling for product Swift under apps/clicky/leanring-buddy/
 * (not Tests, not build/, not DerivedSources). Never raise it. Do not split
 * CompanionManager in this gate; shrink in place, then lower SWIFT_LINE_CEILING.
 *
 * Report with: pnpm size:check
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PACKAGES = path.join(ROOT, "packages");
const MAX_LINES = 400;
// Current count of src .ts files over MAX_LINES that also define a class
// (2026-08-25). Lower it as class god-files in docs/debt/technical-debt.md get
// split. Never raise it. Pure helper files are excluded by design.
const BASELINE = 14;

const HAS_CLASS_RE = /\bclass [A-Z]/;

function collectSrcTs(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["dist", ".build", "node_modules", "test"].includes(entry.name)) {
        continue;
      }
      collectSrcTs(full, out);
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const files = collectSrcTs(PACKAGES);
const oversized = files
  .map((file) => ({ file, content: fs.readFileSync(file, "utf8") }))
  .map((x) => ({ ...x, lines: x.content.split("\n").length }))
  .filter((x) => x.lines > MAX_LINES)
  .sort((a, b) => b.lines - a.lines);

const classOver = oversized.filter((x) => HAS_CLASS_RE.test(x.content));
const pureOver = oversized.filter((x) => !HAS_CLASS_RE.test(x.content));

if (classOver.length > BASELINE) {
  console.error(
    `Class god-file red-line FAILED: ${classOver.length} class files exceed ` +
      `${MAX_LINES} lines, above the ${BASELINE} baseline. A new class god-file ` +
      `was added. Split it, or record it in docs/debt/technical-debt.md.`,
  );
  for (const x of classOver.slice(0, 10)) {
    console.error(`  ${x.lines} ${path.relative(ROOT, x.file)}`);
  }
  process.exit(1);
}

console.log(
  `Class god-file red-line passed: ${classOver.length}/${BASELINE} class files over ` +
    `${MAX_LINES} lines (at/under baseline).`,
);
for (const x of classOver) {
  console.log(`  [class] ${x.lines} ${path.relative(ROOT, x.file)}`);
}
if (pureOver.length > 0) {
  console.log(`  (${pureOver.length} pure-helper files over ${MAX_LINES} lines, not counted:)`);
  for (const x of pureOver) {
    console.log(`  [pure ] ${x.lines} ${path.relative(ROOT, x.file)}`);
  }
}

const SWIFT_ROOT = path.join(ROOT, "apps/clicky/leanring-buddy");
// CompanionManager.swift current size. Ceiling only: never raise.
const SWIFT_LINE_CEILING = 4609;
const COMPANION_MANAGER = "CompanionManager.swift";
const SWIFT_SKIP_DIRS = new Set(["Tests", "build", "DerivedSources"]);

function collectProductSwift(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`Swift god-file ratchet FAILED: cannot read ${dir}: ${err.message}`);
    process.exit(1);
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SWIFT_SKIP_DIRS.has(entry.name)) continue;
      collectProductSwift(full, out);
    } else if (entry.name.endsWith(".swift")) {
      out.push(full);
    }
  }
  return out;
}

function swiftLineCount(content) {
  if (content.length === 0) return 0;
  const parts = content.split("\n");
  return content.endsWith("\n") ? parts.length - 1 : parts.length;
}

if (!fs.existsSync(SWIFT_ROOT)) {
  console.error(
    `Swift god-file ratchet FAILED: missing product Swift root ${path.relative(ROOT, SWIFT_ROOT)}`,
  );
  process.exit(1);
}

const swiftFiles = collectProductSwift(SWIFT_ROOT)
  .map((file) => ({
    file,
    lines: swiftLineCount(fs.readFileSync(file, "utf8")),
  }))
  .sort((a, b) => b.lines - a.lines);

const companion = swiftFiles.find((x) => path.basename(x.file) === COMPANION_MANAGER);
if (!companion) {
  console.error(
    `Swift god-file ratchet FAILED: ${COMPANION_MANAGER} missing under apps/clicky/leanring-buddy/`,
  );
  process.exit(1);
}

const swiftOver = swiftFiles.filter((x) => x.lines > SWIFT_LINE_CEILING);
if (swiftOver.length > 0) {
  console.error(
    `Swift god-file ratchet FAILED: ${swiftOver.length} product Swift file(s) exceed ` +
      `${SWIFT_LINE_CEILING} lines (CompanionManager.swift ceiling, only down).`,
  );
  for (const x of swiftOver) {
    console.error(`  ${x.lines} ${path.relative(ROOT, x.file)}`);
  }
  process.exit(1);
}

console.log(
  `Swift god-file ratchet passed: ${COMPANION_MANAGER} ${companion.lines}/${SWIFT_LINE_CEILING} ` +
    `(ceiling, only down); ${swiftFiles.length} product Swift files scanned.`,
);
