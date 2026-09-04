#!/usr/bin/env node
/**
 * Offline MiniMax-M3 first-token compare: current visual prompt vs text-only.
 * Reads apps/clicky/worker/.dev.vars. Never prints secrets or prompt text.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEV_VARS = join(ROOT, "apps/clicky/worker/.dev.vars");
const MINIMAX_BASE = "https://api.minimaxi.com/v1";
const N = 5;
const GAP_MS = 400;
const TIMEOUT_MS = 20_000;

function loadDevVars(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function percentile(values, p) {
  const xs = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const i = (p / 100) * (xs.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return Math.round(xs[lo]);
  return Math.round(xs[lo] + (xs[hi] - xs[lo]) * (i - lo));
}

function makeJpeg1280x800() {
  const pgm = join(tmpdir(), "yishu-probe-screen.pgm");
  const jpg = join(tmpdir(), "yishu-probe-screen.jpg");
  const header = Buffer.from("P5\n1280 800\n255\n");
  const pixels = Buffer.alloc(1280 * 800);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 13 + (i >> 7)) & 255;
  writeFileSync(pgm, Buffer.concat([header, pixels]));
  execFileSync("sips", ["-s", "format", "jpeg", pgm, "--out", jpg], { stdio: "pipe" });
  return readFileSync(jpg);
}

function extractDelta(obj) {
  const choice = Array.isArray(obj?.choices) ? obj.choices[0] : null;
  const delta = choice?.delta || choice?.message || {};
  return {
    content: typeof delta.content === "string" ? delta.content : "",
    reasoning: typeof delta.reasoning_content === "string" ? delta.reasoning_content : "",
    finish: choice?.finish_reason ?? null,
  };
}

async function timedChat({ apiKey, system, user, images }) {
  const t0 = performance.now();
  const userContent = images.length === 0
    ? user
    : [
      { type: "text", text: user },
      ...images.map((image) => ({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${image.toString("base64")}` },
      })),
    ];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${MINIMAX_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "MiniMax-M3",
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
        stream: true,
        max_tokens: 256,
        reasoning_split: true,
      }),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const code = err?.name === "AbortError" ? "timeout" : err?.cause?.code || err?.name || "fetch-failed";
    return { ok: false, firstMs: null, note: code };
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    return { ok: false, firstMs: null, firstSseMs: null, reasoningMs: null, note: `http_${res.status}` };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let firstMs = null;
  let firstSseMs = null;
  let reasoningMs = null;
  let finish = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstSseMs === null) firstSseMs = Math.round(performance.now() - t0);
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const line of parts) {
        const data = line.startsWith("data:") ? line.slice(5).trim() : "";
        if (!data || data === "[DONE]") continue;
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = extractDelta(parsed);
        if (delta.finish) finish = delta.finish;
        if (delta.reasoning.length > 0 && reasoningMs === null) {
          reasoningMs = Math.round(performance.now() - t0);
        }
        if (delta.content.length > 0 && firstMs === null) {
          firstMs = Math.round(performance.now() - t0);
          try {
            await reader.cancel();
          } catch {
            // ignore
          }
          return { ok: true, firstMs, firstSseMs, reasoningMs, note: null };
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return {
    ok: firstMs !== null,
    firstMs,
    firstSseMs,
    reasoningMs,
    note: firstMs === null ? `no_content:${finish ?? "end"}` : null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const { buildGroundedPrompt, localClockLine } = await import("../src/context-prompt.ts");
const { YISHU_SYSTEM_PROMPT } = await import("../src/persona.ts");
const { makeTurnStartCommand } = await import("../test/fixtures.ts");

const command = makeTurnStartCommand();
command.payload.utterance = "在吗";
const textOnlyPrompt = buildGroundedPrompt(command);
const frame = command.payload.contextFrame;
const visualPrompt = [
  "The user is speaking while sharing the following fresh computer context.",
  "Treat observations as evidence with confidence and timestamps, not as infallible facts.",
  localClockLine(),
  "",
  "<context_frame>",
  JSON.stringify({
    ...frame,
    screenshots: frame.screenshots.map(({ base64Data: _b, ...meta }) => meta),
  }, null, 2),
  "</context_frame>",
  "",
  "<user_utterance>",
  "在吗",
  "</user_utterance>",
].join("\n");

const jpeg = makeJpeg1280x800();
const vars = loadDevVars(DEV_VARS);
const apiKey = vars.MINIMAX_API_KEY;
if (!apiKey) {
  console.log(JSON.stringify({ ok: false, note: "missing_minimax_key" }));
  process.exit(1);
}

async function runSuite(label, user, images) {
  const samples = [];
  for (let i = 0; i < N; i += 1) {
    const result = await timedChat({
      apiKey,
      system: YISHU_SYSTEM_PROMPT,
      user,
      images,
    });
    samples.push(result);
    await sleep(GAP_MS);
  }
  const ok = samples.filter((s) => s.ok && s.firstMs !== null).map((s) => s.firstMs);
  const sse = samples.map((s) => s.firstSseMs).filter((n) => Number.isFinite(n));
  const reasoning = samples.map((s) => s.reasoningMs).filter((n) => Number.isFinite(n));
  return {
    label,
    n: N,
    ok: ok.length,
    first_ms: ok,
    first_sse_ms: sse,
    reasoning_ms: reasoning,
    p50: percentile(ok, 50),
    p90: percentile(ok, 90),
    sse_p50: percentile(sse, 50),
    reasoning_p50: percentile(reasoning, 50),
    notes: samples.map((s) => s.note).filter(Boolean),
    promptChars: user.length,
    imageCount: images.length,
    imageBytes: images.reduce((sum, buf) => sum + buf.length, 0),
  };
}

const withImages = await runSuite("current_images", visualPrompt, [jpeg]);
const textOnly = await runSuite("text_only", textOnlyPrompt, []);
console.log(JSON.stringify({
  withImages: {
    p50: withImages.p50,
    p90: withImages.p90,
    first_ms: withImages.first_ms,
    sse_p50: withImages.sse_p50,
    reasoning_p50: withImages.reasoning_p50,
    first_sse_ms: withImages.first_sse_ms,
    reasoning_ms: withImages.reasoning_ms,
    ok: withImages.ok,
    promptChars: withImages.promptChars,
    imageCount: withImages.imageCount,
    imageBytes: withImages.imageBytes,
    notes: withImages.notes,
  },
  textOnly: {
    p50: textOnly.p50,
    p90: textOnly.p90,
    first_ms: textOnly.first_ms,
    sse_p50: textOnly.sse_p50,
    reasoning_p50: textOnly.reasoning_p50,
    ok: textOnly.ok,
    promptChars: textOnly.promptChars,
    imageCount: 0,
    imageBytes: 0,
    notes: textOnly.notes,
  },
}, null, 2));
