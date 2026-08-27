#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const configPath = process.argv[2]
  ?? path.join(os.homedir(), "Library", "Application Support", "Yishu", "model-config.json");

if (!existsSync(configPath)) {
  console.log(JSON.stringify({ path: configPath, present: false, inlineSecrets: 0, credentialRefs: 0 }, null, 2));
  process.exit(0);
}

const raw = readFileSync(configPath, "utf8");
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  console.error("audit-credentials: model-config is not valid JSON");
  process.exit(1);
}

const providers = Array.isArray(parsed.providers) ? parsed.providers : [];
const inlineSecrets = providers.filter((provider) => typeof provider.apiKey === "string" && provider.apiKey.length > 0).length;
const credentialRefs = providers.filter((provider) => typeof provider.credentialRef === "string").length;
console.log(JSON.stringify({
  path: configPath,
  present: true,
  providerCount: providers.length,
  inlineSecrets,
  credentialRefs,
  secretValuesPrinted: false,
}, null, 2));
if (inlineSecrets > 0) process.exit(2);
