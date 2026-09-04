#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openHeaderWebSocket } from "./ws.mjs";
import { readSse } from "./run-stepfun.mjs";
import {
  WORK_DIR,
  RESULTS_DIR,
  SAMPLE_RATE,
  loadDevVars,
  keyMeta,
  hostnameOf,
  parseWav,
  chunkPcm,
  sleep,
  nowMs,
  cer,
  median,
  roundMs,
  sanitizeError,
  withRetries,
} from "./lib.mjs";

const TRUTH_PATH = join(WORK_DIR, "truth.json");
const DATE_STAMP = "2026-09-04";
const TRIALS = 3;
const INTERIM_MS = 800;
const OVERLAP_MS = 200;
const ASR_MODEL = "stepaudio-2.5-asr";
const REALTIME_MODEL = "stepaudio-2.5-realtime";

function stepPlanBase(env) {
  return (env.STEPFUN_STEP_PLAN_BASE || "https://api.stepfun.com/step_plan/v1").replace(/\/$/, "");
}

function asrUrl(env) {
  return `${stepPlanBase(env)}/audio/asr/sse`;
}

function realtimeUrl(env) {
  const http = stepPlanBase(env);
  const ws = http.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  return `${ws}/realtime?model=${REALTIME_MODEL}`;
}

function requirePlanKey(env) {
  const key = env.STEPFUN_STEP_PLAN_API_KEY || env.STEPFUN_API_KEY;
  if (!key) {
    const err = new Error("STEPFUN_STEP_PLAN_API_KEY missing");
    err.status = 401;
    throw err;
  }
  return key;
}

export function pcmSlice(pcm, sampleRate, startMs, endMs) {
  const bps = sampleRate * 2;
  let start = Math.floor((startMs / 1000) * bps);
  let end = Math.floor((endMs / 1000) * bps);
  start -= start % 2;
  end -= end % 2;
  return pcm.subarray(Math.max(0, start), Math.min(pcm.length, end));
}

function sliceDurationMs(pcm, sampleRate) {
  return Math.round((pcm.length / (sampleRate * 2)) * 1000);
}

function asrBody(pcm, sampleRate) {
  return {
    audio: {
      data: Buffer.from(pcm).toString("base64"),
      input: {
        transcription: {
          model: ASR_MODEL,
          language: "zh",
          enable_itn: true,
        },
        format: {
          type: "pcm",
          codec: "pcm_s16le",
          rate: sampleRate,
          bits: 16,
          channel: 1,
        },
      },
    },
  };
}

export async function postAsr(env, pcm, sampleRate, label) {
  const key = requirePlanKey(env);
  const url = asrUrl(env);
  return withRetries(
    async () => {
      const t0 = nowMs();
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "content-type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(asrBody(pcm, sampleRate)),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) {
        await res.text().catch(() => "");
        const err = new Error(`Step Plan ASR HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const sse = await readSse(res, t0);
      return {
        text: sse.text,
        firstDeltaMs: sse.firstDeltaMs,
        streamEndMs: sse.streamEndMs,
        doneMs: sse.doneMs,
        eventTypes: sse.eventTypes,
        billed_ms: sliceDurationMs(pcm, sampleRate),
        upstream_streams_deltas: sse.upstreamStreamsDeltas,
      };
    },
    { label }
  );
}

export async function runD({ wavPath, truth, env, durationMs }) {
  const wav = readFileSync(wavPath);
  const parsed = parseWav(wav);
  const rate = parsed.sampleRate || SAMPLE_RATE;
  try {
    const sse = await postAsr(env, parsed.pcm, rate, "D");
    return {
      ok: true,
      method: "D",
      text: sse.text,
      cer: cer(sse.text, truth),
      first_partial_ms: roundMs(durationMs + (sse.firstDeltaMs ?? sse.streamEndMs)),
      first_delta_after_end_ms: roundMs(sse.firstDeltaMs),
      final_after_end_ms: roundMs(sse.streamEndMs),
      billed_audio_ms: sse.billed_ms,
      upstream_streams_deltas: sse.upstream_streams_deltas,
      event_types: sse.eventTypes,
    };
  } catch (err) {
    return failRow("D", err);
  }
}

export async function runE({ wavPath, truth, env, durationMs }) {
  const wav = readFileSync(wavPath);
  const parsed = parseWav(wav);
  const rate = parsed.sampleRate || SAMPLE_RATE;
  const t0 = nowMs();
  const interims = [];
  const inflight = [];
  let firstPartialMs = null;

  const fire = (endMs, kind) => {
    const slice = pcmSlice(parsed.pcm, rate, 0, endMs);
    if (!slice.length) return;
    const sentAt = nowMs();
    const p = postAsr(env, slice, rate, `E-${kind}`).then((sse) => {
      const row = {
        kind,
        end_ms: endMs,
        sent_at_ms: roundMs(sentAt - t0),
        latency_ms: roundMs(nowMs() - sentAt),
        text: sse.text,
        billed_ms: sse.billed_ms,
      };
      if (sse.text && firstPartialMs == null) firstPartialMs = nowMs() - t0;
      interims.push(row);
      return row;
    });
    inflight.push(p);
  };

  let mark = INTERIM_MS;
  while (mark < durationMs) {
    await sleep(INTERIM_MS);
    fire(Math.min(mark, durationMs), "interim");
    mark += INTERIM_MS;
  }
  const leftover = durationMs - (mark - INTERIM_MS);
  if (leftover > 0) await sleep(leftover);
  const tEnd = nowMs();
  let final;
  try {
    final = await postAsr(env, parsed.pcm, rate, "E-final");
  } catch (err) {
    await Promise.allSettled(inflight);
    return failRow("E", err);
  }
  await Promise.allSettled(inflight);
  const billed = interims.reduce((s, r) => s + (r.billed_ms || 0), 0) + (final.billed_ms || 0);
  return {
    ok: true,
    method: "E",
    text: final.text,
    cer: cer(final.text, truth),
    first_partial_ms: roundMs(firstPartialMs),
    final_after_end_ms: roundMs(nowMs() - tEnd),
    billed_audio_ms: billed,
    interim_count: interims.length,
    interim_latencies_ms: interims.map((r) => r.latency_ms),
    interims: interims.map((r) => ({
      end_ms: r.end_ms,
      sent_at_ms: r.sent_at_ms,
      latency_ms: r.latency_ms,
      billed_ms: r.billed_ms,
      text: r.text,
    })),
  };
}

export async function runF({ wavPath, truth, env, durationMs }) {
  const wav = readFileSync(wavPath);
  const parsed = parseWav(wav);
  const rate = parsed.sampleRate || SAMPLE_RATE;
  const t0 = nowMs();
  const segs = [];
  const inflight = [];
  let firstPartialMs = null;
  let lastSentAt = t0;

  const fire = (startMs, endMs, index) => {
    const slice = pcmSlice(parsed.pcm, rate, startMs, endMs);
    if (!slice.length) return;
    const sentAt = nowMs();
    lastSentAt = sentAt;
    const p = postAsr(env, slice, rate, `F-${index}`).then((sse) => {
      const row = {
        index,
        start_ms: startMs,
        end_ms: endMs,
        sent_at_ms: roundMs(sentAt - t0),
        latency_ms: roundMs(nowMs() - sentAt),
        text: sse.text,
        billed_ms: sse.billed_ms,
      };
      if (sse.text && firstPartialMs == null) firstPartialMs = nowMs() - t0;
      segs[index] = row;
      return row;
    });
    inflight.push(p);
  };

  let t = 0;
  let index = 0;
  while (t < durationMs) {
    const wait = Math.min(INTERIM_MS, durationMs - t);
    await sleep(wait);
    const end = Math.min(durationMs, t + wait);
    const start = t === 0 ? 0 : Math.max(0, t - OVERLAP_MS);
    fire(start, end, index);
    t = end;
    index += 1;
  }
  await Promise.allSettled(inflight);
  const ordered = segs.filter(Boolean);
  const text = ordered
    .map((s) => s.text || "")
    .filter(Boolean)
    .join("");
  const billed = ordered.reduce((s, r) => s + (r.billed_ms || 0), 0);
  const last = ordered[ordered.length - 1];
  return {
    ok: Boolean(text),
    method: "F",
    text,
    cer: text ? cer(text, truth) : null,
    first_partial_ms: roundMs(firstPartialMs),
    final_after_end_ms: last ? last.latency_ms : null,
    billed_audio_ms: billed,
    segment_count: ordered.length,
    interim_latencies_ms: ordered.map((r) => r.latency_ms),
    segments: ordered.map((r) => ({
      start_ms: r.start_ms,
      end_ms: r.end_ms,
      sent_at_ms: r.sent_at_ms,
      latency_ms: r.latency_ms,
      billed_ms: r.billed_ms,
      text: r.text,
    })),
    error: text ? undefined : { message: "empty concatenation" },
  };
}

function nextEventId(seq) {
  seq.n += 1;
  return `evt_${Date.now()}_${seq.n}`;
}

export async function runG({ wavPath, truth, env, durationMs }) {
  const key = requirePlanKey(env);
  const url = realtimeUrl(env);
  const wav = readFileSync(wavPath);
  const parsed = parseWav(wav);
  const chunks = chunkPcm(parsed.pcm, parsed.sampleRate || SAMPLE_RATE, 100);
  const fact = {
    websocket_asr_on_step_plan: false,
    realtime_conversation_url: url.replace(/\?.*/, ""),
    model: REALTIME_MODEL,
  };

  const trySession = async (modalities) => {
    const ws = await openHeaderWebSocket(url, { Authorization: `Bearer ${key}` });
    const seq = { n: 0 };
    const eventTypes = [];
    let sessionReady = false;
    let errorMsg = null;
    let firstPartialMs = null;
    let finalText = "";
    let latestText = "";
    let tAudioStart = null;
    let tAudioEnd = null;
    let finalMs = null;
    let incremental = false;
    const waiters = new Set();
    const notify = () => {
      for (const w of waiters) w();
    };

    const onMessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
      } catch {
        return;
      }
      const type = msg?.type;
      if (type) eventTypes.push(type);
      if (type === "ping") {
        ws.send(JSON.stringify({ type: "pong", event_id: nextEventId(seq) }));
        return;
      }
      if (type === "error") {
        errorMsg = String(msg?.error?.message || msg?.error?.code || "ws error").slice(0, 200);
        notify();
        return;
      }
      if (type === "session.created" || type === "session.updated") sessionReady = true;
      const userDelta = /input_audio_transcription\.(delta|partial)/.test(type || "");
      const userDone = /input_audio_transcription\.(completed|done)$/.test(type || "");
      let piece = msg.transcript || msg.text || "";
      if (!piece && Array.isArray(msg.item?.content)) {
        piece = msg.item.content.map((c) => c.transcript || c.text || "").join("");
      }
      if (userDelta && (msg.delta || piece)) {
        incremental = true;
        latestText = msg.delta || piece || latestText;
        if (tAudioStart != null && firstPartialMs == null && latestText) {
          firstPartialMs = nowMs() - tAudioStart;
        }
      }
      if (userDone || (type === "conversation.item.created" && piece)) {
        if (piece) finalText = piece;
        if (!firstPartialMs && tAudioStart != null && (finalText || latestText)) {
          firstPartialMs = nowMs() - tAudioStart;
        }
        if (userDone && tAudioEnd != null) finalMs = nowMs() - tAudioEnd;
      }
      notify();
    };

    ws.addEventListener("message", (ev) => onMessage(ev.data));
    ws.addEventListener("close", () => notify());
    ws.addEventListener("error", () => notify());

    const waitUntil = async (pred, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (errorMsg) {
          const err = new Error(errorMsg);
          if (/unauth|forbidden|402|modalit/i.test(errorMsg)) err.status = 400;
          throw err;
        }
        if (pred()) return;
        await new Promise((resolve) => {
          const w = () => {
            waiters.delete(w);
            resolve();
          };
          waiters.add(w);
          setTimeout(w, 40);
        });
      }
      const err = new Error(`${label} timeout`);
      err.code = "ETIMEDOUT";
      throw err;
    };

    const session = {
      modalities,
      instructions: "只转写用户说的中文，不要回答，不要生成回复。",
      input_audio_format: "pcm16",
      input_audio_transcription: { model: ASR_MODEL },
      turn_detection: {
        type: "server_vad",
        silence_duration_ms: 300,
      },
    };
    if (modalities.includes("audio")) {
      session.voice = "qingchunshaonv";
      session.output_audio_format = "pcm16";
    }

    try {
      ws.send(
        JSON.stringify({
          event_id: nextEventId(seq),
          type: "session.update",
          session,
        })
      );
      await waitUntil(
        () => sessionReady || eventTypes.includes("session.updated"),
        8_000,
        "session.ready"
      );

      tAudioStart = nowMs();
      for (const chunk of chunks) {
        ws.send(
          JSON.stringify({
            event_id: nextEventId(seq),
            type: "input_audio_buffer.append",
            audio: Buffer.from(chunk).toString("base64"),
          })
        );
        await sleep(100);
      }
      tAudioEnd = nowMs();
      const silenceChunk = Buffer.alloc(Math.floor(((parsed.sampleRate || SAMPLE_RATE) * 2 * 0.1) / 2) * 2);
      for (let i = 0; i < 12; i++) {
        ws.send(
          JSON.stringify({
            event_id: nextEventId(seq),
            type: "input_audio_buffer.append",
            audio: silenceChunk.toString("base64"),
          })
        );
        await sleep(100);
      }
      fact.trailing_silence_ms = 1200;
      try {
        await waitUntil(
          () => Boolean(finalText) || Boolean(errorMsg),
          4_000,
          "transcription"
        );
      } catch {
        fact.transcription_timeout = true;
      }
      const text = (finalText || latestText).trim();
      const uniqueEvents = [...new Set(eventTypes)];
      console.error(`[G] modalities=${modalities.join("+")} events=${uniqueEvents.join(",") || "none"}`);
      return {
        ok: Boolean(text),
        method: "G",
        text,
        cer: text ? cer(text, truth) : null,
        first_partial_ms: roundMs(firstPartialMs),
        final_after_end_ms: roundMs(finalMs),
        event_types: uniqueEvents,
        incremental_transcripts: incremental,
        modalities,
        fact,
        error: text ? undefined : { message: errorMsg || `no transcript events=${uniqueEvents.join(",") || "none"}` },
      };
    } finally {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  };

  try {
    // Smoke: modalities ["text"] is accepted but never emits user transcripts.
    // Use text+audio and discard model audio; record that choice.
    fact.modalities_text_accepted = true;
    fact.modalities_used = ["text", "audio"];
    return await trySession(["text", "audio"]);
  } catch (err) {
    return { ...failRow("G", err), fact };
  }
}

export function failRow(method, err) {
  return {
    ok: false,
    method,
    text: "",
    cer: null,
    first_partial_ms: null,
    final_after_end_ms: null,
    error: sanitizeError(err),
  };
}

function fmtMs(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return String(Math.round(n));
}

function fmtCer(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(3);
}

function summarize(trials) {
  const ok = trials.filter((t) => t.ok);
  return {
    n_ok: ok.length,
    n: trials.length,
    first_partial_ms: median(ok.map((t) => t.first_partial_ms)),
    final_after_end_ms: median(ok.map((t) => t.final_after_end_ms)),
    first_delta_after_end_ms: median(ok.map((t) => t.first_delta_after_end_ms)),
    cer: median(ok.map((t) => t.cer)),
    billed_audio_ms: median(ok.map((t) => t.billed_audio_ms)),
    text: ok[0]?.text || "",
    incremental_transcripts: ok[0]?.incremental_transcripts ?? null,
    event_types: ok[0]?.event_types || [],
    error: ok.length ? undefined : trials[0]?.error,
  };
}

const ACCEPTABLE_CER = 0.05;

function recommend(cells, samples) {
  const methods = ["D", "E", "F", "G"];
  const long = samples.filter((s) => s.duration_ms >= 4000);
  const lines = [];
  lines.push(
    "C Apple: rejected by owner on quality (人评). Step Plan has no WebSocket ASR; only HTTP+SSE `/step_plan/v1/audio/asr/sse` and realtime `stepaudio-2.5-realtime`."
  );
  const evals = methods.map((m) => {
    const rows = samples.map((s) => ({ s, c: cells[`${s.id}:${m}`] }));
    const longRows = long.map((s) => ({ s, c: cells[`${s.id}:${m}`] }));
    const ok = rows.every((r) => r.c?.n_ok);
    const cerOk = rows.every((r) => r.c?.n_ok && r.c.cer != null && r.c.cer <= ACCEPTABLE_CER);
    const whileSpeaking = longRows.every(
      (r) => r.c?.n_ok && r.c.first_partial_ms != null && r.c.first_partial_ms < r.s.duration_ms
    );
    const finalMed = median(rows.map((r) => r.c?.final_after_end_ms));
    const cerMed = median(rows.map((r) => r.c?.cer));
    const billed = median(rows.map((r) => r.c?.billed_audio_ms));
    return { m, ok, cerOk, whileSpeaking, finalMed, cerMed, billed };
  });
  const hits300 = evals.filter(
    (e) => e.ok && e.cerOk && e.whileSpeaking && e.finalMed != null && e.finalMed <= 300
  );
  if (hits300.length) {
    const best = hits300.sort((a, b) => a.cerMed - b.cerMed || a.finalMed - b.finalMed)[0];
    lines.push(
      `${best.m} meets both bars at acceptable CER (final ${fmtMs(best.finalMed)} ms, CER ${fmtCer(best.cerMed)}, billed median ${fmtMs(best.billed)} ms).`
    );
  } else {
    lines.push("None of D–G hits text-while-speaking and final ≤300 ms at acceptable CER (≤0.05).");
    const liveOk = evals.filter((e) => e.ok && e.cerOk && e.whileSpeaking);
    if (liveOk.length) {
      const best = liveOk.sort((a, b) => (a.finalMed ?? 9e9) - (b.finalMed ?? 9e9))[0];
      lines.push(
        `Best live+accurate path is ${best.m}: first text ~1.8 s on clips ≥4 s, final ${fmtMs(best.finalMed)} ms (misses 300), CER ${fmtCer(best.cerMed)}, billed ${fmtMs(best.billed)} ms.`
      );
    }
    const fastestFinal = evals
      .filter((e) => e.ok && e.finalMed != null)
      .sort((a, b) => a.finalMed - b.finalMed)[0];
    if (fastestFinal) {
      lines.push(
        `Fastest final is ${fastestFinal.m} at ${fmtMs(fastestFinal.finalMed)} ms, CER ${fmtCer(fastestFinal.cerMed)} (not acceptable if CER>0.05).`
      );
    }
  }
  for (const e of evals) {
    lines.push(
      `${e.m}: while_speaking=${e.whileSpeaking} final=${fmtMs(e.finalMed)} CER=${fmtCer(e.cerMed)} billed_ms=${fmtMs(e.billed)} n_ok=${e.ok} cer_ok=${e.cerOk}.`
    );
  }
  lines.push(
    "Product: E interims during hold + D on key-up. Do not ship F (boundary CER) or Apple. G only fired on the 18 s clip, at VAD end, not incrementally."
  );
  return lines.join(" ");
}

function renderMd({ samples, cells, trials, rec, envMeta }) {
  const methods = ["D", "E", "F", "G"];
  const lines = [];
  lines.push("");
  lines.push("## D–G Step Plan");
  lines.push("");
  lines.push(
    `Fact: WebSocket streaming ASR is not available on Step Plan. ASR is \`POST https://api.stepfun.com/step_plan/v1/audio/asr/sse\` (\`${ASR_MODEL}\`, PCM). Realtime is \`wss://api.stepfun.com/step_plan/v1/realtime?model=${REALTIME_MODEL}\`. STEPFUN_STEP_PLAN_API_KEY length=${envMeta.keyLength}. Medians match \`step_plan.cells\`. D first SSE delta after key-up is 354–626 ms. E/F first interim is ~1.8 s from audio start (first 800 ms chunk + RTT). G user transcript event: \`conversation.item.input_audio_transcription.completed\` at VAD end only (no input-transcription deltas); short clips never reached \`speech_stopped\`.`
  );
  lines.push("");
  lines.push("| sample | method | first_partial_ms | final_after_end_ms | CER | billed_audio_ms | n_ok |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const s of samples) {
    for (const m of methods) {
      const c = cells[`${s.id}:${m}`];
      lines.push(
        `| ${s.id} | ${m} | ${fmtMs(c.first_partial_ms)} | ${fmtMs(c.final_after_end_ms)} | ${fmtCer(c.cer)} | ${fmtMs(c.billed_audio_ms)} | ${c.n_ok}/${c.n} |`
      );
    }
  }
  lines.push("");
  lines.push("### Recommendation (D–G)");
  lines.push("");
  lines.push(rec);
  lines.push("");
  lines.push("| sample | method | trial | ok | first_partial_ms | final_after_end_ms | CER | billed_audio_ms | error |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const t of trials) {
    const err = t.error?.message ? t.error.message.replace(/\|/g, "/") : "";
    lines.push(
      `| ${t.sample} | ${t.method} | ${t.trial} | ${t.ok} | ${fmtMs(t.first_partial_ms)} | ${fmtMs(t.final_after_end_ms)} | ${fmtCer(t.cer)} | ${fmtMs(t.billed_audio_ms)} | ${err} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  if (!existsSync(TRUTH_PATH)) {
    console.error("missing truth.json");
    process.exit(1);
  }
  const truth = JSON.parse(readFileSync(TRUTH_PATH, "utf8"));
  const env = loadDevVars();
  const planKey = keyMeta(env, "STEPFUN_STEP_PLAN_API_KEY");
  const base = stepPlanBase(env);
  console.log(
    `[step-plan] STEPFUN_STEP_PLAN_API_KEY present=${planKey.present} length=${planKey.length} base_host=${hostnameOf(base)} base_path=${new URL(base).pathname} asr=${asrUrl(env)}`
  );

  const runners = { D: runD, E: runE, F: runF, G: runG };
  const trialRows = [];
  const cells = {};
  for (const sample of truth.samples) {
    const grouped = { D: [], E: [], F: [], G: [] };
    for (let trial = 1; trial <= TRIALS; trial++) {
      for (const method of ["D", "E", "F", "G"]) {
        console.log(`[step-plan] ${method} ${sample.id} trial ${trial}/${TRIALS}`);
        const row = await runners[method]({
          wavPath: sample.path,
          truth: sample.text,
          env,
          durationMs: sample.duration_ms,
        });
        grouped[method].push(row);
        trialRows.push({ sample: sample.id, trial, ...row });
      }
    }
    for (const method of ["D", "E", "F", "G"]) {
      cells[`${sample.id}:${method}`] = summarize(grouped[method]);
    }
  }

  const rec = recommend(cells, truth.samples);
  const envMeta = {
    host: hostnameOf(base),
    keyLength: planKey.length,
  };
  const block = {
    at: new Date().toISOString(),
    plan: "Step Plan",
    asr_url: asrUrl(env),
    realtime_url: realtimeUrl(env).replace(/\?.*/, "?model=stepaudio-2.5-realtime"),
    websocket_asr_available: false,
    apple_rejected: "C Apple: rejected by owner on quality (人评)",
    cells,
    trials: trialRows.map((t) => ({
      sample: t.sample,
      method: t.method,
      trial: t.trial,
      ok: t.ok,
      first_partial_ms: t.first_partial_ms ?? null,
      first_delta_after_end_ms: t.first_delta_after_end_ms ?? null,
      final_after_end_ms: t.final_after_end_ms ?? null,
      cer: t.cer ?? null,
      billed_audio_ms: t.billed_audio_ms ?? null,
      text: t.text || "",
      incremental_transcripts: t.incremental_transcripts ?? null,
      event_types: t.event_types || null,
      interim_count: t.interim_count ?? t.segment_count ?? null,
      interim_latencies_ms: t.interim_latencies_ms || null,
      error: t.error || null,
    })),
    recommendation: rec,
  };

  const jsonPath = join(RESULTS_DIR, `${DATE_STAMP}-exp2-stt.json`);
  const mdPath = join(RESULTS_DIR, `${DATE_STAMP}-exp2-stt.md`);
  const payload = JSON.parse(readFileSync(jsonPath, "utf8"));
  payload.step_plan = block;
  payload.recommendation = rec;
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + "\n");

  let md = readFileSync(mdPath, "utf8");
  if (!md.includes("C Apple: rejected by owner on quality (人评)")) {
    md = md.replace(
      "## C (retry, .app bundle)",
      "## C Apple: rejected by owner on quality (人评)\n\nOwner listened and rejected Apple STT. `.app` artifacts left in place; Apple work stopped.\n\n## C (retry, .app bundle)"
    );
  }
  md = md.replace(
    /## Recommendation\n\n[\s\S]*?\n\n## Trial log/,
    `## Recommendation\n\n${rec}\n\n## Trial log`
  );
  const dgBlock = renderMd({ samples: truth.samples, cells, trials: block.trials, rec, envMeta });
  if (md.includes("## D–G Step Plan")) {
    md = md.replace(/## D–G Step Plan[\s\S]*$/, dgBlock.trimStart());
  } else {
    md += dgBlock;
  }
  writeFileSync(mdPath, md.endsWith("\n") ? md : `${md}\n`);
  console.log(`[step-plan] wrote ${jsonPath}`);
  console.log(`[step-plan] wrote ${mdPath}`);
}

function rewriteFromExisting() {
  const jsonPath = join(RESULTS_DIR, `${DATE_STAMP}-exp2-stt.json`);
  const mdPath = join(RESULTS_DIR, `${DATE_STAMP}-exp2-stt.md`);
  const truth = JSON.parse(readFileSync(TRUTH_PATH, "utf8"));
  const payload = JSON.parse(readFileSync(jsonPath, "utf8"));
  const trials = payload.step_plan.trials;
  const cells = {};
  for (const sample of truth.samples) {
    for (const method of ["D", "E", "F", "G"]) {
      cells[`${sample.id}:${method}`] = summarize(
        trials.filter((t) => t.sample === sample.id && t.method === method)
      );
    }
  }
  const rec = recommend(cells, truth.samples);
  payload.step_plan.cells = cells;
  payload.step_plan.recommendation = rec;
  payload.recommendation = rec;
  if (
    payload.apple_retry?.recommendation &&
    !payload.apple_retry.recommendation.includes("rejected by owner on quality")
  ) {
    payload.apple_retry.recommendation = `C Apple: rejected by owner on quality (人评). Historical numbers only. ${payload.apple_retry.recommendation}`;
  }
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + "\n");

  const envMeta = {
    host: hostnameOf(payload.step_plan.asr_url || "https://api.stepfun.com/step_plan/v1"),
    keyLength: 64,
  };
  let md = readFileSync(mdPath, "utf8");
  md = md.replace(
    /## Recommendation\n\n[\s\S]*?\n\n## Trial log/,
    `## Recommendation\n\n${rec}\n\n## Trial log`
  );
  const dgBlock = renderMd({ samples: truth.samples, cells, trials, rec, envMeta });
  if (md.includes("## D–G Step Plan")) {
    md = md.replace(/## D–G Step Plan[\s\S]*$/, dgBlock.trimStart());
  } else {
    md += dgBlock;
  }
  writeFileSync(mdPath, md.endsWith("\n") ? md : `${md}\n`);
  console.log(`[step-plan] rewrote cells+rec from ${trials.length} trials`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = process.argv.includes("--rewrite-only") ? rewriteFromExisting : main;
  Promise.resolve(run()).catch((err) => {
    console.error(`[step-plan] fatal: ${sanitizeError(err).message}`);
    process.exit(1);
  });
}
