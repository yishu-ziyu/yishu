#!/usr/bin/env node
/**
 * Fast-tier chat latency: MiniMax direct + StepFun Step Plan.
 * Secrets from apps/clicky/worker/.dev.vars. Never printed.
 *
 *   node evals/voice/exp1-gateway/fast-tier.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../..");
const DEV_VARS = join(ROOT, "apps/clicky/worker/.dev.vars");
const RESULTS_DIR = join(ROOT, "evals/voice/results");
const SCRATCH_DIR = join(ROOT, ".work/voice-experiments");
const RESULT_STEM = "2026-09-04-exp1-gateway-vs-direct";
const SHORT_N = 20;
const REALISTIC_N = 5;
const GAP_MS = 300;
const TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 2;
const SYSTEM_SHORT = "你是奕枢，一个说话简短的朋友。";
const USER_SHORT = "用一句话说今天适合做什么。";
const USER_REALISTIC = "帮我看看这个窗口里哪个是保存按钮";
const MINIMAX_BASE = "https://api.minimaxi.com/v1";
const STEP_PLAN_BASE = "https://api.stepfun.com/step_plan/v1";
const DOCS_THINKING =
  'MiniMax OpenAI-compatible docs (platform.minimax.io): MiniMax-M3 thinking is on by default; thinking:{type:"disabled"} skips reasoning. reasoning_split only changes output shape. M2.x cannot disable thinking. service_tier is admission (standard|priority), not reasoning.';

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function round1(n) {
  return Math.round(n * 10) / 10;
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

function sanitize(text) {
  if (!text) return "";
  return String(text)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_\-]{8,}/g, "sk-[redacted]")
    .replace(/[A-Za-z0-9_\-+/=]{40,}/g, "[redacted]")
    .slice(0, 400);
}

function chars(s) {
  return [...String(s)].length;
}

function padChars(seed, target, filler) {
  let s = seed;
  while (chars(s) < target) s += filler;
  return [...s].slice(0, target).join("");
}

function isChatModelId(id) {
  const s = String(id || "");
  if (!s) return false;
  return !/(tts|t2a|speech|whisper|embed|image|video|dall|audio|asr|voice|rerank)/i.test(s);
}

function mmRank(id) {
  const s = String(id).toLowerCase();
  if (/highspeed|high-speed/.test(s)) return 0;
  if (/(^|[-_.])fast([-_.]|$)/.test(s)) return 1;
  if (s === "minimax-m3") return 2;
  return 3;
}

function isStepFlashOrMini(id) {
  const s = String(id || "");
  return /^step-3(\.\d+)?/i.test(s) && /(flash|mini)/i.test(s);
}

function extractContent(obj) {
  if (!obj || typeof obj !== "object") return "";
  const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
  const delta = choice?.delta || choice?.message || {};
  const candidates = [delta.content, choice?.text, obj.output_text, obj.text];
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

function buildRealisticSystem() {
  const persona = padChars(
    "你是奕枢，用户电脑菜单栏里的光球朋友。说话短、像人、先出声再干活。你看得见当前窗口的界面元素。用户正在用桌面软件，你要根据编号指出该点哪里。不要解释架构，不要问记忆存在哪。遇到保存、导出、确认这类按钮，直接报编号和标签。不要说「作为AI」。保持一句到三句。你的语气像认识很久的同事，不卖萌，不客服腔。",
    1500,
    "屏幕是普通桌面工作场景，没有紧急通知。结合记忆里的习惯给一句能动手的话。"
  );
  const ui = Array.from({ length: 20 }, (_, i) => {
    const n = i + 1;
    const labels = [
      "窗口标题栏-未命名文稿",
      "菜单-文件",
      "菜单-编辑",
      "菜单-视图",
      "工具栏-新建",
      "工具栏-打开",
      "工具栏-保存",
      "工具栏-另存为",
      "工具栏-撤销",
      "工具栏-重做",
      "侧栏-页面列表",
      "画布-正文编辑区",
      "浮动面板-导出",
      "状态栏-就绪",
      "按钮-取消",
      "按钮-关闭",
      "按钮-打印",
      "按钮-分享",
      "按钮-帮助",
      "按钮-设置",
    ];
    return `${n}. ${labels[i]}`;
  }).join("\n");
  const memory = padChars(
    "记忆：用户要短句；保存常用工具栏而不是菜单；不喜欢先问再做；点错会不耐烦；中文口播。",
    300,
    "周末更想少说话多干活。"
  );
  return `${persona}\n界面元素：\n${ui}\n${memory}`;
}

async function timedGet(url, apiKey) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: ac.signal,
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
      note: res.ok ? null : `unreachable: ${res.status}; ${sanitize(text)}`,
    };
  } catch (err) {
    const code = err?.name === "AbortError" ? "timeout" : err?.cause?.code || err?.name || "fetch-failed";
    return {
      http_status: 0,
      ids: [],
      elapsed_ms: round1(performance.now() - started),
      note: `unreachable: ${code}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function timedChat({ url, apiKey, model, system, user, extraBody, maxTokens, captureText }) {
  const t0 = performance.now();
  const payload = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: maxTokens ?? 60,
    stream: true,
    ...(extraBody && typeof extraBody === "object" ? extraBody : {}),
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
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
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const code = err?.name === "AbortError" ? "timeout" : err?.cause?.code || err?.name || "fetch-failed";
    return {
      ok: false,
      http_status: 0,
      t_first_token_ms: null,
      t_done_ms: round1(performance.now() - t0),
      note: `unreachable: ${code}`,
      sample_text: null,
    };
  }

  const status = res.status;
  if (!res.ok) {
    let errText = "";
    try {
      errText = await res.text();
    } catch {
      errText = "";
    }
    clearTimeout(timer);
    return {
      ok: false,
      http_status: status,
      t_first_token_ms: null,
      t_done_ms: round1(performance.now() - t0),
      note: `unreachable: ${status}` + (errText ? `; ${sanitize(errText)}` : ""),
      sample_text: null,
    };
  }

  if (!res.body) {
    clearTimeout(timer);
    return {
      ok: false,
      http_status: status,
      t_first_token_ms: null,
      t_done_ms: round1(performance.now() - t0),
      note: "empty-body",
      sample_text: null,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let tFirstToken = null;
  let collected = "";
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
        const data = line.startsWith("data:")
          ? line.slice(5).trim()
          : line.startsWith("{")
            ? line.trim()
            : "";
        if (!data || data === "[DONE]") continue;
        try {
          const event = JSON.parse(data);
          const delta = extractContent(event);
          if (delta) {
            if (tFirstToken == null) tFirstToken = round1(performance.now() - t0);
            if (captureText && collected.length < 240) collected += delta;
          }
        } catch {
          // keep-alive / comment
        }
      }
    }
  } catch (err) {
    const code = err?.name === "AbortError" ? "timeout" : err?.name || "stream-failed";
    return {
      ok: tFirstToken != null,
      http_status: status,
      t_first_token_ms: tFirstToken,
      t_done_ms: round1(performance.now() - t0),
      note: tFirstToken != null ? null : `unreachable: ${code}`,
      sample_text: collected || null,
    };
  } finally {
    clearTimeout(timer);
  }

  return {
    ok: tFirstToken != null,
    http_status: status,
    t_first_token_ms: tFirstToken,
    t_done_ms: round1(performance.now() - t0),
    note: tFirstToken == null ? "no-content-delta" : null,
    sample_text: collected || null,
  };
}

function isModelRejected(row) {
  if (row.ok) return false;
  const status = row.http_status;
  if (status !== 400 && status !== 404 && status !== 422) return false;
  return /model|not found|invalid|unknown|unsupported|does not exist|不存在|不可用|unrecognized|extra fields|unexpected/i.test(
    `${row.note || ""}`
  );
}

function isHardFail(row) {
  if (row.ok) return false;
  const status = row.http_status;
  return status === 401 || status === 403 || status === 402 || status === 0;
}

function shouldRetry(row) {
  if (row.ok) return false;
  if (isModelRejected(row) || isHardFail(row)) return false;
  const note = `${row.note || ""}`;
  return row.http_status === 0 || row.http_status >= 500 || /timeout|stream-failed/i.test(note);
}

async function timedChatOnce(opts) {
  let last = await timedChat(opts);
  last.attempts = 1;
  if (last.ok || !shouldRetry(last)) return last;
  last = await timedChat(opts);
  last.attempts = 2;
  return last;
}

function paramLabel(extraBody, maxTokens) {
  const parts = [];
  if (extraBody && Object.keys(extraBody).length) parts.push(JSON.stringify(extraBody));
  if (maxTokens != null && maxTokens !== 60) parts.push(`max_tokens:${maxTokens}`);
  return parts.length ? parts.join(" ") : "default";
}

function writeScratch(path, payload) {
  writeFileSync(path, JSON.stringify(payload, null, 2));
}

async function runSuite({
  provider,
  model,
  params,
  extraBody,
  maxTokens,
  url,
  apiKey,
  n,
  system,
  user,
  prompt,
  rows,
  scratchPath,
  captureFirstReply,
}) {
  console.log(`[run] ${provider} model=${model} params=${params} prompt=${prompt} n=${n}`);
  let sample = null;
  for (let i = 0; i < n; i++) {
    const metrics = await timedChatOnce({
      url,
      apiKey,
      model,
      system,
      user,
      extraBody,
      maxTokens,
      captureText: Boolean(captureFirstReply) && sample == null,
    });
    const rec = {
      provider,
      model,
      params,
      prompt,
      run_index: i + 1,
      t_first_token_ms: metrics.t_first_token_ms,
      t_done_ms: metrics.t_done_ms,
      http_status: metrics.http_status,
      ok: Boolean(metrics.ok),
      attempts: metrics.attempts ?? 1,
      note: metrics.note || null,
    };
    rows.push(rec);
    writeScratch(scratchPath, { updated: new Date().toISOString(), rows });
    if (captureFirstReply && sample == null && metrics.sample_text) {
      sample = metrics.sample_text.replace(/\s+/g, " ").trim().slice(0, 240);
    }
    console.log(
      `  #${i + 1}/${n} status=${rec.http_status} ft=${rec.t_first_token_ms ?? "n/a"} done=${rec.t_done_ms ?? "n/a"}${rec.note ? ` note=${rec.note}` : ""}`
    );
    if (i === 0 && (isHardFail(rec) || isModelRejected(rec))) return { early: rec, sample };
    if (i < n - 1) await sleep(GAP_MS);
  }
  return { early: null, sample };
}

function summarize(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.provider}\t${row.model}\t${row.params}\t${row.prompt}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const out = [];
  for (const [key, group] of groups) {
    const [provider, model, params, prompt] = key.split("\t");
    const ok = group.filter((r) => r.ok);
    out.push({
      provider,
      model,
      params,
      prompt,
      n: group.length,
      ok: ok.length,
      ft_p50: percentile(ok.map((r) => r.t_first_token_ms), 50),
      ft_p95: percentile(ok.map((r) => r.t_first_token_ms), 95),
      done_p50: percentile(ok.map((r) => r.t_done_ms), 50),
      done_p95: percentile(ok.map((r) => r.t_done_ms), 95),
      note: ok.length ? null : group.find((r) => r.note)?.note || null,
    });
  }
  return out;
}

function tableLines(summaries) {
  const lines = [
    "| provider | model | params | n | ok | ft p50 | ft p95 | done p50 | realistic p50 |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  const realistic = new Map();
  for (const s of summaries) {
    if (s.prompt === "realistic") {
      realistic.set(`${s.provider}\t${s.model}\t${s.params}`, s.ft_p50);
    }
  }
  const shorts = summaries.filter((s) => s.prompt === "short");
  const shown = shorts.length ? shorts : summaries;
  for (const s of shown) {
    const rp = realistic.get(`${s.provider}\t${s.model}\t${s.params}`);
    lines.push(
      `| ${s.provider} | ${s.model} | ${s.params.replace(/\|/g, "/")} | ${s.n} | ${s.ok} | ${s.ft_p50 ?? "—"} | ${s.ft_p95 ?? "—"} | ${s.done_p50 ?? "—"} | ${rp ?? "—"} |`
    );
  }
  return lines.join("\n");
}

function recommendation(summaries, facts) {
  const shortOk = summaries.filter(
    (s) => s.prompt === "short" && s.ok > 0 && s.ft_p50 != null
  );
  const best = [...shortOk].sort((a, b) => a.ft_p50 - b.ft_p50)[0];
  if (!best) {
    return "No successful short-prompt first-token. Do not change the 实时对话 default.";
  }
  const miss = best.ft_p50 <= 600 ? 0 : round1(best.ft_p50 - 600);
  const hit = best.ft_p50 <= 600 ? "reaches ≤600 ms" : `misses ≤600 ms by ${miss} ms`;
  const real = summaries.find(
    (s) =>
      s.prompt === "realistic" &&
      s.provider === best.provider &&
      s.model === best.model &&
      s.params === best.params
  );
  const realBit = real?.ft_p50 != null ? ` Realistic first-token p50 ${real.ft_p50} ms.` : "";
  const m3 = facts.m3_param_effects
    .map((e) => `${e.params}:${e.accepted ? `accepted ft p50 ${e.ft_p50 ?? "n/a"}` : "rejected"}`)
    .join("; ");
  const audioBit = facts.stepaudio_sample
    ? ` stepaudio-2.5-chat sample: 「${facts.stepaudio_sample}」`
    : "";
  return `For 实时对话, use ${best.provider} / ${best.model} (${best.params}). Short first-token p50 ${best.ft_p50} ms, p95 ${best.ft_p95} ms; ${hit}.${realBit} M3 extra params: ${m3 || "n/a"}.${audioBit}`;
}

function dash(v) {
  return v == null ? "—" : v;
}

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(SCRATCH_DIR, { recursive: true });
  const scratchPath = join(SCRATCH_DIR, "fast-tier.partial.json");
  const env = loadDevVars(DEV_VARS);
  const minimaxKey = env.MINIMAX_API_KEY || "";
  const stepKey = env.STEPFUN_STEP_PLAN_API_KEY || "";
  const facts = {
    minimax_key_len: minimaxKey.length,
    step_plan_key_len: stepKey.length,
    minimax_base: MINIMAX_BASE,
    step_plan_base: STEP_PLAN_BASE,
    docs_thinking: DOCS_THINKING,
    minimax_models_status: 0,
    minimax_chat_ids: [],
    step_plan_models_status: 0,
    step_plan_ids: [],
    m3_param_effects: [],
    stepaudio_sample: null,
  };

  console.log(
    `[env] MINIMAX_API_KEY length=${facts.minimax_key_len} STEPFUN_STEP_PLAN_API_KEY length=${facts.step_plan_key_len}`
  );
  console.log(`[env] minimax=${MINIMAX_BASE} step_plan=${STEP_PLAN_BASE}`);
  console.log(`[docs] ${DOCS_THINKING}`);

  const rows = [];
  const mmListed = await timedGet(`${MINIMAX_BASE}/models`, minimaxKey);
  facts.minimax_models_status = mmListed.http_status;
  const mmChat = mmListed.ids.filter(isChatModelId).sort((a, b) => mmRank(a) - mmRank(b) || a.localeCompare(b));
  facts.minimax_chat_ids = mmChat;
  console.log(`[minimax] GET /models status=${mmListed.http_status} chat=${mmChat.join(", ") || "(none)"}`);

  const mmUrl = `${MINIMAX_BASE}/chat/completions`;
  if (!minimaxKey) {
    rows.push({
      provider: "minimax",
      model: "(none)",
      params: "default",
      prompt: "short",
      run_index: 1,
      t_first_token_ms: null,
      t_done_ms: null,
      http_status: 0,
      ok: false,
      attempts: 1,
      note: "unreachable: MINIMAX_API_KEY missing",
    });
  } else {
    const models = mmChat.length ? mmChat : ["MiniMax-M3"];
    for (const model of models) {
      const { early } = await runSuite({
        provider: "minimax",
        model,
        params: "default",
        url: mmUrl,
        apiKey: minimaxKey,
        n: SHORT_N,
        system: SYSTEM_SHORT,
        user: USER_SHORT,
        prompt: "short",
        rows,
        scratchPath,
      });
      if (early && isHardFail(early) && model === models[0]) break;
    }

    const variants = [
      { extraBody: { reasoning_effort: "low" }, maxTokens: 60 },
      { extraBody: { thinking: { type: "disabled" } }, maxTokens: 60 },
      { extraBody: { reasoning_split: false }, maxTokens: 60 },
      { extraBody: {}, maxTokens: 30 },
    ];
    const baseline = summarize(rows).find(
      (s) => s.provider === "minimax" && s.model === "MiniMax-M3" && s.params === "default" && s.prompt === "short"
    );
    for (const v of variants) {
      const params = paramLabel(v.extraBody, v.maxTokens);
      const { early } = await runSuite({
        provider: "minimax",
        model: "MiniMax-M3",
        params,
        extraBody: v.extraBody,
        maxTokens: v.maxTokens,
        url: mmUrl,
        apiKey: minimaxKey,
        n: SHORT_N,
        system: SYSTEM_SHORT,
        user: USER_SHORT,
        prompt: "short",
        rows,
        scratchPath,
      });
      const suite = summarize(rows.filter((r) => r.model === "MiniMax-M3" && r.params === params && r.prompt === "short"))[0];
      const accepted = Boolean(suite && suite.ok > 0);
      const rejected = Boolean(early && isModelRejected(early));
      facts.m3_param_effects.push({
        params,
        accepted: accepted && !rejected,
        rejected,
        http_status: early?.http_status ?? null,
        ft_p50: suite?.ft_p50 ?? null,
        baseline_ft_p50: baseline?.ft_p50 ?? null,
        delta_vs_default_ms:
          suite?.ft_p50 != null && baseline?.ft_p50 != null ? round1(suite.ft_p50 - baseline.ft_p50) : null,
        note: rejected ? early?.note || suite?.note : null,
      });
    }
  }

  const stepUrl = `${STEP_PLAN_BASE}/chat/completions`;
  const stepListed = await timedGet(`${STEP_PLAN_BASE}/models`, stepKey);
  facts.step_plan_models_status = stepListed.http_status;
  facts.step_plan_ids = stepListed.ids;
  console.log(
    `[step-plan] GET /models status=${stepListed.http_status} ids=${stepListed.ids.join(", ") || "(none)"}${stepListed.note ? ` note=${stepListed.note}` : ""}`
  );

  const stepModels = [];
  const pushStep = (id, extraBody) => {
    if (!id) return;
    if (stepModels.some((m) => m.id === id && JSON.stringify(m.extraBody || {}) === JSON.stringify(extraBody || {}))) {
      return;
    }
    stepModels.push({ id, extraBody: extraBody || {} });
  };
  const listedFlash = stepListed.ids.filter(isStepFlashOrMini);
  if (listedFlash.length) {
    for (const id of listedFlash) pushStep(id, {});
  } else {
    pushStep("step-3.7-flash", {});
  }
  pushStep("stepaudio-2.5-chat", { modalities: ["text"] });

  if (!stepKey) {
    rows.push({
      provider: "stepfun-step-plan",
      model: "step-3.7-flash",
      params: "default",
      prompt: "short",
      run_index: 1,
      t_first_token_ms: null,
      t_done_ms: null,
      http_status: 0,
      ok: false,
      attempts: 1,
      note: "unreachable: STEPFUN_STEP_PLAN_API_KEY missing",
    });
  } else {
    for (const m of stepModels) {
      const params = paramLabel(m.extraBody, 60);
      const capture = m.id === "stepaudio-2.5-chat";
      const { early, sample } = await runSuite({
        provider: "stepfun-step-plan",
        model: m.id,
        params,
        extraBody: m.extraBody,
        url: stepUrl,
        apiKey: stepKey,
        n: SHORT_N,
        system: SYSTEM_SHORT,
        user: USER_SHORT,
        prompt: "short",
        rows,
        scratchPath,
        captureFirstReply: capture,
      });
      if (capture && sample) facts.stepaudio_sample = sample;
      if (early && isHardFail(early)) continue;
    }
  }

  const shortOk = summarize(rows).filter((s) => s.prompt === "short" && s.ok > 0 && s.ft_p50 != null);
  const fastest = [...shortOk].sort((a, b) => a.ft_p50 - b.ft_p50).slice(0, 3);
  const realisticSystem = buildRealisticSystem();
  console.log(
    `[realistic] persona_chars=${chars(realisticSystem.split("\n界面元素：")[0])} system_chars=${chars(realisticSystem)} models=${fastest.map((s) => s.model).join(", ") || "(none)"}`
  );
  for (const s of fastest) {
    const extraBody = s.params === "default" ? {} : safeParseParams(s.params);
    const maxTokens = extraBody.max_tokens || 60;
    delete extraBody.max_tokens;
    const url = s.provider === "minimax" ? mmUrl : stepUrl;
    const apiKey = s.provider === "minimax" ? minimaxKey : stepKey;
    await runSuite({
      provider: s.provider,
      model: s.model,
      params: s.params,
      extraBody,
      maxTokens,
      url,
      apiKey,
      n: REALISTIC_N,
      system: realisticSystem,
      user: USER_REALISTIC,
      prompt: "realistic",
      rows,
      scratchPath,
    });
  }

  const summaries = summarize(rows);
  const rec = recommendation(summaries, facts);
  const jsonPath = join(RESULTS_DIR, `${RESULT_STEM}.json`);
  const mdPath = join(RESULTS_DIR, `${RESULT_STEM}.md`);
  const existing = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, "utf8")) : {};
  existing.fast_tier = {
    generated_at: new Date().toISOString(),
    node: process.version,
    env: {
      minimax_key_len: facts.minimax_key_len,
      step_plan_key_len: facts.step_plan_key_len,
      minimax_base_host: "api.minimaxi.com",
      step_plan_base_host: "api.stepfun.com",
      step_plan_base_path: "/step_plan/v1",
    },
    docs_thinking: facts.docs_thinking,
    minimax_models: { http_status: facts.minimax_models_status, chat_ids: facts.minimax_chat_ids },
    step_plan_models: {
      http_status: facts.step_plan_models_status,
      ids: facts.step_plan_ids,
      tested: stepModels.map((m) => m.id),
    },
    m3_param_effects: facts.m3_param_effects,
    stepaudio_sample: facts.stepaudio_sample,
    rows,
    summaries,
    recommendation: rec,
  };
  writeFileSync(jsonPath, JSON.stringify(existing, null, 2));

  const prevMd = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
  const stripped = prevMd.replace(/\n## fast tier[\s\S]*$/, "").trimEnd();
  const md = `${stripped}

## fast tier

Runner: \`node evals/voice/exp1-gateway/fast-tier.mjs\` (Node ${process.version})
Date: ${new Date().toISOString()}
Exits: MiniMax \`https://api.minimaxi.com/v1\` (key len ${facts.minimax_key_len}); Step Plan \`https://api.stepfun.com/step_plan/v1\` (key len ${facts.step_plan_key_len}). 8317 not probed.
Protocol: stream true, max_tokens 60, 20 sequential runs, 300 ms gap, AbortController 15 s, at most one retry.
Docs: ${DOCS_THINKING}

GET MiniMax /v1/models status=${facts.minimax_models_status} chat: ${facts.minimax_chat_ids.join(", ") || "(none)"}.
GET Step Plan /models status=${facts.step_plan_models_status} ids: ${facts.step_plan_ids.join(", ") || "(none)"}.

MiniMax-M3 extra params:
${facts.m3_param_effects.map((e) => `- ${e.params}: ${e.accepted ? "accepted" : "rejected"} ft p50 ${dash(e.ft_p50)} vs default ${dash(e.baseline_ft_p50)} (Δ ${dash(e.delta_vs_default_ms)})${e.note ? `; ${sanitize(e.note)}` : ""}`).join("\n") || "(none)"}

${facts.stepaudio_sample ? `stepaudio-2.5-chat sample reply: 「${facts.stepaudio_sample}」` : "stepaudio-2.5-chat: no sample reply"}

${tableLines(summaries)}

Recommendation: ${rec}
`;
  writeFileSync(mdPath, md);
  console.log("wrote", jsonPath);
  console.log("wrote", mdPath);
  console.log("recommendation", rec);
}

function safeParseParams(params) {
  if (!params || params === "default") return {};
  const extra = {};
  const tokenMatch = String(params).match(/max_tokens:(\d+)/);
  if (tokenMatch) extra.max_tokens = Number(tokenMatch[1]);
  const jsonStart = String(params).indexOf("{");
  if (jsonStart >= 0) {
    const jsonEnd = String(params).lastIndexOf("}");
    if (jsonEnd > jsonStart) {
      try {
        Object.assign(extra, JSON.parse(params.slice(jsonStart, jsonEnd + 1)));
      } catch {
        // keep max_tokens only
      }
    }
  }
  return extra;
}

main().catch((err) => {
  console.error("fast-tier failed:", err instanceof Error ? err.name : "unknown");
  process.exit(1);
});
