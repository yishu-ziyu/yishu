#!/usr/bin/env node
/**
 * Lightweight local proxy for 奕枢 (no workerd / wrangler required).
 * Loads secrets from .dev.vars in this directory.
 *
 *   node local-server.mjs
 *   # listens on http://127.0.0.1:8787
 *
 * Chat (vision companion) defaults to OpenAI-compatible Grok via local 8317
 * (cli-proxy-api). ASR stays on StepFun Token Plan; TTS uses MiniMax t2a_v2.
 */

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildStepFunTranscriptionBody,
  sanitizeStepFunHotwords,
} from "./stepfun-hotwords.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";

const STEPFUN_ASR_URL =
  "https://api.stepfun.com/step_plan/v1/audio/asr/sse";
const STEPFUN_CHAT_BASE_DEFAULT = "https://api.stepfun.com/v1";
const CLI_PROXY_CHAT_BASE_DEFAULT = "http://127.0.0.1:8317/v1";
const MINIMAX_TTS_URL_DEFAULT = "https://api.minimaxi.com/v1/t2a_v2";
// 奕枢 clone voice (same id as the desktop speech synthesizer default).
const MINIMAX_VOICE_DEFAULT = "shangqiuzi_v3_20260717";
const MINIMAX_TTS_MODEL_DEFAULT = "speech-2.8-hd";
const CHAT_MODEL_DEFAULT = "grok-4.5";
const YISHU_RUNTIME_MODELS = new Set([
  "grok-4.5",
  "grok-4.3",
  "grok-4.20-0309-reasoning",
  "grok-4.20-0309-non-reasoning",
  "grok-4.20-multi-agent-0309",
  "grok-3-mini",
  "grok-3-mini-fast",
  "grok-composer-2.5-fast",
  "grok-build-0.1",
]);

function loadDevVars(path) {
  const env = { ...process.env };
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

const env = loadDevVars(
  process.env.YISHU_WORKER_ENV_FILE || join(__dirname, ".dev.vars")
);

function requireEnv(name) {
  const value = env[name];
  if (!value) throw new Error(`${name} missing (set worker/.dev.vars)`);
  return value;
}

/**
 * Resolve chat/vision upstream (OpenAI-compatible).
 * Prefer CHAT_* so TTS/ASR can stay on StepFun while chat uses Grok.
 */
function resolveChatUpstream() {
  const chatKey =
    env.CHAT_API_KEY ||
    env.OPENAI_API_KEY ||
    env.XAI_API_KEY ||
    env.STEPFUN_API_KEY;
  if (!chatKey) {
    throw new Error(
      "CHAT_API_KEY (or OPENAI_API_KEY / XAI_API_KEY / STEPFUN_API_KEY) missing"
    );
  }

  const hasExplicitChatBase = Boolean(
    env.CHAT_BASE || env.CHAT_OPENAI_BASE_URL
  );
  const usingCliProxyKey = Boolean(
    env.CHAT_API_KEY || env.OPENAI_API_KEY
  );
  let chatBase = (
    env.CHAT_BASE ||
    env.CHAT_OPENAI_BASE_URL ||
    (usingCliProxyKey && !env.STEPFUN_CHAT_BASE
      ? CLI_PROXY_CHAT_BASE_DEFAULT
      : env.STEPFUN_CHAT_BASE ||
        env.STEPFUN_OPENAI_BASE_URL ||
        STEPFUN_CHAT_BASE_DEFAULT)
  ).replace(/\/$/, "");

  // Token-plan base is fine for StepFun text; official /v1 is safer for multimodal.
  if (
    chatBase.includes("step_plan") &&
    !env.STEPFUN_FORCE_STEP_PLAN &&
    !hasExplicitChatBase
  ) {
    chatBase = STEPFUN_CHAT_BASE_DEFAULT;
  }

  const defaultModel =
    env.CHAT_MODEL || env.STEPFUN_CHAT_MODEL || CHAT_MODEL_DEFAULT;

  return {
    chatKey,
    chatBase,
    defaultModel,
    family: chatBase.includes("8317")
      ? "cli-proxy"
      : chatBase.includes("x.ai")
        ? "xai"
        : chatBase.includes("stepfun")
          ? "stepfun"
          : "openai-compatible",
  };
}

function publicConfigPayload() {
  let chat = {
    configured: false,
    family: "unknown",
    base: null,
    default_model: CHAT_MODEL_DEFAULT,
  };
  try {
    const upstream = resolveChatUpstream();
    chat = {
      configured: true,
      family: upstream.family,
      base: upstream.chatBase,
      default_model: upstream.defaultModel,
    };
  } catch {
    // leave unconfigured
  }
  return {
    ok: true,
    service: "yishu-proxy-local",
    chat,
    tts: {
      provider: "minimax",
      configured: Boolean(
        env.MINIMAX_API_KEY || env.MINIMAX_TOKEN_PLAN_KEY
      ),
      model: env.MINIMAX_TTS_MODEL || MINIMAX_TTS_MODEL_DEFAULT,
      voice_id: env.MINIMAX_VOICE_ID || MINIMAX_VOICE_DEFAULT,
    },
    asr: {
      provider: "stepfun",
      configured: Boolean(env.STEPFUN_API_KEY),
    },
  };
}

function minimaxApiKey() {
  return env.MINIMAX_API_KEY || env.MINIMAX_TOKEN_PLAN_KEY || "";
}

/** MiniMax t2a speed range. Out-of-range / non-finite → default 1.0. */
const MINIMAX_TTS_SPEED_MIN = 0.5;
const MINIMAX_TTS_SPEED_MAX = 2.0;
const MINIMAX_TTS_SPEED_DEFAULT = 1.0;

function clampSpeechSpeed(raw) {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return MINIMAX_TTS_SPEED_DEFAULT;
  return Math.min(MINIMAX_TTS_SPEED_MAX, Math.max(MINIMAX_TTS_SPEED_MIN, n));
}

function hexToBuffer(hex) {
  const cleaned = String(hex || "")
    .trim()
    .replace(/\s+/g, "");
  if (!cleaned || cleaned.length % 2 !== 0) {
    throw new Error("invalid MiniMax audio hex");
  }
  return Buffer.from(cleaned, "hex");
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseStepFunAsrSse(sseText) {
  let text = "";
  for (const line of sseText.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const event = JSON.parse(payload);
      if (event.type === "transcript.text.delta") {
        text += event.delta || "";
      } else if (event.type === "transcript.text.done") {
        text = event.text || text;
      }
    } catch {
      // ignore
    }
  }
  return text.trim();
}

/**
 * App still speaks Anthropic Messages shape (ClaudeAPI.swift).
 * Convert → StepFun OpenAI chat/completions, then stream back as Anthropic SSE
 * so the Swift client does not need a second parser.
 */
function anthropicBodyToOpenAI(body, defaultModel) {
  const requested = typeof body.model === "string" ? body.model : "";
  let model = defaultModel;
  if (
    requested &&
    !requested.startsWith("claude-") &&
    !requested.includes("sonnet") &&
    !requested.includes("opus") &&
    !requested.startsWith("MiniMax")
  ) {
    model = requested;
  }

  const openAIMessages = [];
  if (typeof body.system === "string" && body.system.trim()) {
    openAIMessages.push({ role: "system", content: body.system });
  }

  const incoming = Array.isArray(body.messages) ? body.messages : [];
  for (const message of incoming) {
    const role = message.role === "assistant" ? "assistant" : "user";
    const content = message.content;

    if (typeof content === "string") {
      openAIMessages.push({ role, content });
      continue;
    }

    if (!Array.isArray(content)) {
      openAIMessages.push({ role, content: String(content ?? "") });
      continue;
    }

    const parts = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        parts.push({ type: "text", text: block.text });
        continue;
      }
      if (block.type === "image" && block.source && block.source.type === "base64") {
        const mediaType = block.source.media_type || "image/jpeg";
        const data = block.source.data || "";
        parts.push({
          type: "image_url",
          image_url: { url: `data:${mediaType};base64,${data}` },
        });
      }
    }

    // OpenAI allows string or multimodal array; prefer array when images present.
    if (parts.length === 1 && parts[0].type === "text") {
      openAIMessages.push({ role, content: parts[0].text });
    } else {
      openAIMessages.push({ role, content: parts });
    }
  }

  // step-3.7-flash spends budget on reasoning; keep max_tokens high enough
  // so final spoken content still lands in `content`.
  const maxTokens = Number(body.max_tokens) > 0 ? Number(body.max_tokens) : 1024;
  const stream = body.stream !== false;

  return {
    model,
    messages: openAIMessages,
    max_tokens: Math.max(maxTokens, 512),
    stream,
  };
}

function openAIChunkToAnthropicSSE(chunkText) {
  // Input: one OpenAI SSE data payload (JSON string, not including "data: ").
  if (!chunkText || chunkText === "[DONE]") {
    return "data: [DONE]\n\n";
  }
  try {
    const event = JSON.parse(chunkText);
    const delta = event?.choices?.[0]?.delta || {};
    // Prefer spoken content; never stream chain-of-thought to TTS/UI.
    const text = typeof delta.content === "string" ? delta.content : "";
    if (!text) return "";
    return (
      "data: " +
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      }) +
      "\n\n"
    );
  } catch {
    return "";
  }
}

async function handleChat(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return json(res, 400, { error: "Invalid JSON body" });
  }

  const { chatKey, chatBase, defaultModel, family } = resolveChatUpstream();
  const openAIBody = anthropicBodyToOpenAI(body, defaultModel);

  const upstream = await fetch(`${chatBase}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${chatKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(openAIBody),
  });

  if (!upstream.ok) {
    const errorBody = await upstream.text();
    console.error(
      `[/chat] ${family} error ${upstream.status} model=${openAIBody.model}: ${errorBody}`
    );
    res.writeHead(upstream.status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });
    res.end(errorBody);
    return;
  }

  // Non-stream: rewrite OpenAI JSON into Anthropic-like content blocks for ClaudeAPI.analyzeImage
  if (!openAIBody.stream) {
    const payload = await upstream.json();
    const message = payload?.choices?.[0]?.message || {};
    let text = typeof message.content === "string" ? message.content : "";
    if (!text.trim()) {
      // Fallback if model only filled reasoning (usually means max_tokens too low).
      text =
        (typeof message.reasoning_content === "string" &&
          message.reasoning_content) ||
        (typeof message.reasoning === "string" && message.reasoning) ||
        "";
    }
    return json(res, 200, {
      id: payload.id || "yishu",
      type: "message",
      role: "assistant",
      model: payload.model || openAIBody.model,
      content: [{ type: "text", text }],
      stop_reason: payload?.choices?.[0]?.finish_reason || "end_turn",
      usage: payload.usage || {},
    });
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "access-control-allow-origin": "*",
  });

  if (!upstream.body) {
    res.end("data: [DONE]\n\n");
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      const converted = openAIChunkToAnthropicSSE(payload);
      if (converted) res.write(converted);
    }
  }

  if (buffer.startsWith("data:")) {
    const payload = buffer.slice(5).trim();
    const converted = openAIChunkToAnthropicSSE(payload);
    if (converted) res.write(converted);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * OpenAI-compatible loopback endpoint for the Pi runtime sidecar.
 *
 * Pi may choose only one of the models exposed by the Clicky control panel.
 * The sidecar never receives the upstream credential: this process adds it
 * only when forwarding from 8787 to the configured chat base (8317 today).
 */
async function handleRuntimeChatCompletions(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return json(res, 400, { error: "Invalid JSON body" });
  }

  const model = typeof body?.model === "string" ? body.model : "";
  if (!YISHU_RUNTIME_MODELS.has(model)) {
    return json(res, 400, { error: "Unsupported Yishu runtime model" });
  }

  const { chatKey, chatBase, family } = resolveChatUpstream();
  const upstream = await fetch(`${chatBase}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${chatKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const responseHeaders = {
    "content-type": upstream.headers.get("content-type") || "application/json",
    "cache-control": upstream.headers.get("cache-control") || "no-cache",
    "access-control-allow-origin": "*",
  };

  if (!upstream.ok) {
    // Do not print the upstream response body: it can echo request fragments.
    console.error(
      `[/v1/chat/completions] ${family} error ${upstream.status} model=${model}`
    );
    res.writeHead(upstream.status, responseHeaders);
    res.end(Buffer.from(await upstream.arrayBuffer()));
    return;
  }

  res.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

async function handleTTS(req, res) {
  const raw = await readBody(req);
  let incoming;
  try {
    incoming = JSON.parse(raw.toString("utf8"));
  } catch {
    return json(res, 400, { error: "Invalid JSON body" });
  }

  const text = String(incoming.text || "").trim();
  if (!text) return json(res, 400, { error: "text is required" });

  const key = minimaxApiKey();
  if (!key) {
    return json(res, 500, {
      error: "MINIMAX_API_KEY (or MINIMAX_TOKEN_PLAN_KEY) missing in .dev.vars",
    });
  }

  const voiceId = env.MINIMAX_VOICE_ID || MINIMAX_VOICE_DEFAULT;
  const ttsModel = env.MINIMAX_TTS_MODEL || MINIMAX_TTS_MODEL_DEFAULT;
  const ttsURL = (
    env.MINIMAX_TTS_URL || MINIMAX_TTS_URL_DEFAULT
  ).replace(/\/$/, "");
  const highQuality = ttsModel.endsWith("-hd");
  // Per-request speed from the app wins; env is only a legacy fallback.
  // MiniMax t2a voice_setting.speed is clamped to [0.5, 2.0].
  const speed = clampSpeechSpeed(
    incoming.speed !== undefined && incoming.speed !== null
      ? incoming.speed
      : env.MINIMAX_TTS_SPEED || 1.0
  );
  const volume = Number(env.MINIMAX_TTS_VOLUME || 1.0);

  const upstream = await fetch(ttsURL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ttsModel,
      text,
      stream: false,
      language_boost: "Chinese",
      output_format: "hex",
      voice_setting: {
        voice_id: voiceId,
        speed,
        vol: Number.isFinite(volume) ? volume : 1.0,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: highQuality ? 44100 : 32000,
        bitrate: highQuality ? 256000 : 128000,
        format: "mp3",
        channel: 1,
      },
    }),
  });

  const responseText = await upstream.text();
  if (!upstream.ok) {
    console.error(`[/tts] MiniMax TTS error ${upstream.status}: ${responseText}`);
    res.writeHead(upstream.status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });
    res.end(responseText);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    return json(res, 502, { error: "MiniMax TTS returned non-JSON body" });
  }

  const statusCode = payload?.base_resp?.status_code;
  if (statusCode !== undefined && statusCode !== 0) {
    console.error(
      `[/tts] MiniMax base_resp ${statusCode}: ${payload?.base_resp?.status_msg || ""}`
    );
    return json(res, 502, {
      error: payload?.base_resp?.status_msg || "MiniMax TTS failed",
      base_resp: payload?.base_resp,
    });
  }

  const audioHex = payload?.data?.audio || payload?.audio;
  if (!audioHex) {
    return json(res, 502, {
      error: "MiniMax TTS response missing data.audio",
    });
  }

  let audio;
  try {
    audio = hexToBuffer(audioHex);
  } catch (err) {
    return json(res, 502, {
      error: err instanceof Error ? err.message : "hex decode failed",
    });
  }

  res.writeHead(200, {
    "content-type": "audio/mpeg",
    "access-control-allow-origin": "*",
  });
  res.end(audio);
}

async function handleTranscribe(req, res) {
  const raw = await readBody(req);
  let incoming;
  try {
    incoming = JSON.parse(raw.toString("utf8"));
  } catch {
    return json(res, 400, { error: "Invalid JSON body" });
  }

  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return json(res, 400, { error: "JSON body must be an object" });
  }

  const audioBase64 =
    typeof incoming.audio_base64 === "string" ? incoming.audio_base64 : "";
  if (!audioBase64) return json(res, 400, { error: "audio_base64 is required" });

  const hotwordsValidation = sanitizeStepFunHotwords(incoming.hotwords);
  if (!hotwordsValidation.ok) {
    return json(res, 400, { error: hotwordsValidation.error });
  }

  const key = requireEnv("STEPFUN_API_KEY");
  const formatType =
    typeof incoming.format === "string" && incoming.format.trim()
      ? incoming.format.trim()
      : "wav";
  const sampleRate =
    typeof incoming.sample_rate === "number" &&
    Number.isFinite(incoming.sample_rate) &&
    incoming.sample_rate > 0
      ? incoming.sample_rate
      : 16000;
  const language =
    typeof incoming.language === "string" && incoming.language.trim()
      ? incoming.language.trim()
      : "zh";
  const asrModel = env.STEPFUN_ASR_MODEL || "stepaudio-2.5-asr";

  const upstream = await fetch(STEPFUN_ASR_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(
      buildStepFunTranscriptionBody({
        audioBase64,
        format: formatType,
        sampleRate,
        language,
        model: asrModel,
        hotwords: hotwordsValidation.hotwords,
      })
    ),
  });

  const sseText = await upstream.text();
  if (!upstream.ok) {
    res.writeHead(upstream.status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });
    res.end(sseText);
    return;
  }

  const transcript = parseStepFunAsrSse(sseText);
  return json(res, 200, { text: transcript });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization",
      });
      res.end();
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      if (
        url.pathname === "/" ||
        url.pathname === "/health" ||
        url.pathname === "/config"
      ) {
        return json(res, 200, publicConfigPayload());
      }
      res.writeHead(200, { "access-control-allow-origin": "*" });
      res.end("ok");
      return;
    }

    if (req.method !== "POST") {
      return json(res, 405, { error: "Method not allowed" });
    }

    if (url.pathname === "/chat") return await handleChat(req, res);
    if (url.pathname === "/v1/chat/completions") {
      return await handleRuntimeChatCompletions(req, res);
    }
    if (url.pathname === "/tts") return await handleTTS(req, res);
    if (url.pathname === "/transcribe") return await handleTranscribe(req, res);
    if (url.pathname === "/transcribe-token") {
      return json(res, 410, {
        error:
          "AssemblyAI token route removed. Use POST /transcribe with StepFun ASR.",
      });
    }

    return json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: String(error) });
  }
});

server.listen(PORT, HOST, () => {
  const cfg = publicConfigPayload();
  console.log(`奕枢 proxy listening on http://${HOST}:${PORT}`);
  console.log(
    `chat: family=${cfg.chat.family} base=${cfg.chat.base || "n/a"} model=${cfg.chat.default_model} key=${cfg.chat.configured ? "set" : "MISSING"}`
  );
  console.log(
    `tts: MINIMAX=${minimaxApiKey() ? "set" : "MISSING"} model=${env.MINIMAX_TTS_MODEL || MINIMAX_TTS_MODEL_DEFAULT}`,
    `asr: STEPFUN=${env.STEPFUN_API_KEY ? "set" : "MISSING"}`
  );
});

export { server };
