#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forbidden = [
  "^packages/.*/coverage/",
  "^coverage/",
  "/DerivedData/",
  "node_modules/",
  "\\.dev\\.vars$",
  "\\.env$",
  "BrowserProfiles/",
  "quality\\.sqlite$",
  "\\.zip$",
];
const listed = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
if (listed.status !== 0) {
  console.error(listed.stderr);
  process.exit(1);
}
const files = listed.stdout.split("\n").filter(Boolean);
const hits = files.filter((file) => forbidden.some((pattern) => new RegExp(pattern).test(file)));
const large = spawnSync("git", ["ls-files", "-s"], { cwd: ROOT, encoding: "utf8" });
const oversized = [];
for (const line of large.stdout.split("\n")) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 4) continue;
  const hash = parts[1];
  const file = parts.slice(3).join(" ");
  if (file.endsWith(".png") || file.endsWith(".jpg") || file.endsWith(".mp3") || file.endsWith(".gif")) continue;
  const cat = spawnSync("git", ["cat-file", "-s", hash], { cwd: ROOT, encoding: "utf8" });
  const size = Number(cat.stdout.trim());
  if (Number.isFinite(size) && size > 2_000_000 && !file.endsWith("pnpm-lock.yaml")) {
    oversized.push(`${file} (${size} bytes)`);
  }
}
if (hits.length > 0 || oversized.length > 0) {
  if (hits.length > 0) {
    console.error("generated-file guard failed; tracked generated paths:");
    for (const file of hits) console.error(`  ${file}`);
  }
  if (oversized.length > 0) {
    console.error("generated-file guard failed; oversized binaries:");
    for (const file of oversized) console.error(`  ${file}`);
  }
  process.exit(1);
}
console.log("generated-file guard passed");
