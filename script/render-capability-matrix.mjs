#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const status = JSON.parse(readFileSync(path.join(ROOT, "evals/capability/status.json"), "utf8"));
const scenarioDir = path.join(ROOT, "evals/capability/scenarios");
const ids = readdirSync(scenarioDir).filter((name) => name.endsWith(".yaml")).map((name) => name.replace(/\.yaml$/, "")).sort();

const rows = ids.map((id) => {
  const entry = status.capabilities[id] ?? {
    status: "implemented",
    lastAcceptedAt: null,
    evidence: "none",
    limits: "No device evidence.",
  };
  return {
    id,
    status: entry.status,
    lastAcceptedAt: entry.lastAcceptedAt ?? "—",
    evidence: entry.evidence,
    limits: entry.limits,
  };
});

const publicRows = rows.filter((row) => ["accepted", "reliable", "shippable"].includes(row.status));

function table(items) {
  return [
    "| Capability | Status | Last accepted | Evidence | Known limits |",
    "| --- | --- | --- | --- | --- |",
    ...items.map((row) => `| \`${row.id}\` | ${row.status} | ${row.lastAcceptedAt} | ${row.evidence} | ${row.limits} |`),
  ].join("\n");
}

const matrix = `# Capability matrix

Type: acceptance
Status: current
Verified: local-eval 2026-08-27
Review: any capability status change, new tool, or README current-capability edit

This is the only product capability fact source. README may publish only \`accepted\` / \`reliable\` / \`shippable\` rows.

Evidence kind in this file: **${status.evidenceKind}**. Mock evidence cannot raise a capability above \`implemented\`.

## Public claims (accepted and above)

${publicRows.length === 0 ? "_None. No capability has real-Mac accepted evidence yet._" : table(publicRows)}

## Full truth table

${table(rows)}
`;

writeFileSync(path.join(ROOT, "docs/capabilities/CAPABILITY_MATRIX.md"), matrix);

const readmePath = path.join(ROOT, "README.md");
const readme = readFileSync(readmePath, "utf8");
const start = "<!-- CAPABILITY_MATRIX:START -->";
const end = "<!-- CAPABILITY_MATRIX:END -->";
if (!readme.includes(start) || !readme.includes(end)) {
  console.error("README.md is missing CAPABILITY_MATRIX markers");
  process.exit(1);
}
const block = [
  start,
  "",
  "Only `accepted` and above appear here. The full truth table is [docs/capabilities/CAPABILITY_MATRIX.md](docs/capabilities/CAPABILITY_MATRIX.md).",
  "",
  publicRows.length === 0
    ? "No capability currently meets `accepted`. Implemented protocol paths are listed in the matrix with mock evidence only."
    : table(publicRows),
  "",
  end,
].join("\n");
const next = readme.replace(new RegExp(`${start}[\\s\\S]*?${end}`), block);
writeFileSync(readmePath, next);
console.log("rendered capability matrix and README current-capability table");
