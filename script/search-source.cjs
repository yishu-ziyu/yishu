#!/usr/bin/env node
/**
 * Stock-CI source searcher. Replaces `rg` in check-product-boundaries.sh.
 *
 * Modes:
 *   reject PATTERN PATH...  print file:line:text matches; exit 0 if any, 1 if none
 *   count  PATTERN PATH...  print occurrence count (rg -o | wc -l)
 *   files  PATTERN PATH...  print matching files, one per line; exit 0 if any, 1 if none
 *
 * Skips dist, .build, node_modules, build, DerivedData, DerivedSources, .git,
 * and hidden names — enough to match rg's default gitignore/hidden skip on
 * this repo without requiring ripgrep on PATH.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SKIP_DIRS = new Set([
  "dist",
  ".build",
  "node_modules",
  "build",
  "DerivedData",
  "DerivedSources",
  ".git",
  ".pnpm-store",
  "xcuserdata",
]);

const SKIP_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".mp3",
  ".wav",
  ".icns",
  ".zip",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".dylib",
  ".so",
  ".o",
  ".a",
]);

function usage(message) {
  if (message) console.error(message);
  console.error("usage: search-source.cjs reject|count|files PATTERN PATH...");
  process.exit(2);
}

const mode = process.argv[2];
const pattern = process.argv[3];
const targets = process.argv.slice(4);

if (!mode || !pattern || targets.length === 0) usage();
if (!["reject", "count", "files"].includes(mode)) usage(`unknown mode: ${mode}`);

let regex;
try {
  regex = new RegExp(pattern, mode === "count" ? "g" : "");
} catch (err) {
  usage(`invalid pattern: ${err.message}`);
}

function shouldSkipFile(filePath) {
  return SKIP_EXT.has(path.extname(filePath).toLowerCase());
}

function collectFiles(target, out) {
  let st;
  try {
    st = fs.lstatSync(target);
  } catch (err) {
    console.error(`Product boundary check failed: cannot read ${target}: ${err.message}`);
    process.exit(2);
  }
  if (st.isSymbolicLink()) return;
  if (st.isFile()) {
    if (!shouldSkipFile(target)) out.push(target);
    return;
  }
  if (!st.isDirectory()) return;
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    console.error(`Product boundary check failed: cannot read ${target}: ${err.message}`);
    process.exit(2);
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(target, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) collectFiles(full, out);
    else if (entry.isFile() && !shouldSkipFile(full)) out.push(full);
  }
}

const files = [];
for (const target of targets) collectFiles(target, files);
files.sort();

function rel(file) {
  return path.relative(process.cwd(), file) || file;
}

if (mode === "count") {
  let n = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    regex.lastIndex = 0;
    const matches = text.match(regex);
    if (matches) n += matches.length;
  }
  process.stdout.write(String(n));
  process.exit(0);
}

if (mode === "files") {
  const hits = [];
  const testRe = new RegExp(pattern);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    if (testRe.test(text)) hits.push(rel(file));
  }
  if (hits.length === 0) process.exit(1);
  process.stdout.write(`${hits.join("\n")}\n`);
  process.exit(0);
}

// reject
const testRe = new RegExp(pattern);
const printed = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  for (let i = 0; i < lines.length; i++) {
    if (testRe.test(lines[i])) printed.push(`${rel(file)}:${i + 1}:${lines[i]}`);
  }
}
if (printed.length === 0) process.exit(1);
process.stdout.write(`${printed.join("\n")}\n`);
process.exit(0);
