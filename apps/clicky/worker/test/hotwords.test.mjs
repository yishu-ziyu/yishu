import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const worker = await import("../src/index.ts");
const {
  audioSecondsFromBase64Length,
  buildStepFunTranscriptionBody,
  formatAsrTimingLog,
  redactedUpstreamErrorPayload,
  sanitizeStepFunHotwords,
} = worker;

test("upstream error metadata never echoes response content", () => {
  const secretMarker = "synthetic-secret-marker";
  const payload = redactedUpstreamErrorPayload(502, secretMarker);

  assert.deepEqual(payload, {
    error: "upstream_error",
    status: 502,
    body_bytes: new TextEncoder().encode(secretMarker).byteLength,
  });
  assert.equal(JSON.stringify(payload).includes(secretMarker), false);
});

test("missing hotwords keep the legacy request shape", () => {
  assert.deepEqual(sanitizeStepFunHotwords(undefined), { ok: true });

  const body = buildStepFunTranscriptionBody({
    audioBase64: "cpcm",
    format: "wav",
    sampleRate: 16_000,
    language: "zh",
    model: "stepaudio-2.5-asr",
  });

  assert.equal(body.audio.input.transcription.hotwords, undefined);
});

test("hotwords are trimmed and case-insensitively deduplicated", () => {
  const validation = sanitizeStepFunHotwords([" Yishu ", "yishu", "奕枢"]);
  assert.deepEqual(validation, { ok: true, hotwords: ["Yishu", "奕枢"] });

  const body = buildStepFunTranscriptionBody({
    audioBase64: "cpcm",
    format: "wav",
    sampleRate: 16_000,
    language: "zh",
    model: "stepaudio-2.5-asr",
    hotwords: validation.hotwords,
  });

  assert.deepEqual(body.audio.input.transcription.hotwords, ["Yishu", "奕枢"]);
});

test("malformed hotwords are rejected without echoing their values", () => {
  assert.equal(sanitizeStepFunHotwords("Yishu").ok, false);
  assert.equal(sanitizeStepFunHotwords(["Yishu", 42]).ok, false);
  assert.equal(sanitizeStepFunHotwords(["   "]).ok, false);
  assert.equal(sanitizeStepFunHotwords(["x".repeat(65)]).ok, false);
  assert.equal(sanitizeStepFunHotwords(Array.from({ length: 51 }, () => "x")).ok, false);
});

test("transcribe route forwards sanitized hotwords without calling the network", async () => {
  const originalFetch = globalThis.fetch;
  let forwardedBody;
  let forwardedUrl;
  globalThis.fetch = async (input, init) => {
    forwardedUrl = String(input);
    forwardedBody = JSON.parse(init.body);
    return new Response("data: {\"type\":\"transcript.text.done\",\"text\":\"ok\"}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  try {
    const response = await worker.default.fetch(
      new Request("http://127.0.0.1/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          audio_base64: "cpcm",
          hotwords: [" Yishu ", "yishu", "奕枢"],
        }),
      }),
      { STEPFUN_API_KEY: "synthetic-test-key" }
    );

    assert.equal(response.status, 200);
    assert.match(forwardedUrl, /\/step_plan\/v1\/audio\/asr\/sse$/);
    assert.equal(forwardedBody.audio.input.transcription.enable_itn, true);
    assert.equal(forwardedBody.audio.input.transcription.model, "stepaudio-2.5-asr");
    assert.deepEqual(
      forwardedBody.audio.input.transcription.hotwords,
      ["Yishu", "奕枢"]
    );
    assert.deepEqual(await response.json(), { text: "ok" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transcribe upstream failures redact body from response and logs", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const secretMarker = "synthetic-secret-marker";
  const logs = [];
  globalThis.fetch = async () =>
    new Response(secretMarker, {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  console.error = (...args) => logs.push(args.join(" "));

  try {
    const response = await worker.default.fetch(
      new Request("http://127.0.0.1/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audio_base64: "cpcm" }),
      }),
      { STEPFUN_API_KEY: "synthetic-test-key" }
    );

    const responseText = await response.text();
    assert.equal(response.status, 502);
    assert.equal(responseText.includes(secretMarker), false);
    assert.match(responseText, /upstream_error/);
    assert.equal(logs.join("\n").includes(secretMarker), false);
    assert.match(logs.join("\n"), /status=502/);
    assert.match(logs.join("\n"), /body_bytes=/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test("local-server entrypoint forwards the same request shape", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    HOST: process.env.HOST,
    PORT: process.env.PORT,
    STEPFUN_API_KEY: process.env.STEPFUN_API_KEY,
    YISHU_WORKER_ENV_FILE: process.env.YISHU_WORKER_ENV_FILE,
    YISHU_VOICE_PROXY_TOKEN: process.env.YISHU_VOICE_PROXY_TOKEN,
  };
  const token = "synthetic-loopback-capability-1234567890";
  const fixtureDirectory = mkdtempSync(join(tmpdir(), "yishu-proxy-test-"));
  const fixtureEnvironment = join(fixtureDirectory, ".dev.vars");
  writeFileSync(fixtureEnvironment, "STEPFUN_API_KEY=synthetic-test-key\n", {
    mode: 0o600,
  });
  let forwardedBody;
  globalThis.fetch = async (_input, init) => {
    forwardedBody = JSON.parse(init.body);
    return new Response(
      'data: {"type":"transcript.text.done","text":"ok"}\n\n',
      {
      status: 200,
        headers: { "content-type": "text/event-stream" },
      }
    );
  };

  process.env.HOST = "127.0.0.1";
  process.env.PORT = "0";
  process.env.STEPFUN_API_KEY = "ambient-key-must-not-be-used";
  process.env.YISHU_WORKER_ENV_FILE = fixtureEnvironment;
  process.env.YISHU_VOICE_PROXY_TOKEN = token;

  let server;
  try {
    ({ server } = await import(`../local-server.mjs?hotwords=${Date.now()}`));
    if (!server.listening) await once(server, "listening");

    const address = server.address();
    assert.equal(typeof address, "object");
    const unauthenticated = await originalFetch(
      `http://127.0.0.1:${address.port}/transcribe`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audio_base64: "cpcm" }),
      }
    );
    assert.equal(unauthenticated.status, 401);

    const browserOrigin = await originalFetch(
      `http://127.0.0.1:${address.port}/transcribe`,
      {
        method: "OPTIONS",
        headers: { origin: "https://example.invalid" },
      }
    );
    assert.equal(browserOrigin.status, 403);
    assert.equal(browserOrigin.headers.has("access-control-allow-origin"), false);

    const oversized = await originalFetch(
      `http://127.0.0.1:${address.port}/tts`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "x".repeat(70 * 1024) }),
      }
    );
    assert.equal(oversized.status, 413);

    const response = await originalFetch(
      `http://127.0.0.1:${address.port}/transcribe`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          audio_base64: "cpcm",
          hotwords: [" Yishu ", "yishu", "奕枢"],
        }),
      }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(
      forwardedBody.audio.input.transcription.hotwords,
      ["Yishu", "奕枢"]
    );
    assert.deepEqual(await response.json(), { text: "ok" });
  } finally {
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    rmSync(fixtureDirectory, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("asr timing log has no audio and no keys", () => {
  const line = formatAsrTimingLog({
    route: "/audio/asr/sse",
    upstreamPath: "/step_plan/v1/audio/asr/sse",
    connectMs: 40,
    firstByteMs: 120,
    totalMs: 400,
    audioSeconds: 1.2,
    stream: true,
  });
  assert.match(line, /route=\/audio\/asr\/sse/);
  assert.match(line, /connect_ms=40/);
  assert.match(line, /first_byte_ms=120/);
  assert.match(line, /audio_s=1.2/);
  const detailed = formatAsrTimingLog({
    route: "/audio/asr/sse",
    upstreamPath: "/step_plan/v1/audio/asr/sse",
    connectMs: 40,
    firstByteMs: 120,
    totalMs: 400,
    audioSeconds: 1.2,
    stream: true,
    kind: "final",
    reused: true,
    bodyBytes: 2048,
    bodyReadMs: 3,
  });
  assert.match(detailed, /kind=final/);
  assert.match(detailed, /reused=1/);
  assert.match(detailed, /body_bytes=2048/);
  assert.match(detailed, /body_read_ms=3/);
  assert.equal(line.includes("sk-"), false);
  assert.equal(audioSecondsFromBase64Length("cpcm", 16000) >= 0, true);
  assert.equal(audioSecondsFromBase64Length("A".repeat(64_000), 16_000) > 1, true);
});

test("transcribe stream:true pipes SSE instead of buffering JSON", async () => {
  const originalFetch = globalThis.fetch;
  const sse =
    'data: {"type":"transcript.text.delta","delta":"中"}\n\n' +
    'data: {"type":"transcript.text.done","text":"中间稿"}\n\n';
  let forwardedBody;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/step_plan\/v1\/audio\/asr\/sse$/);
    forwardedBody = JSON.parse(init.body);
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  try {
    const streamed = await worker.default.fetch(
      new Request("http://127.0.0.1/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audio_base64: "cpcm", stream: true, format: "pcm" }),
      }),
      { STEPFUN_API_KEY: "synthetic-test-key" }
    );
    assert.equal(streamed.status, 200);
    assert.match(streamed.headers.get("content-type") || "", /text\/event-stream/);
    assert.equal(forwardedBody.stream, true);
    assert.equal(await streamed.text(), sse);

    const buffered = await worker.default.fetch(
      new Request("http://127.0.0.1/transcribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audio_base64: "cpcm", stream: true }),
      }),
      { STEPFUN_API_KEY: "synthetic-test-key", YISHU_ASR_BUFFER: "1" }
    );
    assert.equal(buffered.status, 200);
    assert.deepEqual(await buffered.json(), { text: "中间稿" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
