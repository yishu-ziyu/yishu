#!/usr/bin/env node
/**
 * Follow-up: cli-proxy 8317 auth retry + MiniMax fast-tier / thinking-off.
 * Secrets stay in process.env. Never printed.
 *
 *   node evals/voice/exp1-gateway/retry.mjs
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  recommendation,
  rowRecord,
  runSuite,
  sanitize,
  summarize,
  timedChatWithRetry,
  urlFacts,
} from "./run.mjs";

const CLI_PROXY_CONFIG = join(homedir(), ".cli-proxy-api", "config.yaml");
const CLI_PROXY_AUTH_DIR = join(homedir(), ".cli-proxy-api", "auths");
const MINIMAX_MODELS_URL = "https://api.minimaxi.com/v1/models";

function loadCliProxyApiKeys(configPath) {
  const tried = { path: configPath, exists: existsSync(configPath), field: "api-keys", count: 0 };
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
        const inline = line.replace(/^api-keys\s*:\s*/, "").trim();
        if (inline && inline !== "|" && inline !== ">") {
          keys.push(inline.replace(/^["']|["']$/g, ""));
        }
      }
      continue;
    }
    const i = (line.match(/^\s*/) || [""])[0].length;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (i <= indent && /[A-Za-z]/.test(line[i] || "")) break;
    if (trimmed.startsWith("-")) {
      const val = trimmed.slice(1).trim();
      const mapped = val.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
      if (mapped && /key|token|secret/i.test(mapped[1])) {
        const v = mapped[2].replace(/^["']|["']$/g, "");
        if (v) keys.push(v);
      } else {
        const v = val.replace(/^["']|["']$/g, "");
        if (v) keys.push(v);
      }
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
    .map((name) => name.replace(/\.json$/, "").split("-")[0])
    .filter(Boolean);
}

function isChatModelId(id) {
  const s = String(id || "");
  if (!s) return false;
  if (/(tts|t2a|speech|whisper|embed|image|video|dall|audio|asr|voice|rerank)/i.test(s)) {
    return false;
  }
  return true;
}

function hasFastOrMiniToken(id) {
  // Token match only: do not treat "gemini" as "mini".
  return /(?:^|[-_.])(?:fast|mini)(?:[-_.]|$)/.test(String(id || "").toLowerCase());
}

function isFullGatewaySuite(id) {
  const s = String(id || "").toLowerCase();
  return s === "grok-4.6" || hasFastOrMiniToken(s) || /^gpt-5/.test(s);
}

function gatewaySuiteRank(id) {
  const s = String(id || "").toLowerCase();
  if (s === "grok-4.6") return 0;
  if (hasFastOrMiniToken(s)) return 1;
  if (/^gpt-5/.test(s)) return 2;
  return 3;
}

async function listModels(url, headers) {
  const started = Date.now();
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
      const data = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed) ? parsed : [];
      ids = data
        .map((item) => (typeof item === "string" ? item : item?.id || item?.name))
        .filter((id) => typeof id === "string" && id.length > 0);
    } catch {
      ids = [];
    }
    return {
      http_status: res.status,
      ids,
      elapsed_ms: Date.now() - started,
      note: res.ok ? null : `unreachable: ${res.status}; ${sanitize(text)}`,
    };
  } catch (err) {
    const code = err?.cause?.code || err?.name || "fetch-failed";
    return {
      http_status: 0,
      ids: [],
      elapsed_ms: Date.now() - started,
      note: `unreachable: ${code}`,
    };
  }
}

function authHeaders(style, key) {
  if (style === "none") return {};
  if (style === "bearer") return { Authorization: `Bearer ${key}` };
  if (style === "x-api-key") return { "x-api-key": key };
  return { Authorization: `Bearer ${key}` };
}

async function probeGatewayAuth(proxyKey, chatKey) {
  const attempts = [];
  const styles = [];
  if (proxyKey) {
    styles.push({ name: "bearer-cli-proxy-api-keys", style: "bearer", key: proxyKey });
    styles.push({ name: "x-api-key-cli-proxy-api-keys", style: "x-api-key", key: proxyKey });
  }
  styles.push({ name: "none", style: "none", key: "" });
  if (chatKey) styles.push({ name: "bearer-CHAT_API_KEY", style: "bearer", key: chatKey });

  let winner = null;
  for (const item of styles) {
    const listed = await listModels(`${GATEWAY_BASE}/models`, authHeaders(item.style, item.key));
    const row = {
      name: item.name,
      http_status: listed.http_status,
      model_count: listed.ids.length,
      note: listed.note,
    };
    attempts.push(row);
    console.log(
      `[auth] ${item.name} status=${listed.http_status} models=${listed.ids.length}${listed.note ? ` note=${listed.note}` : ""}`
    );
    if (listed.http_status === 200 && listed.ids.length && !winner) {
      winner = { ...item, ids: listed.ids };
    }
  }
  return { attempts, winner };
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

function pickRealtime(summaries) {
  const shortOk = summaries.filter(
    (s) => s.prompt_size === "short" && s.n_ok > 0 && s.t_first_token_p50_ms != null
  );
  const under600 = shortOk.filter((s) => s.t_first_token_p50_ms <= 600);
  const under1000 = shortOk.filter((s) => s.t_first_token_p50_ms <= 1000);
  const best = [...shortOk].sort((a, b) => a.t_first_token_p50_ms - b.t_first_token_p50_ms)[0];
  return { shortOk, under600, under1000, best };
}

function followupRecommendation(allSummaries, facts) {
  const { shortOk, under600, under1000, best } = pickRealtime(allSummaries);
  const gwOk = shortOk.filter((s) => s.route === "gateway-8317");
  const mmOk = shortOk.filter((s) => String(s.route).startsWith("direct-minimax"));
  if (!best) {
    return "Still no successful short-prompt first-token. Do not change the 实时对话 default.";
  }
  const bestLabel = `${best.route} / ${best.model}${best.variant ? ` (${best.variant})` : ""}`;
  const budget =
    under600.length > 0
      ? `${under600
          .map((s) => `${s.model}${s.variant ? `/${s.variant}` : ""} p50 ${s.t_first_token_p50_ms}`)
          .join("; ")} can hit first-token ≤600 ms p50.`
      : under1000.length > 0
        ? `No exit hit ≤600 ms p50. Closest under 1.0 s: ${under1000
            .map((s) => `${s.model}${s.variant ? `/${s.variant}` : ""} p50 ${s.t_first_token_p50_ms}`)
            .join("; ")}.`
        : `No exit hit ≤600 ms or ≤1.0 s p50. Fastest is ${bestLabel} at ${best.t_first_token_p50_ms} ms.`;
  const gwBit = facts.gateway_auth_ok
    ? ` Gateway auth works via ${facts.gateway_auth_style} (api-keys field, key len ${facts.cli_proxy_key_len}). ${gwOk.length} gateway short suites succeeded.`
    : ` Gateway still unauthorized after loading ~/.cli-proxy-api/config.yaml api-keys (count=${facts.cli_proxy_key_count}, lens=${(facts.cli_proxy_key_lens || []).join(",")}); tried ${facts.auth_styles_tried}.`;
  const toggle = facts.gateway_auth_ok
    ? " Expose 网关/直连: 8317 can serve a different model set than MiniMax direct; pick the measured fastest for 实时对话 and leave the other as a toggle."
    : " Do not expose the gateway as a live choice until a request from this harness is 200.";
  return `For 实时对话, prefer ${bestLabel} (short first-token p50 ${best.t_first_token_p50_ms} ms, p95 ${best.t_first_token_p95_ms} ms). ${budget}${gwBit}${toggle}`;
}

function renderAppendedMarkdown({ facts, gwSummaries, mmSummaries, rec }) {
  return `
## gateway-8317 (retry)

Config: \`${facts.config_path}\` (exists=${facts.config_exists}). Client auth field: \`api-keys\` (YAML list, count=${facts.cli_proxy_key_count}, lengths=${(facts.cli_proxy_key_lens || []).join(",") || "n/a"}). Upstream OAuth files in auth-dir prefixes: ${facts.auth_dir_providers.join(", ") || "(none)"}. \`ws-auth\` is true in config; HTTP still used Bearer/x-api-key/none probes below.

Auth probes (GET /v1/models):
${facts.auth_attempts
  .map((a) => `- ${a.name}: status=${a.http_status} models=${a.model_count}${a.note ? ` ${sanitize(a.note)}` : ""}`)
  .join("\n")}

Working style: ${facts.gateway_auth_style || "none"}. Listed models: ${facts.gateway_models.join(", ") || "(none)"}.

${mdTable(gwSummaries)}

## minimax fast tier

GET ${MINIMAX_MODELS_URL} status=${facts.minimax_models_status} chat ids: ${facts.minimax_chat_models.join(", ") || "(none)"}.
Docs (platform.minimax.io): MiniMax-M3 thinking is on by default; \`thinking: { type: "disabled" }\` skips reasoning. Also probed \`reasoning_effort: "low"\` and \`max_tokens: 30\`.

${mdTable(mmSummaries)}

## Recommendation (after retry)

${rec}
`;
}

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(SCRATCH_DIR, { recursive: true });
  applyEnv(loadDevVars(DEV_VARS));

  const { keys: proxyKeys, tried } = loadCliProxyApiKeys(CLI_PROXY_CONFIG);
  if (proxyKeys[0]) process.env.CLI_PROXY_API_KEY = proxyKeys[0];
  console.log("cli-proxy config", tried.path, "exists", tried.exists, "api-keys count", tried.count, "lens", tried.lengths || []);
  console.log("auth-dir providers", authDirProviders(CLI_PROXY_AUTH_DIR).join(", ") || "(none)");
  console.log("CHAT_BASE", urlFacts(process.env.CHAT_BASE));
  console.log("key lengths", Object.fromEntries(KEY_NAMES.concat(["CLI_PROXY_API_KEY"]).map((n) => [n, keyLen(n)])));

  const facts = {
    config_path: CLI_PROXY_CONFIG,
    config_exists: tried.exists,
    cli_proxy_key_count: tried.count,
    cli_proxy_key_lens: tried.lengths || [],
    cli_proxy_key_len: proxyKeys[0] ? proxyKeys[0].length : 0,
    auth_dir_providers: authDirProviders(CLI_PROXY_AUTH_DIR),
    listening: listenSnapshot(),
    auth_attempts: [],
    auth_styles_tried: "",
    gateway_auth_ok: false,
    gateway_auth_style: null,
    gateway_models: [],
    minimax_models_status: 0,
    minimax_chat_models: [],
  };

  const scratchPath = join(SCRATCH_DIR, `${RESULT_STEM}.retry.partial.json`);
  const rows = [];

  const auth = await probeGatewayAuth(proxyKeys[0] || "", process.env.CHAT_API_KEY || "");
  facts.auth_attempts = auth.attempts;
  facts.auth_styles_tried = auth.attempts.map((a) => `${a.name}:${a.http_status}`).join(", ");

  if (auth.winner) {
    facts.gateway_auth_ok = true;
    facts.gateway_auth_style = auth.winner.name;
    facts.gateway_models = auth.winner.ids.filter(isChatModelId);
    const extraHeaders =
      auth.winner.style === "x-api-key" ? { "x-api-key": auth.winner.key } : undefined;
    const authKey = auth.winner.style === "none" ? "" : auth.winner.key;
    const models = [...facts.gateway_models].sort(
      (a, b) => gatewaySuiteRank(a) - gatewaySuiteRank(b) || a.localeCompare(b)
    );
    const full = models.filter(isFullGatewaySuite);
    const probeOnly = models.filter((id) => !isFullGatewaySuite(id));
    console.log("[gateway] full suite", full.join(", "));
    console.log("[gateway] one-shot probe", probeOnly.join(", "));
    for (const model of full) {
      let skipLong = false;
      for (const promptSize of ["short", "long"]) {
        if (skipLong) break;
        const early = await runSuite({
          section: "gateway-8317-retry",
          route: "gateway-8317",
          url: GATEWAY_CHAT_URL,
          apiKey: authKey,
          model,
          promptSize,
          extraHeaders,
          rows,
          scratchPath,
        });
        if (early && (isHardUnreachable(early) || isModelRejected(early))) skipLong = true;
      }
    }
    for (const model of probeOnly) {
      console.log(`[probe] gateway-8317 model=${model}`);
      const metrics = await timedChatWithRetry({
        url: GATEWAY_CHAT_URL,
        apiKey: authKey,
        model,
        system: "你是奕枢，一个说话简短的朋友。",
        extraHeaders,
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
      writeFileSync(
        scratchPath,
        JSON.stringify({ updated: new Date().toISOString(), rows }, null, 2)
      );
      console.log(
        `  probe status=${metrics.http_status} t_first_token=${metrics.t_first_token_ms ?? "n/a"} t_done=${metrics.t_done_ms ?? "n/a"}${metrics.note ? ` note=${metrics.note}` : ""}`
      );
    }
  } else {
    rows.push(
      rowRecord(
        {
          section: "gateway-8317-retry",
          route: "gateway-8317",
          model: "(auth)",
          prompt_size: "short",
          run_index: 1,
        },
        {
          ok: false,
          http_status: auth.attempts[0]?.http_status ?? 0,
          t_connect_ms: null,
          t_first_sse_ms: null,
          t_first_token_ms: null,
          t_done_ms: null,
          output_tokens: null,
          note: `no working gateway auth; tried ${facts.auth_styles_tried}`,
        }
      )
    );
  }

  const minimaxKey = process.env.MINIMAX_API_KEY || "";
  const listed = await listModels(MINIMAX_MODELS_URL, {
    Authorization: `Bearer ${minimaxKey}`,
  });
  facts.minimax_models_status = listed.http_status;
  const chatModels = listed.ids.filter(isChatModelId);
  facts.minimax_chat_models = chatModels;
  console.log("[minimax] GET /v1/models", listed.http_status, chatModels.join(", ") || listed.note || "(none)");

  if (!minimaxKey) {
    rows.push(
      rowRecord(
        {
          section: "minimax-fast-tier",
          route: "direct-minimax",
          model: "(none)",
          prompt_size: "short",
          run_index: 1,
        },
        {
          ok: false,
          http_status: 0,
          t_connect_ms: null,
          t_first_sse_ms: null,
          t_first_token_ms: null,
          t_done_ms: null,
          output_tokens: null,
          note: "unreachable: MINIMAX_API_KEY missing",
        }
      )
    );
  } else if (!chatModels.length) {
    rows.push(
      rowRecord(
        {
          section: "minimax-fast-tier",
          route: "direct-minimax",
          model: "(none)",
          prompt_size: "short",
          run_index: 1,
        },
        {
          ok: false,
          http_status: listed.http_status,
          t_connect_ms: null,
          t_first_sse_ms: null,
          t_first_token_ms: null,
          t_done_ms: null,
          output_tokens: null,
          note: listed.note || "unreachable: no chat models listed",
        }
      )
    );
  } else {
    for (const model of chatModels) {
      const early = await runSuite({
        section: "minimax-fast-tier",
        route: "direct-minimax",
        url: DIRECT_MINIMAX_URL,
        apiKey: minimaxKey,
        model,
        promptSize: "short",
        rows,
        scratchPath,
      });
      if (early && isHardUnreachable(early) && model === chatModels[0]) break;
    }

    const m3Variants = [
      { variant: "thinking-disabled", extraBody: { thinking: { type: "disabled" } }, maxTokens: 60 },
      { variant: "reasoning_effort-low", extraBody: { reasoning_effort: "low" }, maxTokens: 60 },
      { variant: "max_tokens-30", extraBody: {}, maxTokens: 30 },
      {
        variant: "thinking-disabled+max_tokens-30",
        extraBody: { thinking: { type: "disabled" } },
        maxTokens: 30,
      },
    ];
    for (const v of m3Variants) {
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
        scratchPath,
      });
      if (early && isModelRejected(early)) {
        console.log(`[minimax] variant ${v.variant} rejected, recorded`);
      }
    }
  }

  const jsonPath = join(RESULTS_DIR, `${RESULT_STEM}.json`);
  const mdPath = join(RESULTS_DIR, `${RESULT_STEM}.md`);
  let existing = { rows: [], summaries: [], env: {}, recommendation: "" };
  if (existsSync(jsonPath)) {
    try {
      existing = JSON.parse(readFileSync(jsonPath, "utf8"));
    } catch {
      existing = { rows: [], summaries: [], env: {} };
    }
  }

  const retrySummaries = summarize(rows);
  const mergedRows = [...(existing.rows || []), ...rows];
  const mergedSummaries = [...(existing.summaries || []), ...retrySummaries];
  const rec = followupRecommendation(mergedSummaries, facts);
  const payload = {
    ...existing,
    followup_at: new Date().toISOString(),
    followup_env: {
      ...facts,
      key_lengths: Object.fromEntries(KEY_NAMES.concat(["CLI_PROXY_API_KEY"]).map((n) => [n, keyLen(n)])),
      listening: facts.listening,
    },
    followup_rows: rows,
    followup_summaries: retrySummaries,
    rows: mergedRows,
    summaries: mergedSummaries,
    recommendation: rec,
  };
  delete payload.followup_env.auth_attempts;
  payload.followup_env.auth_attempts = facts.auth_attempts.map((a) => ({
    name: a.name,
    http_status: a.http_status,
    model_count: a.model_count,
    note: a.note,
  }));

  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  const prevMd = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
  const stripped = prevMd.replace(/\n## gateway-8317 \(retry\)[\s\S]*$/, "").replace(/\n## Recommendation\n[\s\S]*$/, "\n");
  const gwSummaries = retrySummaries.filter((s) => s.section === "gateway-8317-retry" || s.route === "gateway-8317");
  const mmSummaries = retrySummaries.filter((s) => s.section === "minimax-fast-tier");
  writeFileSync(
    mdPath,
    `${stripped.trim()}\n${renderAppendedMarkdown({ facts, gwSummaries, mmSummaries, rec })}`
  );
  console.log("wrote", jsonPath);
  console.log("wrote", mdPath);
}

main().catch((err) => {
  console.error("retry failed:", err instanceof Error ? err.name : "unknown");
  process.exit(1);
});
