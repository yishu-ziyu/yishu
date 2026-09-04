#!/usr/bin/env node
/**
 * Yishu exp3 TTS: MiniMax t2a_v2 vs StepFun HTTP speech.
 * Secrets are read from apps/clicky/worker/.dev.vars at runtime and never logged.
 *
 *   node evals/voice/exp3-tts/run.mjs
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../..");
const DEV_VARS = join(ROOT, "apps/clicky/worker/.dev.vars");
const AUDIO_DIR = join(ROOT, ".work/voice-experiments/tts");
const BLIND_DIR = join(AUDIO_DIR, "blind");
const RESULTS_DIR = join(ROOT, "evals/voice/results");
const RESULTS_JSON = join(RESULTS_DIR, "2026-09-04-exp3-tts.json");
const RESULTS_MD = join(RESULTS_DIR, "2026-09-04-exp3-tts.md");
const PARTIAL_JSON = join(AUDIO_DIR, "_partial.json");

const REQUEST_TIMEOUT_MS = 60_000;
const GAP_MS = 1600;
const MAX_RETRIES = 2;
const MINIMAX_DEFAULT_URL = "https://api.minimaxi.com/v1/t2a_v2";
const STEPFUN_SPEECH_URLS = [
  "https://api.stepfun.com/v1/audio/speech",
  "https://api.stepfun.com/step_plan/v1/audio/speech",
];
const STEPFUN_VOICE = "wenrounansheng";
const STEPFUN_VOICE_NOTE =
  "温柔男声 — 男，温柔亲和；官方情感陪伴/助手推荐。Her-like 陪伴，性别不限。";

const SENTENCES = [
  { id: 1, text: "嗯，在。", runs: 10, mood: "ack" },
  {
    id: 2,
    text: "好，我看到了，是 Xcode 的签名报错，Team 没选。",
    runs: 5,
    mood: "report",
  },
  { id: 3, text: "哈，这个我上次也踩过。", runs: 5, mood: "amused" },
  {
    id: 4,
    text: "抱歉，刚才那一下我点错了，我没有再动。",
    runs: 5,
    mood: "apologetic",
  },
  {
    id: 5,
    text: "等一下……找到了，在第二个标签页。",
    runs: 5,
    mood: "mid-work",
  },
  {
    id: 6,
    text: "你今天听起来有点累，要不先歇会儿？",
    runs: 5,
    mood: "warm-quiet",
  },
];

const MINIMAX_PARAM_BY_SENTENCE = {
  3: "happy",
  4: "sad",
  5: "calm",
  6: "whisper",
};
const MINIMAX_INLINE_BY_SENTENCE = {
  3: "(laughs)哈，这个我上次也踩过。",
  4: "(sighs)抱歉，刚才那一下我点错了，我没有再动。",
  5: "等一下<#0.5#>找到了，在第二个标签页。",
  6: "(breath)你今天听起来有点累，要不先歇会儿？",
};
const STEPFUN_INSTRUCTION_BY_SENTENCE = {
  3: "轻松、带着笑意，像跟熟人说话",
  4: "抱歉、放轻声音、语速稍慢",
  5: "边想边说，找到时语气放下来",
  6: "温柔、声音偏轻、关心",
};
const STEPFUN_INLINE_BY_SENTENCE = {
  3: "（轻笑）哈，这个我上次也踩过。",
  4: "（叹气）抱歉，刚才那一下我点错了，我没有再动。",
  5: "（短暂停顿）等一下……找到了，在第二个标签页。",
  6: "（放轻声音）你今天听起来有点累，要不先歇会儿？",
};
const STEPFUN_MINI_EMOTION_BY_SENTENCE = {
  3: "高兴",
  4: "悲伤",
  5: "困惑",
  6: "悲伤",
};

const TAG_PROBES = [
  {
    id: "laughs-paren",
    tag: "(laughs)",
    syntax: "paren",
    text: "今天是不是很开心呀(laughs)，当然了！",
    control: "今天是不是很开心呀，当然了！",
  },
  {
    id: "laughs-bracket",
    tag: "[laughs]",
    syntax: "bracket",
    text: "今天是不是很开心呀[laughs]，当然了！",
    control: "今天是不是很开心呀，当然了！",
  },
  {
    id: "sighs-paren",
    tag: "(sighs)",
    syntax: "paren",
    text: "算了(sighs)，先这样。",
    control: "算了，先这样。",
  },
  {
    id: "sighs-bracket",
    tag: "[sighs]",
    syntax: "bracket",
    text: "算了[sighs]，先这样。",
    control: "算了，先这样。",
  },
  {
    id: "breath-paren",
    tag: "(breath)",
    syntax: "paren",
    text: "等一下(breath)找到了。",
    control: "等一下找到了。",
  },
  {
    id: "breath-bracket",
    tag: "[breath]",
    syntax: "bracket",
    text: "等一下[breath]找到了。",
    control: "等一下找到了。",
  },
];

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

function redact(value) {
  return String(value ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .replace(/\beyJ[A-Za-z0-9._-]+/g, "[jwt-redacted]")
    .replace(/[A-Za-z0-9+/_-]{40,}/g, "[long-token]");
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, p) {
  const sorted = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return Math.round(sorted[lo]);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

function hexToBuffer(hex) {
  const cleaned = String(hex || "")
    .trim()
    .replace(/\s+/g, "");
  if (!cleaned) return Buffer.alloc(0);
  if (cleaned.length % 2 !== 0) {
    throw new Error("odd-length hex audio");
  }
  return Buffer.from(cleaned, "hex");
}

function slug(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "-");
}

function sentenceFile(engine, model, sentenceId, variant) {
  return join(
    AUDIO_DIR,
    `${slug(engine)}-${slug(model)}-s${String(sentenceId).padStart(2, "0")}-${slug(variant)}.mp3`
  );
}

function afinfoDurationMs(path) {
  try {
    const out = execFileSync("afinfo", [path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const match = out.match(/estimated duration:\s+([0-9.]+)\s+sec/i);
    if (!match) return null;
    return Math.round(Number(match[1]) * 1000);
  } catch {
    return null;
  }
}

function collectJsonStrings(value, into = []) {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) collectJsonStrings(item, into);
  else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectJsonStrings(item, into);
  }
  return into;
}

function subtitleContainsTag(subtitleText, tag) {
  if (!subtitleText) return null;
  const lower = subtitleText.toLowerCase();
  const raw = tag.toLowerCase();
  const inner = raw.replace(/[()[\]（）]/g, "");
  const hits = [raw, inner, `[${inner}]`, `(${inner})`];
  if (inner === "laughs") hits.push("笑声", "laugh");
  if (inner === "sighs") hits.push("叹气", "sigh");
  if (inner === "breath") hits.push("换气", "breath");
  return hits.some((h) => h && lower.includes(h));
}

async function fetchSubtitleText(url) {
  if (!url || typeof url !== "string" || !/^https?:/i.test(url)) return "";
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return "";
    const text = await res.text();
    try {
      return collectJsonStrings(JSON.parse(text)).join("\n");
    } catch {
      return text;
    }
  } catch {
    return "";
  }
}

function parseSseOrJsonLines(chunk, carry) {
  carry.buf += chunk;
  const events = [];
  while (true) {
    const nl = carry.buf.indexOf("\n");
    if (nl < 0) break;
    let line = carry.buf.slice(0, nl);
    carry.buf = carry.buf.slice(nl + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const trimmed = line.trim();
    if (!trimmed) continue;
    let payload = trimmed.startsWith("data:")
      ? trimmed.slice(5).trim()
      : trimmed;
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      carry.partial = (carry.partial || "") + payload;
      try {
        events.push(JSON.parse(carry.partial));
        carry.partial = "";
      } catch {
        /* keep accumulating */
      }
    }
  }
  return events;
}

function flushSseCarry(carry) {
  const rest = (carry.buf + (carry.partial || "")).trim();
  carry.buf = "";
  carry.partial = "";
  if (!rest) return [];
  const payload = rest.startsWith("data:") ? rest.slice(5).trim() : rest;
  if (!payload || payload === "[DONE]") return [];
  try {
    return [JSON.parse(payload)];
  } catch {
    return [];
  }
}

async function readSseJson(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const carry = { buf: "", partial: "" };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const events = parseSseOrJsonLines(decoder.decode(value, { stream: true }), carry);
    for (const event of events) await onEvent(event);
  }
  for (const event of flushSseCarry(carry)) await onEvent(event);
}

async function readBinaryFirstByte(response, onFirst, onChunk) {
  const reader = response.body.getReader();
  const chunks = [];
  let first = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength) {
      if (!first) {
        first = true;
        onFirst();
      }
      const buf = Buffer.from(value);
      chunks.push(buf);
      onChunk?.(buf);
    }
  }
  return Buffer.concat(chunks);
}

function minimaxError(payload, httpStatus) {
  const code = payload?.base_resp?.status_code;
  const msg = payload?.base_resp?.status_msg || payload?.error || "";
  if (code !== undefined && code !== 0) {
    return `base_resp ${code}: ${redact(msg)}`;
  }
  if (httpStatus && httpStatus >= 400) return `http ${httpStatus}`;
  return null;
}

async function callMiniMax(env, { model, text, stream, emotion, subtitle }) {
  const url = (env.MINIMAX_TTS_URL || MINIMAX_DEFAULT_URL).replace(/\/$/, "");
  const highQuality = String(model).endsWith("-hd");
  const voiceSetting = {
    voice_id: env.MINIMAX_VOICE_ID,
    speed: 1.0,
    vol: 1.0,
    pitch: 0,
  };
  if (emotion) voiceSetting.emotion = emotion;
  const body = {
    model,
    text,
    stream: Boolean(stream),
    language_boost: "Chinese",
    output_format: "hex",
    voice_setting: voiceSetting,
    audio_setting: {
      sample_rate: highQuality ? 44100 : 32000,
      bitrate: highQuality ? 256000 : 128000,
      format: "mp3",
      channel: 1,
    },
    subtitle_enable: Boolean(subtitle),
  };
  if (stream) body.stream_options = { exclude_aggregated_audio: true };

  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MINIMAX_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const httpStatus = response.status;
  const result = {
    httpStatus,
    tFirst: null,
    tTotal: null,
    audio: Buffer.alloc(0),
    extraInfo: null,
    subtitleFile: "",
    subtitleText: "",
    error: null,
    host: hostnameOf(url),
  };

  if (stream) {
    const chunks = [];
    let firstError = null;
    await readSseJson(response, (event) => {
      const err = minimaxError(event, 0);
      if (err && !firstError) firstError = err;
      const hex = event?.data?.audio;
      if (hex) {
        const buf = hexToBuffer(hex);
        if (buf.length) {
          if (result.tFirst == null) result.tFirst = Math.round(performance.now() - started);
          chunks.push(buf);
        }
      }
      if (event?.extra_info) result.extraInfo = event.extra_info;
      if (event?.data?.subtitle_file) result.subtitleFile = event.data.subtitle_file;
    });
    result.tTotal = Math.round(performance.now() - started);
    result.audio = Buffer.concat(chunks);
    result.error =
      firstError ||
      (!response.ok ? `http ${httpStatus}` : null) ||
      (result.audio.length === 0 ? "no audio bytes" : null);
    return result;
  }

  const raw = await response.text();
  result.tTotal = Math.round(performance.now() - started);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    result.error = response.ok
      ? "non-JSON body"
      : `http ${httpStatus} non-JSON`;
    return result;
  }
  result.error = minimaxError(payload, httpStatus);
  result.extraInfo = payload?.extra_info || null;
  result.subtitleFile = payload?.data?.subtitle_file || "";
  const hex = payload?.data?.audio || payload?.audio || "";
  if (hex) {
    result.audio = hexToBuffer(hex);
    result.tFirst = result.tTotal;
  } else if (!result.error) {
    result.error = "no audio field";
  }
  return result;
}

function stepfunErrorFromJson(payload, httpStatus) {
  if (!payload) return httpStatus >= 400 ? `http ${httpStatus}` : null;
  const msg =
    payload.error?.message ||
    payload.message ||
    payload.msg ||
    payload.base_resp?.status_msg ||
    "";
  if (httpStatus >= 400) return `http ${httpStatus}${msg ? `: ${redact(msg)}` : ""}`;
  return msg ? redact(msg) : null;
}

async function callStepFun(env, url, { model, text, stream, instruction, voiceLabel, timestamp }) {
  const body = {
    model,
    input: text,
    voice: STEPFUN_VOICE,
    response_format: "mp3",
    speed: 1.0,
    volume: 1.0,
    text_normalization: "standard",
  };
  if (instruction) body.instruction = instruction;
  if (voiceLabel) body.voice_label = voiceLabel;
  if (stream) {
    body.stream_format = "sse";
    if (timestamp) body.timestamp = true;
  } else if (timestamp) {
    body.return_url = true;
    body.timestamp = true;
  }

  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STEPFUN_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const httpStatus = response.status;
  const result = {
    httpStatus,
    tFirst: null,
    tTotal: null,
    audio: Buffer.alloc(0),
    extraInfo: null,
    subtitleText: "",
    error: null,
    host: hostnameOf(url),
    contentType: response.headers.get("content-type") || "",
  };

  const ctype = result.contentType.toLowerCase();
  const looksJson = ctype.includes("json");
  const looksSse = ctype.includes("event-stream") || stream;

  if (stream && (looksSse || looksJson || ctype === "")) {
    const chunks = [];
    const subtitles = [];
    let firstError = null;
    await readSseJson(response, (event) => {
      const type = event?.type || "";
      if (type === "speech.audio.error" || event?.error) {
        firstError =
          firstError ||
          redact(event?.error?.message || event?.message || type || "sse error");
      }
      if (type === "speech.audio.delta" && event.audio) {
        const buf = Buffer.from(event.audio, "base64");
        if (buf.length) {
          if (result.tFirst == null) result.tFirst = Math.round(performance.now() - started);
          chunks.push(buf);
        }
      }
      if (type === "response.subtitle") {
        subtitles.push(event.data || event);
      }
      if (event?.data?.url && !event?.audio) {
        result.extraInfo = { url: event.data.url };
      }
    });
    result.tTotal = Math.round(performance.now() - started);
    result.audio = Buffer.concat(chunks);
    result.subtitleText = collectJsonStrings(subtitles).join("\n");
    result.error =
      firstError ||
      (!response.ok ? `http ${httpStatus}` : null) ||
      (result.audio.length === 0 ? "no audio bytes" : null);
    return result;
  }

  if (looksJson || (!stream && timestamp)) {
    const raw = await response.text();
    result.tTotal = Math.round(performance.now() - started);
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      result.error = `http ${httpStatus} non-JSON`;
      return result;
    }
    result.error = stepfunErrorFromJson(payload, httpStatus);
    result.subtitleText = collectJsonStrings(payload?.data?.subtitles || []).join("\n");
    const audioUrl = payload?.data?.url;
    if (audioUrl && /^https?:/i.test(audioUrl)) {
      const audioRes = await fetch(audioUrl, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      result.audio = Buffer.from(await audioRes.arrayBuffer());
      result.tFirst = result.tTotal;
      if (!audioRes.ok && !result.error) result.error = `audio url http ${audioRes.status}`;
    } else if (!result.error) {
      result.error = "no audio url/bytes";
    }
    return result;
  }

  if (!response.ok) {
    const raw = await response.text();
    result.tTotal = Math.round(performance.now() - started);
    try {
      result.error = stepfunErrorFromJson(JSON.parse(raw), httpStatus);
    } catch {
      result.error = `http ${httpStatus}`;
    }
    return result;
  }

  result.audio = await readBinaryFirstByte(response, () => {
    result.tFirst = Math.round(performance.now() - started);
  });
  result.tTotal = Math.round(performance.now() - started);
  if (!result.audio.length) result.error = "empty body";
  return result;
}

async function withRetries(label, fn) {
  let last = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const out = await fn();
      if (out && !out.error) return { ...out, retries: attempt };
      last = out;
      const retryable =
        !out ||
        out.error?.includes("http 401") ||
        out.error?.includes("http 403") ||
        out.error?.includes("http 408") ||
        out.error?.includes("http 429") ||
        out.error?.includes("http 5") ||
        out.error?.includes("base_resp 1001") ||
        out.error?.includes("base_resp 1002") ||
        out.error?.includes("base_resp 1039") ||
        out.error?.includes("timeout") ||
        out.error?.includes("fetch") ||
        out.error?.includes("network") ||
        out.error?.includes("no audio");
      if (!retryable || attempt === MAX_RETRIES) {
        return { ...(out || { error: "empty" }), retries: attempt };
      }
      const rateLimited =
        out?.error?.includes("429") ||
        out?.error?.includes("1002") ||
        out?.error?.includes("1039") ||
        /rate limit/i.test(out?.error || "");
      const wait = rateLimited ? 8000 * (attempt + 1) : 500 * (attempt + 1);
      console.error(`[retry ${attempt + 1}/${MAX_RETRIES}] ${label}: ${out.error}`);
      await sleep(wait);
    } catch (err) {
      last = {
        error: redact(err.name === "TimeoutError" ? "timeout" : err.message),
        httpStatus: 0,
        tFirst: null,
        tTotal: null,
        audio: Buffer.alloc(0),
        retries: attempt,
      };
      if (attempt === MAX_RETRIES) return last;
      console.error(`[retry ${attempt + 1}/${MAX_RETRIES}] ${label}: ${last.error}`);
      await sleep(400 * (attempt + 1));
    }
  }
  return last;
}

function recordFromCall(meta, call, path) {
  const measured = path && existsSync(path) ? afinfoDurationMs(path) : null;
  const duration = call.extraInfo?.audio_length ?? measured;
  const tTotal = call.tTotal;
  return {
    ...meta,
    ok: Boolean(call.audio?.length) && !call.error,
    http_status: call.httpStatus ?? null,
    error: call.error || null,
    retries: call.retries ?? 0,
    host: call.host || null,
    t_first_audio_ms: call.tFirst,
    t_total_ms: tTotal,
    audio_duration_ms: duration,
    realtime_factor:
      duration && tTotal ? Number((tTotal / duration).toFixed(3)) : null,
    audio_bytes: call.audio?.length || 0,
    extra_info_audio_length_ms: call.extraInfo?.audio_length ?? null,
    subtitle_text_excerpt: (call.subtitleText || "").slice(0, 400),
    tag_in_subtitle: meta.tag
      ? subtitleContainsTag(call.subtitleText || "", meta.tag)
      : null,
    audio_path: path && existsSync(path) ? path.replace(ROOT + "/", "") : null,
  };
}

function saveAudio(path, buffer) {
  if (!buffer?.length) return false;
  writeFileSync(path, buffer);
  return true;
}

function summarize(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = [
      run.engine,
      run.model,
      run.mode,
      `s${run.sentence_id}`,
      run.variant,
    ].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const rows = [];
  for (const [key, list] of groups) {
    const ok = list.filter((r) => r.ok);
    const firsts = ok.map((r) => r.t_first_audio_ms);
    const totals = ok.map((r) => r.t_total_ms);
    const durs = ok.map((r) => r.audio_duration_ms);
    const rtfs = ok.map((r) => r.realtime_factor);
    rows.push({
      key,
      engine: list[0].engine,
      model: list[0].model,
      mode: list[0].mode,
      sentence_id: list[0].sentence_id,
      variant: list[0].variant,
      n: list.length,
      n_ok: ok.length,
      t_first_p50: percentile(firsts, 0.5),
      t_first_p95: percentile(firsts, 0.95),
      t_total_p50: percentile(totals, 0.5),
      t_total_p95: percentile(totals, 0.95),
      audio_duration_p50: percentile(durs, 0.5),
      realtime_factor_p50: (() => {
        const p = percentile(
          rtfs.filter((n) => n != null).map((n) => n * 1000),
          0.5
        );
        return p == null ? null : Number((p / 1000).toFixed(3));
      })(),
      errors: [...new Set(list.filter((r) => !r.ok).map((r) => r.error))].slice(0, 4),
    });
  }
  return rows;
}

function mdTable(headers, rows) {
  const line = (cells) => `| ${cells.join(" | ")} |`;
  const out = [line(headers), line(headers.map(() => "---"))];
  for (const row of rows) out.push(line(row.map((c) => (c == null || c === "" ? "—" : String(c)))));
  return out.join("\n");
}

function pickRecommendation(summary, emotionRows, tagRows, models) {
  const s1Stream = summary.filter(
    (r) => r.sentence_id === 1 && r.variant === "neutral" && r.mode.includes("stream") && r.n_ok >= 8
  );
  const ranked = [...s1Stream].sort(
    (a, b) => (a.t_first_p50 ?? 1e9) - (b.t_first_p50 ?? 1e9)
  );
  const best = ranked[0];
  const minimax28 = (models.minimax || []).some((m) => m.includes("2.8"));
  const parenRendered = tagRows.filter(
    (t) => t.syntax === "paren" && t.ok && t.tag_in_subtitle === false
  );
  const bracketRead = tagRows.filter(
    (t) => t.syntax === "bracket" && t.tag_in_subtitle === true
  );
  const lines = [];
  if (best) {
    lines.push(
      `Streaming default: **${best.engine} ${best.model}** (${best.mode}), s1 ack t_first p50=${best.t_first_p50} ms / p95=${best.t_first_p95} ms (${best.n_ok}/${best.n} ok).`
    );
  } else {
    lines.push("Streaming default: no engine produced ≥8/10 successful s1 stream runs.");
  }
  if (minimax28 && parenRendered.length) {
    lines.push(
      `MiniMax 2.8 inline tags use half-width parentheses such as \`(laughs)\` / \`(sighs)\` / \`(breath)\` (docs: platform.minimax.io T2A HTTP). ${parenRendered.length} paren probes produced audio without the tag string in subtitles.`
    );
  }
  if (bracketRead.length) {
    lines.push(
      `Square-bracket forms like \`[laughs]\` are not documented; ${bracketRead.length} bracket probes put the tag text into subtitles (read-aloud).`
    );
  }
  lines.push(
    "Yishu already emits one spoken sentence at a time. Drive mood from the sentence text (provider auto) plus rare official inline tags on MiniMax 2.8; do not send a whole-turn emotion param that would paint later sentences the wrong color. StepAudio 2.5 `instruction` is global per request — fine per sentence, but inline `（…）` is the local control. step-tts-mini uses `voice_label.emotion` and has no inline markup."
  );
  return lines.join(" ");
}

function writeMarkdown(report) {
  const latency = report.summary.filter((r) => r.variant === "neutral");
  const s1 = latency.filter((r) => r.sentence_id === 1);
  const bySentence = latency.filter((r) => r.mode === report.primary_stream_mode_minimax || r.mode === report.primary_stream_mode_stepfun || r.mode.includes("stream"));
  const emotion = report.summary.filter((r) => r.variant !== "neutral" && r.sentence_id >= 3);
  const md = `# exp3 TTS — MiniMax vs StepFun (2026-09-04)

## Method

Companion voice bake-off for 奕枢. Two vendors with keys on this machine: MiniMax t2a_v2 and StepFun HTTP TTS. No other vendors.

- Node 22 \`fetch\`. Secrets parsed at runtime from \`apps/clicky/worker/.dev.vars\`; values never written.
- MiniMax request copied from \`apps/clicky/worker/local-server.mjs\` (model/voice/url/audio_setting/language_boost). Product currently sends \`stream:false\`; this run also measures \`stream:true\` hex SSE chunks with \`stream_options.exclude_aggregated_audio=true\`.
- MiniMax models tried: ${report.probes.minimax_tried.join(", ") || "—"}. In use: ${(report.models.minimax || []).join(", ") || "—"}. Voice id length ${report.config.minimax_voice_id_len}. Host \`${report.config.minimax_host}\`.
- StepFun endpoint tried: ${report.probes.stepfun_urls_tried.join(", ")}. Locked: \`${report.config.stepfun_url || "none"}\`. Models tried: ${report.probes.stepfun_tried.join(", ") || "—"}. In use: ${(report.models.stepfun || []).join(", ") || "—"}. Voice \`${STEPFUN_VOICE}\` (${STEPFUN_VOICE_NOTE}).
- t_first_audio_ms = request start → first usable audio bytes (MiniMax: first non-empty hex chunk decoded; StepFun SSE: first base64 delta; non-stream MiniMax: full JSON parse, so t_first ≈ t_total).
- Duration via macOS \`afinfo\` (no playback). realtime_factor = t_total / audio_duration.
- Sentence 1: 10 runs; sentences 2–6: 5 runs. Emotion A/B on 3–6 also 5 runs, streaming only. Max 2 retries. Unreachable/unauthorized recorded as a row.
- MiniMax emotion enum from T2A docs: happy/sad/angry/fearful/disgusted/surprised/calm/fluent/whisper. \`fluent\`/\`whisper\` documented as 2.6-only; 2.8 does not support \`whisper\`.
- MiniMax 2.8 interjections (docs): \`(laughs)\` \`(chuckle)\` \`(coughs)\` \`(clear-throat)\` \`(groans)\` \`(breath)\` \`(pant)\` \`(inhale)\` \`(exhale)\` \`(gasps)\` \`(sniffs)\` \`(sighs)\` \`(snorts)\` \`(burps)\` \`(lip-smacking)\` \`(humming)\` \`(hissing)\` \`(emm)\` \`(sneezes)\`. Bracket forms were probed because the brief used \`[laughs]\`.
- StepFun 2.5: global \`instruction\` + inline full-width \`（…）\` (not spoken). \`step-tts-mini\`: \`voice_label.emotion\` (高兴/悲伤/…). HTTP \`stream_format=sse\`; WebSocket \`/v1/realtime/audio\` exists but docs warn 2.5 WS quality is worse than HTTP — not used.

## s1 ack first-audio (「嗯，在。」)

${mdTable(
    ["engine", "model", "mode", "n_ok", "t_first p50", "t_first p95", "t_total p50", "dur p50", "rtf p50"],
    s1.map((r) => [
      r.engine,
      r.model,
      r.mode,
      `${r.n_ok}/${r.n}`,
      r.t_first_p50,
      r.t_first_p95,
      r.t_total_p50,
      r.audio_duration_p50,
      r.realtime_factor_p50,
    ])
  )}

## Neutral latency by sentence (streaming)

${mdTable(
    ["engine", "model", "s", "n_ok", "t_first p50", "t_first p95", "t_total p50", "dur p50"],
    bySentence
      .filter((r) => r.variant === "neutral" && (r.mode === "stream" || r.mode === "sse"))
      .map((r) => [
        r.engine,
        r.model,
        r.sentence_id,
        `${r.n_ok}/${r.n}`,
        r.t_first_p50,
        r.t_first_p95,
        r.t_total_p50,
        r.audio_duration_p50,
      ])
  )}

## Emotion controls (objective)

Request accepted, audio produced, duration delta vs same-sentence neutral (p50 ms). Tag-in-subtitle uses returned subtitle/transcript fields when present (\`null\` = no subtitle field).

${mdTable(
    ["engine", "model", "s", "variant", "n_ok", "dur p50", "Δdur vs neutral", "accepted"],
    emotion.map((r) => {
      const neu = report.summary.find(
        (n) =>
          n.engine === r.engine &&
          n.model === r.model &&
          n.sentence_id === r.sentence_id &&
          n.variant === "neutral" &&
          String(n.mode).includes("stream")
      );
      const delta =
        r.audio_duration_p50 != null && neu?.audio_duration_p50 != null
          ? r.audio_duration_p50 - neu.audio_duration_p50
          : null;
      return [
        r.engine,
        r.model,
        r.sentence_id,
        r.variant,
        `${r.n_ok}/${r.n}`,
        r.audio_duration_p50,
        delta,
        r.n_ok ? "yes" : `no ${r.errors.join("; ")}`,
      ];
    })
  )}

### MiniMax emotion param sweep

${mdTable(
    ["model", "emotion", "http/base", "audio", "dur_ms"],
    (report.emotion_sweep || []).map((r) => [
      r.model,
      r.emotion,
      r.error || r.http_status,
      r.ok ? "yes" : "no",
      r.audio_duration_ms,
    ])
  )}

### Inline tag syntax (MiniMax 2.8 docs = parentheses)

${mdTable(
    ["model", "probe", "syntax", "ok", "dur_ms", "control_dur_ms", "Δdur", "tag in subtitle"],
    (report.tag_probes || []).map((r) => [
      r.model,
      r.probe_id,
      r.syntax,
      r.ok ? "yes" : r.error,
      r.audio_duration_ms,
      r.control_duration_ms,
      r.duration_delta_ms,
      r.tag_in_subtitle == null ? "no subtitle field" : r.tag_in_subtitle ? "yes (read aloud?)" : "no (not in transcript)",
    ])
  )}

## Caveats

- First-audio is network + vendor queue + codec. One machine, one region, one evening.
- MiniMax non-stream packs audio in a JSON hex field, so t_first equals t_total by construction.
- StepFun 2.5 HTTP SSE was used for streaming; WebSocket realtime TTS was not measured (docs: quality may be much worse than HTTP).
- Duration delta is a proxy, not a listening score. Owner blind-listens \`.work/voice-experiments/tts/blind/\`.
- MiniMax uses the product clone voice; StepFun uses stock \`${STEPFUN_VOICE}\`. Timbre is not a fair A/B — latency and controllability are.
- Product emotion allowlist is currently happy/sad/angry/fearful/disgusted/surprised/neutral (no calm/fluent/whisper).

## Recommendation

${report.recommendation}

## Paths

- Runner: \`evals/voice/exp3-tts/run.mjs\`
- JSON: \`evals/voice/results/2026-09-04-exp3-tts.json\`
- Audio: \`.work/voice-experiments/tts/\`
- Blind listen: \`.work/voice-experiments/tts/blind/\`  (map: \`.work/voice-experiments/tts/blind/blind-key.json\`)
`;
  writeFileSync(RESULTS_MD, md);
}

async function probeMiniMax(env) {
  const tried = [];
  const ok = [];
  const failures = [];
  const fallback = {
    "speech-2.8-turbo": "speech-2.6-turbo",
    "speech-2.8-hd": "speech-2.6-hd",
  };
  for (const model of ["speech-2.8-turbo", "speech-2.8-hd"]) {
    tried.push(model);
    const call = await withRetries(`probe ${model}`, () =>
      callMiniMax(env, { model, text: "嗯。", stream: false })
    );
    if (call.audio?.length && !call.error) {
      ok.push(model);
      continue;
    }
    const fb = fallback[model];
    tried.push(fb);
    const call2 = await withRetries(`probe ${fb}`, () =>
      callMiniMax(env, { model: fb, text: "嗯。", stream: false })
    );
    if (call2.audio?.length && !call2.error) ok.push(fb);
    else failures.push({ wanted: model, fallback: fb, error: call.error || call2.error, http: call.httpStatus });
  }
  return { tried, ok, failures };
}

async function probeStepFun(env) {
  const triedModels = [];
  const urlsTried = [];
  let url = null;
  const models = [];
  for (const candidate of STEPFUN_SPEECH_URLS) {
    urlsTried.push(hostnameOf(candidate) + new URL(candidate).pathname);
    const call = await withRetries(`probe step url`, () =>
      callStepFun(env, candidate, {
        model: "stepaudio-2.5-tts",
        text: "嗯。",
        stream: false,
      })
    );
    triedModels.push("stepaudio-2.5-tts");
    if (call.audio?.length && !call.error) {
      url = candidate;
      models.push("stepaudio-2.5-tts");
      break;
    }
    const mini = await withRetries(`probe step-tts-mini ${hostnameOf(candidate)}`, () =>
      callStepFun(env, candidate, {
        model: "step-tts-mini",
        text: "嗯。",
        stream: false,
      })
    );
    triedModels.push("step-tts-mini");
    if (mini.audio?.length && !mini.error) {
      url = candidate;
      models.push("step-tts-mini");
      break;
    }
  }
  const failures = [];
  if (url) {
    for (const extra of ["stepaudio-2.5-tts", "step-tts-mini", "step-tts-2"]) {
      if (models.includes(extra)) continue;
      triedModels.push(extra);
      const call = await withRetries(`probe ${extra}`, () =>
        callStepFun(env, url, { model: extra, text: "嗯。", stream: false })
      );
      if (call.audio?.length && !call.error) models.push(extra);
      else failures.push({ model: extra, error: call.error, http: call.httpStatus });
    }
  }
  return { url, triedModels, urlsTried, models, failures };
}

function writePartial(report) {
  mkdirSync(AUDIO_DIR, { recursive: true });
  writeFileSync(PARTIAL_JSON, JSON.stringify(report, null, 2));
}

function writeBlind(files) {
  mkdirSync(BLIND_DIR, { recursive: true });
  const used = new Set();
  const items = [];
  for (const file of files) {
    let id;
    do {
      id = randomBytes(4).toString("hex");
    } while (used.has(id));
    used.add(id);
    const dest = join(BLIND_DIR, `${id}.mp3`);
    copyFileSync(file.path, dest);
    items.push({
      id,
      file: `${id}.mp3`,
      source: file.path.replace(ROOT + "/", ""),
      engine: file.engine,
      model: file.model,
      sentence_id: file.sentence_id,
      variant: file.variant,
      text: file.text,
    });
  }
  const shuffled = [...items].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(
    join(BLIND_DIR, "blind-key.json"),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        listen_order: shuffled.map((i) => i.file),
        items: shuffled,
      },
      null,
      2
    )
  );
  return shuffled.length;
}

async function main() {
  mkdirSync(AUDIO_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });
  const env = loadDevVars(DEV_VARS);
  if (!env.MINIMAX_API_KEY) throw new Error("MINIMAX_API_KEY missing");
  if (!env.STEPFUN_API_KEY) throw new Error("STEPFUN_API_KEY missing");

  const report = {
    date: "2026-09-04",
    experiment: "exp3-tts",
    config: {
      node: process.version,
      minimax_host: hostnameOf(env.MINIMAX_TTS_URL || MINIMAX_DEFAULT_URL),
      minimax_model_env: env.MINIMAX_TTS_MODEL || null,
      minimax_voice_id_len: (env.MINIMAX_VOICE_ID || "").length,
      minimax_key_len: env.MINIMAX_API_KEY.length,
      stepfun_key_len: env.STEPFUN_API_KEY.length,
      stepfun_voice: STEPFUN_VOICE,
      stepfun_url: null,
    },
    docs: {
      minimax_t2a:
        "https://platform.minimax.io/docs/api-reference/speech-t2a-http",
      minimax_cn: "https://platform.minimaxi.com/docs/api-reference/speech-t2a-http",
      stepfun_speech:
        "https://platform.stepfun.com/docs/zh/api-reference/audio/create-audio",
      stepfun_25:
        "https://platform.stepfun.com/docs/zh/guides/models/stepaudio-2.5-tts",
      stepfun_voices:
        "https://platform.stepfun.com/docs/zh/api-reference/audio/system-voices",
      inline_tags_official:
        "(laughs) (sighs) (breath) — MiniMax speech-2.8 only; not [laughs]",
    },
    probes: {
      minimax_tried: [],
      stepfun_tried: [],
      stepfun_urls_tried: [],
    },
    models: { minimax: [], stepfun: [] },
    runs: [],
    emotion_sweep: [],
    tag_probes: [],
    summary: [],
    saved_audio: [],
    recommendation: "",
    primary_stream_mode_minimax: "stream",
    primary_stream_mode_stepfun: "sse",
  };

  console.error("probe MiniMax models…");
  const mm = await probeMiniMax(env);
  report.probes.minimax_tried = mm.tried;
  report.models.minimax = mm.ok;
  report.probes.minimax_failures = mm.failures;
  console.error(
    `MiniMax models: ${report.models.minimax.join(", ") || "NONE"} (key_len=${report.config.minimax_key_len})`
  );

  console.error("probe StepFun endpoint/models…");
  const st = await probeStepFun(env);
  report.probes.stepfun_tried = st.triedModels;
  report.probes.stepfun_urls_tried = st.urlsTried;
  report.models.stepfun = st.models;
  report.probes.stepfun_failures = st.failures;
  report.config.stepfun_url = st.url;
  console.error(
    `StepFun url host=${st.url ? hostnameOf(st.url) : "NONE"} models=${st.models.join(", ") || "NONE"} (key_len=${report.config.stepfun_key_len})`
  );

  const jobs = [];

  for (const model of report.models.minimax) {
    for (const mode of ["stream", "nostream"]) {
      for (const s of SENTENCES) {
        jobs.push({
          engine: "minimax",
          model,
          mode,
          sentence_id: s.id,
          variant: "neutral",
          text: s.text,
          runs: s.runs,
          stream: mode === "stream",
          save: true,
          saveVariant: mode === "stream" ? "neutral" : "neutral-nostream",
        });
      }
    }
    for (const s of SENTENCES.filter((x) => x.id >= 3)) {
      jobs.push({
        engine: "minimax",
        model,
        mode: "stream",
        sentence_id: s.id,
        variant: "emotion-param",
        text: s.text,
        emotion: MINIMAX_PARAM_BY_SENTENCE[s.id],
        runs: 5,
        stream: true,
        save: true,
      });
      jobs.push({
        engine: "minimax",
        model,
        mode: "stream",
        sentence_id: s.id,
        variant: "emotion-inline",
        text: MINIMAX_INLINE_BY_SENTENCE[s.id],
        runs: 5,
        stream: true,
        save: true,
        subtitle: true,
        tag: MINIMAX_INLINE_BY_SENTENCE[s.id].match(/\([^)]+\)|<#[^#]+#>/)?.[0],
      });
    }
  }

  for (const model of report.models.stepfun) {
    const is25 = model.includes("2.5");
    for (const mode of ["sse", "nostream"]) {
      for (const s of SENTENCES) {
        jobs.push({
          engine: "stepfun",
          model,
          mode,
          sentence_id: s.id,
          variant: "neutral",
          text: s.text,
          runs: s.runs,
          stream: mode === "sse",
          save: true,
          saveVariant: mode === "sse" ? "neutral" : "neutral-nostream",
        });
      }
    }
    for (const s of SENTENCES.filter((x) => x.id >= 3)) {
      jobs.push({
        engine: "stepfun",
        model,
        mode: "sse",
        sentence_id: s.id,
        variant: "emotion-param",
        text: s.text,
        instruction: is25 ? STEPFUN_INSTRUCTION_BY_SENTENCE[s.id] : undefined,
        voiceLabel: is25
          ? undefined
          : { emotion: STEPFUN_MINI_EMOTION_BY_SENTENCE[s.id] },
        runs: 5,
        stream: true,
        save: true,
      });
      if (is25) {
        jobs.push({
          engine: "stepfun",
          model,
          mode: "sse",
          sentence_id: s.id,
          variant: "emotion-inline",
          text: STEPFUN_INLINE_BY_SENTENCE[s.id],
          runs: 5,
          stream: true,
          save: true,
          timestamp: true,
          tag: STEPFUN_INLINE_BY_SENTENCE[s.id].match(/（[^）]+）/)?.[0],
        });
      }
    }
  }

  let done = 0;
  const totalRuns = jobs.reduce((n, j) => n + j.runs, 0);
  const saved = [];

  for (const job of jobs) {
    const canonical = sentenceFile(
      job.engine,
      job.model,
      job.sentence_id,
      job.saveVariant || job.variant
    );
    for (let i = 1; i <= job.runs; i++) {
      done += 1;
      const label = `${job.engine} ${job.model} ${job.mode} s${job.sentence_id} ${job.variant} ${i}/${job.runs}`;
      const call = await withRetries(label, async () => {
        if (job.engine === "minimax") {
          return callMiniMax(env, {
            model: job.model,
            text: job.text,
            stream: job.stream,
            emotion: job.emotion,
            subtitle: job.subtitle,
          });
        }
        return callStepFun(env, report.config.stepfun_url, {
          model: job.model,
          text: job.text,
          stream: job.stream,
          instruction: job.instruction,
          voiceLabel: job.voiceLabel,
          timestamp: job.timestamp,
        });
      });
      if (job.subtitle && call.subtitleFile) {
        call.subtitleText =
          (call.subtitleText || "") + "\n" + (await fetchSubtitleText(call.subtitleFile));
      }
      const tmp = join(AUDIO_DIR, "_run.mp3");
      let path = null;
      if (call.audio?.length) {
        saveAudio(tmp, call.audio);
        path = tmp;
        if (job.save && (i === 1 || !existsSync(canonical))) {
          saveAudio(canonical, call.audio);
          if (i === 1) {
            saved.push({
              path: canonical,
              engine: job.engine,
              model: job.model,
              sentence_id: job.sentence_id,
              variant: job.saveVariant || job.variant,
              text: job.text,
            });
          }
        }
      }
      const rec = recordFromCall(
        {
          engine: job.engine,
          model: job.model,
          mode: job.mode,
          sentence_id: job.sentence_id,
          variant: job.variant,
          run_index: i,
          tag: job.tag || null,
          emotion: job.emotion || job.instruction || job.voiceLabel?.emotion || null,
        },
        call,
        path
      );
      report.runs.push(rec);
      console.error(
        `[${done}/${totalRuns}] ${label} ok=${rec.ok} t_first=${rec.t_first_audio_ms} t_total=${rec.t_total_ms} dur=${rec.audio_duration_ms} err=${rec.error || ""}`
      );
      await sleep(GAP_MS);
      if (done % 15 === 0) {
        report.summary = summarize(report.runs);
        writePartial(report);
      }
    }
  }

  console.error("MiniMax emotion param sweep…");
  for (const model of report.models.minimax) {
    for (const emotion of ["happy", "sad", "calm", "fluent", "whisper"]) {
      const call = await withRetries(`sweep ${model} ${emotion}`, () =>
        callMiniMax(env, {
          model,
          text: SENTENCES[1].text,
          stream: true,
          emotion,
        })
      );
      const path = join(
        AUDIO_DIR,
        `${slug("minimax")}-${slug(model)}-sweep-${slug(emotion)}.mp3`
      );
      if (call.audio?.length) saveAudio(path, call.audio);
      report.emotion_sweep.push(
        recordFromCall(
          {
            engine: "minimax",
            model,
            mode: "stream",
            sentence_id: 2,
            variant: `sweep-${emotion}`,
            emotion,
            run_index: 1,
          },
          call,
          existsSync(path) ? path : null
        )
      );
      await sleep(GAP_MS);
    }
  }

  console.error("MiniMax inline tag probes…");
  const tagModels = report.models.minimax.filter((m) => m.includes("2.8"));
  const probeModels = tagModels.length ? tagModels : report.models.minimax;
  for (const model of probeModels) {
    const controlCache = new Map();
    for (const probe of TAG_PROBES) {
      if (!controlCache.has(probe.control)) {
        const controlCall = await withRetries(`tag-control ${model}`, () =>
          callMiniMax(env, { model, text: probe.control, stream: true, subtitle: true })
        );
        const cpath = join(AUDIO_DIR, `${slug("minimax")}-${slug(model)}-tag-control.mp3`);
        if (controlCall.audio?.length) saveAudio(cpath, controlCall.audio);
        controlCache.set(probe.control, {
          dur: cpath && existsSync(cpath) ? afinfoDurationMs(cpath) : null,
        });
        await sleep(GAP_MS);
      }
      const call = await withRetries(`tag ${model} ${probe.id}`, () =>
        callMiniMax(env, {
          model,
          text: probe.text,
          stream: true,
          subtitle: true,
        })
      );
      if (call.subtitleFile) {
        call.subtitleText =
          (call.subtitleText || "") + "\n" + (await fetchSubtitleText(call.subtitleFile));
      }
      const path = join(
        AUDIO_DIR,
        `${slug("minimax")}-${slug(model)}-tag-${slug(probe.id)}.mp3`
      );
      if (call.audio?.length) {
        saveAudio(path, call.audio);
        saved.push({
          path,
          engine: "minimax",
          model,
          sentence_id: "tag",
          variant: probe.id,
          text: probe.text,
        });
      }
      const rec = recordFromCall(
        {
          engine: "minimax",
          model,
          mode: "stream",
          sentence_id: 0,
          variant: `tag-${probe.id}`,
          tag: probe.tag,
          run_index: 1,
        },
        call,
        existsSync(path) ? path : null
      );
      const controlDur = controlCache.get(probe.control)?.dur ?? null;
      report.tag_probes.push({
        ...rec,
        probe_id: probe.id,
        syntax: probe.syntax,
        tag: probe.tag,
        control_duration_ms: controlDur,
        duration_delta_ms:
          rec.audio_duration_ms != null && controlDur != null
            ? rec.audio_duration_ms - controlDur
            : null,
      });
      await sleep(GAP_MS);
    }
  }

  report.summary = summarize(report.runs);
  report.saved_audio = saved.map((s) => s.path.replace(ROOT + "/", ""));
  report.recommendation = pickRecommendation(
    report.summary,
    report.summary.filter((r) => r.variant !== "neutral"),
    report.tag_probes,
    report.models
  );
  writeBlind(saved.filter((s) => existsSync(s.path)));
  writeFileSync(RESULTS_JSON, JSON.stringify(report, null, 2));
  writeMarkdown(report);
  writePartial(report);
  console.error(`wrote ${RESULTS_JSON}`);
  console.error(`wrote ${RESULTS_MD}`);
  console.error(`audio ${AUDIO_DIR}`);
}

main().catch((err) => {
  console.error(redact(err.stack || err.message));
  process.exit(1);
});
