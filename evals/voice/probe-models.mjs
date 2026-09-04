#!/usr/bin/env node
/**
 * M0 #12: probe every model listed in the local model-config.
 * Keys come from apps/clicky/worker/.dev.vars (never printed).
 *
 *   node evals/voice/probe-models.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../..");
const DEV_VARS = join(REPO, "apps/clicky/worker/.dev.vars");
const DEFAULT_CONFIG = join(homedir(), "Library/Application Support/Yishu/model-config.json");
const TIMEOUT_MS = 10_000;

function loadDevVars(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[trimmed.slice(0, eq).trim()] = value;
  }
  return env;
}

function applyEnv(parsed) {
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] == null || process.env[key] === "") process.env[key] = value;
  }
}

function joinChatUrl(base) {
  const trimmed = String(base || "").replace(/\/$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

function listedModels(config) {
  const out = [];
  for (const provider of config.providers || []) {
    const models = Array.isArray(provider.models) ? [...provider.models] : [];
    if (provider.defaultModel && !models.includes(provider.defaultModel)) {
      models.push(provider.defaultModel);
    }
    for (const model of models) {
      out.push({
        providerId: provider.id,
        providerName: provider.name || provider.id,
        baseUrl: provider.baseUrl,
        model,
        apiKeyEnv: provider.apiKeyEnv,
        credentialRef: provider.credentialRef,
      });
    }
  }
  return out;
}

function resolveKey(entry) {
  if (entry.apiKeyEnv && process.env[entry.apiKeyEnv]) return process.env[entry.apiKeyEnv];
  if (process.env.MINIMAX_API_KEY) return process.env.MINIMAX_API_KEY;
  return undefined;
}

function sanitize(text) {
  return String(text || "")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_\-]{8,}/g, "sk-[redacted]")
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "[redacted]")
    .slice(0, 180);
}

async function probeOne(entry, apiKey) {
  const url = joinChatUrl(entry.baseUrl);
  const headers = {
    "content-type": "application/json",
    Accept: "text/event-stream",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body = JSON.stringify({
    model: entry.model,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1,
    stream: true,
  });
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const code = err?.cause?.code || err?.name || "fetch-failed";
    return { reachable: false, detail: code === "TimeoutError" ? "timeout" : `network:${code}` };
  }
  if (!res.ok) {
    let errText = "";
    try {
      errText = await res.text();
    } catch {
      errText = "";
    }
    return { reachable: false, detail: `http ${res.status}${errText ? `: ${sanitize(errText)}` : ""}` };
  }
  if (!res.body) return { reachable: false, detail: "empty-body" };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes("data:") || buf.includes('"choices"')) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return { reachable: true, detail: "stream" };
      }
    }
  } catch (err) {
    return { reachable: false, detail: `stream:${err?.name || "read-failed"}` };
  }
  return buf.trim()
    ? { reachable: true, detail: "body" }
    : { reachable: false, detail: "no-stream-bytes" };
}

export async function main(argv = process.argv.slice(2)) {
  applyEnv(loadDevVars(DEV_VARS));
  const configPath = argv.includes("--config")
    ? argv[argv.indexOf("--config") + 1]
    : DEFAULT_CONFIG;
  if (!existsSync(configPath)) {
    console.error(`model-config not found: ${configPath}`);
    return 1;
  }
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    console.error(`model-config is not valid JSON: ${err.message}`);
    return 1;
  }
  if (!config || !Array.isArray(config.providers) || config.providers.length === 0) {
    console.error("model-config: providers must be a non-empty array");
    return 1;
  }
  const entries = listedModels(config);
  if (!entries.length) {
    console.error("model-config: no models listed");
    return 1;
  }
  const rows = [];
  for (const entry of entries) {
    const key = resolveKey(entry);
    const result = await probeOne(entry, key);
    rows.push({
      provider: entry.providerId,
      model: entry.model,
      host: (() => {
        try {
          return new URL(entry.baseUrl).host;
        } catch {
          return entry.baseUrl;
        }
      })(),
      reachable: result.reachable,
      detail: result.detail,
    });
  }
  const wProv = Math.max(8, ...rows.map((r) => r.provider.length));
  const wModel = Math.max(5, ...rows.map((r) => r.model.length));
  const wHost = Math.max(4, ...rows.map((r) => r.host.length));
  console.log(
    `${"provider".padEnd(wProv)}  ${"model".padEnd(wModel)}  ${"host".padEnd(wHost)}  result`,
  );
  for (const row of rows) {
    console.log(
      `${row.provider.padEnd(wProv)}  ${row.model.padEnd(wModel)}  ${row.host.padEnd(wHost)}  ${
        row.reachable ? "reachable" : `unreachable (${row.detail})`
      }`,
    );
  }
  const bad = rows.filter((r) => !r.reachable);
  if (bad.length) {
    console.error(`${bad.length}/${rows.length} listed model(s) unreachable`);
    return 1;
  }
  console.log(`${rows.length} listed model(s) reachable`);
  return 0;
}

const isMain =
  process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  main().then((code) => process.exit(code));
}
