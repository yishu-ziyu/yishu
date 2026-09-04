#!/usr/bin/env node
/**
 * Chat-completion latency: MiniMax direct vs 8317 gateway vs 8787 app proxy vs StepFun.
 * Secrets are loaded from apps/clicky/worker/.dev.vars into process.env and never printed.
 *
 *   node evals/voice/exp1-gateway/run.mjs
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../..");
const DEV_VARS = join(ROOT, "apps/clicky/worker/.dev.vars");
const RESULTS_DIR = join(ROOT, "evals/voice/results");
const SCRATCH_DIR = join(ROOT, ".work/voice-experiments");
const RESULT_STEM = "2026-09-04-exp1-gateway-vs-direct";
const SHORT_RUNS = 20;
const LONG_RUNS = 5;
const GAP_MS = 500;
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 120_000;
const SYSTEM_SHORT = "你是奕枢，一个说话简短的朋友。";
const USER_PROMPT = "用一句话说今天适合做什么。";
const LONG_TARGET_CHARS = 4000;
const DIRECT_MINIMAX_URL = "https://api.minimaxi.com/v1/chat/completions";
const GATEWAY_BASE = "http://127.0.0.1:8317/v1";
const GATEWAY_CHAT_URL = `${GATEWAY_BASE}/chat/completions`;
const APP_PROXY_URL = "http://127.0.0.1:8787/v1/chat/completions";
const GROK_CANDIDATES = ["grok-4.6", "grok-4.5", "grok-4.3"];
const KEY_NAMES = [
  "MINIMAX_API_KEY",
  "MINIMAX_TTS_MODEL",
  "MINIMAX_VOICE_ID",
  "MINIMAX_TTS_URL",
  "STEPFUN_API_KEY",
  "STEPFUN_ASR_MODEL",
  "STEPFUN_CHAT_BASE",
  "STEPFUN_CHAT_MODEL",
  "CHAT_API_KEY",
  "CHAT_BASE",
  "CHAT_MODEL",
  "YISHU_VOICE_PROXY_TOKEN",
];

function loadDevVars(path) {
  const env = {};
  if (!existsSync(path)) return env;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function applyEnv(parsed) {
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] == null || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

function keyLen(name) {
  const v = process.env[name];
  return typeof v === "string" && v.length > 0 ? v.length : 0;
}

function urlFacts(raw) {
  if (!raw) return { host: null, port: null, protocol: null, pathname: null };
  try {
    const u = new URL(raw.includes("://") ? raw : `https://${raw}`);
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return { host: u.hostname, port, protocol: u.protocol.replace(":", ""), pathname: u.pathname };
  } catch {
    return { host: "unparseable", port: null, protocol: null, pathname: null };
  }
}

function joinChatUrl(base) {
  const trimmed = String(base || "").replace(/\/$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function padSystem(targetChars) {
  const filler =
    "屏幕上下文是普通的桌面工作场景，没有紧急事项，也没有需要立刻处理的通知。请结合当前情境给出一句简短建议。";
  let s = SYSTEM_SHORT;
  while ([...s].length < targetChars) s += filler;
  return [...s].slice(0, targetChars).join("");
}

function sanitize(text) {
  if (!text) return "";
  return String(text)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_\-]{8,}/g, "sk-[redacted]")
    .replace(/[A-Za-z0-9_\-+/=]{40,}/g, "[redacted]")
    .slice(0, 400);
}

function percentile(values, p) {
  const xs = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const i = (p / 100) * (xs.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return round1(xs[lo]);
  return round1(xs[lo] + (xs[hi] - xs[lo]) * (i - lo));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function extractContent(obj) {
  if (!obj || typeof obj !== "object") return "";
  const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
  const delta = choice?.delta || choice?.message || {};
  const candidates = [
    delta.content,
    choice?.text,
    obj.output_text,
    obj.text,
    obj.data?.content,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
    if (Array.isArray(c)) {
      const joined = c
        .map((part) =>
          typeof part === "string" ? part : part && typeof part.text === "string" ? part.text : ""
        )
        .join("");
      if (joined) return joined;
    }
  }
  return "";
}

function extractUsageTokens(obj) {
  const usage = obj?.usage || obj?.choices?.[0]?.usage;
  if (!usage || typeof usage !== "object") return null;
  const n = usage.completion_tokens ?? usage.output_tokens ?? usage.completion_tokens_total;
  return Number.isFinite(Number(n)) ? Number(n) : null;
}

function suggestedMinimaxModels(errorText) {
  const found = String(errorText || "").match(/MiniMax[-A-Za-z0-9.]+/g) || [];
  const extra = [];
  if (/m2\.5/i.test(errorText) && !found.includes("MiniMax-M2.5")) extra.push("MiniMax-M2.5");
  if (/m2\b/i.test(errorText) && !found.includes("MiniMax-M2")) extra.push("MiniMax-M2");
  return [...new Set([...found, ...extra, "MiniMax-M2.5"])].filter((m) => m !== "MiniMax-M3");
}

function isModelRejected(row) {
  if (row.ok) return false;
  const status = row.http_status;
  if (status !== 400 && status !== 404 && status !== 422) return false;
  const note = `${row.note || ""}`.toLowerCase();
  return /model|not found|invalid|unknown|unsupported|does not exist|不存在|不可用/.test(note);
}

function isHardUnreachable(row) {
  if (row.ok) return false;
  const status = row.http_status;
  return (
    status === 401 ||
    status === 403 ||
    status === 0 ||
    (typeof row.note === "string" && row.note.startsWith("unreachable:"))
  );
}

function listenSnapshot() {
  try {
    return execSync("lsof -nP -iTCP:8317 -iTCP:8787 -sTCP:LISTEN", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const extra = err && typeof err.stdout === "string" ? err.stdout.trim() : "";
    return extra || "none";
  }
}

async function listGatewayModels(apiKey) {
  const started = performance.now();
  try {
    const res = await fetch(`${GATEWAY_BASE}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
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
      elapsed_ms: round1(performance.now() - started),
      note: res.ok ? null : `unreachable: ${res.status}`,
    };
  } catch (err) {
    const code = err?.cause?.code || err?.name || "fetch-failed";
    return {
      http_status: 0,
      ids: [],
      elapsed_ms: round1(performance.now() - started),
      note: `unreachable: ${code}`,
    };
  }
}

const noUsageUrls = new Set();

async function timedChat({ url, apiKey, model, system, user, extraHeaders, includeUsage, extraBody, maxTokens }) {
  if (includeUsage == null) includeUsage = !noUsageUrls.has(url);
  const t0 = performance.now();
  const payload = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user || USER_PROMPT },
    ],
    max_tokens: maxTokens ?? 60,
    stream: true,
    ...(extraBody && typeof extraBody === "object" ? extraBody : {}),
  };
  if (includeUsage) payload.stream_options = { include_usage: true };
  const body = JSON.stringify(payload);
  const headers = {
    "content-type": "application/json",
    Accept: "text/event-stream",
    ...(extraHeaders || {}),
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const code = err?.cause?.code || err?.name || "fetch-failed";
    return {
      ok: false,
      http_status: 0,
      t_connect_ms: round1(performance.now() - t0),
      t_first_sse_ms: null,
      t_first_token_ms: null,
      t_done_ms: round1(performance.now() - t0),
      output_tokens: null,
      note: `unreachable: ${code}`,
    };
  }

  const tConnect = round1(performance.now() - t0);
  const status = res.status;
  if (!res.ok) {
    let errText = "";
    try {
      errText = await res.text();
    } catch {
      errText = "";
    }
    if (includeUsage && status === 400 && /stream_options/i.test(errText)) {
      noUsageUrls.add(url);
      return timedChat({
        url,
        apiKey,
        model,
        system,
        extraHeaders,
        includeUsage: false,
        extraBody,
        maxTokens,
      });
    }
    return {
      ok: false,
      http_status: status,
      t_connect_ms: tConnect,
      t_first_sse_ms: null,
      t_first_token_ms: null,
      t_done_ms: round1(performance.now() - t0),
      output_tokens: null,
      note: `unreachable: ${status}` + (errText ? `; ${sanitize(errText)}` : ""),
    };
  }

  let tFirstSse = null;
  let tFirstToken = null;
  let outputTokens = null;
  if (!res.body) {
    return {
      ok: false,
      http_status: status,
      t_connect_ms: tConnect,
      t_first_sse_ms: null,
      t_first_token_ms: null,
      t_done_ms: round1(performance.now() - t0),
      output_tokens: null,
      note: "empty-body",
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = buf.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        if (tFirstSse == null) tFirstSse = round1(performance.now() - t0);
        const payload = line.startsWith("data:")
          ? line.slice(5).trim()
          : line.startsWith("{")
            ? line.trim()
            : "";
        if (!payload || payload === "[DONE]") continue;
        try {
          const event = JSON.parse(payload);
          const tokens = extractUsageTokens(event);
          if (tokens != null) outputTokens = tokens;
          const delta = extractContent(event);
          if (delta && tFirstToken == null) tFirstToken = round1(performance.now() - t0);
        } catch {
          // non-JSON SSE comment / keep-alive
        }
      }
    }
    if (buf.trim()) {
      if (tFirstSse == null) tFirstSse = round1(performance.now() - t0);
      const payload = buf.startsWith("data:") ? buf.slice(5).trim() : "";
      if (payload && payload !== "[DONE]") {
        try {
          const event = JSON.parse(payload);
          const tokens = extractUsageTokens(event);
          if (tokens != null) outputTokens = tokens;
          const delta = extractContent(event);
          if (delta && tFirstToken == null) tFirstToken = round1(performance.now() - t0);
        } catch {
          // ignore
        }
      }
    }
  } catch (err) {
    const code = err?.name || "stream-failed";
    return {
      ok: false,
      http_status: status,
      t_connect_ms: tConnect,
      t_first_sse_ms: tFirstSse,
      t_first_token_ms: tFirstToken,
      t_done_ms: round1(performance.now() - t0),
      output_tokens: outputTokens,
      note: `unreachable: ${code}`,
    };
  }

  return {
    ok: tFirstToken != null,
    http_status: status,
    t_connect_ms: tConnect,
    t_first_sse_ms: tFirstSse,
    t_first_token_ms: tFirstToken,
    t_done_ms: round1(performance.now() - t0),
    output_tokens: outputTokens,
    note: tFirstToken == null ? "no-content-delta" : null,
  };
}

async function timedChatWithRetry(opts) {
  let last = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    last = await timedChat(opts);
    last.attempts = attempt + 1;
    if (last.ok) return last;
    if (isModelRejected(last)) return last;
    if (attempt < MAX_RETRIES) await sleep(GAP_MS);
  }
  return last;
}

function rowRecord(base, metrics) {
  return {
    section: base.section || null,
    route: base.route,
    model: base.model,
    variant: base.variant || null,
    prompt_size: base.prompt_size,
    run_index: base.run_index,
    t_connect_ms: metrics.t_connect_ms,
    t_first_sse_ms: metrics.t_first_sse_ms,
    t_first_token_ms: metrics.t_first_token_ms,
    t_done_ms: metrics.t_done_ms,
    output_tokens: metrics.output_tokens,
    http_status: metrics.http_status,
    ok: Boolean(metrics.ok),
    attempts: metrics.attempts ?? 1,
    note: metrics.note || null,
  };
}

async function runSuite({
  route,
  url,
  apiKey,
  model,
  promptSize,
  extraHeaders,
  rows,
  scratchPath,
  variant = null,
  section = null,
  extraBody,
  maxTokens,
}) {
  const n = promptSize === "long" ? LONG_RUNS : SHORT_RUNS;
  const system = promptSize === "long" ? padSystem(LONG_TARGET_CHARS) : SYSTEM_SHORT;
  console.log(
    `[run] ${route} model=${model}${variant ? ` variant=${variant}` : ""} prompt=${promptSize} n=${n}`
  );
  for (let i = 0; i < n; i++) {
    const metrics = await timedChatWithRetry({
      url,
      apiKey,
      model,
      system,
      extraHeaders,
      extraBody,
      maxTokens,
    });
    const rec = rowRecord(
      { section, route, model, variant, prompt_size: promptSize, run_index: i + 1 },
      metrics
    );
    rows.push(rec);
    writeFileSync(scratchPath, JSON.stringify({ updated: new Date().toISOString(), rows }, null, 2));
    const token = rec.t_first_token_ms ?? "n/a";
    const done = rec.t_done_ms ?? "n/a";
    console.log(
      `  #${i + 1}/${n} status=${rec.http_status} t_first_token=${token} t_done=${done}${rec.note ? ` note=${rec.note}` : ""}`
    );
    if (i === 0 && (isHardUnreachable(rec) || isModelRejected(rec))) {
      return rec;
    }
    if (i < n - 1) await sleep(GAP_MS);
  }
  return null;
}

function summarize(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.section || ""}\t${row.route}\t${row.model}\t${row.variant || ""}\t${row.prompt_size}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const out = [];
  for (const [key, group] of groups) {
    const [section, route, model, variant, prompt_size] = key.split("\t");
    const ok = group.filter((r) => r.ok);
    const failNote = group.find((r) => r.note)?.note || null;
    out.push({
      section: section || null,
      route,
      model,
      variant: variant || null,
      prompt_size,
      n: group.length,
      n_ok: ok.length,
      t_first_token_p50_ms: percentile(ok.map((r) => r.t_first_token_ms), 50),
      t_first_token_p95_ms: percentile(ok.map((r) => r.t_first_token_ms), 95),
      t_done_p50_ms: percentile(ok.map((r) => r.t_done_ms), 50),
      t_done_p95_ms: percentile(ok.map((r) => r.t_done_ms), 95),
      note: ok.length ? null : failNote,
    });
  }
  return out;
}

function recommendation(summaries, envFacts) {
  const shortOk = summaries.filter((s) => s.prompt_size === "short" && s.n_ok > 0 && s.t_first_token_p50_ms != null);
  const longOk = summaries.filter((s) => s.prompt_size === "long" && s.n_ok > 0 && s.route === "direct-minimax");
  const gatewayFail = summaries.filter((s) => s.route === "gateway-8317" && s.n_ok === 0);
  const gateway401 = gatewayFail.some((s) => /unreachable: 401/.test(s.note || ""));
  const gatewayListening = /:8317/.test(envFacts?.listening || "");
  const stepfun = summaries.find((s) => s.route === "stepfun");
  const app = summaries.find((s) => s.route === "app-proxy-8787");
  if (!shortOk.length) {
    return "No successful short-prompt runs. Do not change the 实时对话 default until a route answers. Re-check that 8317 is listening and that MiniMax/StepFun keys still authorize /chat/completions.";
  }
  const best = [...shortOk].sort((a, b) => a.t_first_token_p50_ms - b.t_first_token_p50_ms)[0];
  const long = longOk[0];
  const longBit = long
    ? ` Long (~4000-char system) first-token p50 ${long.t_first_token_p50_ms} ms / p95 ${long.t_first_token_p95_ms} ms.`
    : "";
  const gatewayBit = gateway401
    ? ` 8317 ${gatewayListening ? "is listening" : "was probed"} but CHAT_API_KEY returns 401 on /v1/models and on MiniMax-M3 plus grok-4.6/4.5/4.3 chat, so Grok latency is unknown and the gateway must not be the default until a valid cli-proxy key is configured.`
    : "";
  const stepBit =
    stepfun && stepfun.n_ok
      ? ` StepFun short first-token p50 ${stepfun.t_first_token_p50_ms} ms.`
      : stepfun?.note
        ? ` StepFun: ${sanitize(stepfun.note)}.`
        : "";
  const appBit = app?.note ? ` 8787: ${app.note}.` : "";
  const toggleBit = gateway401
    ? " A 网关 / 直连 toggle is worth shipping as an advanced control for when 8317 auth works; it is not a choice between two measured live paths today."
    : " A 网关 / 直连 toggle is worth exposing if first-token p50 differs by ≥150 ms or the gateway uniquely serves Grok.";
  return `For 实时对话, default to ${best.route} / ${best.model} (short first-token p50 ${best.t_first_token_p50_ms} ms, p95 ${best.t_first_token_p95_ms} ms).${longBit}${gatewayBit}${stepBit}${appBit}${toggleBit}`;
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

function renderMarkdown({ envFacts, summaries, rec }) {
  return `# Exp1: gateway vs direct chat latency

Date: 2026-09-04
Runner: \`node evals/voice/exp1-gateway/run.mjs\` (Node ${process.version})

## Method

OpenAI-compatible \`POST /chat/completions\` with \`stream: true\`, \`max_tokens: 60\`.
System: 「你是奕枢，一个说话简短的朋友。」 User: 「用一句话说今天适合做什么。」
Short = 20 sequential runs, 500 ms apart. Long = same user prompt, system padded to ~4000 Chinese characters, 5 runs.
Timers start at request send: t_connect = response headers, t_first_sse = first SSE line, t_first_token = first non-empty content delta, t_done = stream end.
Retries: at most twice per run. Unreachable or unauthorized routes are one result row, then skipped.

## Environment

- CHAT_BASE host=${envFacts.chat_base.host} port=${envFacts.chat_base.port} path=${envFacts.chat_base.pathname}
- CHAT_MODEL=${envFacts.chat_model}
- STEPFUN_CHAT_BASE host=${envFacts.stepfun_chat_base.host} port=${envFacts.stepfun_chat_base.port}
- STEPFUN_CHAT_MODEL=${envFacts.stepfun_chat_model}
- Key lengths: ${Object.entries(envFacts.key_lengths)
    .map(([k, n]) => `${k}=${n}`)
    .join(", ")}
- Gateway GET /v1/models status=${envFacts.gateway_models.http_status} ids=${envFacts.gateway_models.ids.join(", ") || "(none)"} note=${envFacts.gateway_models.note || ""}
- MiniMax direct accepted model: ${envFacts.minimax_direct_model || "(none)"}
- App proxy 8787: ${envFacts.app_proxy_note}
- Listening (\`lsof -nP -iTCP:8317 -iTCP:8787 -sTCP:LISTEN\`):

\`\`\`
${envFacts.listening}
\`\`\`

## p50 / p95

${mdTable(summaries)}

## Caveats

- First-token is spoken-content delta only, not reasoning.
- \`stream_options.include_usage\` is requested; output token counts are missing when the vendor omits a usage chunk.
- CHAT_BASE in \`.dev.vars\` is the product chat pointer; 8317 is still probed as the cli-proxy exit even when CHAT_BASE is not that host.
- 8787 requires \`YISHU_VOICE_PROXY_TOKEN\` from the running app process, not from \`.dev.vars\`. This harness does not read another process's memory.
- Sample size is small (20 / 5). p95 is noisy.
- Sequential runs on a live laptop: local CPU, network, and gateway load are not isolated.

## Recommendation

${rec}
`;
}

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(SCRATCH_DIR, { recursive: true });
  const scratchPath = join(SCRATCH_DIR, `${RESULT_STEM}.partial.json`);

  const parsed = loadDevVars(DEV_VARS);
  applyEnv(parsed);

  const envFacts = {
    chat_base: urlFacts(process.env.CHAT_BASE),
    chat_model: process.env.CHAT_MODEL || null,
    stepfun_chat_base: urlFacts(process.env.STEPFUN_CHAT_BASE),
    stepfun_chat_model: process.env.STEPFUN_CHAT_MODEL || null,
    key_lengths: Object.fromEntries(KEY_NAMES.map((name) => [name, keyLen(name)])),
    listening: listenSnapshot(),
    gateway_models: { http_status: 0, ids: [], note: null },
    minimax_direct_model: null,
    app_proxy_note: "needs runtime token; skipped",
  };

  console.log("CHAT_BASE host/port", envFacts.chat_base.host, envFacts.chat_base.port);
  console.log("CHAT_MODEL", envFacts.chat_model);
  console.log("STEPFUN_CHAT_BASE host/port", envFacts.stepfun_chat_base.host, envFacts.stepfun_chat_base.port);
  console.log("STEPFUN_CHAT_MODEL", envFacts.stepfun_chat_model);
  console.log("key lengths", envFacts.key_lengths);
  console.log("listening\n" + envFacts.listening);

  const rows = [];
  const chatKey = process.env.CHAT_API_KEY || "";
  const minimaxKey = process.env.MINIMAX_API_KEY || "";
  const stepfunKey = process.env.STEPFUN_API_KEY || "";
  const chatModel = process.env.CHAT_MODEL || "MiniMax-M3";

  envFacts.gateway_models = await listGatewayModels(chatKey);
  console.log(
    "gateway /v1/models",
    envFacts.gateway_models.http_status,
    envFacts.gateway_models.ids.join(", ") || "(none)",
    envFacts.gateway_models.note || ""
  );

  const gatewayModels = [];
  const pushGateway = (model) => {
    if (model && !gatewayModels.includes(model)) gatewayModels.push(model);
  };
  pushGateway(chatModel);
  for (const grok of GROK_CANDIDATES) pushGateway(grok);
  pushGateway("MiniMax-M3");

  if (minimaxKey) {
    let accepted = null;
    const tryModels = ["MiniMax-M3"];
    for (const model of tryModels) {
      console.log(`[probe] direct-minimax ${model}`);
      const probe = await timedChatWithRetry({
        url: DIRECT_MINIMAX_URL,
        apiKey: minimaxKey,
        model,
        system: SYSTEM_SHORT,
      });
      if (probe.ok) {
        accepted = model;
        break;
      }
      rows.push(
        rowRecord(
          { route: "direct-minimax", model, prompt_size: "short", run_index: 0 },
          { ...probe, note: probe.note || `unreachable: ${probe.http_status}` }
        )
      );
      if (isModelRejected(probe)) {
        for (const suggested of suggestedMinimaxModels(probe.note)) {
          if (!tryModels.includes(suggested)) tryModels.push(suggested);
        }
      } else {
        break;
      }
    }
    envFacts.minimax_direct_model = accepted;
    if (accepted) {
      for (const promptSize of ["short", "long"]) {
        const early = await runSuite({
          route: "direct-minimax",
          url: DIRECT_MINIMAX_URL,
          apiKey: minimaxKey,
          model: accepted,
          promptSize,
          rows,
          scratchPath,
        });
        if (early && isHardUnreachable(early)) break;
      }
    }
  } else {
    rows.push(
      rowRecord(
        { route: "direct-minimax", model: "MiniMax-M3", prompt_size: "short", run_index: 1 },
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
  }

  if (chatKey) {
    for (const model of gatewayModels) {
      let skipLong = false;
      for (const promptSize of ["short", "long"]) {
        if (skipLong) break;
        const early = await runSuite({
          route: "gateway-8317",
          url: GATEWAY_CHAT_URL,
          apiKey: chatKey,
          model,
          promptSize,
          rows,
          scratchPath,
        });
        if (early && (isHardUnreachable(early) || isModelRejected(early))) {
          skipLong = true;
        }
      }
    }
  } else {
    rows.push(
      rowRecord(
        { route: "gateway-8317", model: chatModel, prompt_size: "short", run_index: 1 },
        {
          ok: false,
          http_status: 0,
          t_connect_ms: null,
          t_first_sse_ms: null,
          t_first_token_ms: null,
          t_done_ms: null,
          output_tokens: null,
          note: "unreachable: CHAT_API_KEY missing",
        }
      )
    );
  }

  const appToken = process.env.YISHU_VOICE_PROXY_TOKEN || "";
  if (!appToken) {
    envFacts.app_proxy_note = "needs runtime token; skipped";
    rows.push(
      rowRecord(
        { route: "app-proxy-8787", model: chatModel, prompt_size: "short", run_index: 1 },
        {
          ok: false,
          http_status: 0,
          t_connect_ms: null,
          t_first_sse_ms: null,
          t_first_token_ms: null,
          t_done_ms: null,
          output_tokens: null,
          note: "needs runtime token; skipped",
        }
      )
    );
  } else if (appToken.length < 32) {
    envFacts.app_proxy_note = "needs runtime token; skipped";
    rows.push(
      rowRecord(
        { route: "app-proxy-8787", model: chatModel, prompt_size: "short", run_index: 1 },
        {
          ok: false,
          http_status: 0,
          t_connect_ms: null,
          t_first_sse_ms: null,
          t_first_token_ms: null,
          t_done_ms: null,
          output_tokens: null,
          note: "needs runtime token; skipped",
        }
      )
    );
  } else {
    envFacts.app_proxy_note = "YISHU_VOICE_PROXY_TOKEN present in env; probing";
    for (const promptSize of ["short", "long"]) {
      const early = await runSuite({
        route: "app-proxy-8787",
        url: APP_PROXY_URL,
        apiKey: appToken,
        model: chatModel,
        promptSize,
        rows,
        scratchPath,
      });
      if (early && (isHardUnreachable(early) || isModelRejected(early))) break;
    }
  }

  const stepBase = process.env.STEPFUN_CHAT_BASE;
  const stepModel = process.env.STEPFUN_CHAT_MODEL || "step-3.7-flash";
  if (stepfunKey && stepBase) {
    for (const promptSize of ["short", "long"]) {
      const early = await runSuite({
        route: "stepfun",
        url: joinChatUrl(stepBase),
        apiKey: stepfunKey,
        model: stepModel,
        promptSize,
        rows,
        scratchPath,
      });
      if (early && isHardUnreachable(early)) break;
    }
  } else {
    rows.push(
      rowRecord(
        { route: "stepfun", model: stepModel, prompt_size: "short", run_index: 1 },
        {
          ok: false,
          http_status: 0,
          t_connect_ms: null,
          t_first_sse_ms: null,
          t_first_token_ms: null,
          t_done_ms: null,
          output_tokens: null,
          note: "unreachable: STEPFUN credentials missing",
        }
      )
    );
  }

  const summaries = summarize(rows);
  const rec = recommendation(summaries, envFacts);
  const payload = {
    generated_at: new Date().toISOString(),
    node: process.version,
    env: envFacts,
    rows,
    summaries,
    recommendation: rec,
  };
  const jsonPath = join(RESULTS_DIR, `${RESULT_STEM}.json`);
  const mdPath = join(RESULTS_DIR, `${RESULT_STEM}.md`);
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  writeFileSync(mdPath, renderMarkdown({ envFacts, summaries, rec }));
  console.log("wrote", jsonPath);
  console.log("wrote", mdPath);
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((err) => {
    console.error("run failed:", err instanceof Error ? err.name : "unknown");
    process.exit(1);
  });
}

export {
  DEV_VARS,
  DIRECT_MINIMAX_URL,
  GAP_MS,
  GATEWAY_BASE,
  GATEWAY_CHAT_URL,
  KEY_NAMES,
  LONG_RUNS,
  RESULTS_DIR,
  RESULT_STEM,
  ROOT,
  SCRATCH_DIR,
  SHORT_RUNS,
  SYSTEM_SHORT,
  applyEnv,
  isHardUnreachable,
  isModelRejected,
  keyLen,
  listenSnapshot,
  listGatewayModels,
  loadDevVars,
  padSystem,
  percentile,
  recommendation,
  rowRecord,
  runSuite,
  sanitize,
  sleep,
  summarize,
  timedChat,
  timedChatWithRetry,
  urlFacts,
};
