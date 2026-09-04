#!/usr/bin/env node
/**
 * StepFun Step Plan WebSocket TTS follow-up + 16-file blind-short set.
 * Secrets from apps/clicky/worker/.dev.vars. Never logged.
 *
 *   node evals/voice/exp3-tts/run-ws.mjs
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
const BLIND_SHORT = join(AUDIO_DIR, "blind-short");
const RESULTS_JSON = join(ROOT, "evals/voice/results/2026-09-04-exp3-tts.json");
const RESULTS_MD = join(ROOT, "evals/voice/results/2026-09-04-exp3-tts.md");
const WS_URL =
  "wss://api.stepfun.com/step_plan/v1/realtime/audio?model=stepaudio-2.5-tts";
const MAX_RETRIES = 2;
const GAP_MS = 700;
const WS_TIMEOUT_MS = 45_000;

const SENTENCES = [
  { id: 1, text: "嗯，在。", runs: 10 },
  { id: 2, text: "好，我看到了，是 Xcode 的签名报错，Team 没选。", runs: 5 },
  { id: 3, text: "哈，这个我上次也踩过。", runs: 5 },
  { id: 4, text: "抱歉，刚才那一下我点错了，我没有再动。", runs: 5 },
  { id: 5, text: "等一下……找到了，在第二个标签页。", runs: 5 },
  { id: 6, text: "你今天听起来有点累，要不先歇会儿？", runs: 5 },
];

const INSTRUCTIONS = {
  3: "像朋友随口说的，带一点笑意",
  4: "放轻、放慢，带歉意",
  5: "先停顿，像刚找到东西那样松一口气",
  6: "很轻很暖，像关心人",
};

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
    .replace(/[A-Za-z0-9+/_-]{40,}/g, "[long-token]");
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

function slug(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "-");
}

function afinfoDurationMs(path) {
  try {
    const out = execFileSync("afinfo", [path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const match = out.match(/estimated duration:\s+([0-9.]+)\s+sec/i);
    return match ? Math.round(Number(match[1]) * 1000) : null;
  } catch {
    return null;
  }
}

function wavEnergy(buf) {
  if (!buf || buf.length < 44) return null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "data") {
      const start = offset + 8;
      const end = Math.min(start + size, buf.length);
      let bits = 16;
      try {
        bits = buf.readUInt16LE(34);
      } catch {
        /* keep 16 */
      }
      if (bits !== 16) return { note: `pcm_bits=${bits}`, rms: null };
      let sumSq = 0;
      let sumAbs = 0;
      let n = 0;
      for (let i = start; i + 1 < end; i += 2) {
        const s = buf.readInt16LE(i) / 32768;
        sumSq += s * s;
        sumAbs += Math.abs(s);
        n += 1;
      }
      if (!n) return null;
      return {
        rms: Number(Math.sqrt(sumSq / n).toFixed(5)),
        mean_abs: Number((sumAbs / n).toFixed(5)),
        samples: n,
      };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

async function listVoices(env) {
  const base = env.STEPFUN_STEP_PLAN_BASE.replace(/\/$/, "");
  const urls = [
    `${base}/audio/system_voices?model=stepaudio-2.5-tts`,
    `${base}/audio/system_voices?model=step-tts-2`,
    `${base}/audio/voices`,
    "https://api.stepfun.com/v1/audio/system_voices?model=step-tts-2",
  ];
  const tried = [];
  for (const url of urls) {
    const hostPath = new URL(url).hostname + new URL(url).pathname;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${env.STEPFUN_STEP_PLAN_API_KEY}` },
        signal: AbortSignal.timeout(12_000),
      });
      tried.push({ url: hostPath, http: res.status });
      if (!res.ok) continue;
      const payload = await res.json();
      const voices = payload.voices || Object.keys(payload["voices-details"] || {});
      if (voices.length) return { voices, tried, hostPath };
    } catch (err) {
      tried.push({ url: hostPath, error: redact(err.message) });
    }
  }
  return { voices: [], tried };
}

function sendJson(ws, obj) {
  ws.send(JSON.stringify(obj));
}

function decodeAudio(b64) {
  if (!b64) return Buffer.alloc(0);
  return Buffer.from(b64, "base64");
}

async function callStepPlanWs(env, { voice, text, instruction }) {
  const started = performance.now();
  const eventCounts = {};
  const eventOrder = [];
  let tFirst = null;
  let tTextSent = null;
  let tFirstAfterText = null;
  let tCreated = null;
  let sessionId = null;
  const deltas = [];
  let complete = Buffer.alloc(0);
  let lastError = null;

  const ws = new WebSocket(WS_URL, {
    headers: { Authorization: `Bearer ${env.STEPFUN_STEP_PLAN_API_KEY}` },
  });

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      lastError = lastError || "timeout";
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      finish();
    }, WS_TIMEOUT_MS);

    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve();
    }

    function note(type) {
      eventCounts[type] = (eventCounts[type] || 0) + 1;
      if (eventOrder.length < 24) eventOrder.push(type);
    }

    function onEvent(event) {
      const type = event?.type || "unknown";
      note(type);
      if (type === "tts.connection.done") {
        sessionId = event.data?.session_id;
        if (!sessionId) {
          lastError = "connection.done missing session_id";
          finish();
          return;
        }
        const create = {
          type: "tts.create",
          data: {
            session_id: sessionId,
            voice_id: voice,
            response_format: "wav",
            volume_ratio: 1.0,
            speed_ratio: 1.0,
            sample_rate: 16000,
            text_normalization: "standard",
            mode: "sentence",
          },
        };
        if (instruction) create.data.instruction = instruction;
        sendJson(ws, create);
        return;
      }
      if (type === "tts.response.created") {
        tCreated = Math.round(performance.now() - started);
        tTextSent = performance.now();
        sendJson(ws, {
          type: "tts.text.delta",
          data: { session_id: sessionId, text },
        });
        sendJson(ws, {
          type: "tts.text.done",
          data: { session_id: sessionId },
        });
        return;
      }
      if (type === "tts.response.audio.delta") {
        const buf = decodeAudio(event.data?.audio);
        if (buf.length) {
          if (tFirst == null) tFirst = Math.round(performance.now() - started);
          if (tFirstAfterText == null && tTextSent != null) {
            tFirstAfterText = Math.round(performance.now() - tTextSent);
          }
          deltas.push(buf);
        }
        return;
      }
      if (type === "tts.response.audio.done") {
        const buf = decodeAudio(event.data?.audio);
        if (buf.length) complete = buf;
        finish();
        return;
      }
      if (type === "tts.response.error") {
        lastError = redact(
          event.data?.message || event.data?.code || "tts.response.error"
        );
        finish();
      }
    }

    ws.addEventListener("message", (ev) => {
      try {
        onEvent(JSON.parse(String(ev.data)));
      } catch {
        note("non-json");
      }
    });
    ws.addEventListener("error", () => {
      lastError = lastError || "ws error";
    });
    ws.addEventListener("close", () => finish());
  });

  void result;
  const audio = complete.length ? complete : deltas[deltas.length - 1] || Buffer.alloc(0);
  const tTotal = Math.round(performance.now() - started);
  if (!lastError && !audio.length) lastError = "no audio bytes";
  return {
    ok: Boolean(audio.length) && !lastError,
    error: lastError,
    audio,
    tFirst,
    tFirstAfterText,
    tCreated,
    tTotal,
    sessionIdPresent: Boolean(sessionId),
    eventCounts,
    eventOrder,
    deltaCount: deltas.length,
    host: "api.stepfun.com",
  };
}

async function withRetries(label, fn) {
  let last = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const out = await fn();
      if (out?.ok) return { ...out, retries: attempt };
      last = out;
      const retryable =
        !out ||
        /timeout|ws error|overloaded|503|429|no audio/i.test(out.error || "");
      if (!retryable || attempt === MAX_RETRIES) {
        return { ...(out || { error: "empty" }), retries: attempt };
      }
      console.error(`[retry ${attempt + 1}/${MAX_RETRIES}] ${label}: ${out.error}`);
      await sleep(/429|503|overload/i.test(out.error || "") ? 8000 : 600);
    } catch (err) {
      last = { ok: false, error: redact(err.message), retries: attempt };
      if (attempt === MAX_RETRIES) return last;
      console.error(`[retry ${attempt + 1}/${MAX_RETRIES}] ${label}: ${last.error}`);
      await sleep(600);
    }
  }
  return last;
}

function summarize(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = [run.voice, run.variant, `s${run.sentence_id}`].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const rows = [];
  for (const list of groups.values()) {
    const ok = list.filter((r) => r.ok);
    rows.push({
      voice: list[0].voice,
      variant: list[0].variant,
      sentence_id: list[0].sentence_id,
      n: list.length,
      n_ok: ok.length,
      t_first_p50: percentile(ok.map((r) => r.t_first_audio_ms), 0.5),
      t_first_p95: percentile(ok.map((r) => r.t_first_audio_ms), 0.95),
      t_first_after_text_p50: percentile(ok.map((r) => r.t_first_after_text_ms), 0.5),
      t_total_p50: percentile(ok.map((r) => r.t_total_ms), 0.5),
      t_total_p95: percentile(ok.map((r) => r.t_total_ms), 0.95),
      audio_duration_p50: percentile(ok.map((r) => r.audio_duration_ms), 0.5),
      rms_p50: percentile(
        ok.filter((r) => r.rms != null).map((r) => r.rms * 100000),
        0.5
      )
        ? percentile(
            ok.filter((r) => r.rms != null).map((r) => r.rms * 100000),
            0.5
          ) / 100000
        : null,
      errors: [...new Set(list.filter((r) => !r.ok).map((r) => r.error))].slice(0, 3),
    });
  }
  return rows;
}

function mdTable(headers, rows) {
  const line = (cells) => `| ${cells.join(" | ")} |`;
  const out = [line(headers), line(headers.map(() => "---"))];
  for (const row of rows) {
    out.push(line(row.map((c) => (c == null || c === "" ? "—" : String(c)))));
  }
  return out.join("\n");
}

function writeCanonical(voice, sentenceId, variant, buffer) {
  const name = `stepfun-ws-${slug(voice)}-s${String(sentenceId).padStart(2, "0")}-${slug(variant)}.wav`;
  const path = join(AUDIO_DIR, name);
  if (buffer?.length && !existsSync(path)) writeFileSync(path, buffer);
  return path;
}

function existingMiniMax(sentenceId, kind) {
  const map = {
    1: "neutral",
    3: kind === "emotion" ? "emotion-param" : "neutral",
    4: kind === "emotion" ? "emotion-param" : "neutral",
    5: kind === "emotion" ? "emotion-param" : "neutral",
    6: kind === "emotion" ? "emotion-inline" : "neutral",
  };
  const variant = map[sentenceId];
  if (!variant) return null;
  const path = join(
    AUDIO_DIR,
    `minimax-speech-2.8-hd-s${String(sentenceId).padStart(2, "0")}-${variant}.mp3`
  );
  return existsSync(path) ? path : null;
}

function buildBlindShort(wsFiles) {
  mkdirSync(BLIND_SHORT, { recursive: true });
  const picks = [];
  const mm1 = existingMiniMax(1, "neutral");
  const sf1 = wsFiles.find((f) => f.sentence_id === 1 && f.variant === "neutral");
  if (mm1) picks.push({ path: mm1, engine: "minimax", model: "speech-2.8-hd", sentence_id: 1, variant: "neutral", text: SENTENCES[0].text });
  if (sf1) picks.push({ ...sf1, engine: "stepfun-ws" });

  for (const id of [3, 4, 5, 6]) {
    const s = SENTENCES[id - 1];
    const mmNeu = existingMiniMax(id, "neutral");
    const mmEmo = existingMiniMax(id, "emotion");
    const sfNeu = wsFiles.find((f) => f.sentence_id === id && f.variant === "neutral");
    const sfIns = wsFiles.find((f) => f.sentence_id === id && f.variant === "instruction");
    if (mmNeu) picks.push({ path: mmNeu, engine: "minimax", model: "speech-2.8-hd", sentence_id: id, variant: "neutral", text: s.text });
    if (mmEmo) picks.push({ path: mmEmo, engine: "minimax", model: "speech-2.8-hd", sentence_id: id, variant: "emotion-directed", text: s.text });
    if (sfIns) picks.push({ ...sfIns, engine: "stepfun-ws" });
    if ((id === 3 || id === 4) && sfNeu) picks.push({ ...sfNeu, engine: "stepfun-ws" });
  }

  const chosen = picks.filter((p) => p.path && existsSync(p.path)).slice(0, 16);
  const used = new Set();
  const items = [];
  for (const file of chosen) {
    let id;
    do id = randomBytes(4).toString("hex");
    while (used.has(id));
    used.add(id);
    const ext = file.path.endsWith(".wav") ? "wav" : "mp3";
    const dest = join(BLIND_SHORT, `${id}.${ext}`);
    copyFileSync(file.path, dest);
    items.push({
      id,
      file: `${id}.${ext}`,
      source: file.path.replace(ROOT + "/", ""),
      engine: file.engine,
      model: file.model || "stepaudio-2.5-tts",
      voice: file.voice || null,
      sentence_id: file.sentence_id,
      variant: file.variant,
      text: file.text,
    });
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(
    join(BLIND_SHORT, "blind-short-key.json"),
    JSON.stringify({ generated_at: new Date().toISOString(), items }, null, 2)
  );
  const sheet = `# 奕枢声音盲听（短组）

最多 16 条。不要先看 \`blind-short-key.json\`。用系统播放器听，每条填三格。

| 文件 | 像人 1–5 | 情绪听得出 yes/no | 想当奕枢的声音 yes/no | 备注 |
| --- | --- | --- | --- | --- |
${items.map((i) => `| ${i.file} |  |  |  |  |`).join("\n")}

听完再打开 \`blind-short-key.json\` 对答案。
`;
  writeFileSync(join(BLIND_SHORT, "listening-sheet.md"), sheet);
  return items.length;
}

function appendReports(report, ws) {
  const json = existsSync(RESULTS_JSON)
    ? JSON.parse(readFileSync(RESULTS_JSON, "utf8"))
    : { date: "2026-09-04", experiment: "exp3-tts" };
  json.stepfun_step_plan_ws = ws;
  json.blind_short = report.blind_short;
  json.recommendation = report.recommendation;
  writeFileSync(RESULTS_JSON, JSON.stringify(json, null, 2) + "\n");

  let md = existsSync(RESULTS_MD) ? readFileSync(RESULTS_MD, "utf8") : "";
  const marker = "\n## StepFun Step Plan WS\n";
  const cut = md.indexOf(marker);
  if (cut >= 0) md = md.slice(0, cut);
  const recIdx = md.indexOf("\n## Recommendation\n");
  const pathIdx = md.indexOf("\n## Paths\n");
  const head = recIdx >= 0 ? md.slice(0, recIdx) : pathIdx >= 0 ? md.slice(0, pathIdx) : md;

  const s1 = ws.summary.filter((r) => r.sentence_id === 1);
  const bySent = ws.summary.filter((r) => r.voice === ws.primary_voice);
  const instr = bySent.filter((r) => r.sentence_id >= 3);
  const extra =
    marker +
    "\n" +
    [
      "Step Plan WebSocket: `wss://api.stepfun.com/step_plan/v1/realtime/audio?model=stepaudio-2.5-tts`. Auth `STEPFUN_STEP_PLAN_API_KEY` (len " +
        ws.key_len +
        "). Protocol from [ws-audio](https://platform.stepfun.com/docs/zh/api-reference/audio/ws-audio): wait `tts.connection.done` → `tts.create` (wav / 16 kHz / `mode=sentence`) → `tts.text.delta` + `tts.text.done` → collect `tts.response.audio.delta` until `tts.response.audio.done`.",
      "",
      `Voices endpoint: ${ws.voices.tried.map((t) => `${t.url}→${t.http || t.error}`).join("; ") || "—"}. Listed: ${(ws.voices.listed || []).slice(0, 20).join(", ") || "none"}. Tried: ${(ws.voices.tried_ids || []).join(", ")}. Primary: \`${ws.primary_voice}\`.`,
      "",
      "Event types seen: `" +
        Object.entries(ws.event_type_totals)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${k}×${n}`)
          .join("`, `") +
        "`.",
      "",
      "t_first_audio_ms is connect-start → first audio bytes (new WS per utterance, comparable to HTTP fetch start). t_first_after_text_ms is `tts.text.delta` → first audio (warm-session increment).",
      "",
      "### s1 ack (WS)",
      "",
      mdTable(
        ["voice", "variant", "n_ok", "t_first p50", "t_first p95", "after-text p50", "t_total p50", "dur p50"],
        s1.map((r) => [
          r.voice,
          r.variant,
          `${r.n_ok}/${r.n}`,
          r.t_first_p50,
          r.t_first_p95,
          r.t_first_after_text_p50,
          r.t_total_p50,
          r.audio_duration_p50,
        ])
      ),
      "",
      "### Primary voice by sentence",
      "",
      mdTable(
        ["s", "variant", "n_ok", "t_first p50", "t_first p95", "t_total p50", "dur p50", "rms p50"],
        bySent.map((r) => [
          r.sentence_id,
          r.variant,
          `${r.n_ok}/${r.n}`,
          r.t_first_p50,
          r.t_first_p95,
          r.t_total_p50,
          r.audio_duration_p50,
          r.rms_p50,
        ])
      ),
      "",
      "### instruction vs no-instruction (s3–6, primary voice)",
      "",
      mdTable(
        ["s", "instr dur p50", "neutral dur p50", "Δdur", "instr rms", "neutral rms", "Δrms"],
        [3, 4, 5, 6].map((id) => {
          const n = instr.find((r) => r.sentence_id === id && r.variant === "neutral");
          const i = instr.find((r) => r.sentence_id === id && r.variant === "instruction");
          const dDur =
            i?.audio_duration_p50 != null && n?.audio_duration_p50 != null
              ? i.audio_duration_p50 - n.audio_duration_p50
              : null;
          const dRms =
            i?.rms_p50 != null && n?.rms_p50 != null
              ? Number((i.rms_p50 - n.rms_p50).toFixed(5))
              : null;
          return [id, i?.audio_duration_p50, n?.audio_duration_p50, dDur, i?.rms_p50, n?.rms_p50, dRms];
        })
      ),
      "",
      "MiniMax closest files reused from the HTTP bake-off (HD stream): s3 happy param, s4 sad param, s5 calm param, s6 `(breath)` inline. No new MiniMax calls.",
      "",
      "## blind-short",
      "",
      `${report.blind_short.count} unlabeled files in \`.work/voice-experiments/tts/blind-short/\`. Sheet: \`listening-sheet.md\`. Sealed map: \`blind-short-key.json\`. Selection: s1 × {MiniMax HD, StepFun WS}; s3–6 × MiniMax neutral + MiniMax emotion-directed + StepFun instruction; StepFun neutral on s3/s4/s6 (dropped s5 SF-neutral to stay at 16).`,
      "",
      "## Recommendation",
      "",
      report.recommendation,
      "",
      "## Paths",
      "",
      "- Runner: `evals/voice/exp3-tts/run.mjs`, `evals/voice/exp3-tts/run-ws.mjs`",
      "- JSON: `evals/voice/results/2026-09-04-exp3-tts.json`",
      "- Audio: `.work/voice-experiments/tts/`",
      "- Blind (70): `.work/voice-experiments/tts/blind/`",
      "- Blind-short (16): `.work/voice-experiments/tts/blind-short/`",
      "",
    ].join("\n");

  writeFileSync(RESULTS_MD, head.replace(/\s+$/, "") + extra);
}

async function main() {
  mkdirSync(AUDIO_DIR, { recursive: true });
  const env = loadDevVars(DEV_VARS);
  if (!env.STEPFUN_STEP_PLAN_API_KEY) throw new Error("STEPFUN_STEP_PLAN_API_KEY missing");
  if (!env.STEPFUN_STEP_PLAN_BASE) throw new Error("STEPFUN_STEP_PLAN_BASE missing");

  const voices = await listVoices(env);
  console.error(
    `voices listed=${voices.voices.length} tried=${voices.tried.map((t) => `${t.url}:${t.http || "err"}`).join(",")}`
  );

  const candidateVoices = ["linjiajiejie", "cixingnansheng"];
  const voiceOk = [];
  const voiceFail = [];
  for (const voice of candidateVoices) {
    const call = await withRetries(`probe ${voice}`, () =>
      callStepPlanWs(env, { voice, text: "嗯。", instruction: null })
    );
    console.error(
      `probe ${voice} ok=${call.ok} t_first=${call.tFirst} types=${Object.keys(call.eventCounts || {}).join(",")}`
    );
    if (call.ok) voiceOk.push(voice);
    else voiceFail.push({ voice, error: call.error });
    await sleep(GAP_MS);
  }
  const primary = voiceOk.includes("linjiajiejie")
    ? "linjiajiejie"
    : voiceOk[0] || null;
  if (!primary) throw new Error("no Step Plan WS voice produced audio");

  const eventTotals = {};
  const runs = [];
  const saved = [];

  function addEvents(counts) {
    for (const [k, n] of Object.entries(counts || {})) {
      eventTotals[k] = (eventTotals[k] || 0) + n;
    }
  }

  const jobs = [];
  for (const s of SENTENCES) {
    jobs.push({
      voice: primary,
      sentence_id: s.id,
      variant: "neutral",
      text: s.text,
      instruction: null,
      runs: s.runs,
    });
  }
  for (const s of SENTENCES.filter((x) => x.id >= 3)) {
    jobs.push({
      voice: primary,
      sentence_id: s.id,
      variant: "instruction",
      text: s.text,
      instruction: INSTRUCTIONS[s.id],
      runs: 5,
    });
  }
  const other = voiceOk.find((v) => v !== primary);
  if (other) {
    for (const s of SENTENCES) {
      jobs.push({
        voice: other,
        sentence_id: s.id,
        variant: "neutral",
        text: s.text,
        instruction: null,
        runs: 1,
      });
    }
  }

  let done = 0;
  const total = jobs.reduce((n, j) => n + j.runs, 0);
  for (const job of jobs) {
    for (let i = 1; i <= job.runs; i++) {
      done += 1;
      const label = `${job.voice} s${job.sentence_id} ${job.variant} ${i}/${job.runs}`;
      const call = await withRetries(label, () =>
        callStepPlanWs(env, {
          voice: job.voice,
          text: job.text,
          instruction: job.instruction,
        })
      );
      addEvents(call.eventCounts);
      let path = null;
      if (call.audio?.length) {
        const tmp = join(AUDIO_DIR, "_ws-run.wav");
        writeFileSync(tmp, call.audio);
        path = tmp;
        if (i === 1) {
          const canonical = writeCanonical(
            job.voice,
            job.sentence_id,
            job.variant,
            call.audio
          );
          saved.push({
            path: canonical,
            voice: job.voice,
            sentence_id: job.sentence_id,
            variant: job.variant,
            text: job.text,
            model: "stepaudio-2.5-tts",
          });
        }
      }
      const energy = call.audio?.length ? wavEnergy(call.audio) : null;
      const rec = {
        engine: "stepfun-ws",
        model: "stepaudio-2.5-tts",
        mode: "step-plan-ws",
        voice: job.voice,
        sentence_id: job.sentence_id,
        variant: job.variant,
        instruction: job.instruction,
        run_index: i,
        ok: Boolean(call.ok),
        error: call.error || null,
        retries: call.retries ?? 0,
        t_first_audio_ms: call.tFirst ?? null,
        t_first_after_text_ms: call.tFirstAfterText ?? null,
        t_created_ms: call.tCreated ?? null,
        t_total_ms: call.tTotal ?? null,
        audio_duration_ms: path ? afinfoDurationMs(path) : null,
        rms: energy?.rms ?? null,
        mean_abs: energy?.mean_abs ?? null,
        event_counts: call.eventCounts || {},
        event_order: call.eventOrder || [],
      };
      rec.realtime_factor =
        rec.audio_duration_ms && rec.t_total_ms
          ? Number((rec.t_total_ms / rec.audio_duration_ms).toFixed(3))
          : null;
      runs.push(rec);
      console.error(
        `[${done}/${total}] ${label} ok=${rec.ok} t_first=${rec.t_first_audio_ms} after_text=${rec.t_first_after_text_ms} tot=${rec.t_total_ms} dur=${rec.audio_duration_ms} rms=${rec.rms} err=${rec.error || ""} types=${Object.keys(rec.event_counts).join(",")}`
      );
      await sleep(GAP_MS);
    }
  }

  const summary = summarize(runs);
  const s1pri = summary.find(
    (r) => r.voice === primary && r.sentence_id === 1 && r.variant === "neutral"
  );
  const instrDeltas = [3, 4, 5, 6].map((id) => {
    const n = summary.find((r) => r.voice === primary && r.sentence_id === id && r.variant === "neutral");
    const i = summary.find((r) => r.voice === primary && r.sentence_id === id && r.variant === "instruction");
    return {
      sentence_id: id,
      duration_delta_ms:
        i?.audio_duration_p50 != null && n?.audio_duration_p50 != null
          ? i.audio_duration_p50 - n.audio_duration_p50
          : null,
      rms_delta:
        i?.rms_p50 != null && n?.rms_p50 != null
          ? Number((i.rms_p50 - n.rms_p50).toFixed(5))
          : null,
    };
  });
  const moved = instrDeltas.filter(
    (d) =>
      (d.duration_delta_ms != null && Math.abs(d.duration_delta_ms) >= 80) ||
      (d.rms_delta != null && Math.abs(d.rms_delta) >= 0.005)
  );

  const mmS1 = 676;
  const recBits = [];
  recBits.push(
    `Streaming default remains MiniMax speech-2.8-hd stream:true (s1 t_first p50 ${mmS1} ms). StepFun Step Plan WS (${primary}) s1 t_first p50=${s1pri?.t_first_p50 ?? "—"} / p95=${s1pri?.t_first_p95 ?? "—"} ms (n_ok ${s1pri?.n_ok ?? 0}/${s1pri?.n ?? 0}); after-text p50=${s1pri?.t_first_after_text_p50 ?? "—"} ms.`
  );
  if (s1pri?.t_first_p50 != null && s1pri.t_first_p50 > mmS1) {
    recBits.push(
      `WS first-audio is ${s1pri.t_first_p50 - mmS1} ms slower than MiniMax HD stream on the ack.`
    );
  }
  recBits.push(
    moved.length
      ? `instruction moved duration or RMS on ${moved.length}/4 directed sentences (Δdur ${moved.map((d) => `s${d.sentence_id}:${d.duration_delta_ms}`).join(", ")}). That is an objective change, not a listening score — owner judges whether it is worth the extra first-audio vs MiniMax.`
      : "instruction did not move duration or RMS by the thresholds (±80 ms / ±0.005 RMS) on s3–6. Extra first-audio vs MiniMax is not justified by these numbers alone."
  );

  const wsBlock = {
    date: "2026-09-04",
    endpoint: WS_URL,
    key_len: env.STEPFUN_STEP_PLAN_API_KEY.length,
    base_host: new URL(env.STEPFUN_STEP_PLAN_BASE).hostname,
    protocol:
      "tts.connection.done → tts.create → tts.text.delta + tts.text.done → tts.response.audio.delta* → tts.response.audio.done",
    docs: "https://platform.stepfun.com/docs/zh/api-reference/audio/ws-audio",
    voices: {
      listed: voices.voices,
      tried: voices.tried,
      tried_ids: candidateVoices,
      ok: voiceOk,
      fail: voiceFail,
    },
    primary_voice: primary,
    event_type_totals: eventTotals,
    runs,
    summary,
    instruction_deltas: instrDeltas,
  };

  const blindCount = buildBlindShort(saved.filter((s) => s.voice === primary));
  const report = {
    recommendation: recBits.join(" "),
    blind_short: {
      count: blindCount,
      path: ".work/voice-experiments/tts/blind-short/",
      sheet: ".work/voice-experiments/tts/blind-short/listening-sheet.md",
      key: ".work/voice-experiments/tts/blind-short/blind-short-key.json",
    },
  };
  appendReports(report, wsBlock);
  console.error(`wrote ${RESULTS_JSON}`);
  console.error(`wrote ${RESULTS_MD}`);
  console.error(`blind-short ${blindCount} files`);
}

main().catch((err) => {
  console.error(redact(err.stack || err.message));
  process.exit(1);
});
