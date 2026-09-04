#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  WORK_DIR,
  RESULTS_DIR,
  SCRIPT_DIR,
  loadDevVars,
  keyMeta,
  hostnameOf,
  cer,
  median,
  roundMs,
  sanitizeError,
  STEPFUN_ASR_URL,
  STEPFUN_ASR_STREAM_URL,
} from "./lib.mjs";
import { runMethodA, runMethodB } from "./run-stepfun.mjs";

const APPLE_SRC = join(SCRIPT_DIR, "apple-stt.swift");
const APPLE_BIN = join(WORK_DIR, "apple-stt");
const TRUTH_PATH = join(WORK_DIR, "truth.json");
const DATE_STAMP = "2026-09-04";
const TRIALS = 3;
const FINAL_TARGET_MS = 300;

function spawnJson(command, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => stdout.push(d));
    child.stderr.on("data", (d) => stderr.push(d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: sanitizeError(err), stderr: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const errText = Buffer.concat(stderr).toString("utf8").slice(0, 400);
      if (!out) {
        const tcc = code === 134 || /PRIVACY_VIOLATION|TCC/i.test(errText);
        resolve({
          ok: false,
          error: {
            status: null,
            code: tcc ? "TCC" : code === null ? "ETIMEDOUT" : `exit_${code}`,
            message: tcc
              ? "permission not granted"
              : errText || "no json from apple-stt",
          },
          auth_status: tcc ? "denied" : undefined,
        });
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({
          ok: false,
          error: { status: null, code: "PARSE", message: "apple-stt returned non-JSON" },
        });
      }
    });
  });
}

function compileApple() {
  return new Promise((resolve) => {
    mkdirSync(WORK_DIR, { recursive: true });
    const child = spawn("swiftc", ["-O", "-o", APPLE_BIN, APPLE_SRC], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr = [];
    child.stderr.on("data", (d) => stderr.push(d));
    child.on("error", (err) => resolve({ ok: false, error: sanitizeError(err) }));
    child.on("close", (code) => {
      if (code === 0 && existsSync(APPLE_BIN)) {
        chmodSync(APPLE_BIN, 0o755);
        resolve({ ok: true });
        return;
      }
      resolve({
        ok: false,
        error: {
          status: null,
          code: `swiftc_${code}`,
          message: Buffer.concat(stderr).toString("utf8").slice(0, 240) || "swiftc failed",
        },
      });
    });
  });
}

async function runApple(wavPath, truth, durationMs, appleState) {
  if (!appleState.compiled) {
    return {
      ok: false,
      method: "C",
      text: "",
      cer: null,
      first_partial_ms: null,
      final_after_end_ms: null,
      error: appleState.compileError || { message: "apple-stt not compiled" },
    };
  }
  if (appleState.permissionDenied) {
    return {
      ok: false,
      method: "C",
      text: "",
      cer: null,
      first_partial_ms: null,
      final_after_end_ms: null,
      error: { status: null, code: "PERMISSION", message: "permission not granted" },
    };
  }
  const timeoutMs = Math.max(30_000, (durationMs || 0) + 25_000);
  const raw = await spawnJson(APPLE_BIN, ["--wav", wavPath], { timeoutMs });
  const errMsg = typeof raw.error === "string" ? raw.error : raw.error?.message;
  if (errMsg === "permission not granted" || (raw.auth_status && raw.auth_status !== "authorized")) {
    appleState.permissionDenied = true;
  }
  const text = raw.text || "";
  const errObj =
    typeof raw.error === "string"
      ? { message: raw.error }
      : raw.error && typeof raw.error === "object"
        ? raw.error
        : raw.ok
          ? undefined
          : { message: "apple-stt failed" };
  return {
    ok: Boolean(raw.ok && text),
    method: "C",
    text,
    cer: text ? cer(text, truth) : null,
    first_partial_ms: roundMs(raw.first_partial_ms),
    final_after_end_ms: roundMs(raw.final_after_end_ms),
    on_device: raw.on_device ?? true,
    supports_on_device: raw.supports_on_device,
    auth_status: raw.auth_status,
    error: raw.ok ? undefined : errObj,
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
    cer: median(ok.map((t) => t.cer)),
    first_delta_after_end_ms: median(ok.map((t) => t.first_delta_after_end_ms)),
    text: ok[0]?.text || "",
    error: ok.length ? undefined : trials[0]?.error,
  };
}

function recommendation(cells, samples) {
  const byMethod = { A: [], B: [], C: [] };
  for (const sample of samples) {
    for (const method of ["A", "B", "C"]) {
      byMethod[method].push(cells[`${sample.id}:${method}`]);
    }
  }
  const dur = Object.fromEntries(samples.map((s) => [s.id, s.duration_ms]));
  const bPartialsDuringSpeech = samples.every((s) => {
    const cell = cells[`${s.id}:B`];
    return cell?.n_ok && cell.first_partial_ms != null && cell.first_partial_ms < dur[s.id];
  });
  const cPartialsDuringSpeech = samples.every((s) => {
    const cell = cells[`${s.id}:C`];
    return cell?.n_ok && cell.first_partial_ms != null && cell.first_partial_ms < dur[s.id];
  });
  const bFinal = median(byMethod.B.map((c) => c.final_after_end_ms));
  const cFinal = median(byMethod.C.map((c) => c.final_after_end_ms));
  const aFinal = median(byMethod.A.map((c) => c.final_after_end_ms));
  const aFirstDelta = median(byMethod.A.map((c) => c.first_delta_after_end_ms));
  const bOk = byMethod.B.every((c) => c.n_ok);
  const cOk = byMethod.C.every((c) => c.n_ok);
  const bMeets = bOk && bPartialsDuringSpeech && bFinal != null && bFinal <= FINAL_TARGET_MS;
  const cMeets = cOk && cPartialsDuringSpeech && cFinal != null && cFinal <= FINAL_TARGET_MS;

  const lines = [];
  if (cMeets) {
    lines.push(
      `Apple on-device (C) is the only path that can meet both product bars on this machine: partials while speaking, median final ${fmtMs(cFinal)} ms after end (target ≤${FINAL_TARGET_MS} ms). Use it as a local lane when zh-CN on-device assets and Speech permission are available.`
    );
  } else if (bMeets) {
    lines.push(
      `StepFun streaming ASR (B, wss://api.stepfun.com/v1/realtime/asr/stream, model stepaudio-2.5-asr-stream) meets both bars: partials while speaking, median final ${fmtMs(bFinal)} ms after key-up.`
    );
  } else {
    lines.push(
      `Neither streaming path fully met “text while speaking + final ≤${FINAL_TARGET_MS} ms after key-up” on this run.`
    );
    if (bOk) {
      lines.push(
        `B did ${bPartialsDuringSpeech ? "show" : "not show"} partials during speech; median final_after_end is ${fmtMs(bFinal)} ms.`
      );
    } else {
      lines.push("B did not complete successfully on every sample (see caveats).");
    }
    if (cOk) {
      lines.push(
        `C did ${cPartialsDuringSpeech ? "show" : "not show"} partials during speech; median final_after_end is ${fmtMs(cFinal)} ms.`
      );
    } else {
      lines.push("C did not complete successfully on every sample (permission, on-device support, or empty transcript).");
    }
  }
  lines.push(
    `A (current product: whole-file POST to ${STEPFUN_ASR_URL} after key-up) cannot show text while speaking. Median time-to-final after end is ${fmtMs(aFinal)} ms; upstream SSE first delta after POST is ${fmtMs(aFirstDelta)} ms. Streaming that existing SSE through the local proxy would only help post-keyup latency, not in-speech partials.`
  );
  lines.push(
    "Product change: during PTT, stream 16 kHz PCM chunks into the already-sketched StepFun streaming seam (or Apple on-device), render partials live, and on key-up send input_audio_buffer.commit instead of posting the full WAV. Keep today’s buffered StepFun SSE as fallback when the socket is unavailable."
  );
  return lines.join(" ");
}

function renderMarkdown({ createdAt, samples, cells, trials, caveats, rec, envMeta }) {
  const methods = [
    ["A", "StepFun HTTP SSE after hold (current product)"],
    ["B", "StepFun WebSocket streaming ASR"],
    ["C", "Apple on-device zh-CN"],
  ];
  const lines = [];
  lines.push("# Exp2 STT latency");
  lines.push("");
  lines.push(`Date: ${DATE_STAMP}. Generated: ${createdAt}.`);
  lines.push("");
  lines.push("Target: text appears while the user speaks; final text ≤ ~300 ms after key-up.");
  lines.push("");
  lines.push("## Setup");
  lines.push("");
  lines.push(`- MiniMax TTS host: \`${envMeta.ttsHost}\`, model \`${envMeta.ttsModel}\``);
  lines.push(`- StepFun ASR host: \`${envMeta.asrHost}\`, model \`${envMeta.asrModel}\``);
  lines.push(`- StepFun stream: \`${STEPFUN_ASR_STREAM_URL}\`, model \`stepaudio-2.5-asr-stream\``);
  lines.push(`- STEPFUN_API_KEY length: ${envMeta.stepfunKeyLength}; MINIMAX_API_KEY length: ${envMeta.minimaxKeyLength}`);
  lines.push(`- Trials per cell: ${TRIALS} (median of successful runs)`);
  lines.push("- Audio fed in 100 ms PCM chunks at real time for B and C; A is whole-file after the simulated hold.");
  lines.push("");
  lines.push("## Samples");
  lines.push("");
  lines.push("| id | duration_ms | truth |");
  lines.push("|---|---|---|");
  for (const s of samples) {
    lines.push(`| ${s.id} | ${s.duration_ms} | ${s.text} |`);
  }
  lines.push("");
  lines.push("## Median table (sample × method)");
  lines.push("");
  lines.push("| sample | method | first_partial_ms | final_after_end_ms | CER | n_ok |");
  lines.push("|---|---|---|---|---|---|");
  for (const s of samples) {
    for (const [method] of methods) {
      const cell = cells[`${s.id}:${method}`];
      lines.push(
        `| ${s.id} | ${method} | ${fmtMs(cell.first_partial_ms)} | ${fmtMs(cell.final_after_end_ms)} | ${fmtCer(cell.cer)} | ${cell.n_ok}/${cell.n} |`
      );
    }
  }
  lines.push("");
  lines.push("Method A `first_partial_ms` is empty because nothing is sent until key-up. See `first_delta_after_end_ms` in the JSON for when the upstream SSE starts emitting `transcript.text.delta`.");
  lines.push("");
  lines.push("## Caveats");
  lines.push("");
  for (const c of caveats) lines.push(`- ${c}`);
  lines.push("");
  lines.push("## Recommendation");
  lines.push("");
  lines.push(rec);
  lines.push("");
  lines.push("## Trial log");
  lines.push("");
  lines.push("| sample | method | trial | ok | first_partial_ms | final_after_end_ms | CER | error |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const t of trials) {
    const err = t.error?.message ? t.error.message.replace(/\|/g, "/") : "";
    lines.push(
      `| ${t.sample} | ${t.method} | ${t.trial} | ${t.ok} | ${fmtMs(t.first_partial_ms)} | ${fmtMs(t.final_after_end_ms)} | ${fmtCer(t.cer)} | ${err} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  if (!existsSync(TRUTH_PATH)) {
    console.error("missing .work/voice-experiments/stt/truth.json — run synth.mjs first");
    process.exit(1);
  }
  const truth = JSON.parse(readFileSync(TRUTH_PATH, "utf8"));
  const env = loadDevVars();
  const stepMeta = keyMeta(env, "STEPFUN_API_KEY");
  const miniMeta = keyMeta(env, "MINIMAX_API_KEY");
  console.log(
    `[run] STEPFUN_API_KEY present=${stepMeta.present} length=${stepMeta.length} MINIMAX_API_KEY present=${miniMeta.present} length=${miniMeta.length}`
  );
  console.log(`[run] ASR host=${hostnameOf(STEPFUN_ASR_URL)} model=${env.STEPFUN_ASR_MODEL || "stepaudio-2.5-asr"}`);

  mkdirSync(WORK_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });

  const appleState = { compiled: false, permissionDenied: false, compileError: null, probe: null };
  const compiled = await compileApple();
  appleState.compiled = compiled.ok;
  appleState.compileError = compiled.error;
  if (compiled.ok) {
    appleState.probe = await spawnJson(APPLE_BIN, ["--probe"], { timeoutMs: 20_000 });
    if (!appleState.probe.ok) {
      appleState.permissionDenied = true;
      console.error(`[run] Apple probe: ${appleState.probe.error?.message || appleState.probe.auth_status || "failed"}`);
    } else {
      console.log(
        `[run] Apple probe auth=${appleState.probe.auth_status} supports_on_device=${appleState.probe.supports_on_device}`
      );
    }
  } else {
    console.error(`[run] swiftc failed: ${compiled.error?.message || "unknown"}`);
  }

  const trialRows = [];
  const cells = {};
  for (const sample of truth.samples) {
    const grouped = { A: [], B: [], C: [] };
    for (let trial = 1; trial <= TRIALS; trial++) {
      console.log(`[run] A ${sample.id} trial ${trial}/${TRIALS}`);
      const a = await runMethodA({ wavPath: sample.path, truth: sample.text, env });
      grouped.A.push(a);
      trialRows.push({ sample: sample.id, trial, ...a });

      console.log(`[run] B ${sample.id} trial ${trial}/${TRIALS}`);
      const b = await runMethodB({ wavPath: sample.path, truth: sample.text, env });
      grouped.B.push(b);
      trialRows.push({ sample: sample.id, trial, ...b });

      console.log(`[run] C ${sample.id} trial ${trial}/${TRIALS}`);
      const c = await runApple(sample.path, sample.text, sample.duration_ms, appleState);
      grouped.C.push(c);
      trialRows.push({ sample: sample.id, trial, ...c });
    }
    for (const method of ["A", "B", "C"]) {
      cells[`${sample.id}:${method}`] = summarize(grouped[method]);
    }
  }

  const caveats = [];
  caveats.push(
    `Network: StepFun HTTP ${hostnameOf(STEPFUN_ASR_URL)}; StepFun WS ${hostnameOf(STEPFUN_ASR_STREAM_URL.replace(/^wss/, "https"))}; MiniMax TTS ${truth.tts?.url_host || "unknown"}. Failures after 1+2 retries are recorded as rows, not retried further.`
  );
  const aOk = trialRows.filter((t) => t.method === "A" && t.ok);
  if (aOk.length) {
    caveats.push(
      `Method A upstream streams SSE deltas (${aOk.filter((t) => t.upstream_streams_deltas).length}/${aOk.length} successful trials). The product proxy currently buffers the full SSE before returning text.`
    );
  }
  caveats.push(
    "Method B uses the dedicated realtime ASR socket `wss://api.stepfun.com/v1/realtime/asr/stream` (model stepaudio-2.5-asr-stream). Client VAD is off; key-up is `input_audio_buffer.commit`. If that socket returns 402, the conversation realtime API is probed as a workaround."
  );
  const b402 = trialRows.find((t) => t.method === "B" && t.error?.status === 402);
  if (b402) {
    caveats.push(
      `This StepFun key is on Token Plan HTTP ASR (method A works) but WebSocket realtime returned HTTP 402. Conversation realtime (${b402.workaround_endpoint || "wss://api.stepfun.com/v1/realtime"}) also ${b402.conversation_realtime_status ?? "402"}. Method B did not stream audio.`
    );
  }
  if (appleState.compileError) {
    caveats.push(`Apple binary did not compile: ${appleState.compileError.message}`);
  } else if (appleState.permissionDenied) {
    caveats.push(
      `Apple Speech status is ${appleState.probe?.auth_status || "unknown"} (supportsOnDeviceRecognition=${appleState.probe?.supports_on_device}). This CLI skips requestAuthorization because that TCC-crashes when Cursor is the responsible process. Recorded as permission not granted. Run the binary from Terminal.app to grant Speech Recognition if you want C numbers.`
    );
  } else if (appleState.probe?.supports_on_device === false) {
    caveats.push("SFSpeechRecognizer(zh-CN) reports supportsOnDeviceRecognition=false on this Mac.");
  } else {
    caveats.push("Apple path used SFSpeechRecognizer(locale: zh-CN) with requiresOnDeviceRecognition=true and 100 ms PCM buffer pacing.");
  }
  caveats.push("CER strips Unicode punctuation/symbols/whitespace then lowercases; English product names are compared as letters.");
  caveats.push("TTS durations are whatever MiniMax produced at speed=1; they are close to the 2/4/8/12/15 s targets but not exact.");

  const rec = recommendation(cells, truth.samples);
  const createdAt = new Date().toISOString();
  const payload = {
    experiment: "exp2-stt",
    date: DATE_STAMP,
    created_at: createdAt,
    target: {
      text_while_speaking: true,
      final_after_end_ms: FINAL_TARGET_MS,
    },
    env: {
      ttsHost: truth.tts?.url_host,
      ttsModel: truth.tts?.model,
      asrHost: hostnameOf(STEPFUN_ASR_URL),
      asrModel: env.STEPFUN_ASR_MODEL || "stepaudio-2.5-asr",
      streamHost: hostnameOf(STEPFUN_ASR_STREAM_URL.replace(/^wss/, "https")),
      streamModel: "stepaudio-2.5-asr-stream",
      stepfunKeyLength: stepMeta.length,
      minimaxKeyLength: miniMeta.length,
    },
    samples: truth.samples.map((s) => ({
      id: s.id,
      duration_ms: s.duration_ms,
      text: s.text,
      path: s.path,
    })),
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
      text: t.text || "",
      upstream_streams_deltas: t.upstream_streams_deltas ?? null,
      workaround: t.workaround ?? false,
      conversation_realtime_status: t.conversation_realtime_status ?? null,
      error: t.error || null,
    })),
    caveats,
    recommendation: rec,
  };

  const jsonPath = join(RESULTS_DIR, `${DATE_STAMP}-exp2-stt.json`);
  const mdPath = join(RESULTS_DIR, `${DATE_STAMP}-exp2-stt.md`);
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + "\n");
  writeFileSync(
    mdPath,
    renderMarkdown({
      createdAt,
      samples: truth.samples,
      cells,
      trials: payload.trials,
      caveats,
      rec,
      envMeta: payload.env,
    })
  );
  console.log(`[run] wrote ${jsonPath}`);
  console.log(`[run] wrote ${mdPath}`);
}

main().catch((err) => {
  console.error(`[run] fatal: ${sanitizeError(err).message}`);
  process.exit(1);
});
