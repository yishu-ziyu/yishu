#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  WORK_DIR,
  DEV_VARS_PATH,
  SAMPLE_RATE,
  loadDevVars,
  keyMeta,
  hostnameOf,
  hexToBuffer,
  pcmToWav,
  parseWav,
  wavDurationMs,
  withRetries,
  sanitizeError,
} from "./lib.mjs";

const MINIMAX_TTS_URL_DEFAULT = "https://api.minimaxi.com/v1/t2a_v2";
const MINIMAX_VOICE_DEFAULT = "shangqiuzi_v3_20260717";
const MINIMAX_TTS_MODEL_DEFAULT = "speech-2.8-hd";

const SAMPLES = [
  {
    id: "s01",
    target_seconds: 2,
    text: "帮我把这个窗口挪到左边。",
  },
  {
    id: "s02",
    target_seconds: 4,
    text: "刚才那封邮件的附件叫什么名字，帮我找一下。",
  },
  {
    id: "s03",
    target_seconds: 8,
    text: "我下周二下午三点要和王老师开会，记一下，另外提醒我周一晚上把幻灯片改完。",
  },
  {
    id: "s04",
    target_seconds: 12,
    text: "下个月我想去杭州待四天，第一天西湖周边走走，第二天去灵隐寺和龙井村，第三天去西溪湿地，第四天上午看博物馆下午坐高铁回来，帮我把行程和预算列一下。",
  },
  {
    id: "s05",
    target_seconds: 15,
    text: "我下周要把奕枢的语音识别改成边说边出字，需要先在 Xcode 里把 Apple Speech 接上，再用 Figma 画菜单栏的录音状态，最后把实验脚本和结果推到 GitHub 给同事看一眼。",
  },
];

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stderrChunks = [];
    child.stderr.on("data", (d) => stderrChunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        const err = new Error(`${cmd} exited ${code}: ${Buffer.concat(stderrChunks).toString("utf8").slice(0, 200)}`);
        err.code = "AFCONVERT";
        reject(err);
      }
    });
  });
}

async function afconvertTo16kMonoWav(srcPath, dstPath) {
  await run("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", srcPath, dstPath]);
}

function looksLikeWav(buf) {
  return buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE";
}

async function requestTts(env, text, format, speed = 1) {
  const key = env.MINIMAX_API_KEY || env.MINIMAX_TOKEN_PLAN_KEY;
  if (!key) {
    const err = new Error("MINIMAX_API_KEY missing");
    err.status = 401;
    throw err;
  }
  const ttsURL = (env.MINIMAX_TTS_URL || MINIMAX_TTS_URL_DEFAULT).replace(/\/$/, "");
  const model = env.MINIMAX_TTS_MODEL || MINIMAX_TTS_MODEL_DEFAULT;
  const voiceId = env.MINIMAX_VOICE_ID || MINIMAX_VOICE_DEFAULT;
  const clamped = Math.min(2, Math.max(0.5, speed));
  const res = await fetch(ttsURL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      text,
      stream: false,
      language_boost: "Chinese",
      output_format: "hex",
      voice_setting: {
        voice_id: voiceId,
        speed: clamped,
        vol: 1,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 16000,
        format,
        channel: 1,
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const responseText = await res.text();
  if (!res.ok) {
    const err = new Error(`MiniMax TTS HTTP ${res.status}`);
    err.status = res.status;
    err.code = `HTTP_${res.status}`;
    throw err;
  }
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error("MiniMax TTS returned non-JSON body");
  }
  const statusCode = payload?.base_resp?.status_code;
  if (statusCode !== undefined && statusCode !== 0) {
    const err = new Error(`MiniMax base_resp ${statusCode}: ${payload?.base_resp?.status_msg || "failed"}`);
    err.status = statusCode === 1004 || statusCode === 2013 ? 401 : 502;
    throw err;
  }
  const audioHex = payload?.data?.audio || payload?.audio;
  if (!audioHex || typeof audioHex !== "string") {
    throw new Error("MiniMax TTS response missing data.audio");
  }
  return {
    bytes: hexToBuffer(audioHex),
    extra: payload?.extra_info || {},
    host: hostnameOf(ttsURL),
    model,
    voiceId,
    url: ttsURL,
  };
}

async function synthesizeOne(env, sample, speed = 1) {
  const formats = ["wav", "pcm", "mp3"];
  let lastErr;
  for (const format of formats) {
    try {
      const result = await withRetries(() => requestTts(env, sample.text, format, speed), {
        label: `tts:${sample.id}:${format}`,
      });
      return { ...result, format, speed };
    } catch (err) {
      lastErr = err;
      console.error(`[synth] ${sample.id} format=${format} failed: ${sanitizeError(err).message}`);
    }
  }
  throw lastErr;
}

async function toCanonicalWav(id, raw, format) {
  const wavPath = join(WORK_DIR, `${id}.wav`);
  const tmpPath = join(WORK_DIR, `${id}.src.bin`);
  writeFileSync(tmpPath, raw);
  try {
    if (format === "wav" && looksLikeWav(raw)) {
      const parsed = parseWav(raw);
      if (parsed.sampleRate === SAMPLE_RATE && parsed.channels === 1 && parsed.bits === 16) {
        writeFileSync(wavPath, raw);
        return { wavPath, parsed, converted: false };
      }
      const converted = join(WORK_DIR, `${id}.conv.wav`);
      await afconvertTo16kMonoWav(tmpPath, converted);
      const out = readFileSync(converted);
      writeFileSync(wavPath, out);
      unlinkSync(converted);
      return { wavPath, parsed: parseWav(out), converted: true };
    }
    if (format === "pcm") {
      const wav = pcmToWav(raw, SAMPLE_RATE, 1, 16);
      writeFileSync(wavPath, wav);
      return { wavPath, parsed: parseWav(wav), converted: false };
    }
    const converted = join(WORK_DIR, `${id}.conv.wav`);
    await afconvertTo16kMonoWav(tmpPath, converted);
    const out = readFileSync(converted);
    writeFileSync(wavPath, out);
    unlinkSync(converted);
    return { wavPath, parsed: parseWav(out), converted: true };
  } finally {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  }
}

async function main() {
  mkdirSync(WORK_DIR, { recursive: true });
  const env = loadDevVars();
  const key = keyMeta(env, "MINIMAX_API_KEY");
  const ttsURL = env.MINIMAX_TTS_URL || MINIMAX_TTS_URL_DEFAULT;
  const model = env.MINIMAX_TTS_MODEL || MINIMAX_TTS_MODEL_DEFAULT;
  const voiceId = env.MINIMAX_VOICE_ID || MINIMAX_VOICE_DEFAULT;
  console.log(
    `[synth] MINIMAX_API_KEY present=${key.present} length=${key.length} host=${hostnameOf(ttsURL)} model=${model} voice_id=${voiceId}`
  );
  if (!key.present && !keyMeta(env, "MINIMAX_TOKEN_PLAN_KEY").present) {
    throw new Error("MINIMAX_API_KEY missing in worker/.dev.vars");
  }

  const samples = [];
  let usedFormat = null;
  let usedHost = hostnameOf(ttsURL);
  for (const sample of SAMPLES) {
    let tts = await synthesizeOne(env, sample, 1);
    usedFormat = tts.format;
    usedHost = tts.host;
    let { wavPath, parsed, converted } = await toCanonicalWav(sample.id, tts.bytes, tts.format);
    let durationMs = wavDurationMs(parsed.pcm, parsed.sampleRate, parsed.channels, parsed.bits);
    const targetMs = sample.target_seconds * 1000;
    const ratio = durationMs / targetMs;
    if (ratio > 1.25 || ratio < 0.75) {
      const speed = Math.min(2, Math.max(0.5, ratio));
      console.log(`[synth] ${sample.id} retune speed=${speed.toFixed(2)} (got ${durationMs}ms, target ${targetMs}ms)`);
      tts = await synthesizeOne(env, sample, speed);
      usedFormat = tts.format;
      const next = await toCanonicalWav(sample.id, tts.bytes, tts.format);
      wavPath = next.wavPath;
      parsed = next.parsed;
      converted = next.converted;
      durationMs = wavDurationMs(parsed.pcm, parsed.sampleRate, parsed.channels, parsed.bits);
    }
    const row = {
      id: sample.id,
      path: wavPath,
      text: sample.text,
      target_seconds: sample.target_seconds,
      duration_ms: durationMs,
      sample_rate: parsed.sampleRate,
      channels: parsed.channels,
      bits: parsed.bits,
      bytes: parsed.pcm.length,
      tts_format: tts.format,
      tts_speed: tts.speed,
      converted,
    };
    samples.push(row);
    console.log(
      `[synth] ${sample.id} ${durationMs}ms (target ~${sample.target_seconds}s) format=${tts.format} converted=${converted} pcm_bytes=${parsed.pcm.length}`
    );
  }

  const truth = {
    created_at: new Date().toISOString(),
    sample_rate: SAMPLE_RATE,
    channels: 1,
    encoding: "pcm_s16le",
    tts: {
      url_host: usedHost,
      model,
      voice_id: voiceId,
      format: usedFormat,
    },
    samples,
  };
  const truthPath = join(WORK_DIR, "truth.json");
  writeFileSync(truthPath, JSON.stringify(truth, null, 2) + "\n");
  console.log(`[synth] wrote ${samples.length} wavs + ${truthPath}`);
}

main().catch((err) => {
  console.error(`[synth] fatal: ${sanitizeError(err).message}`);
  process.exit(1);
});
