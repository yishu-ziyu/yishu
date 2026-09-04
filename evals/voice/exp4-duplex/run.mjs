#!/usr/bin/env node
/**
 * Throwaway full-duplex prototype: StepFun Realtime as mouth/ears,
 * ask_yishu as the Yishu brain. No product code is touched.
 *
 *   node evals/voice/exp4-duplex/run.mjs
 */
import { execFile } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import https from "node:https";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../..");
const DEV_VARS = join(REPO, "apps/clicky/worker/.dev.vars");
const WORK = join(REPO, ".work/voice-experiments/duplex");
const RESULTS_DIR = join(REPO, "evals/voice/results");
const RESULT_STAMP = "2026-09-04-exp4-duplex";

const PLAN_MODEL = "stepaudio-2.5-realtime";
const DEFAULT_VOICE = "linjiajiejie";
const FALLBACK_VOICE = "wenrounansheng";
const SAMPLE_RATE = 24000;
const CHUNK_MS = 100;
const VAD_SILENCE_MS = 700;
const BRAIN_DELAY_MS = 2500;
const MAX_RETRIES = 2;

function parseStepPlan(env) {
  const key = env.STEPFUN_STEP_PLAN_API_KEY;
  const base = String(env.STEPFUN_STEP_PLAN_BASE || "").replace(/\/$/, "");
  if (!key) throw new Error("STEPFUN_STEP_PLAN_API_KEY missing");
  if (!base) throw new Error("STEPFUN_STEP_PLAN_BASE missing");
  const u = new URL(base);
  const prefix = u.pathname.replace(/\/$/, "") || "/step_plan/v1";
  return {
    key,
    host: u.hostname,
    prefix,
    wsUrl: `wss://${u.hostname}${prefix}/realtime?model=${encodeURIComponent(PLAN_MODEL)}`,
    httpRealtimePath: `${prefix}/realtime?model=${encodeURIComponent(PLAN_MODEL)}`,
    httpModelsPath: `${prefix}/models`,
  };
}

const INSTRUCTIONS = `你是奕枢，一个住在用户 Mac 上的朋友，不是客服。说话短，像朋友，先应答一句再做事。凡是需要看屏幕、操作电脑、查资料、回忆过去聊过的内容，你自己都不知道，必须调用 ask_yishu 并等结果；等待时可以先说一句你在看。不要编造屏幕内容或记忆。`;

const FORCE_LINE =
  "涉及屏幕、操作、资料、回忆时你没有任何信息，唯一允许的动作是调用 ask_yishu；不许说“我看看”然后结束。";
const INSTRUCTIONS_S6 = `${INSTRUCTIONS}${FORCE_LINE}`;
const INSTRUCTIONS_S7 =
  "你不回答任何问题。你只做两件事：把用户说的话如实转写；当我发给你一段文字时，用自然、温暖的语气把它原样念出来，不增不减。";
const CANNED_S8 =
  "屏幕上是 Xcode 的签名错误，Signing and Capabilities 里 Team 没选，你打开那个页把团队勾上就能过。";
const VAD_DEFAULT = { type: "server_vad" };
const VAD_FAST = {
  type: "server_vad",
  prefix_padding_ms: 200,
  silence_duration_ms: 80,
  energy_awakeness_threshold: 1200,
};

const ASK_YISHU_DESC =
  "把需要看屏幕、动手操作、查资料或回忆过往对话的问题交给奕枢的大脑处理，返回文字答案。";
const ASK_YISHU_DESC_EN =
  "Hand off any question that needs the screen, computer actions, web lookup, or past conversation memory to Yishu's brain. Returns a text answer.";
const INSTRUCTIONS_EN =
  "You are Yishu, a friend living on the user's Mac, not a help desk. Always speak Mandarin Chinese to the user, short and warm, one short line first. You have NO access to the screen, the computer, the web, or past conversations yourself: for anything that needs them, you MUST call ask_yishu and wait; while waiting you may say one short Chinese line like 我看一下. Never invent screen contents or memories. For casual chat, answer directly without tools.";

const UTTERANCES = {
  U1: "今天有点累，你说我该早点睡吗？",
  U2: "帮我看看屏幕上这个报错是什么意思。",
  U3: "等一下，先别说了。",
  U4: "我上周跟你提过的那本书叫什么？",
  UH: "嗯？",
};

const BRAIN_S2 = "屏幕上是 Xcode 的签名错误，Signing & Capabilities 里 Team 没选。";
const BRAIN_S3 = "是《Her》的原著剧本集，你 8 月 28 日提过。";
const CANNED_S7 = {
  U1: "你今天先早点休息。",
  U2: BRAIN_S2,
  U4: BRAIN_S3,
};

const TOOL_OPENAI = [
  {
    type: "function",
    name: "ask_yishu",
    description: ASK_YISHU_DESC,
    parameters: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
  },
];
const TOOL_STEPFUN = [
  {
    type: "function",
    function: {
      name: "ask_yishu",
      description: ASK_YISHU_DESC,
      parameters: {
        type: "object",
        properties: { question: { type: "string" } },
        required: ["question"],
      },
    },
  },
];
const INSTRUCTIONS_CONCRETE =
  "You are Yishu, a friend who lives on the user's Mac. Always reply in Mandarin Chinese, short and warm. You cannot see the screen and you have no memory of past conversations. When the user asks about anything on the screen, call look_at_screen. When the user asks about something they told you before, call recall_memory. For casual conversation, just answer naturally.";
const TOOL_CONCRETE = [
  {
    type: "function",
    function: {
      name: "look_at_screen",
      description: "Look at the user's current screen and answer a question about it.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "What to look for on the screen" },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_memory",
      description: "Search the user's past conversations and notes.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to recall from past conversations" },
        },
        required: ["query"],
      },
    },
  },
];
const TOOL_STEPFUN_EN = [
  {
    type: "function",
    function: {
      name: "ask_yishu",
      description: ASK_YISHU_DESC_EN,
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The user question to hand off" },
        },
        required: ["question"],
      },
    },
  },
];

function loadDotVars(path) {
  const out = {};
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    out[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function percentile(values, p) {
  const nums = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const idx = Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1));
  return nums[idx];
}

function pcmDurationMs(pcm, sampleRate = SAMPLE_RATE) {
  return Math.round((pcm.length / 2 / sampleRate) * 1000);
}

function silencePcm(ms, sampleRate = SAMPLE_RATE) {
  const samples = Math.round((sampleRate * ms) / 1000);
  return Buffer.alloc(samples * 2);
}

function pcm16ToWav(pcm, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function parseWav(buf) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return null;
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  const channels = buf.readUInt16LE(22);
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") {
      let pcm = buf.subarray(offset + 8, offset + 8 + size);
      if (bits === 16 && channels === 2) {
        const mono = Buffer.alloc(pcm.length / 2);
        for (let i = 0, j = 0; i + 3 < pcm.length; i += 4, j += 2) {
          mono[j] = pcm[i];
          mono[j + 1] = pcm[i + 1];
        }
        pcm = mono;
      }
      return { pcm, sampleRate, bits, channels };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

function looksMp3(buf) {
  if (buf.length < 3) return false;
  if (buf.toString("ascii", 0, 3) === "ID3") return true;
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
}

async function afconvertToPcm16(inPath, outWavPath, sampleRate) {
  await execFileAsync("afconvert", [
    inPath,
    "-f",
    "WAVE",
    "-d",
    `LEI16@${sampleRate}`,
    "-c",
    "1",
    outWavPath,
  ]);
  const wav = readFileSync(outWavPath);
  const parsed = parseWav(wav);
  if (!parsed) throw new Error("afconvert produced unreadable wav");
  return parsed.pcm;
}

function slimEvent(ev) {
  if (!ev || typeof ev !== "object") return ev;
  const copy = { ...ev };
  const audioTypes = new Set([
    "response.audio.delta",
    "input_audio_buffer.append",
  ]);
  if (audioTypes.has(copy.type) && typeof copy.delta === "string") {
    copy.delta_b64_chars = copy.delta.length;
    copy.delta = `[omitted ${copy.delta.length} chars]`;
  }
  if (copy.type === "input_audio_buffer.append" && typeof copy.audio === "string") {
    copy.audio_b64_chars = copy.audio.length;
    copy.audio = `[omitted ${copy.audio.length} chars]`;
  }
  if (copy.item?.content && Array.isArray(copy.item.content)) {
    copy.item = {
      ...copy.item,
      content: copy.item.content.map((part) => {
        if (part && typeof part.audio === "string") {
          return { ...part, audio: `[omitted ${part.audio.length} chars]` };
        }
        return part;
      }),
    };
  }
  return copy;
}

function isModelDenied(message) {
  const m = String(message || "").toLowerCase();
  return (
    m.includes("unauthorized") ||
    m.includes("not allowed") ||
    m.includes("model_not_found") ||
    m.includes("invalid model") ||
    m.includes("does not exist") ||
    m.includes("unknown model") ||
    m.includes("permission") ||
    m.includes("forbidden") ||
    m.includes("quota_exceeded") ||
    m.includes("quota") ||
    m.includes("402") ||
    m.includes("401") ||
    m.includes("403")
  );
}

async function preflightRealtime(plan) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: plan.host,
        path: plan.httpRealtimePath,
        method: "GET",
        headers: {
          Authorization: `Bearer ${plan.key}`,
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let type = null;
          let message = null;
          try {
            const j = JSON.parse(body);
            type = j.error?.type || null;
            message = j.error?.message || null;
          } catch {
            message = body.slice(0, 180) || res.statusMessage || null;
          }
          resolve({ http: res.statusCode, type, message });
        });
      },
    );
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve({ http: 101, type: null, message: "switching protocols" });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("preflight timeout"));
    });
    req.on("error", (err) => reject(new Error(`preflight ${err.message}`)));
    req.end();
  });
}

function looksLikeToolsReject(message) {
  const m = String(message || "").toLowerCase();
  return (
    m.includes("tool") ||
    m.includes("function") ||
    m.includes("unknown parameter") ||
    m.includes("unsupported")
  );
}

function looksLikeVoiceReject(message) {
  return String(message || "").toLowerCase().includes("voice");
}

function skippedRows(reason) {
  const rows = [];
  for (const scenario of ["S1", "S2", "S3", "S4"]) {
    for (let run = 1; run <= 3; run++) {
      rows.push({
        scenario,
        run,
        latency_ms: null,
        ask_yishu_called: false,
        question: null,
        bridging: false,
        bridging_during_wait: false,
        bridging_text: "",
        transcript: "",
        error: reason,
      });
    }
  }
  rows.push({
    scenario: "S5",
    run: 1,
    latency_ms: null,
    ask_yishu_called: false,
    error: "skipped: S1–S4 did not run",
  });
  return rows;
}

function parseFnArgs(raw) {
  if (!raw) return { raw: "", question: null };
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  try {
    const obj = JSON.parse(text);
    return { raw: text, question: obj.question ?? obj.query ?? null, obj };
  } catch {
    return { raw: text, question: null };
  }
}

function extractFunctionCall(ev) {
  if (!ev) return null;
  if (ev.type === "response.function_call_arguments.done") {
    const parsed = parseFnArgs(ev.arguments);
    return {
      name: ev.name || ev.item?.name || null,
      call_id: ev.call_id,
      arguments: parsed.raw,
      question: parsed.question,
    };
  }
  if (ev.type === "conversation.item.created" && ev.item?.type === "function_call") {
    const parsed = parseFnArgs(ev.item.arguments);
    return {
      name: ev.item.name,
      call_id: ev.item.call_id,
      arguments: parsed.raw,
      question: parsed.question,
      incomplete: ev.item.status === "incomplete" && !ev.item.arguments,
    };
  }
  if (ev.type === "response.done" || ev.type === "response.output_item.done") {
    const items = ev.response?.output || (ev.item ? [ev.item] : []);
    for (const item of items) {
      if (item?.type === "function_call") {
        const parsed = parseFnArgs(item.arguments);
        return {
          name: item.name,
          call_id: item.call_id,
          arguments: parsed.raw,
          question: parsed.question,
        };
      }
    }
  }
  return null;
}

function assembleTranscripts(events) {
  const byItem = new Map();
  const done = [];
  for (const ev of events) {
    if (ev.type === "response.audio_transcript.delta" && ev.delta) {
      const key = ev.item_id || ev.response_id || "unknown";
      byItem.set(key, (byItem.get(key) || "") + ev.delta);
    }
    if (ev.type === "response.audio_transcript.done" && ev.transcript) {
      done.push({
        response_id: ev.response_id,
        item_id: ev.item_id,
        transcript: ev.transcript,
      });
    }
    if (ev.type === "response.text.done" && ev.text) {
      done.push({
        response_id: ev.response_id,
        item_id: ev.item_id,
        transcript: ev.text,
        via: "text",
      });
    }
  }
  if (!done.length) {
    for (const [item_id, transcript] of byItem) {
      if (transcript) done.push({ item_id, transcript, via: "delta" });
    }
  }
  return done;
}

function faithfulness(transcript, source) {
  const t = String(transcript || "");
  if (!t) return { ok: false, invented: true, missing: ["empty"], notes: "no transcript" };
  const checks =
    source === BRAIN_S2
      ? [
          ["Xcode", /xcode/i],
          ["签名", /签名|signing/i],
          ["Team", /team|团队/i],
        ]
      : [
          ["Her", /her|她/i],
          ["剧本", /剧本|原著/],
          ["8月28", /8\s*月\s*28|8\/28|八月二十八/],
        ];
  const missing = checks.filter(([, re]) => !re.test(t)).map(([n]) => n);
  const inventedHints = [];
  if (source === BRAIN_S2) {
    if (/crash|崩溃|内存|null pointer|swift\s*error/i.test(t) && !/签名|signing|team/i.test(t)) {
      inventedHints.push("unrelated error type");
    }
  }
  if (source === BRAIN_S3) {
    if (/哈利|harry|三体|小说奖/i.test(t)) inventedHints.push("wrong book");
  }
  return {
    ok: missing.length === 0,
    missing,
    invented: inventedHints.length > 0,
    inventedHints,
    paraphrase: t.includes(source) ? "verbatim" : "paraphrase-or-partial",
  };
}

class JsonlLog {
  constructor(path) {
    this.path = path;
    writeFileSync(path, "");
  }
  write(row) {
    appendFileSync(this.path, JSON.stringify(row) + "\n");
  }
}

class RealtimeSession {
  constructor({ url, apiKey, log, tag }) {
    this.url = url;
    this.apiKey = apiKey;
    this.log = log;
    this.tag = tag;
    this.ws = null;
    this.events = [];
    this.listeners = new Set();
    this.seq = 0;
    this.open = false;
    this.closeInfo = null;
    this.audioChunks = [];
    this.t0 = performance.now();
  }

  mono() {
    return Math.round(performance.now() - this.t0);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(new Error("websocket connect timeout"));
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }, 12000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        this.open = true;
        this.log?.write({
          ts_mono_ms: this.mono(),
          ts_unix_ms: Date.now(),
          dir: "meta",
          event: { type: "ws.open", host: (() => { try { return new URL(this.url).host; } catch { return ""; } })() },
        });
        resolve();
      });
      ws.addEventListener("message", (msg) => {
        let ev;
        try {
          ev = JSON.parse(typeof msg.data === "string" ? msg.data : msg.data.toString());
        } catch {
          this.log?.write({
            ts_mono_ms: this.mono(),
            ts_unix_ms: Date.now(),
            dir: "in",
            event: { type: "_unparseable" },
          });
          return;
        }
        ev._mono = this.mono();
        ev._unix = Date.now();
        this.events.push(ev);
        if (ev.type === "response.audio.delta" && ev.delta) {
          try {
            this.audioChunks.push(Buffer.from(ev.delta, "base64"));
          } catch {
            /* ignore */
          }
        }
        this.log?.write({
          ts_mono_ms: ev._mono,
          ts_unix_ms: ev._unix,
          dir: "in",
          event: slimEvent(ev),
        });
        for (const fn of this.listeners) fn(ev);
      });
      ws.addEventListener("error", (e) => {
        const msg = e.message || e.error?.message || "websocket error before open";
        this.log?.write({
          ts_mono_ms: this.mono(),
          ts_unix_ms: Date.now(),
          dir: "meta",
          event: { type: "ws.error", message: msg },
        });
        if (!this.open) {
          clearTimeout(timer);
          reject(new Error(msg));
        }
      });
      ws.addEventListener("close", (e) => {
        this.open = false;
        this.closeInfo = { code: e.code, reason: String(e.reason || "") };
        this.log?.write({
          ts_mono_ms: this.mono(),
          ts_unix_ms: Date.now(),
          dir: "meta",
          event: { type: "ws.close", code: e.code, reason: String(e.reason || "") },
        });
        if (!this.events.length) {
          reject(
            new Error(
              `websocket closed before session.created code=${e.code} reason=${e.reason || ""}`,
            ),
          );
        }
      });
    });
  }

  send(obj) {
    const event = { event_id: `c_${++this.seq}`, ...obj };
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("websocket not open");
    }
    this.ws.send(JSON.stringify(event));
    this.log?.write({
      ts_mono_ms: this.mono(),
      ts_unix_ms: Date.now(),
      dir: "out",
      event: slimEvent(event),
    });
  }

  waitFor(pred, timeoutMs, label, opts = {}) {
    const sinceMono = opts.sinceMono ?? -1;
    let fromIndex = opts.fromIndex ?? 0;
    const signal = opts.signal;
    const match = () => {
      for (let i = fromIndex; i < this.events.length; i++) {
        const ev = this.events[i];
        if (ev._mono >= sinceMono && pred(ev)) return ev;
      }
      return null;
    };
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const hit = match();
      if (hit) {
        resolve(hit);
        return;
      }
      const cleanup = () => {
        this.listeners.delete(handler);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout waiting for ${label} (${timeoutMs}ms)`));
      }, timeoutMs);
      const onAbort = () => {
        cleanup();
        reject(new Error("aborted"));
      };
      const handler = () => {
        const ev = match();
        if (ev) {
          cleanup();
          resolve(ev);
        }
      };
      signal?.addEventListener("abort", onAbort);
      this.listeners.add(handler);
    });
  }

  audioSince(startMono) {
    const parts = [];
    for (const ev of this.events) {
      if (ev.type === "response.audio.delta" && ev._mono >= startMono && ev.delta) {
        try {
          parts.push(Buffer.from(ev.delta, "base64"));
        } catch {
          /* ignore */
        }
      }
    }
    return parts.length ? Buffer.concat(parts) : Buffer.alloc(0);
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

async function withRetries(label, fn) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      console.error(`[retry] ${label} attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${err.message}`);
      if (isModelDenied(err.message)) throw err;
      if (attempt < MAX_RETRIES) await sleep(600 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function ttsMiniMax(env, text, outBase) {
  const url = env.MINIMAX_TTS_URL;
  const model = env.MINIMAX_TTS_MODEL;
  const voiceId = env.MINIMAX_VOICE_ID;
  const key = env.MINIMAX_API_KEY;
  if (!url || !model || !voiceId || !key) {
    throw new Error("MiniMax TTS env incomplete (url/model/voice/key)");
  }
  const pcmPath = `${outBase}.pcm`;
  const wavPath = `${outBase}.wav`;
  if (existsSync(pcmPath) && existsSync(wavPath)) {
    const pcm = readFileSync(pcmPath);
    if (pcm.length > 1000) return pcm;
  }

  const bodyPcm = {
    model,
    text,
    stream: false,
    language_boost: "Chinese",
    output_format: "hex",
    voice_setting: { voice_id: voiceId, speed: 1.0, vol: 1.0, pitch: 0 },
    audio_setting: { sample_rate: SAMPLE_RATE, format: "pcm", channel: 1 },
  };
  const bodyMp3 = {
    ...bodyPcm,
    audio_setting: {
      sample_rate: SAMPLE_RATE,
      bitrate: 128000,
      format: "mp3",
      channel: 1,
    },
  };

  async function request(body) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const textBody = await res.text();
    let payload;
    try {
      payload = JSON.parse(textBody);
    } catch {
      throw new Error(`MiniMax TTS non-JSON HTTP ${res.status}`);
    }
    const statusCode = payload?.base_resp?.status_code;
    if (!res.ok || (statusCode !== undefined && statusCode !== 0)) {
      throw new Error(
        `MiniMax TTS HTTP ${res.status} base_resp=${statusCode ?? "n/a"} msg=${payload?.base_resp?.status_msg || ""}`,
      );
    }
    const audioHex = payload?.data?.audio || payload?.audio;
    if (!audioHex) throw new Error("MiniMax TTS missing data.audio");
    const buf = Buffer.from(String(audioHex).trim(), "hex");
    const reportedRate = payload?.extra_info?.audio_sample_rate;
    return { buf, reportedRate };
  }

  return withRetries(`tts:${text.slice(0, 8)}`, async () => {
    let raw;
    let usedMp3 = false;
    try {
      raw = await request(bodyPcm);
    } catch (err) {
      console.error(`[tts] pcm request failed (${err.message}); trying mp3`);
      raw = await request(bodyMp3);
      usedMp3 = true;
    }
    const tmp = `${outBase}.src`;
    writeFileSync(tmp, raw.buf);
    let pcm;
    if (!usedMp3 && !looksMp3(raw.buf) && raw.buf.toString("ascii", 0, 4) !== "RIFF") {
      pcm = raw.buf;
      if (raw.reportedRate && raw.reportedRate !== SAMPLE_RATE) {
        const tmpWav = `${outBase}.src.wav`;
        writeFileSync(tmpWav, pcm16ToWav(pcm, raw.reportedRate));
        pcm = await afconvertToPcm16(tmpWav, wavPath, SAMPLE_RATE);
      }
    } else {
      pcm = await afconvertToPcm16(tmp, wavPath, SAMPLE_RATE);
    }
    if (pcm.length % 2) pcm = pcm.subarray(0, pcm.length - 1);
    writeFileSync(pcmPath, pcm);
    writeFileSync(wavPath, pcm16ToWav(pcm, SAMPLE_RATE));
    console.log(
      `[tts] ${outBase.split("/").pop()} ${pcmDurationMs(pcm)}ms pcm bytes=${pcm.length} (no secrets)`,
    );
    return pcm;
  });
}

function instructionsFor(model, voice) {
  let text = INSTRUCTIONS;
  if (model === "step-audio-2-mini") {
    text +=
      voice === "qingchunshaonv"
        ? "请使用默认女声与用户交流。"
        : "请使用默认男声与用户交流。";
  }
  return text;
}

function sessionPayload(voice, tools, extra = {}) {
  const session = {
    modalities: extra.modalities || ["text", "audio"],
    instructions: extra.instructions || INSTRUCTIONS,
    voice,
    input_audio_format: "pcm16",
    output_audio_format: "pcm16",
  };
  if (extra.turn_detection === null) {
    // omit: push-to-talk; server_vad on + commit is rejected
  } else {
    session.turn_detection = extra.turn_detection || { type: "server_vad" };
  }
  if (tools) session.tools = tools;
  if (extra.tool_choice !== undefined) session.tool_choice = extra.tool_choice;
  if (extra.input_audio_transcription) session.input_audio_transcription = extra.input_audio_transcription;
  if (extra.transcription) session.transcription = extra.transcription;
  return session;
}

function runLogPath(chosen, scenario, run) {
  return join(WORK, `${chosen.logPrefix || ""}${scenario}-${run}.jsonl`);
}

function hasCjk(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ""));
}

function latinLeakWords(text, allowSource = "") {
  const allow = new Set(
    [...(String(allowSource).match(/[A-Za-z]{2,}/g) || []), "yishu", "her", "xcode", "team"].map((w) =>
      w.toLowerCase(),
    ),
  );
  return (String(text || "").match(/[A-Za-z]{2,}/g) || []).filter((w) => !allow.has(w.toLowerCase()));
}

function personaFlags(text) {
  const t = String(text || "");
  const helpdesk = /请问有什么可以|很高兴为您|您好，我是|客服|为您服务|how can i help/i.test(t);
  return {
    chinese: hasCjk(t),
    helpdesk,
    friend_like: hasCjk(t) && !helpdesk && t.length > 0,
  };
}

function annotateSpeech(row, allowSource = "") {
  const text = row.transcript || row.transcript_after || row.bridging_text || "";
  row.chinese = hasCjk(text);
  row.english_leak = latinLeakWords(text, allowSource);
  row.english_leak_yes = row.english_leak.length > 0;
  row.persona = personaFlags(text);
  if (row.scenario === "S1") {
    row.fabricated = /日程|日历|忙了一整天|帮你看看你今天/.test(text);
  }
  return row;
}

async function pushUserAudio(session, pcm, pushToTalk) {
  await streamPcm(session, pcm);
  const tEnd = session.mono();
  if (pushToTalk) {
    await streamPcm(session, silencePcm(200), 100);
    session.send({ type: "input_audio_buffer.commit" });
    session.send({ type: "response.create", response: { modalities: ["text", "audio"] } });
  } else {
    await streamPcm(session, silencePcm(VAD_SILENCE_MS), 100);
  }
  return tEnd;
}

async function streamPcm(session, pcm, chunkMs = CHUNK_MS) {
  const bytesPerChunk = Math.floor((SAMPLE_RATE * 2 * chunkMs) / 1000);
  const aligned = bytesPerChunk - (bytesPerChunk % 2);
  let offset = 0;
  const start = performance.now();
  let i = 0;
  while (offset < pcm.length) {
    let end = Math.min(offset + aligned, pcm.length);
    if ((end - offset) % 2) end -= 1;
    if (end <= offset) break;
    session.send({
      type: "input_audio_buffer.append",
      audio: pcm.subarray(offset, end).toString("base64"),
    });
    offset = end;
    i += 1;
    const wait = start + i * chunkMs - performance.now();
    if (wait > 0) await sleep(wait);
  }
}

async function trySessionUpdate(session, voice, tools, extra = {}) {
  const fromIndex = session.events.length;
  session.send({ type: "session.update", session: sessionPayload(voice, tools, extra) });
  return Promise.race([
    session.waitFor((e) => e.type === "session.updated", 8000, "session.updated", { fromIndex }),
    session.waitFor((e) => e.type === "error", 8000, "error", { fromIndex }).then((e) => {
      throw new Error(e.error?.message || e.message || "session.update error");
    }),
  ]);
}

async function configureSession(session, hint) {
  await session.waitFor((e) => e.type === "session.created", 8000, "session.created");
  if (hint?.locked) {
    const ev = await trySessionUpdate(session, hint.voice, hint.tools, hint.extra || {});
    return {
      voice: ev.session?.voice || hint.voice,
      toolsFormat: hint.toolsFormat,
      functionCalling: hint.functionCalling,
      tools: hint.tools,
      extra: hint.extra || {},
      responseToolChoice: hint.responseToolChoice,
      locked: true,
    };
  }

  const toolAttempts = [
    { tools: TOOL_STEPFUN, toolsFormat: "stepfun-nested" },
    { tools: TOOL_OPENAI, toolsFormat: "openai-flat" },
  ];
  let lastErr = null;
  let toolsRejected = false;
  for (const voice of [DEFAULT_VOICE, FALLBACK_VOICE]) {
    for (const attempt of toolAttempts) {
      try {
        const ev = await trySessionUpdate(session, voice, attempt.tools);
        console.log(`[session.update] ok voice=${ev.session?.voice || voice} tools=${attempt.toolsFormat}`);
        return {
          voice: ev.session?.voice || voice,
          toolsFormat: attempt.toolsFormat,
          functionCalling: true,
          tools: attempt.tools,
        };
      } catch (err) {
        lastErr = err;
        console.error(`[session.update] ${attempt.toolsFormat}/${voice}: ${err.message}`);
        if (looksLikeToolsReject(err.message)) toolsRejected = true;
        if (looksLikeVoiceReject(err.message)) break;
      }
    }
  }
  if (toolsRejected) {
    try {
      const ev = await trySessionUpdate(session, DEFAULT_VOICE, null);
      console.log("[session.update] ok without tools — function calling unsupported");
      return {
        voice: ev.session?.voice || DEFAULT_VOICE,
        toolsFormat: "none",
        functionCalling: false,
        tools: null,
      };
    } catch (err) {
      lastErr = err;
      console.error(`[session.update] no-tools/${DEFAULT_VOICE}: ${err.message}`);
    }
  }
  throw lastErr || new Error("session.update failed");
}

async function probeModel(plan, failures) {
  const model = PLAN_MODEL;
  let pre = { http: null, type: null, message: null };
  try {
    pre = await preflightRealtime(plan);
    console.log(`[probe] ${model} path=${plan.prefix} http=${pre.http} type=${pre.type || "n/a"}`);
  } catch (err) {
    console.error(`[probe] preflight ${err.message}; still trying websocket`);
  }
  const log = new JsonlLog(join(WORK, `probe-step-plan-${model}.jsonl`));
  log.write({
    ts_mono_ms: 0,
    ts_unix_ms: Date.now(),
    dir: "meta",
    event: {
      type: "preflight",
      model,
      host: plan.host,
      path: plan.httpRealtimePath,
      http: pre.http,
      error_type: pre.type,
      message: pre.message,
    },
  });
  const session = new RealtimeSession({ url: plan.wsUrl, apiKey: plan.key, log, tag: `probe-${model}` });
  try {
    await session.connect();
    const cfg = await configureSession(session, null);
    session.close();
    return { model, url: plan.wsUrl, locked: true, ...cfg };
  } catch (err) {
    const reason = err.message || String(err);
    failures.push({
      model,
      reason,
      http: pre.http,
      error_type: pre.type,
      path: plan.prefix,
    });
    session.close();
    throw err;
  }
}

async function openConfigured(apiKey, chosen, logPath) {
  const log = new JsonlLog(logPath);
  const session = new RealtimeSession({ url: chosen.url, apiKey, log, tag: logPath });
  await session.connect();
  const cfg = await configureSession(session, chosen);
  return { session, cfg };
}

async function runChitChat({ apiKey, chosen, pcm, scenario, run, extraAfterFirstAudio }) {
  const logPath = runLogPath(chosen, scenario, run);
  const { session } = await withRetries(`${scenario}-${run}-connect`, () =>
    openConfigured(apiKey, chosen, logPath),
  );
  const out = {
    scenario,
    run,
    ask_yishu_called: false,
    tool_called: false,
    tool_name: null,
    question: null,
    latency_ms: null,
    transcript: "",
    transcripts: [],
    error: null,
  };
  try {
    const tEnd = await pushUserAudio(session, pcm, Boolean(chosen.extra?.pushToTalk));
    out.t_end_of_user_audio_mono_ms = tEnd;
    out.user_audio_ms = pcmDurationMs(pcm);

    const deadline = 18000;
    let firstAudio = null;
    let fn = null;
    const stop = Date.now() + deadline;
    let fromIndex = 0;
    while (Date.now() < stop && !firstAudio && !fn) {
      try {
        const ev = await session.waitFor(
          (e) =>
            (e.type === "response.audio.delta" && e._mono >= tEnd) ||
            e.type === "response.function_call_arguments.done" ||
            (e.type === "conversation.item.created" && e.item?.type === "function_call") ||
            e.type === "response.done" ||
            e.type === "error",
          Math.max(200, stop - Date.now()),
          "audio-or-fn",
          { sinceMono: tEnd, fromIndex },
        );
        fromIndex = session.events.indexOf(ev) + 1;
        if (ev.type === "error") throw new Error(ev.error?.message || "server error");
        const maybeFn = extractFunctionCall(ev);
        if (maybeFn && !maybeFn.incomplete) fn = maybeFn;
        if (ev.type === "response.audio.delta") firstAudio = ev;
        if (ev.type === "response.done" && !fn) break;
      } catch (err) {
        if (!String(err.message).startsWith("timeout")) throw err;
        break;
      }
    }

    if (fn) {
      out.ask_yishu_called = fn.name === "ask_yishu" || true;
      out.tool_called = true;
      out.tool_name = fn.name;
      out.question = fn.question;
      out.call_id = fn.call_id;
      out.fn_arguments = fn.arguments;
    }
    if (firstAudio) {
      out.latency_ms = firstAudio._mono - tEnd;
      out.first_audio_response_id = firstAudio.response_id;
    }

    if (extraAfterFirstAudio && firstAudio) {
      const extra = await extraAfterFirstAudio(session, { tEnd, firstAudio });
      Object.assign(out, extra);
    } else {
      try {
        await session.waitFor(
          (e) => e.type === "response.done" || e.type === "response.audio.done",
          12000,
          "response.done",
        );
      } catch {
        /* hang is a result */
      }
      await sleep(400);
    }

    out.transcripts = assembleTranscripts(session.events);
    out.transcript = out.transcripts.map((t) => t.transcript).join(" / ");
    const wav = join(WORK, `${chosen.logPrefix || ""}${scenario}-${run}-out.wav`);
    const audio = session.audioSince(tEnd);
    if (audio.length) writeFileSync(wav, pcm16ToWav(audio));
    out.output_wav = audio.length ? wav : null;
    out.output_audio_ms = pcmDurationMs(audio);
  } catch (err) {
    out.error = err.message;
  } finally {
    session.close();
  }
  return out;
}

async function runBrainCall({ apiKey, chosen, pcm, scenario, run, brainText, forceResponseToolChoice, textInput }) {
  const logPath = runLogPath(chosen, scenario, run);
  const { session } = await withRetries(`${scenario}-${run}-connect`, () =>
    openConfigured(apiKey, chosen, logPath),
  );
  const out = {
    scenario,
    run,
    ask_yishu_called: false,
    question: null,
    tool_called: false,
    tool_name: null,
    ms_end_to_fn: null,
    bridging: false,
    bridging_text: "",
    ms_output_to_audio: null,
    transcript: "",
    transcripts: [],
    faithful: null,
    error: null,
  };
  try {
    let tEnd;
    if (textInput) {
      tEnd = session.mono();
      session.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: textInput }],
        },
      });
      session.send({ type: "response.create", response: { modalities: ["text", "audio"] } });
    } else {
      tEnd = await pushUserAudio(session, pcm, Boolean(chosen.extra?.pushToTalk));
    }
    out.t_end_of_user_audio_mono_ms = tEnd;
    out.input = textInput ? "text" : "audio";

    const responseToolChoice = forceResponseToolChoice || chosen.responseToolChoice;
    if (responseToolChoice) {
      try {
        await session.waitFor(
          (e) => e.type === "response.created" && e._mono >= tEnd,
          4000,
          "auto response",
          { sinceMono: tEnd },
        );
        session.send({ type: "response.cancel" });
        await sleep(150);
      } catch {
        /* no auto response yet */
      }
      session.send({
        type: "response.create",
        response: { modalities: ["text", "audio"], tool_choice: responseToolChoice },
      });
      out.forced_via = "response.create";
    }

    let fn = null;
    let doneWithoutFn = false;
    const stopAt = Date.now() + 20000;
    let fromIndex = 0;
    while (Date.now() < stopAt && !fn && !doneWithoutFn) {
      let ev;
      try {
        ev = await session.waitFor(
          (e) =>
            e._mono >= tEnd &&
            (e.type === "response.function_call_arguments.done" ||
              e.type === "response.done" ||
              e.type === "error" ||
              (e.type === "conversation.item.created" &&
                e.item?.type === "function_call" &&
                e.item?.arguments)),
          Math.max(200, stopAt - Date.now()),
          "fn-or-done",
          { sinceMono: tEnd, fromIndex },
        );
      } catch (err) {
        if (!String(err.message).startsWith("timeout")) throw err;
        break;
      }
      fromIndex = session.events.indexOf(ev) + 1;
      if (ev.type === "error") throw new Error(ev.error?.message || "server error");
      const maybe = extractFunctionCall(ev);
      if (maybe && maybe.call_id) fn = maybe;
      else if (ev.type === "response.done") {
        const fromDone = extractFunctionCall(ev);
        if (fromDone) fn = fromDone;
        else doneWithoutFn = true;
      }
    }

    if (!fn) {
      out.transcripts = assembleTranscripts(session.events);
      out.transcript = out.transcripts.map((t) => t.transcript).join(" / ");
      out.error = doneWithoutFn ? "responded without ask_yishu" : "no function call or response";
      const audio = session.audioSince(tEnd);
      if (audio.length) {
        writeFileSync(join(WORK, `${chosen.logPrefix || ""}${scenario}-${run}-out.wav`), pcm16ToWav(audio));
      }
      return out;
    }

    out.ask_yishu_called = true;
    out.tool_called = true;
    out.tool_name = fn.name;
    out.question = fn.question;
    out.call_id = fn.call_id;
    out.fn_arguments = fn.arguments;
    const tFn = session.events.find(
      (e) =>
        e.type === "response.function_call_arguments.done" ||
        (e.type === "conversation.item.created" && e.item?.call_id === fn.call_id),
    );
    out.ms_end_to_fn = (tFn?._mono ?? session.mono()) - tEnd;

    const preFnText = assembleTranscripts(
      session.events.filter((e) => e._mono <= (tFn?._mono ?? 0)),
    )
      .map((t) => t.transcript)
      .join(" / ");
    out.pre_fn_speech = preFnText;

    const tFnMono = tFn?._mono ?? session.mono();
    const fnRespId = tFn?.response_id;
    try {
      await session.waitFor(
        (e) =>
          e.type === "response.done" &&
          (fnRespId
            ? e.response?.id === fnRespId || e.response_id === fnRespId
            : e._mono >= tFnMono),
        10000,
        "fn response.done",
      );
    } catch {
      /* may already be done */
    }
    const spent = session.mono() - tFnMono;
    if (spent < BRAIN_DELAY_MS) await sleep(BRAIN_DELAY_MS - spent);

    const waitEvents = session.events.filter(
      (e) => e._mono > tFnMono && (e.type?.startsWith("response.audio") || e.type?.includes("transcript")),
    );
    const waitText = assembleTranscripts(waitEvents)
      .map((t) => t.transcript)
      .join(" / ");
    const waitAudio = waitEvents.some((e) => e.type === "response.audio.delta");
    out.bridging = Boolean(waitText || waitAudio || preFnText);
    out.bridging_text = [preFnText, waitText].filter(Boolean).join(" | ");
    out.bridging_during_wait = Boolean(waitText || waitAudio);
    out.bridging_before_fn = Boolean(preFnText);

    const tOut = session.mono();
    session.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: fn.call_id,
        output: brainText,
      },
    });
    session.send({ type: "response.create" });

    let firstAfter = null;
    try {
      firstAfter = await session.waitFor(
        (e) => e.type === "response.audio.delta" && e._mono >= tOut,
        15000,
        "audio after brain",
      );
    } catch (err) {
      out.error = err.message;
    }
    if (firstAfter) out.ms_output_to_audio = firstAfter._mono - tOut;
    try {
      await session.waitFor((e) => e.type === "response.done" && e._mono >= tOut, 15000, "final done");
    } catch {
      /* recorded as missing final */
    }
    await sleep(300);

    const after = session.events.filter((e) => e._mono >= tOut);
    out.transcripts = assembleTranscripts(after);
    out.transcript = out.transcripts.map((t) => t.transcript).join(" / ");
    out.faithful = faithfulness(out.transcript, brainText);
    const audio = session.audioSince(tOut);
    if (audio.length) {
      writeFileSync(join(WORK, `${chosen.logPrefix || ""}${scenario}-${run}-out.wav`), pcm16ToWav(audio));
      out.output_audio_ms = pcmDurationMs(audio);
    }
  } catch (err) {
    out.error = err.message;
  } finally {
    session.close();
  }
  return out;
}

async function runInterrupt({ apiKey, chosen, pcmU1, pcmU3, run }) {
  const scenario = "S4";
  const logPath = runLogPath(chosen, scenario, run);
  const { session } = await withRetries(`${scenario}-${run}-connect`, () =>
    openConfigured(apiKey, chosen, logPath),
  );
  const out = {
    scenario,
    run,
    latency_ms: null,
    stopped: false,
    ms_u3_to_speech_started: null,
    ms_u3_to_cancelled: null,
    ms_u3_to_last_audio: null,
    transcript_before: "",
    transcript_after: "",
    error: null,
  };
  try {
    await streamPcm(session, pcmU1);
    const tEnd = session.mono();
    await streamPcm(session, silencePcm(VAD_SILENCE_MS), 100);
    const firstAudio = await session.waitFor(
      (e) => e.type === "response.audio.delta" && e._mono >= tEnd,
      18000,
      "first audio S4",
    );
    out.latency_ms = firstAudio._mono - tEnd;
    const resp1 = firstAudio.response_id;
    await sleep(800);
    const tU3 = session.mono();
    out.t_u3_start_mono_ms = tU3;
    const streamU3 = streamPcm(session, pcmU3).then(async () => {
      await streamPcm(session, silencePcm(VAD_SILENCE_MS), 100);
    });

    const until = Date.now() + 20000;
    let fromIndex = 0;
    while (Date.now() < until) {
      const remain = until - Date.now();
      if (remain <= 0) break;
      try {
        const ev = await session.waitFor(
          (e) =>
            e._mono >= tU3 &&
            (e.type === "input_audio_buffer.speech_started" ||
              e.type === "response.cancelled" ||
              e.type === "response.done" ||
              e.type === "response.audio.delta"),
          remain,
          "interrupt marker",
          { sinceMono: tU3, fromIndex },
        );
        fromIndex = session.events.indexOf(ev) + 1;
      } catch {
        break;
      }
      const started = session.events.find(
        (e) => e.type === "input_audio_buffer.speech_started" && e._mono >= tU3,
      );
      if (started && out.ms_u3_to_speech_started == null) {
        out.ms_u3_to_speech_started = started._mono - tU3;
      }
      const cancelled = session.events.find(
        (e) =>
          e._mono >= tU3 &&
          (e.type === "response.cancelled" ||
            (e.type === "response.done" &&
              (e.response?.status === "cancelled" || e.response?.status === "incomplete"))),
      );
      if (cancelled && out.ms_u3_to_cancelled == null) {
        out.ms_u3_to_cancelled = cancelled._mono - tU3;
        out.cancel_type = cancelled.type;
        out.cancel_status = cancelled.response?.status || cancelled.type;
      }
    }
    await streamU3.catch(() => {});
    await sleep(2500);

    const audioResp1 = session.events.filter(
      (e) => e.type === "response.audio.delta" && e.response_id === resp1,
    );
    const last1 = audioResp1[audioResp1.length - 1];
    if (last1) out.ms_u3_to_last_audio = last1._mono - tU3;
    const audioAfterU3SameResp = audioResp1.filter((e) => e._mono > tU3 + 80);
    out.stopped =
      out.ms_u3_to_cancelled != null ||
      out.ms_u3_to_speech_started != null ||
      audioAfterU3SameResp.length === 0;
    out.audio_deltas_after_u3_same_resp = audioAfterU3SameResp.length;

    const before = assembleTranscripts(session.events.filter((e) => e._mono < tU3));
    const after = assembleTranscripts(session.events.filter((e) => e._mono >= tU3));
    out.transcript_before = before.map((t) => t.transcript).join(" / ");
    out.transcript_after = after.map((t) => t.transcript).join(" / ");
    const audio = Buffer.concat(
      session.events
        .filter((e) => e.type === "response.audio.delta" && e.delta)
        .map((e) => Buffer.from(e.delta, "base64")),
    );
    if (audio.length) writeFileSync(join(WORK, `${scenario}-${run}-out.wav`), pcm16ToWav(audio));
  } catch (err) {
    out.error = err.message;
  } finally {
    session.close();
  }
  return out;
}

function editDistance(a, b) {
  const s = [...String(a || "")];
  const t = [...String(b || "")];
  const m = s.length;
  const n = t.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        s[i - 1] === t[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function eventTypes(session) {
  return [...new Set(session.events.map((e) => e.type).filter(Boolean))];
}

function loudOnset(pcm) {
  const n = Math.round((SAMPLE_RATE * 0.06 * 2));
  const tone = Buffer.alloc(n);
  for (let i = 0, s = 0; i + 1 < n; i += 2, s++) {
    tone.writeInt16LE(Math.round(22000 * Math.sin((2 * Math.PI * 700 * s) / SAMPLE_RATE)), i);
  }
  return Buffer.concat([tone, pcm]);
}

async function runInterruptPtt({ apiKey, chosen, pcmU1, pcmU3, run, method }) {
  const scenario = "S4";
  const logPath = runLogPath(chosen, scenario, `${run}-${method}`);
  const { session } = await withRetries(`${scenario}-${run}-connect`, () =>
    openConfigured(apiKey, chosen, logPath),
  );
  const out = {
    scenario,
    run,
    method,
    latency_ms: null,
    stopped: false,
    ms_action_to_last_audio: null,
    ms_action_to_cancelled: null,
    transcript_before: "",
    transcript_after: "",
    error: null,
  };
  try {
    const tEnd = await pushUserAudio(session, pcmU1, true);
    const firstAudio = await session.waitFor(
      (e) => e.type === "response.audio.delta" && e._mono >= tEnd,
      18000,
      "first audio S4-ptt",
    );
    out.latency_ms = firstAudio._mono - tEnd;
    const resp1 = firstAudio.response_id;
    await sleep(800);
    const tAction = session.mono();
    out.t_action_mono_ms = tAction;
    if (method === "cancel") {
      session.send({ type: "response.cancel" });
    } else {
      await streamPcm(session, pcmU3);
    }

    const until = Date.now() + 12000;
    let fromIndex = 0;
    while (Date.now() < until) {
      try {
        const ev = await session.waitFor(
          (e) =>
            e._mono >= tAction &&
            (e.type === "response.cancelled" ||
              e.type === "response.done" ||
              e.type === "response.audio.delta" ||
              e.type === "error"),
          Math.min(3000, until - Date.now()),
          "interrupt ptt marker",
          { sinceMono: tAction, fromIndex },
        );
        fromIndex = session.events.indexOf(ev) + 1;
        if (ev.type === "error") {
          out.error = ev.error?.message || "server error";
          break;
        }
      } catch {
        break;
      }
    }
    await sleep(800);

    const audioResp1 = session.events.filter(
      (e) => e.type === "response.audio.delta" && e.response_id === resp1,
    );
    const last1 = audioResp1[audioResp1.length - 1];
    if (last1) out.ms_action_to_last_audio = last1._mono - tAction;
    const after = audioResp1.filter((e) => e._mono > tAction + 40);
    const cancelled = session.events.find(
      (e) =>
        e._mono >= tAction &&
        (e.type === "response.cancelled" ||
          (e.type === "response.done" &&
            (e.response?.status === "cancelled" || e.response?.status === "incomplete"))),
    );
    if (cancelled) {
      out.ms_action_to_cancelled = cancelled._mono - tAction;
      out.cancel_type = cancelled.type;
      out.cancel_status = cancelled.response?.status || cancelled.type;
    }
    out.stopped = Boolean(cancelled) || after.length === 0;
    out.audio_deltas_after_action = after.length;
    out.ms_u3_to_last_audio = out.ms_action_to_last_audio;
    out.ms_u3_to_cancelled = out.ms_action_to_cancelled;

    const before = assembleTranscripts(session.events.filter((e) => e._mono < tAction));
    const afterT = assembleTranscripts(session.events.filter((e) => e._mono >= tAction));
    out.transcript_before = before.map((t) => t.transcript).join(" / ");
    out.transcript_after = afterT.map((t) => t.transcript).join(" / ");
    const audio = session.audioSince(tEnd);
    if (audio.length) {
      writeFileSync(join(WORK, `${chosen.logPrefix || ""}S4-${run}-${method}-out.wav`), pcm16ToWav(audio));
    }
  } catch (err) {
    out.error = err.message;
  } finally {
    session.close();
  }
  return out;
}

async function discoverToolChoice(plan, voice) {
  const attempts = [];
  const sessionForms = [
    { label: "session.required", value: "required" },
    { label: "session.function", value: { type: "function", function: { name: "ask_yishu" } } },
    { label: "session.function-flat", value: { type: "function", name: "ask_yishu" } },
  ];
  const log = new JsonlLog(join(WORK, "probe-tool-choice.jsonl"));
  const session = new RealtimeSession({ url: plan.wsUrl, apiKey: plan.key, log, tag: "tool-choice" });
  try {
    await session.connect();
    await session.waitFor((e) => e.type === "session.created", 8000, "session.created");
    for (const form of sessionForms) {
      try {
        await trySessionUpdate(session, voice, TOOL_STEPFUN, {
          instructions: INSTRUCTIONS_S6,
          tool_choice: form.value,
        });
        attempts.push({ form: form.label, ok: true });
        console.log(`[tool_choice] accepted ${form.label}`);
        session.close();
        return { sessionToolChoice: form.value, label: form.label, attempts };
      } catch (err) {
        attempts.push({ form: form.label, ok: false, error: err.message });
        console.error(`[tool_choice] reject ${form.label}: ${err.message}`);
      }
    }
    try {
      await trySessionUpdate(session, voice, TOOL_STEPFUN, { instructions: INSTRUCTIONS_S6 });
    } catch (err) {
      attempts.push({ form: "session.tools-only", ok: false, error: err.message });
    }
    const responseForms = [
      { label: "response.required", value: "required" },
      { label: "response.function", value: { type: "function", function: { name: "ask_yishu" } } },
    ];
    for (const form of responseForms) {
      const fromIndex = session.events.length;
      session.send({
        type: "response.create",
        response: { modalities: ["text", "audio"], tool_choice: form.value },
      });
      try {
        const ev = await Promise.race([
          session.waitFor((e) => e.type === "response.created", 5000, "rc", { fromIndex }),
          session.waitFor((e) => e.type === "error", 5000, "err", { fromIndex }).then((e) => {
            throw new Error(e.error?.message || "response.create error");
          }),
        ]);
        attempts.push({ form: form.label, ok: true, type: ev.type });
        console.log(`[tool_choice] accepted ${form.label}`);
        session.close();
        return { responseToolChoice: form.value, label: form.label, attempts };
      } catch (err) {
        attempts.push({ form: form.label, ok: false, error: err.message });
        console.error(`[tool_choice] reject ${form.label}: ${err.message}`);
      }
    }
    session.close();
    return { rejected: true, attempts };
  } catch (err) {
    session.close();
    return { rejected: true, attempts, error: err.message };
  }
}

async function discoverTranscription(session, voice) {
  const forms = [
    { label: "input_audio_transcription.whisper-1", extra: { input_audio_transcription: { model: "whisper-1" } } },
    { label: "input_audio_transcription.enabled", extra: { input_audio_transcription: { enabled: true } } },
    { label: "input_audio_transcription.empty", extra: { input_audio_transcription: {} } },
    { label: "transcription.step-asr", extra: { transcription: { model: "step-asr" } } },
  ];
  const attempts = [];
  for (const form of forms) {
    try {
      await trySessionUpdate(session, voice, null, {
        instructions: INSTRUCTIONS_S7,
        turn_detection: VAD_DEFAULT,
        ...form.extra,
      });
      attempts.push({ form: form.label, ok: true });
      console.log(`[transcription] accepted ${form.label}`);
      return { extra: form.extra, label: form.label, attempts };
    } catch (err) {
      attempts.push({ form: form.label, ok: false, error: err.message });
      console.error(`[transcription] reject ${form.label}: ${err.message}`);
    }
  }
  try {
    await trySessionUpdate(session, voice, null, {
      instructions: INSTRUCTIONS_S7,
      turn_detection: VAD_DEFAULT,
    });
    attempts.push({ form: "none", ok: true });
  } catch (err) {
    attempts.push({ form: "none", ok: false, error: err.message });
  }
  return { extra: {}, label: "none", attempts };
}

async function speakCanned(session, canned) {
  const tSend = session.mono();
  const tries = [];
  session.send({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: canned }],
    },
  });
  session.send({
    type: "response.create",
    response: { modalities: ["audio", "text"] },
  });
  tries.push("assistant+response.modalities");
  try {
    const ev = await session.waitFor(
      (e) => e.type === "response.audio.delta" && e._mono >= tSend,
      8000,
      "tts assistant",
      { sinceMono: tSend },
    );
    return { form: tries[0], firstAudio: ev, tSend };
  } catch {
    /* fall through */
  }
  const t2 = session.mono();
  session.send({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `请原样无修改地念出下面这句话：${canned}` }],
    },
  });
  session.send({ type: "response.create" });
  tries.push("user-prompt+response.create");
  const ev = await session.waitFor(
    (e) => e.type === "response.audio.delta" && e._mono >= t2,
    12000,
    "tts user-prompt",
    { sinceMono: t2 },
  );
  return { form: tries[1], firstAudio: ev, tSend: t2 };
}

async function runTransport({ apiKey, url, voice, pcm, utterance, canned, run, transcribeExtra }) {
  const scenario = `S7-${utterance}`;
  const logPath = join(WORK, `${scenario}-${run}.jsonl`);
  const log = new JsonlLog(logPath);
  const session = new RealtimeSession({ url, apiKey, log, tag: logPath });
  const out = {
    scenario,
    run,
    utterance,
    canned,
    ms_end_to_transcript: null,
    user_transcript: "",
    partial_during_speech: false,
    violation: false,
    tts_form: null,
    ms_text_to_audio: null,
    spoken: "",
    edit_distance: null,
    verbatim: false,
    event_types: [],
    error: null,
  };
  try {
    await session.connect();
    await session.waitFor((e) => e.type === "session.created", 8000, "session.created");
    await trySessionUpdate(session, voice, null, {
      instructions: INSTRUCTIONS_S7,
      turn_detection: VAD_DEFAULT,
      ...transcribeExtra,
    });
    await streamPcm(session, pcm);
    const tEnd = session.mono();
    out.t_end_of_user_audio_mono_ms = tEnd;
    await streamPcm(session, silencePcm(VAD_SILENCE_MS), 100);

    const until = Date.now() + 12000;
    let fromIndex = 0;
    while (Date.now() < until && !out.user_transcript) {
      try {
        const ev = await session.waitFor(
          (e) =>
            e._mono >= tEnd &&
            (e.type === "conversation.item.input_audio_transcription.completed" ||
              e.type === "conversation.item.input_audio_transcription.delta" ||
              e.type === "response.audio.delta" ||
              e.type === "response.text.delta" ||
              e.type === "response.audio_transcript.delta" ||
              e.type === "response.done" ||
              e.type === "error"),
          Math.max(200, until - Date.now()),
          "s7-wait",
          { sinceMono: tEnd, fromIndex },
        );
        fromIndex = session.events.indexOf(ev) + 1;
        if (ev.type === "error") throw new Error(ev.error?.message || "server error");
        if (ev.type === "conversation.item.input_audio_transcription.completed") {
          out.user_transcript = ev.transcript || "";
          out.ms_end_to_transcript = ev._mono - tEnd;
        }
        if (ev.type === "conversation.item.input_audio_transcription.delta") {
          out.partial_during_speech = true;
        }
        if (ev.type === "response.audio.delta" || ev.type === "response.audio_transcript.delta") {
          out.violation = true;
          try {
            session.send({ type: "response.cancel" });
          } catch {
            /* ignore */
          }
          break;
        }
      } catch (err) {
        if (!String(err.message).startsWith("timeout")) throw err;
        break;
      }
    }
    const duringSpeech = session.events.some(
      (e) =>
        e.type === "conversation.item.input_audio_transcription.delta" &&
        e._mono < tEnd,
    );
    if (duringSpeech) out.partial_during_speech = true;
    if (!out.user_transcript) {
      const done = session.events.find(
        (e) => e.type === "conversation.item.input_audio_transcription.completed",
      );
      if (done) {
        out.user_transcript = done.transcript || "";
        out.ms_end_to_transcript = done._mono - tEnd;
      }
    }

    await sleep(800);
    const spoken = await speakCanned(session, canned);
    out.tts_form = spoken.form;
    out.ms_text_to_audio = spoken.firstAudio._mono - spoken.tSend;
    try {
      await session.waitFor(
        (e) => e.type === "response.done" && e._mono >= spoken.tSend,
        15000,
        "s7 spoken done",
        { sinceMono: spoken.tSend },
      );
    } catch {
      /* hang */
    }
    await sleep(200);
    const after = session.events.filter((e) => e._mono >= spoken.tSend);
    out.spoken = assembleTranscripts(after).map((t) => t.transcript).join("");
    const norm = (s) => String(s || "").replace(/\s+/g, "");
    out.edit_distance = editDistance(norm(out.spoken), norm(canned));
    out.verbatim = out.edit_distance === 0 && Boolean(out.spoken);
    const audio = session.audioSince(spoken.tSend);
    if (audio.length) {
      writeFileSync(join(WORK, `${scenario}-${run}-out.wav`), pcm16ToWav(audio));
      out.output_audio_ms = pcmDurationMs(audio);
    }
    out.event_types = eventTypes(session);
  } catch (err) {
    out.error = err.message;
    out.event_types = eventTypes(session);
  } finally {
    session.close();
  }
  return out;
}

async function runVadClean({ apiKey, url, voice, pcmU3, run, vad, tag }) {
  const scenario = `S8-${tag}`;
  const logPath = join(WORK, `${scenario}-${run}.jsonl`);
  const log = new JsonlLog(logPath);
  const session = new RealtimeSession({ url, apiKey, log, tag: logPath });
  const out = {
    scenario,
    run,
    vad,
    ms_u3_to_speech_started: null,
    ms_u3_to_last_audio: null,
    tts_form: null,
    error: null,
  };
  try {
    await session.connect();
    await session.waitFor((e) => e.type === "session.created", 8000, "session.created");
    await trySessionUpdate(session, voice, null, {
      instructions: INSTRUCTIONS_S7,
      turn_detection: vad,
    });
    const spoken = await speakCanned(session, CANNED_S8);
    out.tts_form = spoken.form;
    const resp1 = spoken.firstAudio.response_id;
    await sleep(1000);
    const tU3 = session.mono();
    out.t_u3_start_mono_ms = tU3;
    const u3 = loudOnset(pcmU3);
    const stream = streamPcm(session, u3).then(() => streamPcm(session, silencePcm(VAD_SILENCE_MS), 100));
    const until = Date.now() + 12000;
    let fromIndex = 0;
    while (Date.now() < until) {
      try {
        const ev = await session.waitFor(
          (e) =>
            e._mono >= tU3 &&
            (e.type === "input_audio_buffer.speech_started" || e.type === "response.audio.delta"),
          until - Date.now(),
          "s8 marker",
          { sinceMono: tU3, fromIndex },
        );
        fromIndex = session.events.indexOf(ev) + 1;
        if (ev.type === "input_audio_buffer.speech_started" && out.ms_u3_to_speech_started == null) {
          out.ms_u3_to_speech_started = ev._mono - tU3;
        }
      } catch {
        break;
      }
    }
    await stream.catch(() => {});
    await sleep(400);
    const last = session.events
      .filter((e) => e.type === "response.audio.delta" && (!resp1 || e.response_id === resp1))
      .at(-1);
    if (last) out.ms_u3_to_last_audio = last._mono - tU3;
    out.event_types = eventTypes(session);
  } catch (err) {
    out.error = err.message;
  } finally {
    session.close();
  }
  return out;
}

function summarizeScenarios(all) {
  const by = {};
  for (const row of all) {
    (by[row.scenario] ??= []).push(row);
  }
  const out = {};
  for (const [k, runs] of Object.entries(by)) {
    const lat = runs.map((r) => r.latency_ms).filter(Number.isFinite);
    const fnLat = runs.map((r) => r.ms_end_to_fn).filter(Number.isFinite);
    const outLat = runs.map((r) => r.ms_output_to_audio).filter(Number.isFinite);
    const stop = runs.map((r) => r.ms_u3_to_speech_started ?? r.ms_u3_to_cancelled).filter(Number.isFinite);
    out[k] = {
      runs,
      latency_p50_ms: percentile(lat, 50),
      latency_p95_ms: percentile(lat, 95),
      fn_p50_ms: percentile(fnLat, 50),
      output_to_audio_p50_ms: percentile(outLat, 50),
      interrupt_stop_p50_ms: percentile(stop, 50),
      ask_yishu: runs.map((r) => Boolean(r.ask_yishu_called)),
      bridging: runs.map((r) => ({
        yes: Boolean(r.bridging),
        text: r.bridging_text || "",
        during_wait: Boolean(r.bridging_during_wait),
      })),
    };
  }
  return out;
}

function recommendation(chosen, summary, failures) {
  const s1 = summary.S1;
  const s2 = summary.S2;
  const s3 = summary.S3;
  const s4 = summary.S4;
  const s5 = summary.S5;
  const s1Ok = s1?.runs.filter((r) => r.latency_ms != null && !r.ask_yishu_called).length >= 2;
  const s2Fn = s2?.ask_yishu.filter(Boolean).length >= 2;
  const s3Fn = s3?.ask_yishu.filter(Boolean).length >= 2;
  const s2BridgeWait = s2?.bridging.filter((b) => b.during_wait).length || 0;
  const s2SilentWait = s2Fn && s2BridgeWait === 0;
  const interruptOk = s4?.runs.filter((r) => r.stopped && !r.error).length >= 2;
  const wrongSelf =
    (s2?.runs.filter((r) => !r.ask_yishu_called).length || 0) +
    (s3?.runs.filter((r) => !r.ask_yishu_called).length || 0);
  const s1FalseTool = s1?.runs.filter((r) => r.ask_yishu_called).length || 0;

  let verdict;
  if (chosen.functionCalling === false) {
    verdict = "not viable — session accepted but function calling is unsupported (ask_yishu cannot hand off)";
  } else if (s1Ok && s2Fn && s3Fn) {
    verdict = interruptOk
      ? "viable-with-guards"
      : "viable-for-turn-taking; interruption unproven";
  } else if (s1Ok && (s2Fn || s3Fn)) {
    verdict = "partially viable — tool routing is inconsistent";
  } else if (s1Ok) {
    verdict = "not viable as mouth/ears+brain: chit-chat works, ask_yishu does not reliably fire";
  } else {
    verdict = "not viable from this run (realtime path itself failed or was too slow/unreliable)";
  }

  const risks = [];
  if (s1FalseTool) risks.push("chit-chat wrongly called ask_yishu");
  if (wrongSelf) risks.push("screen/memory turns self-answered instead of ask_yishu");
  if (s2SilentWait) risks.push("silence during the 2.5s brain wait (no bridging phrase)");
  if (!interruptOk) risks.push("barge-in did not clearly stop the in-flight response");
  const drift = [...(s2?.runs || []), ...(s3?.runs || [])].some(
    (r) => r.faithful && r.faithful.invented,
  );
  if (drift) risks.push("final spoken answer added invented details");
  if (failures.length) risks.push("some candidate models were unreachable or not allowed");
  if ((s1?.latency_p50_ms ?? 9999) > 1500) risks.push("chit-chat first-audio p50 > 1.5s");

  const p50 = s5?.latency_p50_ms ?? s1?.latency_p50_ms;
  return {
    verdict,
    p50_first_audio_ms: p50,
    risks,
    paragraph: [
      `Realtime model as mouth/ears + ask_yishu as brain: ${verdict}.`,
      `Used ${chosen.model} @ ${SAMPLE_RATE} Hz voice=${chosen.voice} tools=${chosen.toolsFormat}.`,
      `Chit-chat first-audio p50=${s1?.latency_p50_ms ?? "n/a"}ms; S5 floor p50=${s5?.latency_p50_ms ?? "skipped"}ms.`,
      `S2 ask_yishu ${s2?.ask_yishu.filter(Boolean).length || 0}/3; S3 ${s3?.ask_yishu.filter(Boolean).length || 0}/3; S1 false-tool ${s1FalseTool}/3.`,
      `Bridging during wait: S2 ${s2BridgeWait}/3. Interrupt stopped: ${s4?.runs.filter((r) => r.stopped).length || 0}/3.`,
      risks.length ? `Main risks: ${risks.join("; ")}.` : "No major routing/wait/interrupt risks observed in this small n.",
      "This is a lab harness (file-streamed TTS, no live mic, n=3). Product still needs a live barge-in test and a hard rule that screen/memory never skip the brain.",
    ].join(" "),
  };
}

function toMd(report) {
  const lines = [];
  lines.push(report.title ? `# ${report.title}` : "# exp4 duplex — 2026-09-04");
  lines.push("");
  lines.push(`- Model used: \`${report.model_used ?? "none"}\``);
  lines.push(`- Sample rate: ${report.sample_rate} Hz pcm16`);
  lines.push(`- Voice: \`${report.voice}\``);
  lines.push(`- Tools format that worked: \`${report.tools_format}\``);
  if (report.function_calling !== undefined) {
    lines.push(`- Function calling: ${report.function_calling}`);
  }
  if (report.endpoint) lines.push(`- Endpoint: \`${report.endpoint}\``);
  lines.push(`- StepFun host: \`${report.host}\``);
  if (report.path) lines.push(`- Path prefix: \`${report.path}\``);
  if (report.stepfun_step_plan_key_length != null) {
    lines.push(`- STEPFUN_STEP_PLAN_API_KEY length: ${report.stepfun_step_plan_key_length}`);
  }
  if (report.stepfun_key_length != null) {
    lines.push(`- STEPFUN_API_KEY length: ${report.stepfun_key_length}`);
  }
  lines.push(`- MINIMAX_API_KEY length: ${report.minimax_key_length}`);
  lines.push(`- MINIMAX_TTS_MODEL: \`${report.minimax_tts_model}\``);
  if (report.tts_user_audio_ms) {
    lines.push(
      `- MiniMax TTS durations: U1 ${report.tts_user_audio_ms.U1}ms, U2 ${report.tts_user_audio_ms.U2}ms, U3 ${report.tts_user_audio_ms.U3}ms, U4 ${report.tts_user_audio_ms.U4}ms, 嗯 ${report.tts_user_audio_ms.UH}ms`,
    );
  }
  if (report.catalog?.candidate_in_catalog) {
    const bits = Object.entries(report.catalog.candidate_in_catalog)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    lines.push(`- Catalog (/v1/models http ${report.catalog.http}): ${bits}`);
  }
  lines.push("");
  if (report.candidate_failures?.length) {
    lines.push("## Candidate models that failed");
    for (const f of report.candidate_failures) {
      lines.push(`- \`${f.model}\`: ${f.reason}`);
    }
    lines.push("");
  }
  lines.push("## Per-scenario table");
  lines.push("");
  lines.push(
    "| Scenario | Run | first-audio ms | ask_yishu | question | bridging (wait) | bridging text | interrupt stop ms | transcript | error |",
  );
  lines.push("|---|---:|---:|---|---|---|---|---:|---|---|");
  for (const [name, block] of Object.entries(report.scenarios)) {
    for (const r of block.runs) {
      const stop = r.ms_u3_to_speech_started ?? r.ms_u3_to_cancelled ?? "";
      const tr = (r.transcript || r.transcript_after || r.transcript_before || "").replace(/\s+/g, " ").slice(0, 80);
      lines.push(
        `| ${name} | ${r.run} | ${r.latency_ms ?? r.ms_output_to_audio ?? ""} | ${r.ask_yishu_called ? "yes" : "no"} | ${(r.question || "").replace(/\|/g, "/").slice(0, 40)} | ${r.bridging_during_wait ? "yes" : r.bridging ? "pre-fn" : "no"} | ${(r.bridging_text || "").replace(/\|/g, "/").slice(0, 40)} | ${stop} | ${tr.replace(/\|/g, "/")} | ${(r.error || "").replace(/\|/g, "/").slice(0, 90)} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Aggregates");
  lines.push("");
  for (const [name, block] of Object.entries(report.scenarios)) {
    lines.push(
      `- **${name}** first-audio p50=${block.latency_p50_ms ?? "n/a"} p95=${block.latency_p95_ms ?? "n/a"}; fn p50=${block.fn_p50_ms ?? "n/a"}; brain→audio p50=${block.output_to_audio_p50_ms ?? "n/a"}; interrupt p50=${block.interrupt_stop_p50_ms ?? "n/a"}; ask_yishu=${block.ask_yishu.join(",")}`,
    );
  }
  lines.push("");
  lines.push("## Transcripts (full)");
  lines.push("");
  for (const [name, block] of Object.entries(report.scenarios)) {
    for (const r of block.runs) {
      lines.push(`### ${name} run ${r.run}`);
      if (r.question) lines.push(`- ask_yishu.question: ${r.question}`);
      if (r.bridging_text) lines.push(`- bridging: ${r.bridging_text}`);
      if (r.transcript) lines.push(`- ${r.transcript}`);
      if (r.transcript_before) lines.push(`- before interrupt: ${r.transcript_before}`);
      if (r.transcript_after) lines.push(`- after interrupt: ${r.transcript_after}`);
      if (r.faithful) lines.push(`- faithful: ${JSON.stringify(r.faithful)}`);
      if (r.error) lines.push(`- error: ${r.error}`);
      lines.push("");
    }
  }
  lines.push("## Caveats");
  lines.push("");
  for (const c of report.caveats) lines.push(`- ${c}`);
  lines.push("");
  lines.push("## Recommendation");
  lines.push("");
  lines.push(report.recommendation.paragraph);
  lines.push("");
  return lines.join("\n");
}

function scenariosWorked(summary) {
  const n = (s, pred) => (summary[s]?.runs || []).filter(pred).length;
  return (
    n("S1", (r) => r.latency_ms != null) >= 2 &&
    n("S2", (r) => r.ask_yishu_called) >= 2 &&
    n("S3", (r) => r.ask_yishu_called) >= 2 &&
    n("S4", (r) => r.latency_ms != null) >= 2
  );
}

function persistStepPlan(stepPlan, readmeText) {
  const jsonPath = join(RESULTS_DIR, `${RESULT_STAMP}.json`);
  const mdPath = join(RESULTS_DIR, `${RESULT_STAMP}.md`);
  let root = {};
  if (existsSync(jsonPath)) {
    try {
      root = JSON.parse(readFileSync(jsonPath, "utf8"));
    } catch {
      root = {};
    }
  }
  root.step_plan_run = stepPlan;
  writeFileSync(jsonPath, JSON.stringify(root, null, 2));
  let md = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
  const marker = "\n---\n\n# Step Plan run\n";
  const idx = md.indexOf(marker);
  if (idx >= 0) md = md.slice(0, idx);
  md = md.replace(/\s*$/, "") + "\n\n---\n\n" + toMd({ ...stepPlan, title: "Step Plan run" });
  writeFileSync(mdPath, md);
  writeFileSync(join(HERE, "README.md"), readmeText);
}

function toMdS6S8(block) {
  const lines = [];
  lines.push("# S6–S8");
  lines.push("");
  if (block.tool_choice) {
    lines.push(`- tool_choice discovery: \`${block.tool_choice.label || "rejected"}\``);
    for (const a of block.tool_choice.attempts || []) {
      lines.push(`  - ${a.form}: ${a.ok ? "ok" : a.error || "fail"}`);
    }
  }
  if (block.transcription) {
    lines.push(`- input transcription field: \`${block.transcription.label}\``);
  }
  lines.push("");
  lines.push("| Scenario | Run | ask_yishu | question | bridging | faithful | transcript/spoken | interrupt ms | error |");
  lines.push("|---|---:|---|---|---|---|---|---:|---|");
  for (const r of block.rows || []) {
    const stop = r.ms_u3_to_speech_started ?? "";
    const tr = (r.transcript || r.spoken || r.user_transcript || "").replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 70);
    lines.push(
      `| ${r.scenario} | ${r.run} | ${r.ask_yishu_called ? "yes" : "no"} | ${(r.question || "").replace(/\|/g, "/").slice(0, 36)} | ${r.bridging_during_wait ? "wait" : r.bridging ? "pre" : "no"} | ${r.faithful ? (r.faithful.ok ? "ok" : "no") : r.verbatim === true ? "verbatim" : r.edit_distance != null ? `ed=${r.edit_distance}` : ""} | ${tr} | ${stop} | ${(r.error || "").replace(/\|/g, "/").slice(0, 70)} |`,
    );
  }
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push(`1. Forced hand-off: ${block.answers.handoff}`);
  lines.push(`2. Transport-only: ${block.answers.transport}`);
  lines.push(`3. Interrupt floor: ${block.answers.interrupt}`);
  lines.push("");
  if (block.caveats?.length) {
    lines.push("## Caveats");
    lines.push("");
    for (const c of block.caveats) lines.push(`- ${c}`);
    lines.push("");
  }
  return lines.join("\n");
}

function persistS6S8(block) {
  const jsonPath = join(RESULTS_DIR, `${RESULT_STAMP}.json`);
  const mdPath = join(RESULTS_DIR, `${RESULT_STAMP}.md`);
  let root = {};
  if (existsSync(jsonPath)) {
    try {
      root = JSON.parse(readFileSync(jsonPath, "utf8"));
    } catch {
      root = {};
    }
  }
  root.s6_s8_run = block;
  writeFileSync(jsonPath, JSON.stringify(root, null, 2));
  let md = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
  const marker = "\n---\n\n# S6–S8\n";
  const idx = md.indexOf(marker);
  if (idx >= 0) md = md.slice(0, idx);
  md = md.replace(/\s*$/, "") + marker + "\n" + toMdS6S8(block).replace(/^# S6–S8\n/, "");
  writeFileSync(mdPath, md);
}

async function mainS6S8() {
  mkdirSync(WORK, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });
  const env = loadDotVars(DEV_VARS);
  const plan = parseStepPlan(env);
  console.log(
    `[s6-s8] STEPFUN_STEP_PLAN_API_KEY length=${plan.key.length} host=${plan.host} path=${plan.prefix} model=${PLAN_MODEL}`,
  );
  const pcm = {
    U1: await ttsMiniMax(env, UTTERANCES.U1, join(WORK, "U1")),
    U2: await ttsMiniMax(env, UTTERANCES.U2, join(WORK, "U2")),
    U3: await ttsMiniMax(env, UTTERANCES.U3, join(WORK, "U3")),
    U4: await ttsMiniMax(env, UTTERANCES.U4, join(WORK, "U4")),
  };
  const voice = DEFAULT_VOICE;
  const chosenBase = {
    model: PLAN_MODEL,
    url: plan.wsUrl,
    voice,
    tools: TOOL_STEPFUN,
    toolsFormat: "stepfun-nested",
    functionCalling: true,
    locked: true,
  };

  console.log("[S6] discovering tool_choice");
  const toolChoice = await discoverToolChoice(plan, voice);
  const rows = [];
  if (toolChoice.rejected) {
    console.log("[S6] every tool_choice form rejected — stop S6");
    rows.push({
      scenario: "S6",
      run: 0,
      ask_yishu_called: false,
      error: "every tool_choice form rejected",
      tool_choice_attempts: toolChoice.attempts,
    });
  } else {
    const chosenS6 = {
      ...chosenBase,
      extra: {
        instructions: INSTRUCTIONS_S6,
        ...(toolChoice.sessionToolChoice ? { tool_choice: toolChoice.sessionToolChoice } : {}),
      },
      responseToolChoice: toolChoice.responseToolChoice || null,
    };
    for (let run = 1; run <= 3; run++) {
      console.log(`[S6-U2] run ${run}`);
      rows.push(
        await withRetries(`S6-U2-${run}`, () =>
          runBrainCall({
            apiKey: plan.key,
            chosen: chosenS6,
            pcm: pcm.U2,
            scenario: "S6-U2",
            run,
            brainText: BRAIN_S2,
          }),
        ),
      );
    }
    for (let run = 1; run <= 3; run++) {
      console.log(`[S6-U4] run ${run}`);
      rows.push(
        await withRetries(`S6-U4-${run}`, () =>
          runBrainCall({
            apiKey: plan.key,
            chosen: chosenS6,
            pcm: pcm.U4,
            scenario: "S6-U4",
            run,
            brainText: BRAIN_S3,
          }),
        ),
      );
    }
  }

  console.log("[S7] transport-only");
  let transcribe = { extra: {}, label: "none", attempts: [] };
  {
    const log = new JsonlLog(join(WORK, "probe-transcription.jsonl"));
    const session = new RealtimeSession({ url: plan.wsUrl, apiKey: plan.key, log, tag: "asr-field" });
    try {
      await session.connect();
      await session.waitFor((e) => e.type === "session.created", 8000, "session.created");
      transcribe = await discoverTranscription(session, voice);
    } catch (err) {
      console.error(`[transcription] probe ${err.message}`);
    } finally {
      session.close();
    }
  }
  for (const utt of ["U1", "U2", "U4"]) {
    for (let run = 1; run <= 3; run++) {
      console.log(`[S7-${utt}] run ${run}`);
      rows.push(
        await withRetries(`S7-${utt}-${run}`, () =>
          runTransport({
            apiKey: plan.key,
            url: plan.wsUrl,
            voice,
            pcm: pcm[utt],
            utterance: utt,
            canned: CANNED_S7[utt],
            run,
            transcribeExtra: transcribe.extra,
          }),
        ),
      );
    }
  }

  console.log("[S8] VAD interrupt");
  for (const [tag, vad] of [
    ["default", VAD_DEFAULT],
    ["fast", VAD_FAST],
  ]) {
    const n = tag === "default" ? 5 : 5;
    for (let run = 1; run <= n; run++) {
      console.log(`[S8-${tag}] run ${run}`);
      rows.push(
        await withRetries(`S8-${tag}-${run}`, () =>
          runVadClean({
            apiKey: plan.key,
            url: plan.wsUrl,
            voice,
            pcmU3: pcm.U3,
            run,
            vad,
            tag,
          }),
        ),
      );
    }
  }

  const s6 = rows.filter((r) => String(r.scenario).startsWith("S6") && r.run);
  const s7 = rows.filter((r) => String(r.scenario).startsWith("S7"));
  const s8 = rows.filter((r) => String(r.scenario).startsWith("S8"));
  const s6Fire = s6.filter((r) => r.ask_yishu_called).length;
  const s6n = s6.length;
  const s7Asr = s7.map((r) => r.ms_end_to_transcript).filter(Number.isFinite);
  const s7Tts = s7.map((r) => r.ms_text_to_audio).filter(Number.isFinite);
  const s7Partial = s7.some((r) => r.partial_during_speech);
  const s7Viol = s7.filter((r) => r.violation).length;
  const s7Ed = s7.map((r) => r.edit_distance).filter((n) => Number.isFinite(n));
  const s8Start = s8.map((r) => r.ms_u3_to_speech_started).filter(Number.isFinite);
  const s8Last = s8.map((r) => r.ms_u3_to_last_audio).filter(Number.isFinite);
  const s8Fast = s8.filter((r) => r.scenario === "S8-fast").map((r) => r.ms_u3_to_speech_started).filter(Number.isFinite);
  const s8Def = s8.filter((r) => r.scenario === "S8-default").map((r) => r.ms_u3_to_speech_started).filter(Number.isFinite);
  const bestStart = [percentile(s8Fast, 50), percentile(s8Def, 50)].filter(Number.isFinite);
  const best = bestStart.length ? Math.min(...bestStart) : percentile(s8Start, 50);

  const answers = {
    handoff: toolChoice.rejected
      ? `no — server rejected every tool_choice form (${(toolChoice.attempts || []).map((a) => a.form).join(", ")})`
      : `tool_choice ${toolChoice.label} accepted; ask_yishu fired ${s6Fire}/${s6n}. ${s6Fire >= 4 ? "Forced hand-off is usable." : "Still not reliable enough to be the brain gate."}`,
    transport: `transcript p50=${percentile(s7Asr, 50) ?? "n/a"}ms (partials ${s7Partial ? "yes" : "no"}); text→audio p50=${percentile(s7Tts, 50) ?? "n/a"}ms; self-answer violations ${s7Viol}/${s7.length}; median edit-distance ${percentile(s7Ed, 50) ?? "n/a"}. ${s7Viol <= 1 && percentile(s7Tts, 50) != null ? "Viable as STT+TTS pipe with a cancel guard." : "Weak as a pipe — too many self-answers or missing TTS."}`,
    interrupt: `U3→speech_started p50 default=${percentile(s8Def, 50) ?? "n/a"}ms fast=${percentile(s8Fast, 50) ?? "n/a"}ms; U3→last-audio p50=${percentile(s8Last, 50) ?? "n/a"}ms; best p50=${best ?? "n/a"}ms.`,
  };

  const block = {
    date: "2026-09-04",
    model_used: PLAN_MODEL,
    voice,
    endpoint: plan.wsUrl,
    tool_choice: toolChoice,
    transcription: transcribe,
    rows,
    aggregates: {
      s6_ask_yishu: `${s6Fire}/${s6n}`,
      s7_transcript_p50_ms: percentile(s7Asr, 50),
      s7_text_to_audio_p50_ms: percentile(s7Tts, 50),
      s7_partials: s7Partial,
      s7_violations: s7Viol,
      s7_edit_p50: percentile(s7Ed, 50),
      s8_speech_started_p50_ms: percentile(s8Start, 50),
      s8_last_audio_p50_ms: percentile(s8Last, 50),
      s8_best_speech_started_p50_ms: best,
    },
    answers,
    caveats: [
      "S6–S8 used Step Plan /step_plan/v1 and stepaudio-2.5-realtime only.",
      "S8 U3 has a 60ms 700Hz onset prepended so VAD sees a loud start.",
      "API VAD field is energy_awakeness_threshold (not threshold).",
      "S1–S5 were not re-run.",
    ],
  };
  persistS6S8(block);
  const readmePath = join(HERE, "README.md");
  if (existsSync(readmePath)) {
    let rd = readFileSync(readmePath, "utf8");
    if (!rd.includes("S6–S8")) {
      rd += `\n## S6–S8\n\nRe-run only these: \`node evals/voice/exp4-duplex/run.mjs --s6-s8\`\n`;
      writeFileSync(readmePath, rd);
    }
  }
  console.log(`[done] S6–S8 handoff=${s6Fire}/${s6n} transcript_p50=${percentile(s7Asr, 50)} tts_p50=${percentile(s7Tts, 50)} vad_best=${best}`);
}

async function main() {
  mkdirSync(WORK, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });
  const env = loadDotVars(DEV_VARS);
  const plan = parseStepPlan(env);
  console.log(
    `[env] STEPFUN_STEP_PLAN_API_KEY length=${plan.key.length} MINIMAX_API_KEY length=${(env.MINIMAX_API_KEY || "").length} host=${plan.host} path=${plan.prefix} model=${PLAN_MODEL} tts_model=${env.MINIMAX_TTS_MODEL} tts_host=${(() => { try { return new URL(env.MINIMAX_TTS_URL).host; } catch { return "n/a"; } })()}`,
  );

  const pcm = {};
  pcm.U1 = await ttsMiniMax(env, UTTERANCES.U1, join(WORK, "U1"));
  pcm.U2 = await ttsMiniMax(env, UTTERANCES.U2, join(WORK, "U2"));
  pcm.U3 = await ttsMiniMax(env, UTTERANCES.U3, join(WORK, "U3"));
  pcm.U4 = await ttsMiniMax(env, UTTERANCES.U4, join(WORK, "U4"));
  pcm.UH = await ttsMiniMax(env, UTTERANCES.UH, join(WORK, "UH"));
  if (pcmDurationMs(pcm.UH) < 1000) {
    pcm.UH = Buffer.concat([pcm.UH, silencePcm(1000 - pcmDurationMs(pcm.UH))]);
    writeFileSync(join(WORK, "UH-1s.pcm"), pcm.UH);
    writeFileSync(join(WORK, "UH-1s.wav"), pcm16ToWav(pcm.UH));
  }

  const failures = [];
  let chosen = null;
  console.log(`[probe] ${PLAN_MODEL} via ${plan.prefix}`);
  chosen = await withRetries(`probe:${PLAN_MODEL}`, async () => {
    const r = await probeModel(plan, failures);
    if (!r) throw new Error(`probe failed: ${failures.at(-1)?.reason || ""}`);
    return r;
  }).catch((err) => {
    console.error(`[probe] stop: ${err.message}`);
    return null;
  });
  const readmeFor = (extra) => `# exp4-duplex — StepFun full-duplex mouth/ears + ask_yishu brain

Throwaway lab harness. Does not touch product code.

## Command

From the repo root (Node 22, no extra npm deps):

\`\`\`bash
node evals/voice/exp4-duplex/run.mjs
\`\`\`

Secrets are read at runtime from \`apps/clicky/worker/.dev.vars\` (\`STEPFUN_STEP_PLAN_API_KEY\`, \`STEPFUN_STEP_PLAN_BASE\`, MiniMax TTS). Never printed.
Audio and per-run event logs go to \`.work/voice-experiments/duplex/\` (gitignored).
Results: \`evals/voice/results/2026-09-04-exp4-duplex.json\` and \`.md\` (Step Plan run appended).

## This run

- **Model actually used:** \`${extra.model}\`
- **Sample rate:** ${SAMPLE_RATE} Hz pcm16
- **Voice:** \`${extra.voice}\`
- **Tools:** \`${extra.tools}\`
- **Function calling:** ${extra.functionCalling}
- **Endpoint:** \`${plan.wsUrl}\`
`;

  if (!chosen) {
    const skipReason = `not run: ${PLAN_MODEL} failed on ${plan.prefix} (${failures.at(-1)?.reason || "unknown"})`;
    const stepPlan = {
      date: "2026-09-04",
      endpoint: plan.wsUrl,
      model_used: null,
      sample_rate: SAMPLE_RATE,
      voice: DEFAULT_VOICE,
      tools_format: "not reached",
      function_calling: null,
      host: plan.host,
      path: plan.prefix,
      stepfun_step_plan_key_length: plan.key.length,
      minimax_key_length: (env.MINIMAX_API_KEY || "").length,
      minimax_tts_model: env.MINIMAX_TTS_MODEL,
      candidate_failures: failures,
      scenarios: summarizeScenarios(skippedRows(skipReason)),
      caveats: [
        `Only ${PLAN_MODEL} was attempted (no fallbacks).`,
        `Endpoint prefix ${plan.prefix}.`,
        failures.at(-1)?.reason || "probe failed",
      ],
      recommendation: {
        verdict: "not viable — Step Plan realtime session never opened",
        paragraph: `Step Plan path ${plan.prefix} did not accept ${PLAN_MODEL}. ${failures.at(-1)?.reason || ""} Mouth/ears + ask_yishu still unmeasured on this key.`,
        risks: ["Step Plan realtime session failed", "handoff/bridging/interrupt unmeasured"],
      },
    };
    persistStepPlan(stepPlan, readmeFor({ model: "none", voice: DEFAULT_VOICE, tools: "n/a", functionCalling: "n/a" }));
    console.error("[fatal] no model");
    process.exitCode = 1;
    return;
  }
  console.log(
    `[chosen] model=${chosen.model} voice=${chosen.voice} tools=${chosen.toolsFormat} fn=${chosen.functionCalling}`,
  );

  const rows = [];
  for (let run = 1; run <= 3; run++) {
    console.log(`[S1] run ${run}`);
    rows.push(await withRetries(`S1-${run}`, () => runChitChat({ apiKey: plan.key, chosen, pcm: pcm.U1, scenario: "S1", run })));
  }
  for (let run = 1; run <= 3; run++) {
    console.log(`[S2] run ${run}`);
    rows.push(await withRetries(`S2-${run}`, () => runBrainCall({ apiKey: plan.key, chosen, pcm: pcm.U2, scenario: "S2", run, brainText: BRAIN_S2 })));
  }
  for (let run = 1; run <= 3; run++) {
    console.log(`[S3] run ${run}`);
    rows.push(await withRetries(`S3-${run}`, () => runBrainCall({ apiKey: plan.key, chosen, pcm: pcm.U4, scenario: "S3", run, brainText: BRAIN_S3 })));
  }
  for (let run = 1; run <= 3; run++) {
    console.log(`[S4] run ${run}`);
    rows.push(await withRetries(`S4-${run}`, () => runInterrupt({ apiKey: plan.key, chosen, pcmU1: pcm.U1, pcmU3: pcm.U3, run })));
  }

  let summary = summarizeScenarios(rows);
  if (scenariosWorked(summary)) {
    for (let run = 1; run <= 10; run++) {
      console.log(`[S5] run ${run}`);
      rows.push(
        await withRetries(`S5-${run}`, () =>
          runChitChat({ apiKey: plan.key, chosen, pcm: pcm.UH, scenario: "S5", run }),
        ),
      );
    }
    summary = summarizeScenarios(rows);
  } else {
    console.log("[S5] skipped — S1–S4 did not meet the success bar");
  }

  const rec = recommendation(chosen, summary, failures);
  const caveats = [
    `Step Plan endpoint ${plan.wsUrl}.`,
    `Audio streamed in ${CHUNK_MS}ms chunks at real-time pace; docs recommend 20–30ms.`,
    `Trailing ${VAD_SILENCE_MS}ms silence appended so server_vad can fire; latency includes VAD hangover.`,
    "User audio is MiniMax TTS, not a live mic; interruption is file barge-in.",
    chosen.functionCalling
      ? `session.update accepted tools format ${chosen.toolsFormat}.`
      : "session.update rejected tools; retried without. Function calling unsupported.",
  ];
  if (!summary.S5) caveats.push("S5 latency floor skipped because S1–S4 did not all work.");

  const stepPlan = {
    date: "2026-09-04",
    endpoint: plan.wsUrl,
    model_used: chosen.model,
    sample_rate: SAMPLE_RATE,
    voice: chosen.voice,
    tools_format: chosen.toolsFormat,
    function_calling: chosen.functionCalling,
    host: plan.host,
    path: plan.prefix,
    chunk_ms: CHUNK_MS,
    brain_delay_ms: BRAIN_DELAY_MS,
    stepfun_step_plan_key_length: plan.key.length,
    minimax_key_length: (env.MINIMAX_API_KEY || "").length,
    minimax_tts_model: env.MINIMAX_TTS_MODEL,
    candidate_failures: failures,
    scenarios: summary,
    caveats,
    recommendation: rec,
  };
  persistStepPlan(
    stepPlan,
    readmeFor({
      model: chosen.model,
      voice: chosen.voice,
      tools: chosen.toolsFormat,
      functionCalling: chosen.functionCalling,
    }),
  );
  console.log(`[done] model=${chosen.model} verdict=${rec.verdict} fn=${chosen.functionCalling}`);
}

function toMdEnNovad(block) {
  const lines = [];
  lines.push("# Step Plan run, English instructions, VAD off");
  lines.push("");
  lines.push(`- Model: \`${block.model_used}\` voice=\`${block.voice}\``);
  lines.push(`- Endpoint: \`${block.endpoint}\``);
  lines.push("- Config: English session.instructions + nested ask_yishu (EN desc) + turn_detection omitted + commit + response.create");
  lines.push("");
  lines.push(
    "| Scenario | Run | first-audio / out ms | ask_yishu | question | bridging | chinese | en leak | faithful | transcript | error |",
  );
  lines.push("|---|---:|---:|---|---|---|---|---|---|---|---|");
  for (const [name, sc] of Object.entries(block.scenarios || {})) {
    for (const r of sc.runs || []) {
      const tr = (r.transcript || r.transcript_after || r.transcript_before || "")
        .replace(/\s+/g, " ")
        .replace(/\|/g, "/")
        .slice(0, 70);
      const lat = r.latency_ms ?? r.ms_output_to_audio ?? r.ms_action_to_last_audio ?? "";
      lines.push(
        `| ${name}${r.method ? "/" + r.method : ""} | ${r.run} | ${lat} | ${r.ask_yishu_called ? "yes" : "no"} | ${(r.question || "").replace(/\|/g, "/").slice(0, 36)} | ${r.bridging_during_wait ? "wait" : r.bridging ? "pre" : "no"} | ${r.chinese ? "yes" : "no"} | ${r.english_leak_yes ? (r.english_leak || []).slice(0, 4).join(" ") : "no"} | ${r.faithful ? (r.faithful.ok && !r.faithful.invented ? "ok" : "no") : ""} | ${tr} | ${(r.error || "").replace(/\|/g, "/").slice(0, 70)} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Aggregates");
  lines.push("");
  for (const [name, sc] of Object.entries(block.scenarios || {})) {
    lines.push(
      `- **${name}** first-audio p50=${sc.latency_p50_ms ?? "n/a"} p95=${sc.latency_p95_ms ?? "n/a"}; fn p50=${sc.fn_p50_ms ?? "n/a"}; brain→audio p50=${sc.output_to_audio_p50_ms ?? "n/a"}; ask_yishu=${(sc.ask_yishu || []).join(",")}`,
    );
  }
  lines.push("");
  lines.push("## Transcripts");
  lines.push("");
  for (const [name, sc] of Object.entries(block.scenarios || {})) {
    for (const r of sc.runs || []) {
      lines.push(`### ${name} run ${r.run}${r.method ? " " + r.method : ""}`);
      if (r.question) lines.push(`- ask_yishu.question: ${r.question}`);
      if (r.bridging_text) lines.push(`- bridging: ${r.bridging_text}`);
      if (r.transcript) lines.push(`- ${r.transcript}`);
      if (r.transcript_before) lines.push(`- before: ${r.transcript_before}`);
      if (r.transcript_after) lines.push(`- after: ${r.transcript_after}`);
      if (r.faithful) lines.push(`- faithful: ${JSON.stringify(r.faithful)}`);
      if (r.persona) lines.push(`- persona: ${JSON.stringify(r.persona)}`);
      if (r.english_leak_yes) lines.push(`- english leak: ${(r.english_leak || []).join(", ")}`);
      if (r.fabricated) lines.push("- fabricated: yes");
      if (r.error) lines.push(`- error: ${r.error}`);
      lines.push("");
    }
  }
  lines.push("## Verdict");
  lines.push("");
  lines.push(block.recommendation?.paragraph || "");
  lines.push("");
  if (block.caveats?.length) {
    lines.push("## Caveats");
    lines.push("");
    for (const c of block.caveats) lines.push(`- ${c}`);
    lines.push("");
  }
  return lines.join("\n");
}

function persistEnNovad(block) {
  const jsonPath = join(RESULTS_DIR, `${RESULT_STAMP}.json`);
  const mdPath = join(RESULTS_DIR, `${RESULT_STAMP}.md`);
  let root = {};
  if (existsSync(jsonPath)) {
    try {
      root = JSON.parse(readFileSync(jsonPath, "utf8"));
    } catch {
      root = {};
    }
  }
  root.en_novad_run = block;
  writeFileSync(jsonPath, JSON.stringify(root, null, 2));
  let md = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
  const marker = "\n---\n\n# Step Plan run, English instructions, VAD off\n";
  const idx = md.indexOf(marker);
  if (idx >= 0) md = md.slice(0, idx);
  md = md.replace(/\s*$/, "") + marker + "\n" + toMdEnNovad(block).replace(/^# Step Plan run, English instructions, VAD off\n/, "");
  writeFileSync(mdPath, md);
}

function recommendationEnNovad(summary) {
  const s1 = summary.S1;
  const s2 = summary.S2;
  const s3 = summary.S3;
  const s4 = summary.S4;
  const s5 = summary.S5;
  const s1Ok = (s1?.runs || []).filter((r) => r.latency_ms != null && !r.ask_yishu_called && r.chinese).length;
  const s2Fn = (s2?.ask_yishu || []).filter(Boolean).length;
  const s3Fn = (s3?.ask_yishu || []).filter(Boolean).length;
  const s2Faith = (s2?.runs || []).filter((r) => r.faithful?.ok && !r.faithful?.invented && r.chinese).length;
  const s3Faith = (s3?.runs || []).filter((r) => r.faithful?.ok && !r.faithful?.invented && r.chinese).length;
  const leak = [...(s1?.runs || []), ...(s2?.runs || []), ...(s3?.runs || []), ...(s5?.runs || [])].filter(
    (r) => r.english_leak_yes,
  ).length;
  const fab = (s1?.runs || []).filter((r) => r.fabricated).length;
  const cancel = (s4?.runs || []).filter((r) => r.method === "cancel");
  const append = (s4?.runs || []).filter((r) => r.method === "append");
  const cancelStop = cancel.filter((r) => r.stopped).length;
  const appendStop = append.filter((r) => r.stopped).length;
  const helpdesk = [...(s1?.runs || []), ...(s2?.runs || []), ...(s3?.runs || [])].filter((r) => r.persona?.helpdesk).length;

  let verdict;
  if (s2Fn >= 2 && s3Fn >= 2 && s1Ok >= 2) {
    verdict = "viable-with-guards for 实时对话 (English instructions + VAD-off PTT)";
  } else if (s2Fn + s3Fn >= 3) {
    verdict = "partially viable — hand-off fires but routing or speech is inconsistent";
  } else {
    verdict = "still not viable as mouth/ears + ask_yishu brain";
  }

  const risks = [];
  if ((s1?.runs || []).some((r) => r.ask_yishu_called)) risks.push("S1 false-tool");
  if (s2Fn < 3 || s3Fn < 3) risks.push(`hand-off misses S2 ${s2Fn}/3 S3 ${s3Fn}/3`);
  if (fab) risks.push(`S1 fabricated ${fab}/3`);
  if (leak) risks.push(`English leaked in ${leak} spoken turn(s)`);
  if (s2Faith < s2Fn || s3Faith < s3Fn) risks.push("relay not fully faithful/Chinese");
  if (cancelStop < cancel.length) risks.push(`response.cancel stopped ${cancelStop}/${cancel.length}`);
  if (appendStop) risks.push("append-during-playback alone stopped audio (unexpected)");
  if (!appendStop && append.length) risks.push("append-during-playback alone does not stop playback");
  if (helpdesk) risks.push("help-desk persona slipped in");
  if ((s1?.latency_p50_ms ?? 9999) > 1500) risks.push("S1 first-audio p50 > 1.5s");
  if ((s5?.latency_p50_ms ?? 0) > 1500) risks.push("S5 嗯？ p50 > 1.5s");

  const cancelLast = percentile(
    cancel.map((r) => r.ms_action_to_last_audio).filter(Number.isFinite),
    50,
  );
  return {
    verdict,
    p50_first_audio_ms: s5?.latency_p50_ms ?? s1?.latency_p50_ms,
    risks,
    paragraph: [
      `Realtime-as-voice-I/O + ask_yishu: ${verdict}.`,
      `S1 no-tool ${s1Ok}/3 Chinese, first-audio p50=${s1?.latency_p50_ms ?? "n/a"}ms, fabricated ${fab}/3.`,
      `S2 ask_yishu ${s2Fn}/3 faithful+CN ${s2Faith}/3; S3 ${s3Fn}/3 faithful+CN ${s3Faith}/3; brain→audio p50 S2=${s2?.output_to_audio_p50_ms ?? "n/a"} S3=${s3?.output_to_audio_p50_ms ?? "n/a"}.`,
      `S4 cancel stop ${cancelStop}/${cancel.length} last-audio p50=${cancelLast ?? "n/a"}ms; append-alone stop ${appendStop}/${append.length}.`,
      `S5 嗯？ p50=${s5?.latency_p50_ms ?? "n/a"}ms. English leak ${leak}. Help-desk ${helpdesk}.`,
      risks.length ? `Remaining risks: ${risks.join("; ")}.` : "No major routing/language/interrupt risks in this n.",
    ].join(" "),
  };
}

async function mainEnNovad() {
  mkdirSync(WORK, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });
  const env = loadDotVars(DEV_VARS);
  const plan = parseStepPlan(env);
  console.log(
    `[en-novad] STEPFUN_STEP_PLAN_API_KEY length=${plan.key.length} host=${plan.host} path=${plan.prefix} model=${PLAN_MODEL}`,
  );
  const pcm = {
    U1: await ttsMiniMax(env, UTTERANCES.U1, join(WORK, "U1")),
    U2: await ttsMiniMax(env, UTTERANCES.U2, join(WORK, "U2")),
    U3: await ttsMiniMax(env, UTTERANCES.U3, join(WORK, "U3")),
    U4: await ttsMiniMax(env, UTTERANCES.U4, join(WORK, "U4")),
    UH: await ttsMiniMax(env, UTTERANCES.UH, join(WORK, "UH")),
  };
  if (pcmDurationMs(pcm.UH) < 1000) {
    pcm.UH = Buffer.concat([pcm.UH, silencePcm(1000 - pcmDurationMs(pcm.UH))]);
  }

  const chosen = {
    model: PLAN_MODEL,
    url: plan.wsUrl,
    voice: DEFAULT_VOICE,
    tools: TOOL_STEPFUN_EN,
    toolsFormat: "stepfun-nested",
    functionCalling: true,
    locked: true,
    logPrefix: "en-",
    extra: {
      instructions: INSTRUCTIONS_EN,
      turn_detection: null,
      pushToTalk: true,
    },
  };

  const rows = [];
  for (let run = 1; run <= 3; run++) {
    console.log(`[S1] run ${run}`);
    rows.push(
      annotateSpeech(
        await withRetries(`S1-${run}`, () =>
          runChitChat({ apiKey: plan.key, chosen, pcm: pcm.U1, scenario: "S1", run }),
        ),
      ),
    );
  }
  for (let run = 1; run <= 3; run++) {
    console.log(`[S2] run ${run}`);
    rows.push(
      annotateSpeech(
        await withRetries(`S2-${run}`, () =>
          runBrainCall({ apiKey: plan.key, chosen, pcm: pcm.U2, scenario: "S2", run, brainText: BRAIN_S2 }),
        ),
        BRAIN_S2,
      ),
    );
  }
  for (let run = 1; run <= 3; run++) {
    console.log(`[S3] run ${run}`);
    rows.push(
      annotateSpeech(
        await withRetries(`S3-${run}`, () =>
          runBrainCall({ apiKey: plan.key, chosen, pcm: pcm.U4, scenario: "S3", run, brainText: BRAIN_S3 }),
        ),
        BRAIN_S3,
      ),
    );
  }
  const s4methods = ["cancel", "append", "cancel"];
  for (let run = 1; run <= 3; run++) {
    const method = s4methods[run - 1];
    console.log(`[S4] run ${run} ${method}`);
    rows.push(
      annotateSpeech(
        await withRetries(`S4-${run}`, () =>
          runInterruptPtt({ apiKey: plan.key, chosen, pcmU1: pcm.U1, pcmU3: pcm.U3, run, method }),
        ),
      ),
    );
  }
  for (let run = 1; run <= 10; run++) {
    console.log(`[S5] run ${run}`);
    rows.push(
      annotateSpeech(
        await withRetries(`S5-${run}`, () =>
          runChitChat({ apiKey: plan.key, chosen, pcm: pcm.UH, scenario: "S5", run }),
        ),
      ),
    );
  }

  const summary = summarizeScenarios(rows);
  const rec = recommendationEnNovad(summary);
  const block = {
    date: "2026-09-04",
    label: "Step Plan run, English instructions, VAD off",
    endpoint: plan.wsUrl,
    model_used: PLAN_MODEL,
    sample_rate: SAMPLE_RATE,
    voice: DEFAULT_VOICE,
    tools_format: "stepfun-nested",
    instructions_language: "en",
    turn_detection: null,
    push_to_talk: true,
    host: plan.host,
    path: plan.prefix,
    chunk_ms: CHUNK_MS,
    brain_delay_ms: BRAIN_DELAY_MS,
    stepfun_step_plan_key_length: plan.key.length,
    scenarios: summary,
    caveats: [
      "English session.instructions; model required to speak Mandarin.",
      "turn_detection omitted (VAD off). User audio: realtime stream → commit → response.create.",
      "function_call_output sent only after function_call_arguments.done AND that response.done, then remaining 2.5s brain wait.",
      "S4: response.cancel at +800ms after first audio (runs 1,3); append-only barge-in (run 2). No server_vad.",
      "S5 always ran (10× 嗯？). S1–S5 of prior CN+VAD and S6–S8 were not re-run.",
      "User audio is MiniMax TTS, not a live mic.",
    ],
    recommendation: rec,
  };
  persistEnNovad(block);
  const readmePath = join(HERE, "README.md");
  if (existsSync(readmePath)) {
    let rd = readFileSync(readmePath, "utf8");
    if (!rd.includes("--en-novad")) {
      rd += `\n## English instructions, VAD off\n\n\`node evals/voice/exp4-duplex/run.mjs --en-novad\`\n`;
      writeFileSync(readmePath, rd);
    }
  }
  const s2n = (summary.S2?.ask_yishu || []).filter(Boolean).length;
  const s3n = (summary.S3?.ask_yishu || []).filter(Boolean).length;
  console.log(
    `[done] en-novad S2=${s2n}/3 S3=${s3n}/3 S1_p50=${summary.S1?.latency_p50_ms} S5_p50=${summary.S5?.latency_p50_ms} verdict=${rec.verdict}`,
  );
}

function toMdConcrete(block) {
  const lines = [];
  lines.push("# concrete tools");
  lines.push("");
  lines.push(`- Model: \`${block.model_used}\` voice=\`${block.voice}\``);
  lines.push("- Tools: `look_at_screen` + `recall_memory` (nested, EN desc); VAD off + commit PTT; no wait-phrase example");
  lines.push("");
  lines.push("| Scenario | Run | tool? | which | argument | bridging | faithful | out→audio ms | first-audio ms | transcript | error |");
  lines.push("|---|---:|---|---|---|---|---|---:|---:|---|---|");
  for (const r of block.rows || []) {
    const tr = (r.transcript || "").replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 60);
    const arg = (r.question || r.fn_arguments || "").replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 40);
    lines.push(
      `| ${r.scenario} | ${r.run} | ${r.tool_called ? "yes" : "no"} | ${r.tool_name || ""} | ${arg} | ${(r.bridging_text || "").replace(/\|/g, "/").slice(0, 36) || (r.bridging ? "yes" : "no")} | ${r.faithful ? (r.faithful.ok && !r.faithful.invented ? "ok" : "no") : ""} | ${r.ms_output_to_audio ?? ""} | ${r.latency_ms ?? ""} | ${tr} | ${(r.error || "").replace(/\|/g, "/").slice(0, 50)} |`,
    );
  }
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push(block.verdict || "");
  lines.push("");
  return lines.join("\n");
}

function persistConcrete(block) {
  const jsonPath = join(RESULTS_DIR, `${RESULT_STAMP}.json`);
  const mdPath = join(RESULTS_DIR, `${RESULT_STAMP}.md`);
  let root = {};
  if (existsSync(jsonPath)) {
    try {
      root = JSON.parse(readFileSync(jsonPath, "utf8"));
    } catch {
      root = {};
    }
  }
  root.concrete_tools_run = block;
  writeFileSync(jsonPath, JSON.stringify(root, null, 2));
  let md = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
  const marker = "\n---\n\n# concrete tools\n";
  const idx = md.indexOf(marker);
  if (idx >= 0) md = md.slice(0, idx);
  md = md.replace(/\s*$/, "") + marker + "\n" + toMdConcrete(block).replace(/^# concrete tools\n/, "");
  writeFileSync(mdPath, md);
}

function verdictConcrete(rows) {
  const u1 = rows.filter((r) => r.scenario === "U1");
  const u2 = rows.filter((r) => r.scenario === "U2");
  const u4 = rows.filter((r) => r.scenario === "U4");
  const ctrl = rows.filter((r) => r.scenario === "U2-text");
  const n = (arr, pred) => arr.filter(pred).length;
  const u1Tool = n(u1, (r) => r.tool_called);
  const u2Look = n(u2, (r) => r.tool_name === "look_at_screen");
  const u4Recall = n(u4, (r) => r.tool_name === "recall_memory");
  const u2Any = n(u2, (r) => r.tool_called);
  const u4Any = n(u4, (r) => r.tool_called);
  const ctrlLook = n(ctrl, (r) => r.tool_name === "look_at_screen");
  const parrot = rows.filter((r) => /我看一下|我看看/.test(r.transcript || r.bridging_text || "")).length;
  const faith = [...u2, ...u4, ...ctrl].filter((r) => r.faithful?.ok && !r.faithful?.invented).length;
  const outP50 = percentile(
    [...u2, ...u4, ...ctrl].map((r) => r.ms_output_to_audio).filter(Number.isFinite),
    50,
  );
  const audioFires = u2Any + u4Any;
  const textFires = ctrlLook;
  let verdict;
  if (u2Look >= 2 && u4Recall >= 2 && u1Tool === 0) {
    verdict = `Hypothesis supported: concrete tools fire on audio (look_at_screen ${u2Look}/3, recall_memory ${u4Recall}/3); chit-chat stayed tool-free ${3 - u1Tool}/3.`;
  } else if (audioFires === 0 && textFires) {
    verdict = `Audio still suppresses tools (U2+U4 ${audioFires}/6); text control called look_at_screen ${textFires}/1 — semantics work, audio path does not.`;
  } else if (audioFires === 0 && !textFires) {
    verdict = `Hypothesis rejected for this product pair: look_at_screen/recall_memory also did not fire on audio (${audioFires}/6) or text (${textFires}/1). Not just ask_yishu naming. parrot-我看 ${parrot}.`;
  } else {
    verdict = `Partial: audio tools ${audioFires}/6 (look ${u2Look}/3 recall ${u4Recall}/3); text look_at_screen ${textFires}/1; U1 false-tool ${u1Tool}/3; relay faithful ${faith}; out→audio p50=${outP50 ?? "n/a"}ms; parrot-我看 ${parrot}.`;
  }
  return (
    verdict +
    ` Bridging/faithfulness only where a tool fired. Remaining: concrete names do not by themselves unlock the 实时对话 hand-off.`
  );
}

async function mainConcreteTools() {
  mkdirSync(WORK, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });
  const env = loadDotVars(DEV_VARS);
  const plan = parseStepPlan(env);
  console.log(
    `[concrete] STEPFUN_STEP_PLAN_API_KEY length=${plan.key.length} host=${plan.host} model=${PLAN_MODEL}`,
  );
  const pcm = {
    U1: await ttsMiniMax(env, UTTERANCES.U1, join(WORK, "U1")),
    U2: await ttsMiniMax(env, UTTERANCES.U2, join(WORK, "U2")),
    U4: await ttsMiniMax(env, UTTERANCES.U4, join(WORK, "U4")),
  };
  const chosen = {
    model: PLAN_MODEL,
    url: plan.wsUrl,
    voice: DEFAULT_VOICE,
    tools: TOOL_CONCRETE,
    toolsFormat: "stepfun-nested",
    functionCalling: true,
    locked: true,
    logPrefix: "ct-",
    extra: {
      instructions: INSTRUCTIONS_CONCRETE,
      turn_detection: null,
      pushToTalk: true,
    },
  };

  const rows = [];
  for (let run = 1; run <= 3; run++) {
    console.log(`[U1] run ${run}`);
    const row = await withRetries(`ct-U1-${run}`, () =>
      runChitChat({ apiKey: plan.key, chosen, pcm: pcm.U1, scenario: "U1", run }),
    );
    annotateSpeech(row);
    rows.push(row);
  }
  for (let run = 1; run <= 3; run++) {
    console.log(`[U2] run ${run}`);
    const row = await withRetries(`ct-U2-${run}`, () =>
      runBrainCall({ apiKey: plan.key, chosen, pcm: pcm.U2, scenario: "U2", run, brainText: BRAIN_S2 }),
    );
    if (row.error === "responded without ask_yishu") row.error = "responded without tool";
    annotateSpeech(row, BRAIN_S2);
    rows.push(row);
  }
  for (let run = 1; run <= 3; run++) {
    console.log(`[U4] run ${run}`);
    const row = await withRetries(`ct-U4-${run}`, () =>
      runBrainCall({ apiKey: plan.key, chosen, pcm: pcm.U4, scenario: "U4", run, brainText: BRAIN_S3 }),
    );
    if (row.error === "responded without ask_yishu") row.error = "responded without tool";
    annotateSpeech(row, BRAIN_S3);
    rows.push(row);
  }
  console.log("[U2-text] control");
  const ctrl = await withRetries("ct-U2-text", () =>
    runBrainCall({
      apiKey: plan.key,
      chosen,
      pcm: pcm.U2,
      scenario: "U2-text",
      run: 1,
      brainText: BRAIN_S2,
      textInput: "帮我看看屏幕上这个报错是什么意思",
    }),
  );
  if (ctrl.error === "responded without ask_yishu") ctrl.error = "responded without tool";
  annotateSpeech(ctrl, BRAIN_S2);
  rows.push(ctrl);

  const block = {
    date: "2026-09-04",
    label: "concrete tools",
    endpoint: plan.wsUrl,
    model_used: PLAN_MODEL,
    voice: DEFAULT_VOICE,
    tools: ["look_at_screen", "recall_memory"],
    instructions_language: "en",
    turn_detection: null,
    push_to_talk: true,
    rows,
    verdict: verdictConcrete(rows),
    caveats: [
      "No wait-phrase example in instructions.",
      "S5 skipped. Prior CN/EN/S6–S8 runs not re-run.",
      "U2-text is input_text control on the same session config.",
    ],
  };
  persistConcrete(block);
  const readmePath = join(HERE, "README.md");
  if (existsSync(readmePath)) {
    let rd = readFileSync(readmePath, "utf8");
    if (!rd.includes("--concrete-tools")) {
      rd += `\n## Concrete tools\n\n\`node evals/voice/exp4-duplex/run.mjs --concrete-tools\`\n`;
      writeFileSync(readmePath, rd);
    }
  }
  const u2n = rows.filter((r) => r.scenario === "U2" && r.tool_called).length;
  const u4n = rows.filter((r) => r.scenario === "U4" && r.tool_called).length;
  const txt = rows.find((r) => r.scenario === "U2-text");
  console.log(`[done] concrete U2=${u2n}/3 U4=${u4n}/3 text=${txt?.tool_name || "none"}`);
}

const entry = process.argv.includes("--s6-s8")
  ? mainS6S8
  : process.argv.includes("--en-novad")
    ? mainEnNovad
    : process.argv.includes("--concrete-tools")
      ? mainConcreteTools
      : main;
entry().catch((err) => {
  console.error(`[fatal] ${err.message}`);
  process.exitCode = 1;
});
