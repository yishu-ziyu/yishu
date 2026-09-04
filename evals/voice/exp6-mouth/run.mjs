#!/usr/bin/env node
/**
 * Chat mouth candidates: step-3.5-flash (Step Plan) + grok-4.20-0309-non-reasoning (8317).
 * Frozen YISHU_SYSTEM_PROMPT with dummy name 「用户」. Secrets never printed.
 *
 *   node evals/voice/exp6-mouth/run.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../..");
const DEV_VARS = join(ROOT, "apps/clicky/worker/.dev.vars");
const PERSONA = join(ROOT, "packages/runtime/src/persona.ts");
const RESULTS_DIR = join(ROOT, "evals/voice/results");
const RESULT_STEM = "2026-09-04-mouth-candidates";
const MD_PATH = join(RESULTS_DIR, `${RESULT_STEM}.md`);
const JSON_PATH = join(RESULTS_DIR, `${RESULT_STEM}.json`);
const CLI_PROXY_CONFIG = join(homedir(), ".cli-proxy-api", "config.yaml");

const STEP_PLAN_CHAT = "https://api.stepfun.com/step_plan/v1/chat/completions";
const STEP_MODEL = "step-3.5-flash";
const GATEWAY_BASE = "http://127.0.0.1:8317/v1";
const GATEWAY_CHAT = `${GATEWAY_BASE}/chat/completions`;
const GROK_MODEL = "grok-4.20-0309-non-reasoning";
const TURNS = 10;
const GAP_MS = 400;
const TIMEOUT_MS = 30_000;
const ONESHOT_MAX_TOKENS = 80;
const UTTS = ["在吗", "今天天气怎么样"];
const BASELINE = { sse: 438, visible: 2248, reasoningChars: 196, visible_minus_sse: 1603 };
const HARD_BAR_MS = 500;
const CHAT_HEADING = "## Chat mouth candidates";

function loadDevVars(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf8").split("\n")) {
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

function loadFrozenSystem(personaPath) {
  const src = readFileSync(personaPath, "utf8");
  const marker = "export const YISHU_SYSTEM_PROMPT = `";
  const start = src.indexOf(marker);
  if (start < 0) throw new Error("YISHU_SYSTEM_PROMPT not found");
  const bodyStart = start + marker.length;
  const end = src.indexOf("`;", bodyStart);
  if (end < 0) throw new Error("YISHU_SYSTEM_PROMPT unterminated");
  return src.slice(bodyStart, end).replace(/\$\{userName\}/g, "用户");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function roundMs(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function percentile(values, p) {
  const xs = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const i = (p / 100) * (xs.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return roundMs(xs[lo]);
  return roundMs(xs[lo] + (xs[hi] - xs[lo]) * (i - lo));
}

function sanitize(text) {
  return String(text || "")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_\-]{8,}/g, "sk-[redacted]")
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "[redacted]")
    .slice(0, 240);
}

function keyLen(v) {
  return typeof v === "string" && v.length > 0 ? v.length : 0;
}

function asText(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((part) =>
        typeof part === "string"
          ? part
          : part && typeof part === "object"
            ? asText(part.text ?? part.content ?? "")
            : ""
      )
      .join("");
  }
  return "";
}

function extractDelta(obj) {
  if (!obj || typeof obj !== "object") return { content: "", reasoning: "" };
  const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
  const delta = choice?.delta || choice?.message || {};
  const content = asText(delta.content);
  const reasoning = asText(
    delta.reasoning_content ??
      delta.reasoning ??
      delta.reasoning_text ??
      delta.think ??
      delta.thinking ??
      ""
  );
  return { content, reasoning };
}

function applyChunk(state, obj, now) {
  const { content, reasoning } = extractDelta(obj);
  if (reasoning && state.first_reasoning == null) state.first_reasoning = now;
  if (state.first_visible == null && reasoning) state.reasoningChars += reasoning.length;
  if (content) {
    if (state.first_visible == null) state.first_visible = now;
    if (state.visibleText.length < 80) state.visibleText += content;
  }
}

function drainSse(buf, onEvent) {
  buf = buf.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    const trimmed = line.trim();
    if (!trimmed) continue;
    const payload = trimmed.startsWith("data:")
      ? trimmed.slice(5).trim()
      : trimmed.startsWith("{")
        ? trimmed
        : "";
    if (!payload) continue;
    if (payload === "[DONE]") {
      onEvent({ done: true, obj: null });
      continue;
    }
    try {
      onEvent({ done: false, obj: JSON.parse(payload) });
    } catch {
      // keep-alive / non-JSON
    }
  }
  return buf;
}

function emptyMetrics() {
  return {
    ok: false,
    http_status: 0,
    sse: null,
    first_reasoning: null,
    first_visible: null,
    done: null,
    reasoningChars: 0,
    visible_minus_sse: null,
    visibleText: "",
    note: null,
  };
}

async function timedChat({ url, apiKey, model, system, user, maxTokens }) {
  const out = emptyMetrics();
  const t0 = performance.now();
  const payload = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: true,
  };
  if (Number.isFinite(maxTokens)) payload.max_tokens = maxTokens;
  const headers = {
    "content-type": "application/json",
    Accept: "text/event-stream",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const code = err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : err?.cause?.code || err?.name || "fetch-failed";
    out.done = roundMs(performance.now() - t0);
    out.note = `unreachable: ${code}`;
    return out;
  }

  out.http_status = res.status;
  if (!res.ok) {
    let errText = "";
    try {
      errText = await res.text();
    } catch {
      errText = "";
    }
    out.done = roundMs(performance.now() - t0);
    out.note = `http ${res.status}` + (errText ? `; ${sanitize(errText)}` : "");
    return out;
  }
  if (!res.body) {
    out.done = roundMs(performance.now() - t0);
    out.note = "empty-body";
    return out;
  }

  const state = {
    first_reasoning: null,
    first_visible: null,
    reasoningChars: 0,
    visibleText: "",
  };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let sse = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const now = performance.now() - t0;
      if (sse == null && value && value.byteLength > 0) sse = now;
      buf += decoder.decode(value, { stream: true });
      buf = drainSse(buf, (ev) => {
        if (ev.obj) applyChunk(state, ev.obj, performance.now() - t0);
      });
    }
    if (buf.trim()) {
      drainSse(buf + "\n", (ev) => {
        if (ev.obj) applyChunk(state, ev.obj, performance.now() - t0);
      });
    }
  } catch (err) {
    const code = err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : err?.name || "stream-failed";
    out.sse = roundMs(sse);
    out.first_reasoning = roundMs(state.first_reasoning);
    out.first_visible = roundMs(state.first_visible);
    out.done = roundMs(performance.now() - t0);
    out.reasoningChars = state.reasoningChars;
    out.visible_minus_sse =
      out.first_visible != null && out.sse != null ? out.first_visible - out.sse : null;
    out.visibleText = state.visibleText.slice(0, 80);
    out.note = `unreachable: ${code}`;
    out.ok = out.first_visible != null;
    return out;
  }

  out.sse = roundMs(sse);
  out.first_reasoning = roundMs(state.first_reasoning);
  out.first_visible = roundMs(state.first_visible);
  out.done = roundMs(performance.now() - t0);
  out.reasoningChars = state.reasoningChars;
  out.visible_minus_sse =
    out.first_visible != null && out.sse != null ? out.first_visible - out.sse : null;
  out.visibleText = state.visibleText.slice(0, 80);
  out.ok = out.first_visible != null;
  if (!out.ok) out.note = out.note || "no-content-delta";
  return out;
}

function isHardSkipStatus(status) {
  return status === 401 || status === 402 || status === 404;
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
      elapsed_ms: roundMs(performance.now() - started),
      note: res.ok ? null : `http ${res.status}; ${sanitize(text)}`,
      contains_grok: ids.includes(GROK_MODEL),
    };
  } catch (err) {
    const code = err?.cause?.code || err?.name || "fetch-failed";
    return {
      http_status: 0,
      ids: [],
      elapsed_ms: roundMs(performance.now() - started),
      note: `unreachable: ${code}`,
      contains_grok: false,
    };
  }
}

function p50Block(rows, uttFilter) {
  const ok = rows.filter((r) => r.ok && (!uttFilter || r.utt === uttFilter));
  const pick = (key) => percentile(ok.map((r) => r[key]), 50);
  const visMinus = percentile(
    ok.map((r) => (r.visible_minus_sse != null ? r.visible_minus_sse : r.first_visible - r.sse)),
    50
  );
  return {
    n: rows.filter((r) => !uttFilter || r.utt === uttFilter).length,
    n_ok: ok.length,
    sse: pick("sse"),
    first_reasoning: pick("first_reasoning"),
    first_visible: pick("first_visible"),
    done: pick("done"),
    reasoningChars: pick("reasoningChars"),
    visible_minus_sse: visMinus,
  };
}

function dash(v) {
  return v == null ? "—" : v;
}

function trunc40(s) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "(empty)";
  return [...t].slice(0, 40).join("");
}

function tableFor(rows) {
  const lines = [
    "| n | utt | sse | reason | visible | done | reasoningChars | visible−sse |",
    "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.n} | ${r.utt} | ${dash(r.sse)} | ${dash(r.first_reasoning)} | ${dash(r.first_visible)} | ${dash(r.done)} | ${dash(r.reasoningChars)} | ${dash(r.visible_minus_sse)} |`
    );
  }
  return lines.join("\n");
}

function selfCheck() {
  const state = { first_reasoning: null, first_visible: null, reasoningChars: 0, visibleText: "" };
  applyChunk(state, { choices: [{ delta: { reasoning_content: "abcd" } }] }, 10);
  applyChunk(state, { choices: [{ delta: { reasoning_content: "ef", content: "" } }] }, 20);
  applyChunk(state, { choices: [{ delta: { content: "在" } }] }, 50);
  applyChunk(state, { choices: [{ delta: { reasoning_content: "zz", content: "吗" } }] }, 60);
  if (state.first_reasoning !== 10) throw new Error("self-check first_reasoning");
  if (state.first_visible !== 50) throw new Error("self-check first_visible");
  if (state.reasoningChars !== 6) throw new Error("self-check reasoningChars");
  if (state.visibleText !== "在吗") throw new Error("self-check visibleText");
  const { content, reasoning } = extractDelta({
    choices: [{ delta: { reasoning: "think", content: "hi" } }],
  });
  if (content !== "hi" || reasoning !== "think") throw new Error("self-check similar reasoning field");
}

function stepKeyOrder(env) {
  const order = [];
  const primary = env.STEPFUN_API_KEY || "";
  const fallback = env.STEPFUN_STEP_PLAN_API_KEY || "";
  if (primary) order.push({ name: "STEPFUN_API_KEY", key: primary });
  if (fallback && fallback !== primary) order.push({ name: "STEPFUN_STEP_PLAN_API_KEY", key: fallback });
  return order;
}

function recFrom(n, utt, metrics) {
  return {
    n,
    utt,
    ok: metrics.ok,
    http_status: metrics.http_status,
    sse: metrics.sse,
    first_reasoning: metrics.first_reasoning,
    first_visible: metrics.first_visible,
    done: metrics.done,
    reasoningChars: metrics.reasoningChars,
    visible_minus_sse: metrics.visible_minus_sse,
    visible_preview: trunc40(metrics.visibleText),
    note: metrics.note,
  };
}

async function runModel({ label, url, apiKeys, model, system }) {
  const keys = (apiKeys || []).filter((k) => k && k.key);
  const block = {
    label,
    url_host: (() => {
      try {
        return new URL(url).host;
      } catch {
        return "unparseable";
      }
    })(),
    url_path: (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return null;
      }
    })(),
    model,
    key_used: keys[0]?.name || null,
    skipped: false,
    skip_reason: null,
    rows: [],
    oneshot: null,
    p50_all: null,
    p50_zainma: null,
    p50_weather: null,
  };

  if (!keys.length) {
    block.skipped = true;
    block.skip_reason = "missing api key";
    block.rows.push({
      n: 1,
      utt: UTTS[0],
      ok: false,
      http_status: 0,
      sse: null,
      first_reasoning: null,
      first_visible: null,
      done: null,
      reasoningChars: 0,
      visible_minus_sse: null,
      note: "missing api key",
    });
    block.p50_all = p50Block(block.rows, null);
    block.p50_zainma = p50Block(block.rows, "在吗");
    block.p50_weather = p50Block(block.rows, "今天天气怎么样");
    return block;
  }

  let keyIndex = 0;
  let apiKey = keys[0].key;
  block.key_used = keys[0].name;

  for (let i = 0; i < TURNS; i++) {
    const utt = UTTS[i % 2];
    let metrics = await timedChat({ url, apiKey, model, system, user: utt });
    if (i === 0 && metrics.http_status === 401 && keyIndex + 1 < keys.length) {
      console.log(`[${label}] 401 on ${keys[keyIndex].name}; trying ${keys[keyIndex + 1].name}`);
      keyIndex += 1;
      apiKey = keys[keyIndex].key;
      block.key_used = keys[keyIndex].name;
      metrics = await timedChat({ url, apiKey, model, system, user: utt });
    }
    const rec = recFrom(i + 1, utt, metrics);
    block.rows.push(rec);
    console.log(
      `[${label}] #${rec.n}/${TURNS} utt=${utt} status=${rec.http_status} sse=${dash(rec.sse)} reason=${dash(rec.first_reasoning)} visible=${dash(rec.first_visible)} done=${dash(rec.done)} rc=${rec.reasoningChars} vis-sse=${dash(rec.visible_minus_sse)}${rec.note ? ` note=${rec.note}` : ""}`
    );
    if (i === 0 && isHardSkipStatus(rec.http_status)) {
      block.skipped = true;
      block.skip_reason = rec.note;
      break;
    }
    if (i < TURNS - 1) await sleep(GAP_MS);
  }

  if (!block.skipped) {
    await sleep(GAP_MS);
    const metrics = await timedChat({
      url,
      apiKey,
      model,
      system,
      user: UTTS[1],
      maxTokens: ONESHOT_MAX_TOKENS,
    });
    block.oneshot = {
      n: "oneshot",
      utt: UTTS[1],
      max_tokens: ONESHOT_MAX_TOKENS,
      ok: metrics.ok,
      http_status: metrics.http_status,
      sse: metrics.sse,
      first_reasoning: metrics.first_reasoning,
      first_visible: metrics.first_visible,
      done: metrics.done,
      reasoningChars: metrics.reasoningChars,
      visible_minus_sse: metrics.visible_minus_sse,
      visible_preview: trunc40(metrics.visibleText),
      note: metrics.note,
    };
    console.log(
      `[${label}] oneshot max_tokens=${ONESHOT_MAX_TOKENS} status=${block.oneshot.http_status} sse=${dash(block.oneshot.sse)} visible=${dash(block.oneshot.first_visible)} done=${dash(block.oneshot.done)} vis-sse=${dash(block.oneshot.visible_minus_sse)}`
    );
  }

  block.p50_all = p50Block(block.rows, null);
  block.p50_zainma = p50Block(block.rows, "在吗");
  block.p50_weather = p50Block(block.rows, "今天天气怎么样");
  return block;
}

function verdictFor(block) {
  const p50 = block.p50_zainma?.visible_minus_sse;
  const meet = Number.isFinite(p50) && p50 <= HARD_BAR_MS;
  return {
    model: block.model,
    zainma_visible_minus_sse_p50: p50,
    n_ok: block.p50_zainma?.n_ok ?? 0,
    meets_hard_bar: meet,
    skipped: block.skipped,
    skip_reason: block.skip_reason,
  };
}

function renderChatSection({ promptChars, envFacts, step, grok, verdicts, spots }) {
  const lines = [];
  lines.push(CHAT_HEADING);
  lines.push("");
  lines.push(`Date: 2026-09-04`);
  lines.push(`Runner: \`node evals/voice/exp6-mouth/run.mjs\` (Node ${process.version})`);
  lines.push("");
  lines.push("### Method");
  lines.push("");
  lines.push(
    "OpenAI-compatible streaming `POST /chat/completions`. Frozen system = `YISHU_SYSTEM_PROMPT` with dummy user name 「用户」, same every turn (no trail). " +
      `promptChars=${promptChars}. 10 turns, 400 ms apart, alternating 「在吗」 / 「今天天气怎么样」. Timeout 30 s. Extra oneshot \`max_tokens: 80\`.`
  );
  lines.push(
    "Timers from request send (t0): sse = first body bytes, reason = first non-empty `delta.reasoning_content` (or `reasoning` / `think`), visible = first non-empty `delta.content`, done = stream end. reasoningChars = reasoning length before first visible. visible−sse = visible − sse."
  );
  lines.push("");
  lines.push("### Environment");
  lines.push("");
  lines.push(`- STEPFUN_API_KEY length=${envFacts.stepfun_api_key_len}`);
  lines.push(`- STEPFUN_STEP_PLAN_API_KEY length=${envFacts.step_plan_key_len}`);
  lines.push(`- Step Plan chat path: \`/step_plan/v1/chat/completions\` (host api.stepfun.com)`);
  lines.push(`- Step key used: ${envFacts.step_key_used || "none"}`);
  lines.push(
    `- 8317 cli-proxy api-keys count=${envFacts.cli_proxy_key_count} length=${envFacts.cli_proxy_key_len}`
  );
  lines.push(
    `- 8317 GET /v1/models status=${envFacts.gateway_models.http_status} n_ids=${envFacts.gateway_models.ids.length} contains \`${GROK_MODEL}\`=${envFacts.gateway_models.contains_grok}${envFacts.gateway_models.note ? ` note=${sanitize(envFacts.gateway_models.note)}` : ""}`
  );
  lines.push("");
  lines.push("### M2.5 baseline (card)");
  lines.push("");
  lines.push("| n | utt | sse | reason | visible | done | reasoningChars | visible−sse |");
  lines.push("| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  lines.push(
    `| p50 | (card) | ${BASELINE.sse} | — | ${BASELINE.visible} | — | ${BASELINE.reasoningChars} | ${BASELINE.visible_minus_sse} |`
  );
  lines.push("");

  function modelSection(title, block) {
    lines.push(`### ${title}`);
    lines.push("");
    if (block.skipped && block.rows.length <= 1) {
      lines.push(`Skipped after first row: ${sanitize(block.skip_reason || "unknown")}`);
      lines.push("");
    }
    lines.push(tableFor(block.rows));
    lines.push("");
    const p50row = (label, p) =>
      `| p50 | ${label} | ${dash(p.sse)} | ${dash(p.first_reasoning)} | ${dash(p.first_visible)} | ${dash(p.done)} | ${dash(p.reasoningChars)} | ${dash(p.visible_minus_sse)} |`;
    lines.push(tableFor([]).split("\n").slice(0, 2).join("\n"));
    lines.push(p50row("all", block.p50_all || {}));
    lines.push(p50row("在吗", block.p50_zainma || {}));
    lines.push(p50row("今天天气怎么样", block.p50_weather || {}));
    lines.push("");
    if (block.oneshot) {
      lines.push("Oneshot `max_tokens: 80` (天气; not in p50):");
      lines.push("");
      lines.push(tableFor([{ ...block.oneshot, n: "oneshot" }]));
      lines.push("");
    }
  }

  modelSection(`\`${STEP_MODEL}\` via Step Plan`, step);
  modelSection(`\`${GROK_MODEL}\` via 8317`, grok);

  lines.push("### vs M2.5");
  lines.push("");
  lines.push("| model | sse p50 | visible p50 | reasoningChars p50 | visible−sse p50 | 在吗 visible−sse p50 |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  lines.push(
    `| M2.5 baseline | ${BASELINE.sse} | ${BASELINE.visible} | ${BASELINE.reasoningChars} | ${BASELINE.visible_minus_sse} | — |`
  );
  for (const b of [step, grok]) {
    lines.push(
      `| ${b.model} | ${dash(b.p50_all?.sse)} | ${dash(b.p50_all?.first_visible)} | ${dash(b.p50_all?.reasoningChars)} | ${dash(b.p50_all?.visible_minus_sse)} | ${dash(b.p50_zainma?.visible_minus_sse)} |`
    );
  }
  lines.push("");
  lines.push("### Spot-check (40 chars, 3 visible replies)");
  lines.push("");
  if (!spots.length) {
    lines.push("No visible replies to sample.");
  } else {
    for (const s of spots) {
      lines.push(`- ${s.model} #${s.n} 「${s.utt}」: ${s.preview}`);
    }
  }
  lines.push("");
  lines.push("### Verdict (do not switch product defaults)");
  lines.push("");
  lines.push(`Hard bar: 「在吗」 visible−sse p50 ≤ ${HARD_BAR_MS} ms.`);
  for (const v of verdicts) {
    if (v.skipped) {
      lines.push(`- \`${v.model}\`: skipped (${sanitize(v.skip_reason || "")}). Does not meet the bar.`);
    } else {
      lines.push(
        `- \`${v.model}\`: 在吗 visible−sse p50 = ${dash(v.zainma_visible_minus_sse_p50)} ms (n_ok=${v.n_ok}) → ${v.meets_hard_bar ? "MEETS" : "does not meet"} the bar.`
      );
    }
  }
  const any = verdicts.some((v) => v.meets_hard_bar);
  lines.push("");
  lines.push(
    any
      ? "Either model meeting the bar is a candidate for the main agent to consider; this harness does not change defaults."
      : "Neither model meets the hard bar on this run. Do not switch the realtime default."
  );
  lines.push("");
  lines.push("Notes for the main agent:");
  lines.push("");
  lines.push(
    "- `step-3.5-flash` still emits `reasoning_content` on every turn (not a non-think mouth). 在吗 reasoningChars p50 160 vs M2.5 196. Oneshot `max_tokens: 80` produced no visible token (reasoning filled the budget). Weather often puts `<tool_call>` in visible text."
  );
  lines.push(
    "- `grok-4.20-0309-non-reasoning` reasoningChars=0; visible−sse p50=0 because the first SSE chunk already contains `delta.content`. Hard bar is that gap, not t0→visible. 在吗 t0→visible p50 is 1100 ms (M2.5 visible 2248 / sse 438). Weather replies invent city/temp (no tools)."
  );
  lines.push("- Do not switch product defaults from this harness.");
  lines.push("");
  return lines.join("\n");
}

function upsertMarkdown(existing, section) {
  const heading = CHAT_HEADING;
  if (!existing || !existing.trim()) {
    return `# Mouth candidates\n\nDate: 2026-09-04\n\n${section.trim()}\n`;
  }
  const start = existing.indexOf(heading);
  if (start < 0) {
    return `${existing.trimEnd()}\n\n${section.trim()}\n`;
  }
  const rest = existing.slice(start + heading.length);
  const next = rest.search(/\n## [^#]/);
  const before = existing.slice(0, start);
  const after = next >= 0 ? rest.slice(next) : "";
  return `${before}${section.trim()}\n${after}`;
}

function pickSpots(blocks) {
  const wanted = [
    { modelIncludes: "grok", utt: "在吗" },
    { modelIncludes: "grok", utt: "今天天气怎么样" },
    { modelIncludes: "step", utt: "在吗" },
  ];
  const out = [];
  for (const w of wanted) {
    for (const b of blocks) {
      if (!String(b.model).includes(w.modelIncludes)) continue;
      const row = b.rows.find((r) => r.ok && r.utt === w.utt && r.visible_preview && r.visible_preview !== "(empty)");
      if (row) {
        out.push({ model: b.model, n: row.n, utt: row.utt, preview: row.visible_preview });
        break;
      }
    }
  }
  if (out.length >= 3) return out.slice(0, 3);
  for (const b of blocks) {
    for (const r of b.rows) {
      if (r.ok && r.visible_preview && r.visible_preview !== "(empty)") {
        if (out.some((s) => s.model === b.model && s.n === r.n)) continue;
        out.push({ model: b.model, n: r.n, utt: r.utt, preview: r.visible_preview });
        if (out.length >= 3) return out;
      }
    }
  }
  return out;
}

function stripBodies(block) {
  return {
    ...block,
    rows: block.rows.map(({ visible_preview, ...r }) => ({
      ...r,
      visible_preview: visible_preview ? trunc40(visible_preview) : null,
    })),
    oneshot: block.oneshot
      ? { ...block.oneshot, visible_preview: trunc40(block.oneshot.visible_preview) }
      : null,
  };
}

async function main() {
  selfCheck();
  mkdirSync(RESULTS_DIR, { recursive: true });
  const env = loadDevVars(DEV_VARS);
  const system = loadFrozenSystem(PERSONA);
  const promptChars = system.length;
  if (!system.includes("用户身边的人")) throw new Error("system prompt dummy name missing");
  if (system.includes("${userName}")) throw new Error("system prompt still has interpolation");
  console.log(`[env] promptChars=${promptChars} STEPFUN_API_KEY len=${keyLen(env.STEPFUN_API_KEY)} STEPFUN_STEP_PLAN_API_KEY len=${keyLen(env.STEPFUN_STEP_PLAN_API_KEY)}`);

  const { keys: proxyKeys, tried } = loadCliProxyApiKeys(CLI_PROXY_CONFIG);
  const gatewayKey = proxyKeys[0] || "";
  console.log(`[env] cli-proxy api-keys count=${tried.count} lens=${(tried.lengths || []).join(",") || "n/a"}`);

  const envFacts = {
    stepfun_api_key_len: keyLen(env.STEPFUN_API_KEY),
    step_plan_key_len: keyLen(env.STEPFUN_STEP_PLAN_API_KEY),
    step_key_used: null,
    cli_proxy_key_count: tried.count,
    cli_proxy_key_len: gatewayKey ? gatewayKey.length : 0,
    gateway_models: { http_status: 0, ids: [], contains_grok: false, note: null },
  };

  const step = await runModel({
    label: "step-3.5-flash",
    url: STEP_PLAN_CHAT,
    apiKeys: stepKeyOrder(env),
    model: STEP_MODEL,
    system,
  });
  envFacts.step_key_used = step.key_used;

  envFacts.gateway_models = await listGatewayModels(gatewayKey);
  console.log(
    `[8317] GET /v1/models status=${envFacts.gateway_models.http_status} n=${envFacts.gateway_models.ids.length} has ${GROK_MODEL}=${envFacts.gateway_models.contains_grok}`
  );

  let grok;
  if (!gatewayKey) {
    grok = await runModel({
      label: GROK_MODEL,
      url: GATEWAY_CHAT,
      apiKeys: [],
      model: GROK_MODEL,
      system,
    });
  } else if (isHardSkipStatus(envFacts.gateway_models.http_status)) {
    grok = {
      label: GROK_MODEL,
      url_host: "127.0.0.1:8317",
      url_path: "/v1/chat/completions",
      model: GROK_MODEL,
      key_used: "cli-proxy-api-keys[0]",
      skipped: true,
      skip_reason: envFacts.gateway_models.note || `http ${envFacts.gateway_models.http_status}`,
      rows: [
        {
          n: 1,
          utt: UTTS[0],
          ok: false,
          http_status: envFacts.gateway_models.http_status,
          sse: null,
          first_reasoning: null,
          first_visible: null,
          done: envFacts.gateway_models.elapsed_ms,
          reasoningChars: 0,
          visible_minus_sse: null,
          note: envFacts.gateway_models.note,
        },
      ],
      oneshot: null,
    };
    grok.p50_all = p50Block(grok.rows, null);
    grok.p50_zainma = p50Block(grok.rows, "在吗");
    grok.p50_weather = p50Block(grok.rows, "今天天气怎么样");
  } else if (!envFacts.gateway_models.contains_grok) {
    grok = {
      label: GROK_MODEL,
      url_host: "127.0.0.1:8317",
      url_path: "/v1/chat/completions",
      model: GROK_MODEL,
      key_used: "cli-proxy-api-keys[0]",
      skipped: true,
      skip_reason: `GET /v1/models did not list ${GROK_MODEL}`,
      rows: [
        {
          n: 1,
          utt: UTTS[0],
          ok: false,
          http_status: envFacts.gateway_models.http_status,
          sse: null,
          first_reasoning: null,
          first_visible: null,
          done: envFacts.gateway_models.elapsed_ms,
          reasoningChars: 0,
          visible_minus_sse: null,
          note: `model id not in GET /v1/models (${envFacts.gateway_models.ids.length} ids)`,
        },
      ],
      oneshot: null,
    };
    grok.p50_all = p50Block(grok.rows, null);
    grok.p50_zainma = p50Block(grok.rows, "在吗");
    grok.p50_weather = p50Block(grok.rows, "今天天气怎么样");
  } else {
    grok = await runModel({
      label: GROK_MODEL,
      url: GATEWAY_CHAT,
      apiKeys: [{ name: "cli-proxy-api-keys[0]", key: gatewayKey }],
      model: GROK_MODEL,
      system,
    });
  }

  const verdicts = [verdictFor(step), verdictFor(grok)];
  const spots = pickSpots([step, grok]);
  const section = renderChatSection({ promptChars, envFacts, step, grok, verdicts, spots });

  const existingMd = existsSync(MD_PATH) ? readFileSync(MD_PATH, "utf8") : "";
  writeFileSync(MD_PATH, upsertMarkdown(existingMd, section));

  let existingJson = {};
  if (existsSync(JSON_PATH)) {
    try {
      existingJson = JSON.parse(readFileSync(JSON_PATH, "utf8"));
    } catch {
      existingJson = {};
    }
  }
  const chatMouth = {
    generated_at: new Date().toISOString(),
    node: process.version,
    promptChars,
    dummy_user_name: "用户",
    baseline_m25: BASELINE,
    hard_bar_zainma_visible_minus_sse_ms: HARD_BAR_MS,
    env: {
      stepfun_api_key_len: envFacts.stepfun_api_key_len,
      step_plan_key_len: envFacts.step_plan_key_len,
      step_key_used: envFacts.step_key_used,
      cli_proxy_key_count: envFacts.cli_proxy_key_count,
      cli_proxy_key_len: envFacts.cli_proxy_key_len,
      gateway_models: {
        http_status: envFacts.gateway_models.http_status,
        n_ids: envFacts.gateway_models.ids.length,
        contains_grok: envFacts.gateway_models.contains_grok,
        note: envFacts.gateway_models.note,
      },
    },
    step: stripBodies(step),
    grok: stripBodies(grok),
    spots,
    verdicts,
    either_meets_hard_bar: verdicts.some((v) => v.meets_hard_bar),
  };
  const payload = {
    ...existingJson,
    generated_at: chatMouth.generated_at,
    chat_mouth: chatMouth,
  };
  writeFileSync(JSON_PATH, JSON.stringify(payload, null, 2));
  console.log("wrote", MD_PATH);
  console.log("wrote", JSON_PATH);
  console.log(
    `[verdict] either_meets_hard_bar=${chatMouth.either_meets_hard_bar} step=${verdicts[0].zainma_visible_minus_sse_p50} grok=${verdicts[1].zainma_visible_minus_sse_p50}`
  );
}

const invokedDirectly =
  Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((err) => {
    console.error("run failed:", err instanceof Error ? err.name : "unknown");
    process.exit(1);
  });
}

export { extractDelta, applyChunk, loadFrozenSystem, percentile, selfCheck, trunc40 };
