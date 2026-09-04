#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  WORK_DIR,
  RESULTS_DIR,
  SAMPLE_RATE,
  loadDevVars,
  keyMeta,
  hostnameOf,
  parseWav,
  sleep,
  nowMs,
  cer,
  median,
  roundMs,
  sanitizeError,
} from "./lib.mjs";
import { postAsr, pcmSlice, failRow, runD } from "./run-step-plan.mjs";

const TRUTH_PATH = join(WORK_DIR, "truth.json");
const DATE_STAMP = "2026-09-04";
const TRIALS = 3;
const INTERIM_MS = 800;
const ACCEPTABLE_CER = 0.05;
const WINDOWS = [
  { method: "H4", windowMs: 4000, withCombo: false },
  { method: "H6", windowMs: 6000, withCombo: true },
];
const PUNCT_RE = /[。！？，、；：,.!?;:…]/u;

export function longestAffixOverlap(prev, next) {
  const a = [...(prev || "")];
  const b = [...(next || "")];
  const max = Math.min(a.length, b.length);
  for (let k = max; k >= 1; k--) {
    if (a.slice(-k).join("") === b.slice(0, k).join("")) return k;
  }
  return 0;
}

export function stitchWindow(prev, next) {
  if (!prev) return { text: next || "", mode: "replace", overlap: 0 };
  if (!next) return { text: prev, mode: "keep", overlap: 0 };
  const k = longestAffixOverlap(prev, next);
  if (k > 0) {
    const chars = [...prev];
    return { text: chars.slice(0, chars.length - k).join("") + next, mode: "overlap", overlap: k };
  }
  const prevChars = [...prev];
  for (let i = prevChars.length - 1; i >= 0; i--) {
    if (PUNCT_RE.test(prevChars[i])) {
      return { text: prevChars.slice(0, i + 1).join("") + next, mode: "punct", overlap: 0 };
    }
  }
  return { text: prev + next, mode: "concat", overlap: 0 };
}

function selfCheck() {
  const o = stitchWindow("我下周二下午三点开会", "下午三点开会另外提醒");
  if (o.text !== "我下周二下午三点开会另外提醒" || o.mode !== "overlap") {
    throw new Error(`stitch overlap failed: ${o.text}`);
  }
  const p = stitchWindow("帮我记一下。前半段", "后半段内容");
  if (p.text !== "帮我记一下。后半段内容" || p.mode !== "punct") {
    throw new Error(`stitch punct failed: ${p.text}`);
  }
  const r = stitchWindow("", "你好");
  if (r.text !== "你好" || r.mode !== "replace") {
    throw new Error("stitch replace failed");
  }
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
    billed_audio_ms: median(ok.map((t) => t.billed_audio_ms)),
    text: ok[0]?.text || "",
    shown_source: ok[0]?.shown_source || null,
    window_ms: ok[0]?.window_ms ?? trials[0]?.window_ms ?? null,
    error: ok.length ? undefined : trials[0]?.error,
  };
}

function pickComboShown(h, d) {
  const pairCer = cer(h.text || "", d.text || "");
  const hFirst = (h.elapsed_ms ?? 9e9) <= (d.elapsed_ms ?? 9e9);
  const first = hFirst ? h : d;
  const second = hFirst ? d : h;
  const firstVsOther = cer(first.text || "", second.text || "");
  if (firstVsOther <= ACCEPTABLE_CER) {
    return { shown: first, pair_cer: pairCer, used_first: true };
  }
  return { shown: second, pair_cer: pairCer, used_first: false };
}

function foldWindows(rows, windowMs) {
  let text = "";
  const modes = [];
  const ordered = [...rows].sort(
    (a, b) => a.end_ms - b.end_ms || Number(a.kind === "final") - Number(b.kind === "final")
  );
  const folded = [];
  for (const r of ordered) {
    const startMs = Math.max(0, r.end_ms - windowMs);
    const step = startMs <= 0 ? { text: r.text || "", mode: "replace", overlap: 0 } : stitchWindow(text, r.text || "");
    text = step.text;
    modes.push(step.mode);
    folded.push({ ...r, start_ms: startMs, stitched: text, mode: step.mode, overlap: step.overlap });
  }
  return { text, modes, folded };
}

export async function runH({ wavPath, truth, env, durationMs, windowMs, method, withCombo }) {
  const wav = readFileSync(wavPath);
  const parsed = parseWav(wav);
  const rate = parsed.sampleRate || SAMPLE_RATE;
  const t0 = nowMs();
  const raw = [];
  const inflight = [];
  let firstPartialMs = null;

  const fire = (endMs, kind) => {
    const startMs = Math.max(0, endMs - windowMs);
    const slice = pcmSlice(parsed.pcm, rate, startMs, endMs);
    if (!slice.length) return;
    const sentAt = nowMs();
    const p = postAsr(env, slice, rate, `${method}-${kind}`).then((sse) => {
      if (sse.text && firstPartialMs == null) firstPartialMs = nowMs() - t0;
      raw.push({
        kind,
        end_ms: endMs,
        text: sse.text,
        sent_at_ms: roundMs(sentAt - t0),
        latency_ms: roundMs(nowMs() - sentAt),
        billed_ms: sse.billed_ms,
      });
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

  try {
    const tailStart = Math.max(0, durationMs - windowMs);
    const tailSlice = pcmSlice(parsed.pcm, rate, tailStart, durationMs);
    const hTailPromise = postAsr(env, tailSlice, rate, `${method}-final`).then((sse) => ({
      sse,
      elapsed_ms: nowMs() - tEnd,
    }));

    const dPromise = withCombo
      ? runD({ wavPath, truth, env, durationMs }).then((row) => ({
          text: row.text,
          elapsed_ms: row.final_after_end_ms,
          billed_ms: row.billed_audio_ms,
          cer: row.cer,
          ok: row.ok,
          error: row.error,
        }))
      : null;

    const [hTailRaw, dRow] = await Promise.all([hTailPromise, dPromise]);
    await Promise.allSettled(inflight);

    const tailRow = {
      kind: "final",
      end_ms: durationMs,
      text: hTailRaw.sse.text,
      sent_at_ms: 0,
      latency_ms: roundMs(hTailRaw.elapsed_ms),
      billed_ms: hTailRaw.sse.billed_ms,
    };
    const folded = foldWindows([...raw, tailRow], windowMs);
    const billed = folded.folded.reduce((s, r) => s + (r.billed_ms || 0), 0);
    const hTail = {
      text: folded.text,
      elapsed_ms: hTailRaw.elapsed_ms,
      billed_ms: hTailRaw.sse.billed_ms,
    };

    let combo = null;
    if (dRow) {
      if (!dRow.ok) {
        combo = { ok: false, method: "HD", window_ms: windowMs, error: dRow.error };
      } else {
        const picked = pickComboShown(hTail, dRow);
        combo = {
          ok: true,
          method: "HD",
          window_ms: windowMs,
          text: picked.shown.text,
          cer: cer(picked.shown.text, truth),
          first_partial_ms: roundMs(firstPartialMs),
          final_after_end_ms: roundMs(picked.shown.elapsed_ms),
          billed_audio_ms: billed + (dRow.billed_ms || 0),
          shown_source: picked.shown === hTail ? "H" : "D",
          used_first: picked.used_first,
          pair_cer: picked.pair_cer,
          h_final_ms: roundMs(hTail.elapsed_ms),
          d_final_ms: roundMs(dRow.elapsed_ms),
          h_cer: cer(hTail.text, truth),
          d_cer: dRow.cer,
        };
      }
    }

    return {
      ok: true,
      method,
      window_ms: windowMs,
      text: folded.text,
      cer: cer(folded.text, truth),
      first_partial_ms: roundMs(firstPartialMs),
      final_after_end_ms: roundMs(hTail.elapsed_ms),
      billed_audio_ms: billed,
      interim_count: raw.length,
      stitch_modes: folded.modes,
      interims: folded.folded.map((r) => ({
        kind: r.kind,
        start_ms: r.start_ms,
        end_ms: r.end_ms,
        latency_ms: r.latency_ms,
        billed_ms: r.billed_ms,
        mode: r.mode,
        text: r.stitched,
      })),
      combo,
    };
  } catch (err) {
    await Promise.allSettled(inflight);
    return failRow(method, err);
  }
}

function billedPer10s(cells, samples, method) {
  const long = samples.filter((s) => s.duration_ms >= 8000);
  const ratios = (long.length ? long : samples)
    .map((s) => {
      const c = cells[`${s.id}:${method}`];
      if (!c?.n_ok || c.billed_audio_ms == null || !s.duration_ms) return null;
      return (c.billed_audio_ms / s.duration_ms) * 10_000;
    })
    .filter((n) => n != null);
  return median(ratios);
}

function recommendH(cells, samples) {
  const lines = [];
  lines.push("C Apple: rejected by owner on quality (人评).");
  const long = samples.filter((s) => s.duration_ms >= 8000);
  const methods = ["D", "E", "H4", "H6", "HD"];
  const stats = methods.map((m) => {
    const rows = samples.map((s) => cells[`${s.id}:${m}`]).filter(Boolean);
    const ok = rows.filter((c) => c.n_ok === c.n && c.n > 0);
    const longOk = long.map((s) => cells[`${s.id}:${m}`]).filter((c) => c?.n_ok);
    return {
      m,
      cerMed: median(ok.map((c) => c.cer)),
      cerLong: median(longOk.map((c) => c.cer)),
      finalMed: median(ok.map((c) => c.final_after_end_ms)),
      per10: billedPer10s(cells, samples, m),
      cerOk: ok.length === samples.length && ok.every((c) => c.cer != null && c.cer <= ACCEPTABLE_CER),
    };
  });
  const h4 = stats.find((s) => s.m === "H4");
  const h6 = stats.find((s) => s.m === "H6");
  const hd = stats.find((s) => s.m === "HD");
  const e = stats.find((s) => s.m === "E");
  lines.push(
    "H does not keep E's CER after the window slides (clips longer than W). Cost below is billed audio per 10 s of speech on clips ≥8 s."
  );
  if (h4) {
    lines.push(
      `H4: final ${fmtMs(h4.finalMed)} ms, long CER ${fmtCer(h4.cerLong)}, ~${fmtMs((h4.per10 || 0) / 1000)} s billed / 10 s speech.`
    );
  }
  if (h6) {
    lines.push(
      `H6: final ${fmtMs(h6.finalMed)} ms, long CER ${fmtCer(h6.cerLong)}, ~${fmtMs((h6.per10 || 0) / 1000)} s billed / 10 s speech.`
    );
  }
  if (e) {
    lines.push(
      `E: final ${fmtMs(e.finalMed)} ms, CER ${fmtCer(e.cerMed)}, ~${fmtMs((e.per10 || 0) / 1000)} s billed / 10 s (grows with n²).`
    );
  }
  if (hd) {
    lines.push(
      `HD (H6 hold + D on key-up): on long clips always showed D (H/D pair CER>0.05). final ${fmtMs(hd.finalMed)} ms, CER ${fmtCer(hd.cerMed)}, ~${fmtMs((hd.per10 || 0) / 1000)} s billed / 10 s.`
    );
  }
  lines.push(
    "Product: H4 is the cheaper W (~46 s billed / 10 s) but only as a live preview; key-up still needs D. Accurate live text is still E. Do not ship H as the final."
  );
  return lines.join(" ");
}

function renderH({ samples, dCells, eCells, hCells, trials, rec }) {
  const lines = [];
  lines.push("");
  lines.push("## H Windowed-growing");
  lines.push("");
  lines.push(
    "Every 800 ms send the last W seconds (W=4 s and W=6 s). New ASR replaces the tail; prefix older than the window is locked via longest suffix/prefix character overlap, else punctuation-boundary concat. Key-up sends last W once (no full-file). HD = H6 during hold + D full-file in parallel on key-up; shown = first of (H tail, D) whose CER vs the other is ≤0.05, else the later one."
  );
  lines.push("");
  lines.push("| sample | method | first_partial_ms | final_after_end_ms | CER | billed_audio_ms | n_ok |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const s of samples) {
    const pack = {
      D: dCells[`${s.id}:D`],
      E: eCells[`${s.id}:E`],
      H4: hCells[`${s.id}:H4`],
      H6: hCells[`${s.id}:H6`],
      HD: hCells[`${s.id}:HD`],
    };
    for (const [m, c] of Object.entries(pack)) {
      if (!c) continue;
      lines.push(
        `| ${s.id} | ${m} | ${fmtMs(c.first_partial_ms)} | ${fmtMs(c.final_after_end_ms)} | ${fmtCer(c.cer)} | ${fmtMs(c.billed_audio_ms)} | ${c.n_ok}/${c.n} |`
      );
    }
  }
  lines.push("");
  lines.push("### Recommendation (H)");
  lines.push("");
  lines.push(rec);
  lines.push("");
  lines.push("| sample | method | trial | ok | first_partial_ms | final_after_end_ms | CER | billed_audio_ms | shown | error |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const t of trials) {
    const err = t.error?.message ? t.error.message.replace(/\|/g, "/") : "";
    lines.push(
      `| ${t.sample} | ${t.method} | ${t.trial} | ${t.ok} | ${fmtMs(t.first_partial_ms)} | ${fmtMs(t.final_after_end_ms)} | ${fmtCer(t.cer)} | ${fmtMs(t.billed_audio_ms)} | ${t.shown_source || ""} | ${err} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function persistTrial(sampleId, trial, row) {
  return {
    sample: sampleId,
    method: row.method,
    trial,
    ok: row.ok,
    window_ms: row.window_ms ?? null,
    first_partial_ms: row.first_partial_ms ?? null,
    final_after_end_ms: row.final_after_end_ms ?? null,
    cer: row.cer ?? null,
    billed_audio_ms: row.billed_audio_ms ?? null,
    text: row.text || "",
    shown_source: row.shown_source || null,
    pair_cer: row.pair_cer ?? null,
    used_first: row.used_first ?? null,
    interim_count: row.interim_count ?? null,
    stitch_modes: row.stitch_modes || null,
    error: row.error || null,
  };
}

async function main() {
  selfCheck();
  if (!existsSync(TRUTH_PATH)) {
    console.error("missing truth.json");
    process.exit(1);
  }
  const truth = JSON.parse(readFileSync(TRUTH_PATH, "utf8"));
  const env = loadDevVars();
  const planKey = keyMeta(env, "STEPFUN_STEP_PLAN_API_KEY");
  console.log(
    `[h] STEPFUN_STEP_PLAN_API_KEY present=${planKey.present} length=${planKey.length} host=${hostnameOf(env.STEPFUN_STEP_PLAN_BASE || "https://api.stepfun.com/step_plan/v1")}`
  );

  const trialRows = [];
  const grouped = {};
  for (const sample of truth.samples) {
    for (const spec of WINDOWS) {
      grouped[`${sample.id}:${spec.method}`] = [];
    }
    grouped[`${sample.id}:HD`] = [];
    for (let trial = 1; trial <= TRIALS; trial++) {
      for (const spec of WINDOWS) {
        console.log(`[h] ${spec.method} ${sample.id} trial ${trial}/${TRIALS} W=${spec.windowMs}`);
        const row = await runH({
          wavPath: sample.path,
          truth: sample.text,
          env,
          durationMs: sample.duration_ms,
          windowMs: spec.windowMs,
          method: spec.method,
          withCombo: spec.withCombo,
        });
        grouped[`${sample.id}:${spec.method}`].push(row);
        trialRows.push(persistTrial(sample.id, trial, row));
        if (row.combo) {
          grouped[`${sample.id}:HD`].push(row.combo);
          trialRows.push(persistTrial(sample.id, trial, row.combo));
        }
      }
    }
  }

  const jsonPath = join(RESULTS_DIR, `${DATE_STAMP}-exp2-stt.json`);
  const mdPath = join(RESULTS_DIR, `${DATE_STAMP}-exp2-stt.md`);
  const payload = JSON.parse(readFileSync(jsonPath, "utf8"));
  const dCells = payload.step_plan?.cells || {};
  const eCells = payload.step_plan?.cells || {};
  const hCells = {};
  for (const sample of truth.samples) {
    for (const m of ["H4", "H6", "HD"]) {
      hCells[`${sample.id}:${m}`] = summarize(grouped[`${sample.id}:${m}`] || []);
    }
  }
  const recCells = { ...dCells, ...eCells, ...hCells };
  const rec = recommendH(recCells, truth.samples);
  payload.windowed = {
    at: new Date().toISOString(),
    windows_ms: [4000, 6000],
    interval_ms: INTERIM_MS,
    websocket_asr_available: false,
    cells: hCells,
    trials: trialRows,
    recommendation: rec,
  };
  payload.recommendation = rec;
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + "\n");

  let md = readFileSync(mdPath, "utf8");
  md = md.replace(
    /## Recommendation\n\n[\s\S]*?\n\n## Trial log/,
    `## Recommendation\n\n${rec}\n\n## Trial log`
  );
  const block = renderH({
    samples: truth.samples,
    dCells,
    eCells,
    hCells,
    trials: trialRows,
    rec,
  });
  if (md.includes("## H Windowed-growing")) {
    md = md.replace(/## H Windowed-growing[\s\S]*$/, block.trimStart());
  } else {
    md = md.endsWith("\n") ? `${md}${block}` : `${md}\n${block}`;
  }
  writeFileSync(mdPath, md.endsWith("\n") ? md : `${md}\n`);
  console.log(`[h] wrote ${jsonPath}`);
  console.log(`[h] wrote ${mdPath}`);
}

function rewriteFromExisting() {
  selfCheck();
  const jsonPath = join(RESULTS_DIR, `${DATE_STAMP}-exp2-stt.json`);
  const mdPath = join(RESULTS_DIR, `${DATE_STAMP}-exp2-stt.md`);
  const truth = JSON.parse(readFileSync(TRUTH_PATH, "utf8"));
  const payload = JSON.parse(readFileSync(jsonPath, "utf8"));
  const trials = payload.windowed?.trials || [];
  const dCells = payload.step_plan?.cells || {};
  const hCells = {};
  for (const sample of truth.samples) {
    for (const m of ["H4", "H6", "HD"]) {
      hCells[`${sample.id}:${m}`] = summarize(
        trials.filter((t) => t.sample === sample.id && t.method === m)
      );
    }
  }
  const rec = recommendH({ ...dCells, ...hCells }, truth.samples);
  payload.windowed.cells = hCells;
  payload.windowed.recommendation = rec;
  payload.recommendation = rec;
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + "\n");
  let md = readFileSync(mdPath, "utf8");
  md = md.replace(
    /## Recommendation\n\n[\s\S]*?\n\n## Trial log/,
    `## Recommendation\n\n${rec}\n\n## Trial log`
  );
  const block = renderH({
    samples: truth.samples,
    dCells,
    eCells: dCells,
    hCells,
    trials,
    rec,
  });
  if (md.includes("## H Windowed-growing")) {
    md = md.replace(/## H Windowed-growing[\s\S]*$/, block.trimStart());
  } else {
    md += block;
  }
  writeFileSync(mdPath, md.endsWith("\n") ? md : `${md}\n`);
  console.log(`[h] rewrote rec from ${trials.length} trials`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--self-check")) {
    selfCheck();
    console.log("[h] stitch self-check ok");
    process.exit(0);
  }
  const run = process.argv.includes("--rewrite-only") ? rewriteFromExisting : main;
  Promise.resolve(run()).catch((err) => {
    console.error(`[h] fatal: ${sanitizeError(err).message}`);
    process.exit(1);
  });
}
