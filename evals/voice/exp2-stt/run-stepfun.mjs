#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { openHeaderWebSocket } from "./ws.mjs";
import {
  STEPFUN_ASR_URL,
  STEPFUN_ASR_STREAM_URL,
  STEPFUN_ASR_STREAM_MODEL,
  CHUNK_MS,
  SAMPLE_RATE,
  loadDevVars,
  keyMeta,
  hostnameOf,
  parseWav,
  chunkPcm,
  sleep,
  nowMs,
  cer,
  roundMs,
  sanitizeError,
  withRetries,
  buildStepFunTranscriptionBody,
} from "./lib.mjs";

function requireStepFunKey(env) {
  const key = env.STEPFUN_API_KEY;
  if (!key) {
    const err = new Error("STEPFUN_API_KEY missing");
    err.status = 401;
    throw err;
  }
  return key;
}

export async function readSse(response, t0 = nowMs()) {
  if (!response.body) throw new Error("ASR response missing body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let firstDeltaMs = null;
  let doneMs = null;
  const eventTypes = [];

  const handleLine = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (event?.type) eventTypes.push(event.type);
    if (event.type === "transcript.text.delta") {
      if (firstDeltaMs == null) firstDeltaMs = nowMs() - t0;
      text += event.delta || "";
    } else if (event.type === "transcript.text.done") {
      text = event.text || text;
      if (doneMs == null) doneMs = nowMs() - t0;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      handleLine(line);
    }
  }
  buf += decoder.decode();
  if (buf) {
    for (const line of buf.split("\n")) handleLine(line.replace(/\r$/, ""));
  }
  const streamEndMs = nowMs() - t0;
  return {
    text: text.trim(),
    firstDeltaMs,
    doneMs,
    streamEndMs,
    eventTypes,
    upstreamStreamsDeltas: eventTypes.includes("transcript.text.delta"),
  };
}

export async function runMethodA({ wavPath, truth, env }) {
  const key = requireStepFunKey(env);
  const wav = readFileSync(wavPath);
  const parsed = parseWav(wav);
  const asrModel = env.STEPFUN_ASR_MODEL || "stepaudio-2.5-asr";
  const body = buildStepFunTranscriptionBody({
    audioBase64: wav.toString("base64"),
    format: "wav",
    sampleRate: parsed.sampleRate || SAMPLE_RATE,
    language: "zh",
    model: asrModel,
  });

  const runOnce = async () => {
    const tEnd = nowMs();
    const res = await fetch(STEPFUN_ASR_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) {
      await res.text().catch(() => "");
      const err = new Error(`StepFun ASR HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const sse = await readSse(res, tEnd);
    return {
      ok: true,
      method: "A",
      endpoint: STEPFUN_ASR_URL,
      host: hostnameOf(STEPFUN_ASR_URL),
      model: asrModel,
      text: sse.text,
      cer: cer(sse.text, truth),
      first_partial_ms: null,
      first_delta_after_end_ms: roundMs(sse.firstDeltaMs),
      final_after_end_ms: roundMs(sse.streamEndMs),
      done_event_after_end_ms: roundMs(sse.doneMs),
      upstream_streams_deltas: sse.upstreamStreamsDeltas,
      event_types: sse.eventTypes,
    };
  };

  try {
    return await withRetries(runOnce, { label: "stepfun-A" });
  } catch (err) {
    return {
      ok: false,
      method: "A",
      endpoint: STEPFUN_ASR_URL,
      host: hostnameOf(STEPFUN_ASR_URL),
      model: env.STEPFUN_ASR_MODEL || "stepaudio-2.5-asr",
      text: "",
      cer: null,
      first_partial_ms: null,
      first_delta_after_end_ms: null,
      final_after_end_ms: null,
      upstream_streams_deltas: null,
      error: sanitizeError(err),
    };
  }
}

function nextEventId(seq) {
  seq.n += 1;
  return `evt_${Date.now()}_${seq.n}`;
}

function openStepFunAsrSocket(url, key) {
  return openHeaderWebSocket(url, { Authorization: `Bearer ${key}` }).catch((err) => {
    err.code = err.code || "ECONNRESET";
    throw err;
  });
}

const STEPFUN_REALTIME_CONVERSATION_URL =
  "wss://api.stepfun.com/v1/realtime?model=step-audio-2-mini";

let cachedStreamFailure = null;

async function probeConversationRealtime(key) {
  try {
    const ws = await openHeaderWebSocket(STEPFUN_REALTIME_CONVERSATION_URL, {
      Authorization: `Bearer ${key}`,
    });
    ws.close();
    return { status: 101, url: STEPFUN_REALTIME_CONVERSATION_URL };
  } catch (err) {
    return { status: err.status ?? null, code: err.code ?? null, url: STEPFUN_REALTIME_CONVERSATION_URL };
  }
}

export async function runMethodB({ wavPath, truth, env }) {
  if (cachedStreamFailure) return { ...cachedStreamFailure };
  const key = requireStepFunKey(env);
  const wav = readFileSync(wavPath);
  const parsed = parseWav(wav);
  const chunks = chunkPcm(parsed.pcm, parsed.sampleRate || SAMPLE_RATE, CHUNK_MS);
  const durationMs = Math.round((parsed.pcm.length / ((parsed.sampleRate || SAMPLE_RATE) * 2)) * 1000);

  const runOnce = async () => {
    const ws = await openStepFunAsrSocket(STEPFUN_ASR_STREAM_URL, key);
    const seq = { n: 0 };
    const eventTypes = [];
    let sessionReady = false;
    let firstPartialMs = null;
    let finalMs = null;
    let tAudioStart = null;
    let tAudioEnd = null;
    let latestText = "";
    let finalText = "";
    let errorMsg = null;

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
        const message = msg?.error?.message || msg?.error?.code || "websocket error event";
        errorMsg = String(message).slice(0, 200);
        const err = new Error(errorMsg);
        if (/unauth|forbidden/i.test(errorMsg)) err.status = 401;
        notify();
        return;
      }
      if (type === "session.created" || type === "session.updated") {
        sessionReady = true;
      }
      if (type === "conversation.item.input_audio_transcription.delta") {
        const piece = msg.text || msg.delta || "";
        if (piece) latestText = piece;
        if (tAudioStart != null && firstPartialMs == null && latestText) {
          firstPartialMs = nowMs() - tAudioStart;
        }
      }
      if (type === "conversation.item.input_audio_transcription.completed") {
        finalText = msg.transcript || msg.text || latestText;
        if (tAudioEnd != null) finalMs = nowMs() - tAudioEnd;
        else if (tAudioStart != null) finalMs = nowMs() - tAudioStart;
      }
      notify();
    };

    ws.addEventListener("message", (ev) => onMessage(ev.data));
    ws.addEventListener("close", () => notify());

    const waitUntil = async (pred, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (errorMsg) {
          const err = new Error(errorMsg);
          if (/unauth|forbidden/i.test(errorMsg)) err.status = 401;
          throw err;
        }
        if (pred()) return;
        await new Promise((resolve) => {
          const w = () => {
            waiters.delete(w);
            resolve();
          };
          waiters.add(w);
          setTimeout(w, 50);
        });
      }
      const err = new Error(`${label} timeout`);
      err.code = "ETIMEDOUT";
      throw err;
    };

    try {
      ws.send(
        JSON.stringify({
          event_id: nextEventId(seq),
          type: "session.update",
          session: {
            audio: {
              input: {
                format: {
                  type: "pcm",
                  codec: "pcm_s16le",
                  rate: parsed.sampleRate || SAMPLE_RATE,
                  bits: 16,
                  channel: 1,
                },
                transcription: {
                  model: STEPFUN_ASR_STREAM_MODEL,
                  language: "zh",
                  enable_itn: true,
                  full_rerun_on_commit: false,
                },
              },
            },
          },
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
        await sleep(CHUNK_MS);
      }
      tAudioEnd = nowMs();
      ws.send(
        JSON.stringify({
          event_id: nextEventId(seq),
          type: "input_audio_buffer.commit",
        })
      );
      await waitUntil(() => finalText || errorMsg, Math.max(8_000, durationMs + 5_000), "transcription.completed");
      const text = (finalText || latestText).trim();
      return {
        ok: true,
        method: "B",
        endpoint: STEPFUN_ASR_STREAM_URL,
        host: hostnameOf(STEPFUN_ASR_STREAM_URL.replace(/^wss/, "https")),
        model: STEPFUN_ASR_STREAM_MODEL,
        workaround: false,
        text,
        cer: cer(text, truth),
        first_partial_ms: roundMs(firstPartialMs),
        final_after_end_ms: roundMs(finalMs),
        event_types: eventTypes,
        duration_ms: durationMs,
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
    return await withRetries(runOnce, { label: "stepfun-B" });
  } catch (err) {
    const conversation = await probeConversationRealtime(key);
    const row = {
      ok: false,
      method: "B",
      endpoint: STEPFUN_ASR_STREAM_URL,
      host: hostnameOf(STEPFUN_ASR_STREAM_URL),
      model: STEPFUN_ASR_STREAM_MODEL,
      workaround: true,
      workaround_endpoint: conversation.url,
      conversation_realtime_status: conversation.status,
      text: "",
      cer: null,
      first_partial_ms: null,
      final_after_end_ms: null,
      error: sanitizeError(err),
    };
    if (err.status === 402 || conversation.status === 402) cachedStreamFailure = row;
    return row;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      method: { type: "string" },
      wav: { type: "string" },
      text: { type: "string" },
    },
  });
  if (!values.method || !values.wav || values.text == null) {
    console.error("usage: node run-stepfun.mjs --method a|b --wav PATH --text TRUTH");
    process.exit(2);
  }
  const env = loadDevVars();
  const meta = keyMeta(env, "STEPFUN_API_KEY");
  console.error(
    `[stepfun] STEPFUN_API_KEY present=${meta.present} length=${meta.length} asr_model=${env.STEPFUN_ASR_MODEL || "stepaudio-2.5-asr"}`
  );
  const method = values.method.toLowerCase();
  const args = { wavPath: values.wav, truth: values.text, env };
  const result = method === "b" ? await runMethodB(args) : await runMethodA(args);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[stepfun] fatal: ${sanitizeError(err).message}`);
    process.exit(1);
  });
}
