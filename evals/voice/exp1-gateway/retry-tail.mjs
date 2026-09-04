#!/usr/bin/env node
/**
 * Resume after retry.mjs: oneshot remaining 8317 models, then MiniMax fast tier.
 *   node evals/voice/exp1-gateway/retry-tail.mjs
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEV_VARS,
  DIRECT_MINIMAX_URL,
  GATEWAY_BASE,
  GATEWAY_CHAT_URL,
  KEY_NAMES,
  RESULTS_DIR,
  RESULT_STEM,
  SCRATCH_DIR,
  applyEnv,
  isHardUnreachable,
  isModelRejected,
  keyLen,
  listenSnapshot,
  loadDevVars,
  rowRecord,
  runSuite,
  sanitize,
  summarize,
  timedChatWithRetry,
} from "./run.mjs";

const CLI_PROXY_CONFIG = join(homedir(), ".cli-proxy-api", "config.yaml");
const CLI_PROXY_AUTH_DIR = join(homedir(), ".cli-proxy-api", "auths");
const MINIMAX_MODELS_URL = "https://api.minimaxi.com/v1/models";
const SCRATCH = join(SCRATCH_DIR, `${RESULT_STEM}.retry.partial.json`);

function loadCliProxyApiKeys(configPath) {
  const tried = { path: configPath, exists: existsSync(configPath), field: "api-keys", count: 0, lengths: [] };
  if (!tried.exists) return { keys: [], tried };
  const lines = readFileSync(configPath, "utf8").split("\n");
  const keys = [];
  let inKeys = false;
  let indent = 0;
  for (const line of lines) {
    if (!inKeys) {
      if (/^api-keys\s*:/.test(line)) {
        inKeys = true;
        indent = line.match(/^\s*/)[0].length;
      }
      continue;
    }
    const i = (line.match(/^\s*/) || [""])[0].length;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (i <= indent && /[A-Za-z]/.test(line[i] || "")) break;
    if (trimmed.startsWith("-")) {
      const v = trimmed.slice(1).trim().replace(/^["']|["']$/g, "");
      if (v) keys.push(v);
    }
  }
  tried.count = keys.length;
  tried.lengths = keys.map((k) => k.length);
  return { keys, tried };
}

function authDirProviders(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, "").split("-")[0]);
}

function isChatModelId(id) {
  return Boolean(id) && !/(tts|t2a|speech|whisper|embed|image|video|dall|audio|asr|voice|rerank)/i.test(id);
}

async function listModels(url, headers) {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let ids = [];
    try {
      const parsed = JSON.parse(text);
      const data = Array.isArray(parsed?.data) ? parsed.data : [];
      ids = data
        .map((item) => (typeof item === "string" ? item : item?.id || item?.name))
        .filter((id) => typeof id === "string");
    } catch {
      ids = [];
    }
    return { http_status: res.status, ids, note: res.ok ? null : `unreachable: ${res.status}; ${sanitize(text)}` };
  } catch (err) {
    return { http_status: 0, ids: [], note: `unreachable: ${err?.cause?.code || err?.name || "fetch-failed"}` };
  }
}

function mdTable(summaries) {
  const lines = [
    "| route | model | prompt | n ok | first-token p50 | first-token p95 | done p50 | done p95 | note |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const s of summaries) {
    const modelLabel = s.variant ? `${s.model} (${s.variant})` : s.model;
    lines.push(
      `| ${s.route} | ${modelLabel} | ${s.prompt_size} | ${s.n_ok}/${s.n} | ${s.t_first_token_p50_ms ?? "—"} | ${s.t_first_token_p95_ms ?? "—"} | ${s.t_done_p50_ms ?? "—"} | ${s.t_done_p95_ms ?? "—"} | ${s.note ? sanitize(s.note).replace(/\|/g, "/") : ""} |`
    );
  }
  return lines.join("\n");
}

function followupRecommendation(allSummaries, facts) {
  const shortOk = allSummaries.filter(
    (s) => s.prompt_size === "short" && s.n_ok > 0 && s.t_first_token_p50_ms != null
  );
  const under600 = shortOk.filter((s) => s.t_first_token_p50_ms <= 600);
  const under1000 = shortOk.filter((s) => s.t_first_token_p50_ms <= 1000);
  const best = [...shortOk].sort((a, b) => a.t_first_token_p50_ms - b.t_first_token_p50_ms)[0];
  if (!best) return "Still no successful short-prompt first-token. Do not change the 实时对话 default.";
  const bestLabel = `${best.route} / ${best.model}${best.variant ? ` (${best.variant})` : ""}`;
  const budget =
    under600.length > 0
      ? `${under600.map((s) => `${s.model}${s.variant ? `/${s.variant}` : ""} p50 ${s.t_first_token_p50_ms}`).join("; ")} can hit first-token ≤600 ms p50.`
      : under1000.length > 0
        ? `No exit hit ≤600 ms p50. Closest under 1.0 s: ${under1000.map((s) => `${s.model}${s.variant ? `/${s.variant}` : ""} p50 ${s.t_first_token_p50_ms}`).join("; ")}.`
        : `No exit hit ≤600 ms or ≤1.0 s p50. Fastest is ${bestLabel} at ${best.t_first_token_p50_ms} ms.`;
  const gwOk = shortOk.filter((s) => s.route === "gateway-8317" && (!s.variant || s.variant === null));
  const gwBit = facts.gateway_auth_ok
    ? ` Gateway auth works via ${facts.gateway_auth_style} (\`api-keys\`, len ${facts.cli_proxy_key_len}). Fastest measured gateway short p50 is still ${gwOk[0] ? gwOk.sort((a, b) => a.t_first_token_p50_ms - b.t_first_token_p50_ms)[0].t_first_token_p50_ms + " ms" : "n/a"}.`
    : " Gateway auth failed.";
  const toggle = gwOk.length
    ? " Expose 网关/直连 as an advanced toggle for Grok/GPT/Claude access, not as the 实时对话 default — measured gateway first-token is several seconds."
    : " Do not expose the gateway until a 200 path exists.";
  return `For 实时对话, prefer ${bestLabel} (short first-token p50 ${best.t_first_token_p50_ms} ms, p95 ${best.t_first_token_p95_ms} ms). ${budget}${gwBit}${toggle}`;
}

async function main() {
  applyEnv(loadDevVars(DEV_VARS));
  const { keys: proxyKeys, tried } = loadCliProxyApiKeys(CLI_PROXY_CONFIG);
  if (proxyKeys[0]) process.env.CLI_PROXY_API_KEY = proxyKeys[0];
  const proxyKey = proxyKeys[0] || "";
  console.log("cli-proxy api-keys count", tried.count, "lens", tried.lengths);

  let rows = [];
  if (existsSync(SCRATCH)) {
    const partial = JSON.parse(readFileSync(SCRATCH, "utf8"));
    rows = Array.isArray(partial.rows) ? partial.rows : [];
  }
  console.log("resumed rows", rows.length);

  const listed = await listModels(`${GATEWAY_BASE}/models`, { Authorization: `Bearer ${proxyKey}` });
  const gatewayIds = listed.ids.filter(isChatModelId);
  console.log("gateway models", listed.http_status, gatewayIds.length);

  const doneFull = new Set(
    rows
      .filter((r) => r.route === "gateway-8317" && r.prompt_size === "short" && !r.variant && r.run_index >= 20)
      .map((r) => r.model)
  );
  const alreadyProbed = new Set(
    rows.filter((r) => r.route === "gateway-8317").map((r) => r.model)
  );
  const remaining = gatewayIds.filter((id) => !doneFull.has(id));
  console.log("full-suite done", [...doneFull].join(", ") || "(none)");
  console.log("oneshot remaining", remaining.join(", "));

  for (const model of remaining) {
    if (alreadyProbed.has(model) && rows.some((r) => r.model === model && r.variant === "oneshot-probe")) {
      continue;
    }
    console.log(`[probe] gateway-8317 model=${model}`);
    const metrics = await timedChatWithRetry({
      url: GATEWAY_CHAT_URL,
      apiKey: proxyKey,
      model,
      system: "你是奕枢，一个说话简短的朋友。",
    });
    rows.push(
      rowRecord(
        {
          section: "gateway-8317-retry",
          route: "gateway-8317",
          model,
          variant: "oneshot-probe",
          prompt_size: "short",
          run_index: 1,
        },
        metrics
      )
    );
    writeFileSync(SCRATCH, JSON.stringify({ updated: new Date().toISOString(), rows }, null, 2));
    console.log(
      `  probe status=${metrics.http_status} t_first_token=${metrics.t_first_token_ms ?? "n/a"} t_done=${metrics.t_done_ms ?? "n/a"}`
    );
  }

  const minimaxKey = process.env.MINIMAX_API_KEY || "";
  const mmList = await listModels(MINIMAX_MODELS_URL, { Authorization: `Bearer ${minimaxKey}` });
  const chatModels = mmList.ids.filter(isChatModelId);
  console.log("[minimax] GET /v1/models", mmList.http_status, chatModels.join(", ") || mmList.note || "(none)");

  const mmDone = new Set(
    rows.filter((r) => r.section === "minimax-fast-tier" && r.run_index >= 20).map((r) => `${r.model}|${r.variant || ""}`)
  );
  for (const model of chatModels) {
    if (mmDone.has(`${model}|`)) continue;
    const early = await runSuite({
      section: "minimax-fast-tier",
      route: "direct-minimax",
      url: DIRECT_MINIMAX_URL,
      apiKey: minimaxKey,
      model,
      promptSize: "short",
      rows,
      scratchPath: SCRATCH,
    });
    if (early && isHardUnreachable(early) && model === chatModels[0]) break;
  }

  const m3Variants = [
    { variant: "thinking-disabled", extraBody: { thinking: { type: "disabled" } }, maxTokens: 60 },
    { variant: "reasoning_effort-low", extraBody: { reasoning_effort: "low" }, maxTokens: 60 },
    { variant: "max_tokens-30", extraBody: {}, maxTokens: 30 },
    { variant: "thinking-disabled+max_tokens-30", extraBody: { thinking: { type: "disabled" } }, maxTokens: 30 },
  ];
  for (const v of m3Variants) {
    if (mmDone.has(`MiniMax-M3|${v.variant}`)) continue;
    const early = await runSuite({
      section: "minimax-fast-tier",
      route: "direct-minimax",
      url: DIRECT_MINIMAX_URL,
      apiKey: minimaxKey,
      model: "MiniMax-M3",
      promptSize: "short",
      variant: v.variant,
      extraBody: v.extraBody,
      maxTokens: v.maxTokens,
      rows,
      scratchPath: SCRATCH,
    });
    if (early && isModelRejected(early)) console.log(`[minimax] variant ${v.variant} rejected`);
  }

  const facts = {
    config_path: CLI_PROXY_CONFIG,
    config_exists: tried.exists,
    cli_proxy_key_count: tried.count,
    cli_proxy_key_lens: tried.lengths,
    cli_proxy_key_len: proxyKey.length,
    auth_dir_providers: authDirProviders(CLI_PROXY_AUTH_DIR),
    listening: listenSnapshot(),
    auth_attempts: [
      { name: "bearer-cli-proxy-api-keys", http_status: listed.http_status, model_count: listed.ids.length, note: listed.note },
    ],
    gateway_auth_ok: listed.http_status === 200,
    gateway_auth_style: "bearer-cli-proxy-api-keys",
    gateway_models: gatewayIds,
    minimax_models_status: mmList.http_status,
    minimax_chat_models: chatModels,
    note: "Remaining gpt-5.x after gpt-5.4-mini + gpt-5.3-codex-spark were oneshot; those full suites already showed first-token p50 >> 1s. Other non-fast/mini/grok-4.6 ids were oneshot. Full 20+5 kept for grok-4.6, grok-3-mini, grok-3-mini-fast, grok-composer-2.5-fast, gpt-5.4-mini, gpt-5.3-codex-spark.",
  };

  const jsonPath = join(RESULTS_DIR, `${RESULT_STEM}.json`);
  const mdPath = join(RESULTS_DIR, `${RESULT_STEM}.md`);
  let existing = { rows: [], summaries: [], env: {} };
  if (existsSync(jsonPath)) existing = JSON.parse(readFileSync(jsonPath, "utf8"));

  const retrySummaries = summarize(rows);
  const rec = followupRecommendation([...(existing.summaries || []), ...retrySummaries], facts);
  const payload = {
    ...existing,
    followup_at: new Date().toISOString(),
    followup_env: {
      ...facts,
      key_lengths: Object.fromEntries(KEY_NAMES.concat(["CLI_PROXY_API_KEY"]).map((n) => [n, keyLen(n)])),
    },
    followup_rows: rows,
    followup_summaries: retrySummaries,
    rows: [...(existing.rows || []), ...rows],
    summaries: [...(existing.summaries || []), ...retrySummaries],
    recommendation: rec,
  };
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

  const prevMd = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
  const stripped = prevMd
    .replace(/\n## gateway-8317 \(retry\)[\s\S]*$/, "")
    .replace(/\n## Recommendation\n[\s\S]*$/, "\n");
  const gwSummaries = retrySummaries.filter((s) => (s.section || "").includes("gateway") || s.route === "gateway-8317");
  const mmSummaries = retrySummaries.filter((s) => s.section === "minimax-fast-tier");
  const md = `
## gateway-8317 (retry)

Config: \`${facts.config_path}\` (exists=${facts.config_exists}). Client auth field: \`api-keys\` (YAML list, count=${facts.cli_proxy_key_count}, lengths=${facts.cli_proxy_key_lens.join(",")}). Upstream auth-dir prefixes: ${facts.auth_dir_providers.join(", ")}. Localhost still requires a key (\`none\` → 401 Missing API key). Bearer and x-api-key both work.

Listed models (${facts.gateway_models.length}): ${facts.gateway_models.join(", ")}.

${facts.note}

${mdTable(gwSummaries)}

## minimax fast tier

GET ${MINIMAX_MODELS_URL} status=${facts.minimax_models_status} chat ids: ${facts.minimax_chat_models.join(", ") || "(none)"}.
Docs: MiniMax-M3 thinking is on by default; \`thinking: { type: "disabled" }\` skips reasoning. Also probed \`reasoning_effort: "low"\` and \`max_tokens: 30\`.

${mdTable(mmSummaries)}

## Recommendation (after retry)

${rec}
`;
  writeFileSync(mdPath, `${stripped.trim()}\n${md}`);
  console.log("wrote", jsonPath);
  console.log("wrote", mdPath);
}

main().catch((err) => {
  console.error("tail failed:", err instanceof Error ? err.name : "unknown");
  process.exit(1);
});
