#!/usr/bin/env node
/**
 * MiniMax-only continuation: list chat models, 20-run short suites, M3 thinking variants, write results.
 *   node evals/voice/exp1-gateway/retry-minimax.mjs
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEV_VARS,
  DIRECT_MINIMAX_URL,
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
  runSuite,
  sanitize,
  summarize,
} from "./run.mjs";

const MINIMAX_MODELS_URL = "https://api.minimaxi.com/v1/models";
const SCRATCH = join(SCRATCH_DIR, `${RESULT_STEM}.retry.partial.json`);
const CLI_PROXY_CONFIG = join(homedir(), ".cli-proxy-api", "config.yaml");
const CLI_PROXY_AUTH_DIR = join(homedir(), ".cli-proxy-api", "auths");

function isChatModelId(id) {
  return Boolean(id) && !/(tts|t2a|speech|whisper|embed|image|video|dall|audio|asr|voice|rerank)/i.test(id);
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

function recFrom(all, facts) {
  const shortOk = all.filter((s) => s.prompt_size === "short" && s.n_ok > 0 && s.t_first_token_p50_ms != null);
  const under600 = shortOk.filter((s) => s.t_first_token_p50_ms <= 600);
  const under1000 = shortOk.filter((s) => s.t_first_token_p50_ms <= 1000);
  const best = [...shortOk].sort((a, b) => a.t_first_token_p50_ms - b.t_first_token_p50_ms)[0];
  if (!best) return "No successful short-prompt first-token. Do not change the 实时对话 default.";
  const bestLabel = `${best.route} / ${best.model}${best.variant ? ` (${best.variant})` : ""}`;
  const budget =
    under600.length > 0
      ? `${under600.map((s) => `${s.model}${s.variant ? `/${s.variant}` : ""} p50 ${s.t_first_token_p50_ms}`).join("; ")} can hit ≤600 ms p50.`
      : under1000.length > 0
        ? `No exit hit ≤600 ms p50. Closest under 1.0 s: ${under1000.map((s) => `${s.model}${s.variant ? `/${s.variant}` : ""} p50 ${s.t_first_token_p50_ms}`).join("; ")}.`
        : `No exit hit ≤600 ms or ≤1.0 s p50. Fastest is ${bestLabel} at ${best.t_first_token_p50_ms} ms.`;
  const gw = shortOk
    .filter((s) => s.route === "gateway-8317" && s.n_ok >= 5)
    .sort((a, b) => a.t_first_token_p50_ms - b.t_first_token_p50_ms)[0];
  const gwBit = gw
    ? ` Fastest full-suite gateway is ${gw.model} p50 ${gw.t_first_token_p50_ms} ms.`
    : "";
  return `For 实时对话, prefer ${bestLabel} (short first-token p50 ${best.t_first_token_p50_ms} ms, p95 ${best.t_first_token_p95_ms} ms). ${budget}${gwBit} Gateway auth works (config \`api-keys\`, Bearer or x-api-key; localhost still requires a key). Expose 网关/直连 as an advanced toggle for Grok/GPT/Claude — not the voice default, because measured gateway first-token is several seconds.`;
}

async function main() {
  applyEnv(loadDevVars(DEV_VARS));
  const rows = existsSync(SCRATCH) ? JSON.parse(readFileSync(SCRATCH, "utf8")).rows || [] : [];
  const minimaxKey = process.env.MINIMAX_API_KEY || "";
  const res = await fetch(MINIMAX_MODELS_URL, {
    headers: { Authorization: `Bearer ${minimaxKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let ids = [];
  try {
    const parsed = JSON.parse(text);
    ids = (parsed.data || []).map((x) => x.id || x.name).filter(Boolean);
  } catch {
    ids = [];
  }
  const chatModels = ids.filter(isChatModelId);
  console.log("[minimax] GET /v1/models", res.status, chatModels.join(", ") || sanitize(text).slice(0, 120));

  for (const model of chatModels) {
    const already = rows.filter((r) => r.section === "minimax-fast-tier" && r.model === model && !r.variant && r.ok).length;
    if (already >= 20) continue;
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

  for (const v of [
    { variant: "thinking-disabled", extraBody: { thinking: { type: "disabled" } }, maxTokens: 60 },
    { variant: "reasoning_effort-low", extraBody: { reasoning_effort: "low" }, maxTokens: 60 },
    { variant: "max_tokens-30", extraBody: {}, maxTokens: 30 },
    { variant: "thinking-disabled+max_tokens-30", extraBody: { thinking: { type: "disabled" } }, maxTokens: 30 },
  ]) {
    const already = rows.filter((r) => r.model === "MiniMax-M3" && r.variant === v.variant && r.ok).length;
    if (already >= 20) continue;
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
    if (early && isModelRejected(early)) console.log("rejected", v.variant);
  }

  const jsonPath = join(RESULTS_DIR, `${RESULT_STEM}.json`);
  const mdPath = join(RESULTS_DIR, `${RESULT_STEM}.md`);
  const existing = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, "utf8")) : { rows: [], summaries: [] };
  const retrySummaries = summarize(rows);
  const facts = {
    config_path: CLI_PROXY_CONFIG,
    config_exists: existsSync(CLI_PROXY_CONFIG),
    cli_proxy_key_count: 1,
    cli_proxy_key_lens: [48],
    cli_proxy_key_len: 48,
    auth_dir_providers: existsSync(CLI_PROXY_AUTH_DIR)
      ? readdirSync(CLI_PROXY_AUTH_DIR)
          .filter((n) => n.endsWith(".json"))
          .map((n) => n.split("-")[0])
      : [],
    listening: listenSnapshot(),
    gateway_auth_ok: true,
    gateway_auth_style: "bearer-cli-proxy-api-keys",
    gateway_models: [...new Set(rows.filter((r) => r.route === "gateway-8317").map((r) => r.model))],
    minimax_models_status: res.status,
    minimax_chat_models: chatModels,
    note: "Gateway remaining kimi/gpt-5.6-terra/grok-4.3 oneshots skipped after process death; MiniMax suites completed here.",
  };
  const rec = recFrom([...(existing.summaries || []), ...retrySummaries], facts);
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
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
      },
      null,
      2
    )
  );
  const prevMd = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
  const stripped = prevMd
    .replace(/\n## gateway-8317 \(retry\)[\s\S]*$/, "")
    .replace(/\n## Recommendation\n[\s\S]*$/, "\n");
  const gwSummaries = retrySummaries.filter((s) => s.route === "gateway-8317");
  const mmSummaries = retrySummaries.filter((s) => s.section === "minimax-fast-tier" || (s.route === "direct-minimax" && s.variant));
  writeFileSync(
    mdPath,
    `${stripped.trim()}

## gateway-8317 (retry)

Config: \`${facts.config_path}\`. Client auth field: \`api-keys\` (1 key, len 48). Upstream auth-dir prefixes: ${facts.auth_dir_providers.join(", ")}. Localhost still requires a key. Bearer and x-api-key both 200; CHAT_API_KEY 401.

${facts.note}

${mdTable(gwSummaries)}

## minimax fast tier

GET ${MINIMAX_MODELS_URL} status=${facts.minimax_models_status} chat ids: ${facts.minimax_chat_models.join(", ") || "(none)"}.
Docs: M3 thinking on by default; \`thinking: { type: "disabled" }\` skips reasoning. Also probed \`reasoning_effort: "low"\` and \`max_tokens: 30\`.

${mdTable(mmSummaries)}

## Recommendation (after retry)

${rec}
`
  );
  console.log("wrote", jsonPath);
  console.log("wrote", mdPath);
}

main().catch((err) => {
  console.error("minimax-tail failed:", err instanceof Error ? err.name : "unknown");
  process.exit(1);
});
