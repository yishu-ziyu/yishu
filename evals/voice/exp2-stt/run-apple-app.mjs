#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  SCRIPT_DIR,
  WORK_DIR,
  RESULTS_DIR,
  cer,
  median,
  roundMs,
  sanitizeError,
  sleep,
} from "./lib.mjs";

const APP_DIR = join(WORK_DIR, "AppleSTTProbe.app");
const EXE = join(APP_DIR, "Contents", "MacOS", "AppleSTTProbe");
const PLIST_SRC = join(SCRIPT_DIR, "AppleSTTProbe.Info.plist");
const SWIFT_SRC = join(SCRIPT_DIR, "apple-stt.swift");
const TRUTH_PATH = join(WORK_DIR, "truth.json");
const OUT_DIR = join(WORK_DIR, "apple-results");
const DATE_STAMP = "2026-09-04";
const TRIALS = 3;
const MODES = [
  { id: "C-ondevice", onDevice: true, label: "on-device" },
  { id: "C-server", onDevice: false, label: "server-assisted" },
];

function run(cmd, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => stdout.push(d));
    child.stderr.on("data", (d) => stderr.push(d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function packApp() {
  mkdirSync(join(APP_DIR, "Contents", "MacOS"), { recursive: true });
  copyFileSync(PLIST_SRC, join(APP_DIR, "Contents", "Info.plist"));
  return new Promise((resolve) => {
    const child = spawn("swiftc", ["-O", "-o", EXE, SWIFT_SRC], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr = [];
    child.stderr.on("data", (d) => stderr.push(d));
    child.on("error", (err) => resolve({ ok: false, error: sanitizeError(err) }));
    child.on("close", async (code) => {
      if (code !== 0 || !existsSync(EXE)) {
        resolve({
          ok: false,
          error: {
            message: Buffer.concat(stderr).toString("utf8").slice(0, 240) || "swiftc failed",
          },
        });
        return;
      }
      chmodSync(EXE, 0o755);
      const sign = await run("codesign", ["--force", "--sign", "-", "--deep", APP_DIR]);
      if (sign.code !== 0) {
        resolve({ ok: false, error: { message: sign.stderr.slice(0, 240) || "codesign failed" } });
        return;
      }
      resolve({ ok: true });
    });
  });
}

async function waitForFile(path, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf8").trim();
        if (raw.startsWith("{")) return JSON.parse(raw);
      } catch {
        // incomplete write
      }
    }
    await sleep(250);
  }
  return null;
}

async function launchProbe(args, outPath, timeoutMs) {
  if (existsSync(outPath)) unlinkSync(outPath);
  const started = `${outPath}.started`;
  if (existsSync(started)) unlinkSync(started);

  const openArgs = ["-W", "-n", APP_DIR, "--args", ...args];
  const child = spawn("open", openArgs, { stdio: ["ignore", "pipe", "pipe"] });
  const openDone = new Promise((resolve) => child.on("close", resolve));

  const parsed = await waitForFile(outPath, timeoutMs);
  if (parsed) {
    await Promise.race([openDone, sleep(3000)]);
    return parsed;
  }

  const direct = await run(EXE, args, { timeoutMs: Math.min(timeoutMs, 30_000) });
  if (existsSync(outPath)) {
    try {
      return JSON.parse(readFileSync(outPath, "utf8"));
    } catch {
      // fall through
    }
  }
  if (direct.stdout.trim().startsWith("{")) {
    try {
      return JSON.parse(direct.stdout);
    } catch {
      // fall through
    }
  }
  return {
    ok: false,
    error: "permission not granted",
    auth_status: "unknown",
    note: existsSync(started) ? "app started, no result file" : "app did not start",
    open_code: child.exitCode,
    direct_code: direct.code,
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
    text: ok[0]?.text || "",
    error: ok.length ? undefined : trials[0]?.error,
  };
}

function yishuSpeechKeyPresent() {
  const plist = readFileSync(
    join(SCRIPT_DIR, "..", "..", "..", "apps", "clicky", "leanring-buddy", "Info.plist"),
    "utf8"
  );
  return {
    NSSpeechRecognitionUsageDescription: plist.includes("NSSpeechRecognitionUsageDescription"),
    NSMicrophoneUsageDescription: plist.includes("NSMicrophoneUsageDescription"),
  };
}

function recommendation(cells, samples) {
  const onDev = samples.map((s) => cells[`${s.id}:C-ondevice`]);
  const server = samples.map((s) => cells[`${s.id}:C-server`]);
  const onOk = onDev.every((c) => c.n_ok);
  const svOk = server.every((c) => c.n_ok);
  const onPartial = samples.every((s) => {
    const c = cells[`${s.id}:C-ondevice`];
    return c?.n_ok && c.first_partial_ms != null && c.first_partial_ms < s.duration_ms;
  });
  const svPartial = samples.every((s) => {
    const c = cells[`${s.id}:C-server`];
    return c?.n_ok && c.first_partial_ms != null && c.first_partial_ms < s.duration_ms;
  });
  const onFinal = median(onDev.map((c) => c.final_after_end_ms));
  const svFinal = median(server.map((c) => c.final_after_end_ms));
  const onCer = median(onDev.map((c) => c.cer));
  const svCer = median(server.map((c) => c.cer));
  const onMeets = onOk && onPartial && onFinal != null && onFinal <= 300;
  const svMeets = svOk && svPartial && svFinal != null && svFinal <= 300;
  const yishu = yishuSpeechKeyPresent();

  const bits = [];
  if (onMeets) {
    bits.push(
      `Apple on-device (C-ondevice) meets both bars: partials while speaking, median final ${fmtMs(onFinal)} ms after end, median CER ${fmtCer(onCer)}. Use it as the primary live-text path.`
    );
  } else if (onOk) {
    bits.push(
      `Apple on-device ran: partials ${onPartial ? "during" : "not during"} speech, median final ${fmtMs(onFinal)} ms, CER ${fmtCer(onCer)}. ${onFinal != null && onFinal <= 300 ? "Final ≤300 ms." : "Final missed ≤300 ms."}`
    );
  } else {
    bits.push("Apple on-device still did not complete (see caveats).");
  }
  if (svMeets) {
    bits.push(
      `Server-assisted Apple also meets both bars (final ${fmtMs(svFinal)} ms, CER ${fmtCer(svCer)}).`
    );
  } else if (svOk) {
    bits.push(
      `Server-assisted: partials ${svPartial ? "during" : "not during"} speech, median final ${fmtMs(svFinal)} ms, CER ${fmtCer(svCer)}.`
    );
  }
  bits.push(
    "Keep StepFun HTTP SSE as the accuracy fallback after key-up when Apple CER is high or on-device assets are missing."
  );
  bits.push(
    yishu.NSSpeechRecognitionUsageDescription
      ? "奕枢.app Info.plist already has NSSpeechRecognitionUsageDescription."
      : "奕枢.app Info.plist has NSMicrophoneUsageDescription but not NSSpeechRecognitionUsageDescription — add it before shipping Apple Speech in the product."
  );
  return bits.join(" ");
}

function renderRetryMarkdown({ samples, cells, trials, rec, yishu, probe }) {
  const lines = [];
  lines.push("");
  lines.push("## C (retry, .app bundle)");
  lines.push("");
  lines.push(
    `Launched \`AppleSTTProbe.app\` (\`com.yishu.evals.applestt\`) via \`open -W\`. Probe auth=${probe?.auth_status || "unknown"} supports_on_device=${probe?.supports_on_device}.`
  );
  lines.push(
    `奕枢.app Info.plist: NSSpeechRecognitionUsageDescription=${yishu.NSSpeechRecognitionUsageDescription}, NSMicrophoneUsageDescription=${yishu.NSMicrophoneUsageDescription}.`
  );
  lines.push("");
  lines.push("| sample | mode | first_partial_ms | final_after_end_ms | CER | n_ok |");
  lines.push("|---|---|---|---|---|---|");
  for (const s of samples) {
    for (const mode of MODES) {
      const cell = cells[`${s.id}:${mode.id}`];
      lines.push(
        `| ${s.id} | ${mode.label} | ${fmtMs(cell.first_partial_ms)} | ${fmtMs(cell.final_after_end_ms)} | ${fmtCer(cell.cer)} | ${cell.n_ok}/${cell.n} |`
      );
    }
  }
  lines.push("");
  lines.push("### Recommendation (updated)");
  lines.push("");
  lines.push(rec);
  lines.push("");
  lines.push("| sample | mode | trial | ok | first_partial_ms | final_after_end_ms | CER | error |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const t of trials) {
    const err = (t.error || "").toString().replace(/\|/g, "/");
    lines.push(
      `| ${t.sample} | ${t.mode} | ${t.trial} | ${t.ok} | ${fmtMs(t.first_partial_ms)} | ${fmtMs(t.final_after_end_ms)} | ${fmtCer(t.cer)} | ${err} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  if (!existsSync(TRUTH_PATH)) {
    console.error("missing truth.json — run synth.mjs first");
    process.exit(1);
  }
  const truth = JSON.parse(readFileSync(TRUTH_PATH, "utf8"));
  mkdirSync(OUT_DIR, { recursive: true });

  const packed = await packApp();
  if (!packed.ok) {
    console.error(`[apple-app] pack failed: ${packed.error?.message}`);
    process.exit(1);
  }
  console.log(`[apple-app] packed ${APP_DIR}`);

  const probeOut = join(OUT_DIR, "probe.json");
  console.log("[apple-app] launching probe — click Allow on the Speech Recognition dialog if it appears");
  const probe = await launchProbe(["--probe", "--out", probeOut], probeOut, 120_000);
  writeFileSync(probeOut, JSON.stringify(probe, null, 2) + "\n");
  console.log(
    `[apple-app] probe ok=${probe.ok} auth=${probe.auth_status} supports_on_device=${probe.supports_on_device}`
  );

  const trialRows = [];
  const cells = {};
  for (const mode of MODES) {
    for (const sample of truth.samples) {
      const grouped = [];
      for (let trial = 1; trial <= TRIALS; trial++) {
        const outPath = join(OUT_DIR, `${mode.id}-${sample.id}-t${trial}.json`);
        const timeoutMs = Math.max(120_000, (sample.duration_ms || 0) + 40_000);
        console.log(`[apple-app] ${mode.id} ${sample.id} trial ${trial}/${TRIALS}`);
        const raw = await launchProbe(
          [
            "--wav",
            sample.path,
            "--on-device",
            mode.onDevice ? "true" : "false",
            "--sample",
            sample.id,
            "--trial",
            String(trial),
            "--out",
            outPath,
          ],
          outPath,
          timeoutMs
        );
        const text = raw.text || "";
        const errMsg = typeof raw.error === "string" ? raw.error : raw.error?.message;
        const row = {
          sample: sample.id,
          mode: mode.label,
          method: mode.id,
          trial,
          ok: Boolean(raw.ok && text),
          text,
          cer: text ? cer(text, sample.text) : null,
          first_partial_ms: roundMs(raw.first_partial_ms),
          final_after_end_ms: roundMs(raw.final_after_end_ms),
          auth_status: raw.auth_status,
          supports_on_device: raw.supports_on_device,
          error: raw.ok ? undefined : errMsg || "apple-stt failed",
        };
        grouped.push(row);
        trialRows.push(row);
        writeFileSync(outPath, JSON.stringify({ ...raw, cer: row.cer }, null, 2) + "\n");
      }
      cells[`${sample.id}:${mode.id}`] = summarize(grouped);
    }
  }

  const yishu = yishuSpeechKeyPresent();
  const rec = recommendation(cells, truth.samples);
  const retry = {
    at: new Date().toISOString(),
    bundle: APP_DIR,
    bundle_id: "com.yishu.evals.applestt",
    probe,
    yishu_info_plist: yishu,
    cells,
    trials: trialRows,
    recommendation: rec,
  };

  const jsonPath = join(RESULTS_DIR, `${DATE_STAMP}-exp2-stt.json`);
  const mdPath = join(RESULTS_DIR, `${DATE_STAMP}-exp2-stt.md`);
  const payload = JSON.parse(readFileSync(jsonPath, "utf8"));
  payload.apple_retry = retry;
  payload.recommendation = rec;
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + "\n");

  let md = readFileSync(mdPath, "utf8");
  md = md.replace(
    /## Recommendation\n\n[\s\S]*?\n\n## Trial log/,
    `## Recommendation\n\n${rec}\n\n## Trial log`
  );
  if (!md.includes("## C (retry, .app bundle)")) {
    md += renderRetryMarkdown({
      samples: truth.samples,
      cells,
      trials: trialRows,
      rec,
      yishu,
      probe,
    });
  }
  writeFileSync(mdPath, md.endsWith("\n") ? md : md + "\n");
  console.log(`[apple-app] appended ${jsonPath}`);
  console.log(`[apple-app] appended ${mdPath}`);
}

main().catch((err) => {
  console.error(`[apple-app] fatal: ${sanitizeError(err).message}`);
  process.exit(1);
});
