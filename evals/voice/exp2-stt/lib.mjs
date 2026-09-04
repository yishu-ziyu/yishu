import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..");
export const WORK_DIR = join(REPO_ROOT, ".work", "voice-experiments", "stt");
export const RESULTS_DIR = join(REPO_ROOT, "evals", "voice", "results");
export const DEV_VARS_PATH = join(REPO_ROOT, "apps", "clicky", "worker", ".dev.vars");

export const STEPFUN_ASR_URL = "https://api.stepfun.com/step_plan/v1/audio/asr/sse";
export const STEPFUN_ASR_STREAM_URL = "wss://api.stepfun.com/v1/realtime/asr/stream";
export const STEPFUN_ASR_STREAM_MODEL = "stepaudio-2.5-asr-stream";
export const CHUNK_MS = 100;
export const SAMPLE_RATE = 16000;
export const MAX_RETRIES = 2;

export function loadDevVars(path = DEV_VARS_PATH) {
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

export function keyMeta(env, name) {
  const value = env[name];
  if (!value) return { present: false, length: 0 };
  return { present: true, length: value.length };
}

export function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function hexToBuffer(hex) {
  const cleaned = String(hex || "")
    .trim()
    .replace(/\s+/g, "");
  if (!cleaned || cleaned.length % 2 !== 0) {
    throw new Error("invalid MiniMax audio hex");
  }
  return Buffer.from(cleaned, "hex");
}

export function pcmToWav(pcm, sampleRate = SAMPLE_RATE, channels = 1, bits = 16) {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

export function parseWav(buf) {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("not a RIFF WAV");
  }
  let offset = 12;
  let sampleRate = SAMPLE_RATE;
  let channels = 1;
  let bits = 16;
  let pcm = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(start + 2);
      sampleRate = buf.readUInt32LE(start + 4);
      bits = buf.readUInt16LE(start + 14);
    } else if (id === "data") {
      pcm = buf.subarray(start, Math.min(buf.length, start + size));
      break;
    }
    offset = start + size + (size % 2);
  }
  if (!pcm) throw new Error("WAV missing data chunk");
  return { sampleRate, channels, bits, pcm };
}

export function wavDurationMs(pcm, sampleRate, channels, bits) {
  const bytesPerSec = (sampleRate * channels * bits) / 8;
  if (!bytesPerSec) return 0;
  return Math.round((pcm.length / bytesPerSec) * 1000);
}

export function chunkPcm(pcm, sampleRate = SAMPLE_RATE, chunkMs = CHUNK_MS) {
  const bytesPerChunk = Math.floor((sampleRate * 2 * chunkMs) / 1000);
  const aligned = bytesPerChunk - (bytesPerChunk % 2);
  const chunks = [];
  for (let i = 0; i < pcm.length; i += aligned) {
    chunks.push(pcm.subarray(i, Math.min(pcm.length, i + aligned)));
  }
  return chunks;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowMs() {
  return performance.now();
}

export function normalizeForCer(text) {
  return [...String(text || "")]
    .filter((ch) => !/\s/u.test(ch) && !/\p{P}/u.test(ch) && !/\p{S}/u.test(ch))
    .join("")
    .toLowerCase();
}

export function levenshtein(a, b) {
  const s = [...a];
  const t = [...b];
  const n = s.length;
  const m = t.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const prev = new Uint32Array(m + 1);
  const cur = new Uint32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev.set(cur);
  }
  return prev[m];
}

export function cer(hyp, ref) {
  const r = normalizeForCer(ref);
  const h = normalizeForCer(hyp);
  if (!r.length) return h.length === 0 ? 0 : 1;
  return levenshtein(h, r) / r.length;
}

export function median(nums) {
  const xs = nums.filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.floor(xs.length / 2)];
}

export function roundMs(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n);
}

export function sanitizeError(err) {
  const status = err?.status ?? err?.httpStatus ?? null;
  const code = err?.code ?? err?.cause?.code ?? null;
  let message = err instanceof Error ? err.message : String(err ?? "unknown error");
  message = message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "sk-[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted-token]");
  if (message.length > 240) message = `${message.slice(0, 240)}…`;
  return { status, code, message };
}

export function isRetryable(err) {
  const status = err?.status ?? err?.httpStatus;
  const code = err?.code ?? err?.cause?.code;
  if (status === 401 || status === 403 || status === 407 || status === 429) return true;
  if (status === 402) return false;
  if (status >= 500 && status <= 599) return true;
  if (
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_SOCKET"
  ) {
    return true;
  }
  const name = err?.name || "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  const msg = String(err?.message || "");
  return /unauthorized|forbidden|unreachable|ECONN|ETIMEDOUT|WebSocket/i.test(msg);
}

export async function withRetries(fn, { maxRetries = MAX_RETRIES, label = "request" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const retry = attempt < maxRetries && isRetryable(err);
      const info = sanitizeError(err);
      console.error(
        `[${label}] attempt ${attempt + 1}/${maxRetries + 1} failed status=${info.status ?? "-"} code=${info.code ?? "-"} ${info.message}`
      );
      if (!retry) break;
      await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr;
}

export function buildStepFunTranscriptionBody({
  audioBase64,
  format,
  sampleRate,
  language,
  model,
  hotwords,
}) {
  const transcription = {
    model,
    language,
    enable_itn: true,
  };
  if (hotwords && hotwords.length > 0) {
    transcription.hotwords = hotwords;
  }
  return {
    audio: {
      data: audioBase64,
      input: {
        transcription,
        format: {
          type: format,
          codec: "pcm_s16le",
          rate: sampleRate,
          bits: 16,
          channel: 1,
        },
      },
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (cer("你好，世界！", "你好世界") !== 0) throw new Error("cer punctuation");
  if (cer("Xcode", "xcode") !== 0) throw new Error("cer case");
  if (cer("abc", "ab") !== 0.5) throw new Error("cer edit");
  console.log("lib self-check ok");
}
