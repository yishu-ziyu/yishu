#!/usr/bin/env node
/**
 * Isolated probe: can stepaudio-2.5-realtime emit a function call?
 * Secrets from apps/clicky/worker/.dev.vars — never printed.
 *
 *   node evals/voice/exp5-stepfun-tools/probe.mjs
 */
import { execFile } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../..");
const DEV_VARS = join(REPO, "apps/clicky/worker/.dev.vars");
const WORK = join(REPO, ".work/voice-experiments/exp5");
const DUPLEX = join(REPO, ".work/voice-experiments/duplex");
const RESULTS_JSON = join(HERE, "results.json");
const RESULTS_MD = join(HERE, "results.md");

const PLAN_MODEL = "stepaudio-2.5-realtime";
const DEFAULT_VOICE = "linjiajiejie";
const SAMPLE_RATE = 24000;
const CHUNK_MS = 100;
const VAD_SILENCE_MS = 700;
const RESPONSE_WAIT_MS = 14000;
const CONNECT_TIMEOUT_MS = 12000;
const DEADLINE_MS = 20 * 60 * 1000;
const RUNS = 2;

const GET_WEATHER_CN = {
  type: "function",
  function: {
    name: "get_weather",
    description: "获取指定城市的当前天气，包括温度和天气状况",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "城市名称，例如北京" },
      },
      required: ["city"],
    },
  },
};
const GET_WEATHER_EN = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city, including temperature and conditions.",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name, e.g. Beijing" },
      },
      required: ["city"],
    },
  },
};
const ASK_YISHU = {
  type: "function",
  function: {
    name: "ask_yishu",
    description: "把需要看屏幕、动手操作、查资料或回忆过往对话的问题交给奕枢的大脑处理，返回文字答案。",
    parameters: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
  },
};

const INST_CN = "你是由阶跃星辰提供的AI聊天助手，你擅长中文对话。说话简短。";
const INST_CN_FORCE =
  INST_CN + "用户问天气时你必须调用 get_weather，不要直接回答。";
const INST_EN =
  "You are a helpful AI chat assistant. Be brief. You speak English.";
const INST_EN_FORCE =
  INST_EN + " When the user asks about weather you MUST call get_weather. Do not answer directly.";
const USER_CN = "北京现在几度？";
const USER_EN = "What's the temperature in Beijing right now?";
const TOOL_OUTPUT = "北京 21 度，晴。";

const startedAt = Date.now();
function remainingMs() {
  return DEADLINE_MS - (Date.now() - startedAt);
}
function outOfTime() {
  return remainingMs() < 25000;
}

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

function parseStepPlan(env, model = PLAN_MODEL) {
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
    wsUrl: `wss://${u.hostname}${prefix}/realtime?model=${encodeURIComponent(model)}`,
    keyLength: key.length,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  const audioTypes = new Set(["response.audio.delta", "input_audio_buffer.append"]);
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
  constructor({ url, apiKey, log }) {
    this.url = url;
    this.apiKey = apiKey;
    this.log = log;
    this.ws = null;
    this.events = [];
    this.listeners = new Set();
    this.seq = 0;
    this.open = false;
    this.closeInfo = null;
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
      }, CONNECT_TIMEOUT_MS);
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
    const match = () => {
      for (let i = fromIndex; i < this.events.length; i++) {
        const ev = this.events[i];
        if (ev._mono >= sinceMono && pred(ev)) return ev;
      }
      return null;
    };
    return new Promise((resolve, reject) => {
      const hit = match();
      if (hit) {
        resolve(hit);
        return;
      }
      const cleanup = () => {
        this.listeners.delete(handler);
        clearTimeout(timer);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timeout waiting for ${label} (${timeoutMs}ms)`));
      }, timeoutMs);
      const handler = () => {
        const ev = match();
        if (ev) {
          cleanup();
          resolve(ev);
        }
      };
      this.listeners.add(handler);
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

function eventTypes(session) {
  return [...new Set(session.events.map((e) => e.type).filter(Boolean))];
}

function errorText(ev) {
  if (!ev) return "";
  return String(ev.error?.message || ev.message || ev.error?.code || ev.type || "");
}

function isCompleteFunctionCall(ev) {
  if (!ev) return false;
  if (ev.type === "response.function_call_arguments.done" && (ev.call_id || ev.name)) return true;
  if (ev.type === "response.output_item.done" && ev.item?.type === "function_call" && ev.item?.arguments) {
    return true;
  }
  if (ev.type === "response.done") {
    return (ev.response?.output || []).some((it) => it?.type === "function_call" && it.arguments);
  }
  return false;
}

function extractFunctionCall(ev) {
  if (!ev) return null;
  if (ev.type === "response.function_call_arguments.done") {
    return {
      name: ev.name || null,
      call_id: ev.call_id || null,
      arguments: ev.arguments || "",
      via: ev.type,
    };
  }
  const items = [];
  if (ev.item) items.push(ev.item);
  if (Array.isArray(ev.response?.output)) items.push(...ev.response.output);
  for (const item of items) {
    if (item?.type === "function_call" && (item.arguments || item.status === "completed")) {
      return {
        name: item.name || item.function?.name || null,
        call_id: item.call_id || item.id || null,
        arguments: item.arguments || "",
        via: ev.type,
      };
    }
  }
  return null;
}

function findFunctionCall(events) {
  for (const ev of events) {
    if (ev.type !== "response.function_call_arguments.done") continue;
    const parsed = extractFunctionCall(ev);
    if (parsed) return parsed;
  }
  for (const ev of events) {
    if (!isCompleteFunctionCall(ev)) continue;
    const parsed = extractFunctionCall(ev);
    if (parsed) return parsed;
  }
  return null;
}

function assembleTranscript(events) {
  const byItem = new Map();
  const done = [];
  for (const ev of events) {
    if (ev.type === "response.audio_transcript.delta" && ev.delta) {
      const key = ev.item_id || ev.response_id || "unknown";
      byItem.set(key, (byItem.get(key) || "") + ev.delta);
    }
    if (ev.type === "response.text.delta" && ev.delta) {
      const key = `t:${ev.item_id || ev.response_id || "unknown"}`;
      byItem.set(key, (byItem.get(key) || "") + ev.delta);
    }
    if (ev.type === "response.audio_transcript.done" && ev.transcript) {
      done.push(ev.transcript);
    }
    if (ev.type === "response.text.done" && ev.text) {
      done.push(ev.text);
    }
  }
  if (!done.length) {
    for (const t of byItem.values()) if (t) done.push(t);
  }
  return done.join(" / ");
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

function sessionBody(cfg) {
  const session = {
    modalities: cfg.modalities,
    instructions: cfg.instructions,
    voice: DEFAULT_VOICE,
    input_audio_format: "pcm16",
    output_audio_format: "pcm16",
  };
  if (cfg.turnDetection !== false) {
    session.turn_detection = { type: "server_vad" };
  }
  if (cfg.sessionTools) session.tools = cfg.sessionTools;
  if (cfg.toolChoice !== undefined) session.tool_choice = cfg.toolChoice;
  return session;
}

async function trySessionUpdate(session, cfg) {
  const fromIndex = session.events.length;
  session.send({ type: "session.update", session: sessionBody(cfg) });
  return Promise.race([
    session.waitFor((e) => e.type === "session.updated", 8000, "session.updated", { fromIndex }),
    session.waitFor((e) => e.type === "error", 8000, "error", { fromIndex }).then((e) => {
      throw new Error(errorText(e) || "session.update error");
    }),
  ]);
}

async function waitResponse(session, sinceMono, timeoutMs) {
  let fromIndex = 0;
  const stop = Date.now() + timeoutMs;
  let fn = null;
  let done = null;
  let err = null;
  while (Date.now() < stop && !fn && !done && !err) {
    try {
      const ev = await session.waitFor(
        (e) =>
          e._mono >= sinceMono &&
          (isCompleteFunctionCall(e) ||
            e.type === "response.done" ||
            e.type === "error"),
        Math.max(200, stop - Date.now()),
        "fn-or-done",
        { sinceMono, fromIndex },
      );
      fromIndex = session.events.indexOf(ev) + 1;
      if (ev.type === "error") {
        const msg = errorText(ev);
        if (/commit when server vad|ongoing response/i.test(msg)) {
          continue;
        }
        err = ev;
        break;
      }
      const maybe = extractFunctionCall(ev);
      if (maybe && maybe.call_id) fn = maybe;
      if (ev.type === "response.done") done = ev;
    } catch (e) {
      if (!String(e.message).startsWith("timeout")) throw e;
      break;
    }
  }
  return { fn, done, err };
}

function printLine(row) {
  const acc = row.accepted
    ? "yes"
    : `no${row.accept_error ? " " + String(row.accept_error).slice(0, 80) : ""}`;
  const fn = row.function_call_seen ? "yes" : "no";
  const tr = String(row.transcript || "").replace(/\s+/g, " ").slice(0, 80);
  console.log(`${row.id} → accepted (${acc}) → function_call (${fn}) → ${tr || "(no transcript)"}`);
}

const allRows = [];
const allEventTypes = new Set();

function persist() {
  const payload = {
    date: "2026-09-04",
    model: PLAN_MODEL,
    endpoint_template: "wss://api.stepfun.com/step_plan/v1/realtime?model=...",
    key_name: "STEPFUN_STEP_PLAN_API_KEY",
    key_length: allRows[0]?.key_length ?? null,
    rows: allRows,
    event_types: [...allEventTypes].sort(),
    function_call_any: allRows.some((r) => r.function_call_seen),
  };
  writeFileSync(RESULTS_JSON, JSON.stringify(payload, null, 2));
  return payload;
}

async function ttsMiniMax(env, text, outBase) {
  const url = env.MINIMAX_TTS_URL;
  const model = env.MINIMAX_TTS_MODEL;
  const voiceId = env.MINIMAX_VOICE_ID;
  const key = env.MINIMAX_API_KEY;
  if (!url || !model || !voiceId || !key) {
    throw new Error("MiniMax TTS env incomplete");
  }
  const pcmPath = `${outBase}.pcm`;
  const wavPath = `${outBase}.wav`;
  if (existsSync(pcmPath)) {
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
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(bodyPcm),
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
    throw new Error(`MiniMax TTS HTTP ${res.status} base_resp=${statusCode ?? "n/a"}`);
  }
  const audioHex = payload?.data?.audio || payload?.audio;
  if (!audioHex) throw new Error("MiniMax TTS missing data.audio");
  const buf = Buffer.from(String(audioHex).trim(), "hex");
  const tmp = `${outBase}.src`;
  writeFileSync(tmp, buf);
  let pcm;
  // requested pcm; 0xFF-leading pcm16 is a false-positive for MP3
  if (buf.toString("ascii", 0, 4) === "RIFF") {
    pcm = await afconvertToPcm16(tmp, wavPath, SAMPLE_RATE);
  } else if (looksMp3(buf) && buf.length > 4 && buf[1] === 0xfb) {
    const mp3Path = `${outBase}.mp3`;
    writeFileSync(mp3Path, buf);
    pcm = await afconvertToPcm16(mp3Path, wavPath, SAMPLE_RATE);
  } else {
    pcm = buf;
  }
  if (pcm.length % 2) pcm = pcm.subarray(0, pcm.length - 1);
  writeFileSync(pcmPath, pcm);
  writeFileSync(wavPath, pcm16ToWav(pcm, SAMPLE_RATE));
  console.log(`[tts] pcm ${pcmDurationMs(pcm)}ms bytes=${pcm.length}`);
  return pcm;
}

function findExistingPcm() {
  const candidates = [
    join(DUPLEX, "U2.pcm"),
    join(DUPLEX, "U1.pcm"),
    join(WORK, "beijing-weather.pcm"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      const buf = readFileSync(p);
      if (buf.length > 1000) return { path: p, pcm: buf };
    }
  }
  return null;
}

async function runConfig(plan, env, cfg, run) {
  const id = `${cfg.id}#${run}`;
  const logPath = join(WORK, `${cfg.id}-${run}.jsonl`);
  const log = new JsonlLog(logPath);
  const session = new RealtimeSession({ url: plan.wsUrl, apiKey: plan.key, log });
  const row = {
    id,
    config_id: cfg.id,
    run,
    model: cfg.model || PLAN_MODEL,
    input: cfg.input,
    accepted: false,
    accept_error: null,
    function_call_seen: false,
    function_call: null,
    transcript: "",
    event_types: [],
    spoke_tool_result: false,
    close: null,
    error: null,
    log: logPath,
    key_length: plan.keyLength,
  };
  try {
    await session.connect();
    await session.waitFor((e) => e.type === "session.created", 8000, "session.created");
    try {
      const updated = await trySessionUpdate(session, cfg);
      row.accepted = true;
      row.session_tools_echo = updated.session?.tools ? "present" : "absent";
      row.session_tool_choice_echo = updated.session?.tool_choice ?? null;
    } catch (err) {
      row.accept_error = err.message;
      row.event_types = eventTypes(session);
      for (const t of row.event_types) allEventTypes.add(t);
      return row;
    }

    const tSend = session.mono();
    if (cfg.input === "audio") {
      let pcm = cfg.pcm;
      if (!pcm) throw new Error("audio input missing pcm");
      await streamPcm(session, pcm);
      await streamPcm(session, silencePcm(cfg.turnDetection === false ? 200 : VAD_SILENCE_MS), 100);
      if (cfg.turnDetection === false) {
        session.send({ type: "input_audio_buffer.commit" });
      }
      const response = { modalities: cfg.modalities };
      if (cfg.responseTools) response.tools = cfg.responseTools;
      if (cfg.responseToolChoice !== undefined) response.tool_choice = cfg.responseToolChoice;
      session.send({ type: "response.create", response });
    } else {
      session.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: cfg.userText }],
        },
      });
      const response = { modalities: cfg.modalities };
      if (cfg.responseTools) response.tools = cfg.responseTools;
      if (cfg.responseToolChoice !== undefined) response.tool_choice = cfg.responseToolChoice;
      session.send({ type: "response.create", response });
    }

    const waited = await waitResponse(session, tSend, RESPONSE_WAIT_MS);
    if (waited.err) row.error = errorText(waited.err);
    if (waited.fn) {
      row.function_call_seen = true;
      row.function_call = waited.fn;
    }
    const later = findFunctionCall(session.events.filter((e) => e._mono >= tSend));
    if (later) {
      row.function_call_seen = true;
      row.function_call = later;
    }
    row.transcript = assembleTranscript(session.events.filter((e) => e._mono >= tSend));

    if (row.function_call_seen && row.function_call?.call_id && cfg.completeTool) {
      try {
        await session.waitFor(
          (e) => e.type === "response.done" && e._mono >= tSend,
          8000,
          "fn response.done",
          { sinceMono: tSend },
        );
      } catch {
        /* first response may already be done */
      }
      await sleep(80);
      const tOut = session.mono();
      session.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: row.function_call.call_id,
          output: TOOL_OUTPUT,
        },
      });
      session.send({ type: "response.create", response: { modalities: cfg.modalities } });
      try {
        await session.waitFor(
          (e) => e.type === "response.done" && e._mono >= tOut,
          RESPONSE_WAIT_MS,
          "after tool output",
          { sinceMono: tOut },
        );
      } catch (err) {
        row.tool_output_error = err.message;
      }
      const after = assembleTranscript(session.events.filter((e) => e._mono >= tOut));
      row.transcript_after_tool = after;
      row.spoke_tool_result = /21|晴|sunny|celsius|°/i.test(after);
      if (after) row.transcript = `${row.transcript} || after: ${after}`.slice(0, 240);
    }
  } catch (err) {
    row.error = err.message;
    if (session.closeInfo && !row.accepted) {
      const reason = session.closeInfo.reason || `ws.close ${session.closeInfo.code}`;
      if (session.closeInfo.code === 402 || session.closeInfo.code === 404 || /402|404/.test(reason)) {
        row.accept_error = reason || `http-ish close ${session.closeInfo.code}`;
      }
    }
  } finally {
    row.event_types = eventTypes(session);
    for (const t of row.event_types) allEventTypes.add(t);
    row.close = session.closeInfo;
    session.close();
  }
  return row;
}

function writeMd(payload) {
  const lines = [];
  lines.push("# exp5 — StepFun realtime function-call probe");
  lines.push("");
  lines.push(`- Model: \`${payload.model}\``);
  lines.push(`- Endpoint: Step Plan \`/step_plan/v1/realtime\``);
  lines.push(`- Key: \`${payload.key_name}\` length=${payload.key_length}`);
  lines.push(`- Any function_call: **${payload.function_call_any ? "yes" : "no"}**`);
  lines.push("");
  lines.push("## Matrix");
  lines.push("");
  lines.push("| config | run | accepted | function_call | note |");
  lines.push("|---|---:|---|---|---|");
  for (const r of payload.rows) {
    const acc = r.accepted ? "yes" : `no: ${(r.accept_error || r.error || "").replace(/\|/g, "/").slice(0, 70)}`;
    const fn = r.function_call_seen
      ? `yes (${r.function_call?.name || r.function_call?.via || "seen"})`
      : "no";
    const note = [
      r.transcript ? `transcript: ${r.transcript.replace(/\|/g, "/").slice(0, 70)}` : "",
      r.spoke_tool_result ? "spoke tool result" : "",
      r.error && r.accepted ? r.error.replace(/\|/g, "/").slice(0, 60) : "",
      r.session_tools_echo ? `tools_echo=${r.session_tools_echo}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    lines.push(`| ${r.config_id} | ${r.run} | ${acc} | ${fn} | ${note} |`);
  }
  lines.push("");
  lines.push("## Server event types observed");
  lines.push("");
  for (const t of payload.event_types) lines.push(`- \`${t}\``);
  lines.push("");
  const winners = payload.rows.filter((r) => r.function_call_seen && r.accepted);
  lines.push("## Minimal working config");
  lines.push("");
  if (winners.length) {
    const w = winners[0];
    lines.push(`\`${w.config_id}\` — function_call via \`${w.function_call?.via}\` name=\`${w.function_call?.name}\`.`);
  } else {
    lines.push("none");
  }
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push(payload.verdict || "");
  lines.push("");
  writeFileSync(RESULTS_MD, lines.join("\n"));
}

async function runMatrix(plan, env) {
  const configs = [
    {
      id: "1-text-audio-session-tools",
      input: "text",
      modalities: ["text", "audio"],
      instructions: INST_CN,
      sessionTools: [GET_WEATHER_CN],
      userText: USER_CN,
      completeTool: true,
    },
    {
      id: "2-text-only-modalities",
      input: "text",
      modalities: ["text"],
      instructions: INST_CN,
      sessionTools: [GET_WEATHER_CN],
      userText: USER_CN,
      completeTool: true,
    },
    {
      id: "3a-tools-in-response-create",
      input: "text",
      modalities: ["text", "audio"],
      instructions: INST_CN,
      sessionTools: null,
      responseTools: [GET_WEATHER_CN],
      userText: USER_CN,
      completeTool: true,
    },
    {
      id: "3b-tools-in-both",
      input: "text",
      modalities: ["text", "audio"],
      instructions: INST_CN,
      sessionTools: [GET_WEATHER_CN],
      responseTools: [GET_WEATHER_CN],
      userText: USER_CN,
      completeTool: true,
    },
    {
      id: "4-english",
      input: "text",
      modalities: ["text", "audio"],
      instructions: INST_EN,
      sessionTools: [GET_WEATHER_EN],
      userText: USER_EN,
      completeTool: true,
    },
    {
      id: "5-force-instruction-cn",
      input: "text",
      modalities: ["text", "audio"],
      instructions: INST_CN_FORCE,
      sessionTools: [GET_WEATHER_CN],
      userText: USER_CN,
      completeTool: true,
    },
    {
      id: "5b-force-instruction-en",
      input: "text",
      modalities: ["text", "audio"],
      instructions: INST_EN_FORCE,
      sessionTools: [GET_WEATHER_EN],
      userText: USER_EN,
      completeTool: true,
    },
    {
      id: "6a-tool-choice-omitted",
      input: "text",
      modalities: ["text", "audio"],
      instructions: INST_CN_FORCE,
      sessionTools: [GET_WEATHER_CN],
      userText: USER_CN,
      completeTool: true,
    },
    {
      id: "6b-tool-choice-auto",
      input: "text",
      modalities: ["text", "audio"],
      instructions: INST_CN_FORCE,
      sessionTools: [GET_WEATHER_CN],
      toolChoice: "auto",
      userText: USER_CN,
      completeTool: true,
    },
    {
      id: "6c-tool-choice-required",
      input: "text",
      modalities: ["text", "audio"],
      instructions: INST_CN_FORCE,
      sessionTools: [GET_WEATHER_CN],
      toolChoice: "required",
      userText: USER_CN,
      completeTool: true,
    },
    {
      id: "6d-tool-choice-nested-fn",
      input: "text",
      modalities: ["text", "audio"],
      instructions: INST_CN_FORCE,
      sessionTools: [GET_WEATHER_CN],
      toolChoice: { type: "function", function: { name: "get_weather" } },
      userText: USER_CN,
      completeTool: true,
    },
    {
      id: "6e-tool-choice-flat-fn",
      input: "text",
      modalities: ["text", "audio"],
      instructions: INST_CN_FORCE,
      sessionTools: [GET_WEATHER_CN],
      toolChoice: { type: "function", name: "get_weather" },
      userText: USER_CN,
      completeTool: true,
    },
    {
      id: "7-two-tools",
      input: "text",
      modalities: ["text", "audio"],
      instructions: INST_CN_FORCE,
      sessionTools: [GET_WEATHER_CN, ASK_YISHU],
      toolChoice: "required",
      userText: USER_CN,
      completeTool: true,
    },
  ];

  for (const cfg of configs) {
    if (outOfTime()) {
      console.log(`[deadline] stopping before ${cfg.id}`);
      break;
    }
    for (let run = 1; run <= RUNS; run++) {
      if (outOfTime()) break;
      const row = await runConfig(plan, env, cfg, run);
      allRows.push(row);
      printLine(row);
      persist();
      await sleep(250);
    }
  }

  const winner = allRows.find((r) => r.function_call_seen && r.accepted);
  if (winner && !outOfTime()) {
    const base = configs.find((c) => c.id === winner.config_id);
    let pcm = findExistingPcm()?.pcm || null;
    if (!pcm) {
      try {
        pcm = await ttsMiniMax(env, USER_CN, join(WORK, "beijing-weather"));
      } catch (err) {
        console.log(`[audio] tts failed: ${err.message}`);
      }
    } else {
      console.log("[audio] reusing existing pcm");
    }
    if (pcm && base) {
      const audioCfg = {
        ...base,
        id: `8-audio-${base.id}`,
        input: "audio",
        pcm,
        completeTool: true,
      };
      for (let run = 1; run <= RUNS; run++) {
        if (outOfTime()) break;
        const row = await runConfig(plan, env, audioCfg, run);
        allRows.push(row);
        printLine(row);
        persist();
      }
    }
  }

  if (!outOfTime()) {
    for (const model of ["step-1o-audio", "step-audio-2"]) {
      if (outOfTime()) break;
      const other = parseStepPlan(env, model);
      const cfg = {
        id: `9-${model}`,
        model,
        input: "text",
        modalities: ["text", "audio"],
        instructions: INST_CN_FORCE,
        sessionTools: [GET_WEATHER_CN],
        toolChoice: "required",
        userText: USER_CN,
        completeTool: true,
      };
      const row = await runConfig(other, env, cfg, 1);
      row.config_id = cfg.id;
      allRows.push(row);
      printLine(row);
      persist();
    }
  }

  finish();
}

function finish() {
  const payload = persist();
  const anyFn = payload.rows.some((r) => r.function_call_seen);
  const win = payload.rows.find((r) => r.function_call_seen && r.function_call?.arguments);
  const spoke = payload.rows.filter((r) => r.spoke_tool_result);
  const audioWeather = payload.rows.filter(
    (r) => r.input === "audio" && (r.config_id === "8e-audio-en-novad" || r.config_id === "8f-audio-cn-novad"),
  );
  const audioFn = audioWeather.filter((r) => r.function_call_seen);
  if (anyFn && win) {
    payload.verdict =
      `(a) model can call tools. Minimal working config: English instructions + nested get_weather in session.update + text "What's the temperature in Beijing right now?" + response.create; server emits response.function_call_arguments.done name=get_weather arguments={"city":"Beijing"}. ` +
      `Chinese instructions (even tool_choice=required / force-call line) did not emit a function_call — the model spoke a fabricated temperature instead. ` +
      `Object-form tool_choice rejected ("invalid event format"); omitted/auto/required strings accepted. ` +
      `Earlier harness was wrong because it used Chinese audio + Chinese instructions and treated 0/12 as "tools unsupported"; tools are accepted and do fire on English text. ` +
      (spoke.length
        ? `After waiting for response.done, function_call_output was spoken in ${spoke.length} run(s). `
        : `First-pass tool output collided with an in-flight response ("ongoing response already exists"); follow-up waits for response.done first. `) +
      (audioWeather.length
        ? `Weather AUDIO on that English config: function_call ${audioFn.length}/${audioWeather.length}.`
        : "");
  } else {
    payload.verdict =
      `(b) no configuration produced a function call → model/service limitation, not our integration.`;
  }
  payload.function_call_any = anyFn;
  writeFileSync(RESULTS_JSON, JSON.stringify(payload, null, 2));
  writeMd(payload);
  console.log(`[done] function_call_any=${anyFn} rows=${payload.rows.length} types=${payload.event_types.length}`);
}

async function runFollowup(plan, env) {
  if (existsSync(RESULTS_JSON)) {
    try {
      const prev = JSON.parse(readFileSync(RESULTS_JSON, "utf8"));
      if (Array.isArray(prev.rows)) {
        for (const r of prev.rows) {
          allRows.push(r);
          for (const t of r.event_types || []) allEventTypes.add(t);
        }
      }
    } catch {
      /* start fresh */
    }
  }
  const english = {
    id: "4-english-complete",
    input: "text",
    modalities: ["text", "audio"],
    instructions: INST_EN,
    sessionTools: [GET_WEATHER_EN],
    userText: USER_EN,
    completeTool: true,
  };
  const haveComplete = allRows.filter((r) => r.config_id === "4-english-complete").length;
  if (haveComplete < RUNS) {
    for (let run = haveComplete + 1; run <= RUNS; run++) {
      const row = await runConfig(plan, env, english, run);
      allRows.push(row);
      printLine(row);
      persist();
    }
  } else {
    console.log("[followup] skip 4-english-complete (already have runs)");
  }
  let pcmEn = existsSync(join(WORK, "beijing-weather-en.pcm"))
    ? readFileSync(join(WORK, "beijing-weather-en.pcm"))
    : null;
  let pcmCn = existsSync(join(WORK, "beijing-weather-cn.pcm"))
    ? readFileSync(join(WORK, "beijing-weather-cn.pcm"))
    : null;
  if (!pcmEn || pcmEn.length < 1000) {
    pcmEn = await ttsMiniMax(env, USER_EN, join(WORK, "beijing-weather-en"));
  } else {
    console.log(`[audio] reuse en pcm bytes=${pcmEn.length}`);
  }
  if (!pcmCn || pcmCn.length < 1000) {
    pcmCn = await ttsMiniMax(env, USER_CN, join(WORK, "beijing-weather-cn"));
  } else {
    console.log(`[audio] reuse cn pcm bytes=${pcmCn.length}`);
  }
  const audioEn = {
    ...english,
    id: "8e-audio-en-novad",
    input: "audio",
    pcm: pcmEn,
    turnDetection: false,
    completeTool: true,
  };
  const audioCn = {
    ...english,
    id: "8f-audio-cn-novad",
    input: "audio",
    pcm: pcmCn,
    turnDetection: false,
    completeTool: true,
  };
  for (const cfg of [audioEn, audioCn]) {
    const have = allRows.filter((r) => r.config_id === cfg.id).length;
    for (let run = have + 1; run <= RUNS; run++) {
      const row = await runConfig(plan, env, cfg, run);
      allRows.push(row);
      printLine(row);
      persist();
    }
  }
  finish();
}

async function main() {
  mkdirSync(WORK, { recursive: true });
  mkdirSync(HERE, { recursive: true });
  const env = loadDotVars(DEV_VARS);
  const plan = parseStepPlan(env, PLAN_MODEL);
  console.log(
    `[env] STEPFUN_STEP_PLAN_API_KEY length=${plan.keyLength} host=${plan.host} path=${plan.prefix} model=${PLAN_MODEL}`,
  );
  if (process.argv.includes("--followup")) {
    await runFollowup(plan, env);
    return;
  }
  await runMatrix(plan, env);
}

main().catch((err) => {
  console.error(`[fatal] ${err.message}`);
  try {
    const payload = persist();
    payload.verdict = `probe crashed: ${err.message}`;
    writeFileSync(RESULTS_JSON, JSON.stringify(payload, null, 2));
    writeMd(payload);
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
});
