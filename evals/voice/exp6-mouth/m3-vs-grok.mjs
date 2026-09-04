#!/usr/bin/env node
/**
 * Same frozen persona as exp6-mouth. Compare MiniMax-M3 (default + thinking.disabled)
 * vs grok-4.20-0309-non-reasoning. Secrets never printed.
 *
 *   node evals/voice/exp6-mouth/m3-vs-grok.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEV_VARS = join(ROOT, "apps/clicky/worker/.dev.vars");
const PERSONA = join(ROOT, "packages/runtime/src/persona.ts");
const RESULTS_DIR = join(ROOT, "evals/voice/results");
const MD_PATH = join(RESULTS_DIR, "2026-09-04-m3-vs-grok.md");
const JSON_PATH = join(RESULTS_DIR, "2026-09-04-m3-vs-grok.json");
const CLI_PROXY_CONFIG = join(homedir(), ".cli-proxy-api", "config.yaml");
const MINIMAX_CHAT = "https://api.minimaxi.com/v1/chat/completions";
const GATEWAY_CHAT = "http://127.0.0.1:8317/v1/chat/completions";
const GATEWAY_MODELS = "http://127.0.0.1:8317/v1/models";
const M3 = "MiniMax-M3";
const GROK = "grok-4.20-0309-non-reasoning";
const TURNS = 10;
const GAP_MS = 400;
const TIMEOUT_MS = 30_000;
const UTTS = ["在吗", "今天天气怎么样"];

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

function loadCliProxyApiKeys(configPath) {
  const keys = [];
  if (!existsSync(configPath)) return keys;
  const lines = readFileSync(configPath, "utf8").split("\n");
  let inKeys = false;
  let indent = 0;
  for (const line of lines) {
    if (!inKeys) {
      if (/^api-keys\s*:/.test(line)) {
        inKeys = true;
        indent = line.match(/^\s*/)[0].length;
        const inline = line.replace(/^api-keys\s*:\s*/, "").trim();
        if (inline && inline !== "|" && inline !== ">") keys.push(inline.replace(/^["']|["']$/g, ""));
      }
      continue;
    }
    const i = (line.match(/^\s*/) || [""])[0].length;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (i <= indent && /[A-Za-z]/.test(line[i] || "")) break;
    if (trimmed.startsWith("-")) {
      const val = trimmed.slice(1).trim().replace(/^["']|["']$/g, "");
      if (val) keys.push(val);
    }
  }
  return keys;
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
  return Number.isFinite(n) ? Math.round(n) : null;
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
  return {
    content: asText(delta.content),
    reasoning: asText(
      delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text ?? delta.think ?? delta.thinking ?? ""
    ),
  };
}

function partialTagSuffix(buf) {
  const max = Math.min(buf.length, 8);
  for (let n = max; n > 0; n--) {
    const tail = buf.slice(-n);
    if ("<think>".startsWith(tail) || "</think>".startsWith(tail)) return n;
  }
  return 0;
}

function emitVisible(state, text, now) {
  if (!text) return;
  if (state.first_visible == null) state.first_visible = now;
  if (state.visibleText.length < 80) state.visibleText += text;
}

function feedText(state, raw, now) {
  if (!raw) return;
  state.buf = (state.buf || "") + raw;
  while (state.buf.length) {
    if (state.inThink) {
      const end = state.buf.indexOf("</think>");
      if (end < 0) {
        const keep = partialTagSuffix(state.buf);
        const piece = state.buf.slice(0, state.buf.length - keep);
        if (piece) {
          if (state.first_reasoning == null) state.first_reasoning = now;
          if (state.first_visible == null) state.reasoningChars += piece.length;
        }
        state.buf = keep ? state.buf.slice(-keep) : "";
        return;
      }
      if (state.first_reasoning == null) state.first_reasoning = now;
      if (state.first_visible == null) state.reasoningChars += end;
      state.buf = state.buf.slice(end + 8);
      state.inThink = false;
      continue;
    }
    const start = state.buf.indexOf("<think>");
    if (start >= 0) {
      emitVisible(state, state.buf.slice(0, start), now);
      state.buf = state.buf.slice(start + 7);
      state.inThink = true;
      continue;
    }
    const keep = partialTagSuffix(state.buf);
    emitVisible(state, state.buf.slice(0, state.buf.length - keep), now);
    state.buf = keep ? state.buf.slice(-keep) : "";
    return;
  }
}

function applyChunk(state, obj, now) {
  const { content, reasoning } = extractDelta(obj);
  if (reasoning && state.first_reasoning == null) state.first_reasoning = now;
  if (state.first_visible == null && reasoning) state.reasoningChars += reasoning.length;
  feedText(state, content, now);
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
    if (!payload || payload === "[DONE]") {
      if (payload === "[DONE]") onEvent({ obj: null });
      continue;
    }
    try {
      onEvent({ obj: JSON.parse(payload) });
    } catch {
      /* keep-alive */
    }
  }
  return buf;
}

async function timedChat({ url, apiKey, model, system, user, extraBody }) {
  const out = {
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
  const t0 = performance.now();
  const payload = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: true,
    ...(extraBody || {}),
  };
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Accept: "text/event-stream",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
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
  if (!res.ok || !res.body) {
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
  const state = {
    first_reasoning: null,
    first_visible: null,
    reasoningChars: 0,
    visibleText: "",
    buf: "",
    inThink: false,
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
    if (state.buf) {
      const now = performance.now() - t0;
      if (state.inThink) {
        if (state.first_reasoning == null) state.first_reasoning = now;
        if (state.first_visible == null) state.reasoningChars += state.buf.length;
      } else {
        emitVisible(state, state.buf, now);
      }
      state.buf = "";
    }
  } catch (err) {
    const code = err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : err?.name || "stream-failed";
    out.note = `unreachable: ${code}`;
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

function trunc40(s) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "(empty)";
  return [...t].slice(0, 40).join("");
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

function p50Block(rows, uttFilter) {
  const ok = rows.filter((r) => r.ok && (!uttFilter || r.utt === uttFilter));
  const pick = (key) => percentile(ok.map((r) => r[key]), 50);
  return {
    n: rows.filter((r) => !uttFilter || r.utt === uttFilter).length,
    n_ok: ok.length,
    sse: pick("sse"),
    first_reasoning: pick("first_reasoning"),
    first_visible: pick("first_visible"),
    done: pick("done"),
    reasoningChars: pick("reasoningChars"),
    visible_minus_sse: pick("visible_minus_sse"),
  };
}

function dash(v) {
  return v == null ? "—" : v;
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

async function runSuite({ label, url, apiKey, model, system, extraBody }) {
  const block = {
    label,
    model,
    extraBody: extraBody || null,
    skipped: false,
    skip_reason: null,
    rows: [],
  };
  if (!apiKey) {
    block.skipped = true;
    block.skip_reason = "missing api key";
    return block;
  }
  for (let i = 0; i < TURNS; i++) {
    const utt = UTTS[i % 2];
    const metrics = await timedChat({ url, apiKey, model, system, user: utt, extraBody });
    block.rows.push(recFrom(i + 1, utt, metrics));
    console.log(
      `[${label}] ${i + 1}/${TURNS} ${utt} ok=${metrics.ok} vis=${metrics.first_visible} reasonChars=${metrics.reasoningChars}`
    );
    if ((metrics.http_status === 401 || metrics.http_status === 402 || metrics.http_status === 404) && i === 0) {
      block.skipped = true;
      block.skip_reason = metrics.note;
      break;
    }
    if (i + 1 < TURNS) await sleep(GAP_MS);
  }
  block.p50_all = p50Block(block.rows, null);
  block.p50_zainma = p50Block(block.rows, "在吗");
  block.p50_weather = p50Block(block.rows, "今天天气怎么样");
  return block;
}

async function gatewayHasGrok(apiKey) {
  try {
    const res = await fetch(GATEWAY_MODELS, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const parsed = JSON.parse(await res.text());
    const data = Array.isArray(parsed?.data) ? parsed.data : [];
    const ids = data.map((item) => (typeof item === "string" ? item : item?.id)).filter(Boolean);
    return { status: res.status, n: ids.length, has: ids.includes(GROK) };
  } catch (err) {
    return { status: 0, n: 0, has: false, note: err?.name || "fetch-failed" };
  }
}

function selfCheckThink() {
  const s = {
    first_reasoning: null,
    first_visible: null,
    reasoningChars: 0,
    visibleText: "",
    buf: "",
    inThink: false,
  };
  feedText(s, "<thi", 1);
  feedText(s, "nk>abc</thi", 2);
  feedText(s, "nk>在", 10);
  if (s.visibleText !== "在" || s.reasoningChars !== 3 || s.first_visible !== 10) {
    throw new Error("think-strip self-check");
  }
}

async function main() {
  selfCheckThink();
  const system = loadFrozenSystem(PERSONA);
  const env = loadDevVars(DEV_VARS);
  const minimaxKey = env.MINIMAX_API_KEY || "";
  const grokKeys = loadCliProxyApiKeys(CLI_PROXY_CONFIG);
  const grokKey = grokKeys[0] || "";
  const gw = grokKey ? await gatewayHasGrok(grokKey) : { status: 0, n: 0, has: false };

  const m3 = await runSuite({
    label: "MiniMax-M3",
    url: MINIMAX_CHAT,
    apiKey: minimaxKey,
    model: M3,
    system,
  });
  const m3off = await runSuite({
    label: "MiniMax-M3 thinking.disabled",
    url: MINIMAX_CHAT,
    apiKey: minimaxKey,
    model: M3,
    system,
    extraBody: { thinking: { type: "disabled" } },
  });
  const grok = await runSuite({
    label: GROK,
    url: GATEWAY_CHAT,
    apiKey: grokKey,
    model: GROK,
    system,
  });

  const nonThink = [
    { name: "MiniMax-M3 thinking.disabled", vis: m3off.p50_zainma?.first_visible, chars: m3off.p50_zainma?.reasoningChars },
    { name: GROK, vis: grok.p50_zainma?.first_visible, chars: grok.p50_zainma?.reasoningChars },
  ].filter((row) => Number.isFinite(row.vis));
  nonThink.sort((a, b) => a.vis - b.vis);
  const winner = nonThink[0] || null;

  const md = [
    "# M3 vs Grok 4.20 non-reasoning",
    "",
    `Date: 2026-09-04`,
    `Runner: \`node evals/voice/exp6-mouth/m3-vs-grok.mjs\``,
    `promptChars=${system.length}. Frozen YISHU_SYSTEM_PROMPT, dummy name 「用户」. 10 turns, 400 ms apart.`,
    `8317 /models status=${gw.status} n=${gw.n} contains ${GROK}=${gw.has}`,
    `MINIMAX_API_KEY length=${minimaxKey.length}; 8317 api-keys count=${grokKeys.length} length=${grokKey.length}`,
    "",
    "## MiniMax-M3 default",
    "",
    tableFor(m3.rows),
    "",
    `p50 在吗 visible=${dash(m3.p50_zainma?.first_visible)} reasoningChars=${dash(m3.p50_zainma?.reasoningChars)} visible−sse=${dash(m3.p50_zainma?.visible_minus_sse)}`,
    "",
    "## MiniMax-M3 thinking.disabled",
    "",
    tableFor(m3off.rows),
    "",
    `p50 在吗 visible=${dash(m3off.p50_zainma?.first_visible)} reasoningChars=${dash(m3off.p50_zainma?.reasoningChars)} visible−sse=${dash(m3off.p50_zainma?.visible_minus_sse)}`,
    "",
    `## ${GROK} via 8317`,
    "",
    tableFor(grok.rows),
    "",
    `p50 在吗 visible=${dash(grok.p50_zainma?.first_visible)} reasoningChars=${dash(grok.p50_zainma?.reasoningChars)} visible−sse=${dash(grok.p50_zainma?.visible_minus_sse)}`,
    "",
    "## 非思考对决（在吗 t0→可见字 p50）",
    "",
    "| model | 在吗 visible p50 | reasoningChars p50 | visible−sse p50 |",
    "| --- | ---: | ---: | ---: |",
    `| MiniMax-M3 default | ${dash(m3.p50_zainma?.first_visible)} | ${dash(m3.p50_zainma?.reasoningChars)} | ${dash(m3.p50_zainma?.visible_minus_sse)} |`,
    `| MiniMax-M3 thinking.disabled | ${dash(m3off.p50_zainma?.first_visible)} | ${dash(m3off.p50_zainma?.reasoningChars)} | ${dash(m3off.p50_zainma?.visible_minus_sse)} |`,
    `| ${GROK} | ${dash(grok.p50_zainma?.first_visible)} | ${dash(grok.p50_zainma?.reasoningChars)} | ${dash(grok.p50_zainma?.visible_minus_sse)} |`,
    "",
    winner
      ? `更快的非思考嘴：${winner.name}（在吗可见字 p50 ${winner.vis} ms）。未改产品默认。`
      : "无法判胜负。未改产品默认。",
    "",
    "抽查：",
    `- M3 default #1: ${trunc40(m3.rows[0]?.visible_preview)}`,
    `- M3 disabled #1: ${trunc40(m3off.rows[0]?.visible_preview)}`,
    `- Grok #1: ${trunc40(grok.rows[0]?.visible_preview)}`,
  ].join("\n");

  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(MD_PATH, `${md}\n`);
  writeFileSync(
    JSON_PATH,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        promptChars: system.length,
        gateway: gw,
        m3,
        m3off,
        grok,
        winner: winner?.name || null,
      },
      null,
      2
    )
  );
  console.log(`wrote ${MD_PATH}`);
  console.log(winner ? `winner: ${winner.name} ${winner.vis}ms` : "no winner");
}

main().catch((err) => {
  console.error(String(err?.message || err).slice(0, 200));
  process.exit(1);
});
