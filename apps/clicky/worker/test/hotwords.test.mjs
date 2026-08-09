import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

const worker = await import("../src/index.ts");
const {
  buildStepFunTranscriptionBody,
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
  globalThis.fetch = async (_input, init) => {
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
  };
  let forwardedBody;
  globalThis.fetch = async (_input, init) => {
    forwardedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      text: async () =>
        'data: {"type":"transcript.text.done","text":"ok"}\n\n',
    };
  };

  process.env.HOST = "127.0.0.1";
  process.env.PORT = "0";
  process.env.STEPFUN_API_KEY = "synthetic-test-key";
  process.env.YISHU_WORKER_ENV_FILE = "/tmp/yishu-worker-hotwords-test-no-file";

  let server;
  try {
    ({ server } = await import(`../local-server.mjs?hotwords=${Date.now()}`));
    if (!server.listening) await once(server, "listening");

    const address = server.address();
    assert.equal(typeof address, "object");
    const response = await originalFetch(
      `http://127.0.0.1:${address.port}/transcribe`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
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
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
