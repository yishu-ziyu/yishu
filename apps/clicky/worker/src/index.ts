import {
  buildStepFunTranscriptionBody,
  sanitizeStepFunHotwords,
} from "../stepfun-hotwords.mjs";

export {
  buildStepFunTranscriptionBody,
  MAX_STEPFUN_HOTWORD_LENGTH,
  MAX_STEPFUN_HOTWORDS,
  sanitizeStepFunHotwords,
} from "../stepfun-hotwords.mjs";

/**
 * 奕枢 (Yishu) local proxy worker
 *
 * Proxies app traffic so API keys never ship in the Mac binary.
 *
 * Routes:
 *   POST /chat       → OpenAI-compatible chat/completions (default: Grok via 8317)
 *                      App still sends Anthropic-shaped body; worker converts.
 *   POST /tts        → MiniMax t2a_v2 (hex audio → audio/mpeg)
 *   POST /transcribe → StepFun Token Plan ASR (SSE → JSON { text })
 */

interface Env {
  STEPFUN_API_KEY: string;
  STEPFUN_CHAT_MODEL?: string;
  STEPFUN_CHAT_BASE?: string;
  STEPFUN_OPENAI_BASE_URL?: string;
  STEPFUN_FORCE_STEP_PLAN?: string;
  STEPFUN_ASR_MODEL?: string;
  /** Chat/vision overrides (prefer over StepFun for /chat). */
  CHAT_API_KEY?: string;
  OPENAI_API_KEY?: string;
  XAI_API_KEY?: string;
  CHAT_BASE?: string;
  CHAT_OPENAI_BASE_URL?: string;
  CHAT_MODEL?: string;
  /** MiniMax TTS (preferred). */
  MINIMAX_API_KEY?: string;
  MINIMAX_TOKEN_PLAN_KEY?: string;
  MINIMAX_VOICE_ID?: string;
  MINIMAX_TTS_MODEL?: string;
  MINIMAX_TTS_URL?: string;
  MINIMAX_TTS_SPEED?: string;
  MINIMAX_TTS_VOLUME?: string;
}

const STEPFUN_ASR_URL =
  "https://api.stepfun.com/step_plan/v1/audio/asr/sse";
const STEPFUN_CHAT_BASE_DEFAULT = "https://api.stepfun.com/v1";
const CLI_PROXY_CHAT_BASE_DEFAULT = "http://127.0.0.1:8317/v1";
const MINIMAX_TTS_URL_DEFAULT = "https://api.minimaxi.com/v1/t2a_v2";
const MINIMAX_VOICE_DEFAULT = "shangqiuzi_v3_20260717";
const MINIMAX_TTS_MODEL_DEFAULT = "speech-2.8-hd";
const CHAT_MODEL_DEFAULT = "grok-4.6";

/**
 * Return only non-content metadata for an upstream failure. Provider bodies
 * may echo prompts, request headers, or credential-bearing diagnostics, so
 * neither logs nor client-facing errors should forward them.
 */
export function redactedUpstreamErrorPayload(
  statusCode: number,
  responseBody: string
): {
  error: "upstream_error";
  status: number;
  body_bytes: number;
} {
  return {
    error: "upstream_error",
    status: statusCode,
    body_bytes: new TextEncoder().encode(responseBody).byteLength,
  };
}

function logRedactedUpstreamError(
  route: string,
  statusCode: number,
  responseBody: string
): void {
  const metadata = redactedUpstreamErrorPayload(statusCode, responseBody);
  console.error(
    `[${route}] upstream error status=${metadata.status} code=${metadata.error} body_bytes=${metadata.body_bytes}`
  );
}

function resolveChatUpstream(env: Env): {
  chatKey: string;
  chatBase: string;
  defaultModel: string;
  family: string;
} {
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
  const usingCliProxyKey = Boolean(env.CHAT_API_KEY || env.OPENAI_API_KEY);
  let chatBase = (
    env.CHAT_BASE ||
    env.CHAT_OPENAI_BASE_URL ||
    (usingCliProxyKey && !env.STEPFUN_CHAT_BASE
      ? CLI_PROXY_CHAT_BASE_DEFAULT
      : env.STEPFUN_CHAT_BASE ||
        env.STEPFUN_OPENAI_BASE_URL ||
        STEPFUN_CHAT_BASE_DEFAULT)
  ).replace(/\/$/, "");

  if (
    chatBase.includes("step_plan") &&
    !env.STEPFUN_FORCE_STEP_PLAN &&
    !hasExplicitChatBase
  ) {
    chatBase = STEPFUN_CHAT_BASE_DEFAULT;
  }

  const defaultModel =
    env.CHAT_MODEL || env.STEPFUN_CHAT_MODEL || CHAT_MODEL_DEFAULT;

  const family = chatBase.includes("8317")
    ? "cli-proxy"
    : chatBase.includes("x.ai")
      ? "xai"
      : chatBase.includes("stepfun")
        ? "stepfun"
        : "openai-compatible";

  return { chatKey, chatBase, defaultModel, family };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    if (request.method === "HEAD" || request.method === "GET") {
      if (
        url.pathname === "/" ||
        url.pathname === "/health" ||
        url.pathname === "/config"
      ) {
        let chat: Record<string, unknown> = {
          configured: false,
          family: "unknown",
          base: null,
          default_model: CHAT_MODEL_DEFAULT,
        };
        try {
          const upstream = resolveChatUpstream(env);
          chat = {
            configured: true,
            family: upstream.family,
            base: upstream.chatBase,
            default_model: upstream.defaultModel,
          };
        } catch {
          // leave unconfigured
        }
        return json(
          {
            ok: true,
            service: "yishu-proxy",
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
          },
          200
        );
      }
      return new Response("ok", { status: 200, headers: corsHeaders() });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    try {
      if (url.pathname === "/chat") {
        return await handleChat(request, env);
      }
      if (url.pathname === "/tts") {
        return await handleTTS(request, env);
      }
      if (url.pathname === "/transcribe") {
        return await handleTranscribe(request, env);
      }
      // Legacy Clicky route — keep a clear error so old clients fail loudly.
      if (url.pathname === "/transcribe-token") {
        return json(
          {
            error:
              "AssemblyAI token route removed. Use POST /transcribe with StepFun ASR.",
          },
          410
        );
      }
    } catch (error) {
      console.error(`[${url.pathname}] Unhandled error:`, error);
      return json({ error: String(error) }, 500);
    }

    return json({ error: "Not found" }, 404);
  },
};

function anthropicBodyToOpenAI(
  body: Record<string, unknown>,
  defaultModel: string
): Record<string, unknown> {
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

  const openAIMessages: Array<Record<string, unknown>> = [];
  if (typeof body.system === "string" && body.system.trim()) {
    openAIMessages.push({ role: "system", content: body.system });
  }

  const incoming = Array.isArray(body.messages) ? body.messages : [];
  for (const rawMessage of incoming) {
    const message = rawMessage as {
      role?: string;
      content?: unknown;
    };
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

    const parts: Array<Record<string, unknown>> = [];
    for (const rawBlock of content) {
      const block = rawBlock as {
        type?: string;
        text?: string;
        source?: {
          type?: string;
          media_type?: string;
          data?: string;
        };
      };
      if (block.type === "text" && typeof block.text === "string") {
        parts.push({ type: "text", text: block.text });
        continue;
      }
      if (
        block.type === "image" &&
        block.source &&
        block.source.type === "base64"
      ) {
        const mediaType = block.source.media_type || "image/jpeg";
        const data = block.source.data || "";
        parts.push({
          type: "image_url",
          image_url: { url: `data:${mediaType};base64,${data}` },
        });
      }
    }

    if (parts.length === 1 && parts[0].type === "text") {
      openAIMessages.push({ role, content: parts[0].text });
    } else {
      openAIMessages.push({ role, content: parts });
    }
  }

  const maxTokens =
    typeof body.max_tokens === "number" && body.max_tokens > 0
      ? body.max_tokens
      : 1024;
  const stream = body.stream !== false;

  return {
    model,
    messages: openAIMessages,
    max_tokens: Math.max(maxTokens, 512),
    stream,
  };
}

function openAIChunkToAnthropicSSE(chunkText: string): string {
  if (!chunkText || chunkText === "[DONE]") {
    return "data: [DONE]\n\n";
  }
  try {
    const event = JSON.parse(chunkText) as {
      choices?: Array<{ delta?: { content?: string } }>;
    };
    const text = event.choices?.[0]?.delta?.content || "";
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

async function handleChat(request: Request, env: Env): Promise<Response> {
  let chatKey: string;
  let chatBase: string;
  let defaultModel: string;
  try {
    ({ chatKey, chatBase, defaultModel } = resolveChatUpstream(env));
  } catch (error) {
    return json({ error: String(error) }, 500);
  }

  const bodyText = await request.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const openAIBody = anthropicBodyToOpenAI(body, defaultModel);

  const response = await fetch(`${chatBase}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${chatKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(openAIBody),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    logRedactedUpstreamError("/chat", response.status, responseBody);
    return json(
      redactedUpstreamErrorPayload(response.status, responseBody),
      response.status
    );
  }

  if (!openAIBody.stream) {
    const payload = (await response.json()) as {
      id?: string;
      model?: string;
      choices?: Array<{
        message?: {
          content?: string;
          reasoning_content?: string;
          reasoning?: string;
        };
        finish_reason?: string;
      }>;
      usage?: unknown;
    };
    const message = payload.choices?.[0]?.message || {};
    let text = typeof message.content === "string" ? message.content : "";
    if (!text.trim()) {
      text = message.reasoning_content || message.reasoning || "";
    }
    return json(
      {
        id: payload.id || "yishu",
        type: "message",
        role: "assistant",
        model: payload.model || openAIBody.model,
        content: [{ type: "text", text }],
        stop_reason: payload.choices?.[0]?.finish_reason || "end_turn",
        usage: payload.usage || {},
      },
      200
    );
  }

  // Stream OpenAI SSE → Anthropic content_block_delta for ClaudeAPI.swift
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  (async () => {
    try {
      if (!response.body) {
        await writer.write(encoder.encode("data: [DONE]\n\n"));
        await writer.close();
        return;
      }
      const reader = response.body.getReader();
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
          if (converted) await writer.write(encoder.encode(converted));
        }
      }
      if (buffer.startsWith("data:")) {
        const payload = buffer.slice(5).trim();
        const converted = openAIChunkToAnthropicSSE(payload);
        if (converted) await writer.write(encoder.encode(converted));
      }
      await writer.write(encoder.encode("data: [DONE]\n\n"));
      await writer.close();
    } catch (error) {
      console.error("[/chat] stream transform error:", error);
      try {
        await writer.abort(error);
      } catch {
        // ignore
      }
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      ...corsHeaders(),
    },
  });
}

const MINIMAX_TTS_SPEED_MIN = 0.5;
const MINIMAX_TTS_SPEED_MAX = 2.0;
const MINIMAX_TTS_SPEED_DEFAULT = 1.0;

/** MiniMax t2a_v2 voice_setting.emotion allowlist. Invalid → omitted (auto). */
const MINIMAX_TTS_EMOTIONS = new Set([
  "happy",
  "sad",
  "angry",
  "fearful",
  "disgusted",
  "surprised",
  "neutral",
]);

function resolveTtsEmotion(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return MINIMAX_TTS_EMOTIONS.has(value) ? value : undefined;
}

function clampSpeechSpeed(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return MINIMAX_TTS_SPEED_DEFAULT;
  return Math.min(MINIMAX_TTS_SPEED_MAX, Math.max(MINIMAX_TTS_SPEED_MIN, n));
}

function minimaxApiKey(env: Env): string {
  return env.MINIMAX_API_KEY || env.MINIMAX_TOKEN_PLAN_KEY || "";
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.trim().replace(/\s+/g, "");
  if (!cleaned || cleaned.length % 2 !== 0) {
    throw new Error("invalid MiniMax audio hex");
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    out[i / 2] = Number.parseInt(cleaned.slice(i, i + 2), 16);
  }
  return out;
}

async function handleTTS(request: Request, env: Env): Promise<Response> {
  const key = minimaxApiKey(env);
  if (!key) {
    return json(
      { error: "MINIMAX_API_KEY (or MINIMAX_TOKEN_PLAN_KEY) missing" },
      500
    );
  }

  const incoming = (await request.json()) as {
    text?: string;
    model_id?: string;
    emotion?: string;
  };
  const text = (incoming.text || "").trim();
  if (!text) {
    return json({ error: "text is required" }, 400);
  }

  const voiceId = env.MINIMAX_VOICE_ID || MINIMAX_VOICE_DEFAULT;
  const ttsModel = env.MINIMAX_TTS_MODEL || MINIMAX_TTS_MODEL_DEFAULT;
  const ttsURL = (env.MINIMAX_TTS_URL || MINIMAX_TTS_URL_DEFAULT).replace(
    /\/$/,
    ""
  );
  const highQuality = ttsModel.endsWith("-hd");
  // Per-request speed from the app wins; env is only a legacy fallback.
  const speed = clampSpeechSpeed(
    (incoming as { speed?: unknown }).speed !== undefined &&
      (incoming as { speed?: unknown }).speed !== null
      ? (incoming as { speed?: unknown }).speed
      : env.MINIMAX_TTS_SPEED || 1.0
  );
  const volume = Number(env.MINIMAX_TTS_VOLUME || 1.0);
  // Per-request emotion from the app; invalid/absent → provider auto-renders
  // mood from the text itself.
  const emotion = resolveTtsEmotion(incoming.emotion);

  const response = await fetch(ttsURL, {
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
        ...(emotion ? { emotion } : {}),
      },
      audio_setting: {
        sample_rate: highQuality ? 44100 : 32000,
        bitrate: highQuality ? 256000 : 128000,
        format: "mp3",
        channel: 1,
      },
    }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    logRedactedUpstreamError("/tts", response.status, responseText);
    return json(
      redactedUpstreamErrorPayload(response.status, responseText),
      response.status
    );
  }

  let payload: {
    data?: { audio?: string };
    audio?: string;
    base_resp?: { status_code?: number; status_msg?: string };
  };
  try {
    payload = JSON.parse(responseText) as typeof payload;
  } catch {
    return json({ error: "MiniMax TTS returned non-JSON body" }, 502);
  }

  const statusCode = payload.base_resp?.status_code;
  if (statusCode !== undefined && statusCode !== 0) {
    return json(
      {
        error: payload.base_resp?.status_msg || "MiniMax TTS failed",
        base_resp: payload.base_resp,
      },
      502
    );
  }

  const audioHex = payload.data?.audio || payload.audio;
  if (!audioHex) {
    return json({ error: "MiniMax TTS response missing data.audio" }, 502);
  }

  let audio: Uint8Array;
  try {
    audio = hexToBytes(audioHex);
  } catch (err) {
    return json(
      {
        error: err instanceof Error ? err.message : "hex decode failed",
      },
      502
    );
  }

  return new Response(audio, {
    status: 200,
    headers: {
      "content-type": "audio/mpeg",
      ...corsHeaders(),
    },
  });
}

async function handleTranscribe(
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.STEPFUN_API_KEY) {
    return json({ error: "STEPFUN_API_KEY missing" }, 500);
  }

  let incoming: {
    audio_base64?: unknown;
    format?: unknown;
    sample_rate?: unknown;
    language?: unknown;
    hotwords?: unknown;
  };
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ error: "JSON body must be an object" }, 400);
    }
    incoming = parsed as typeof incoming;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const audioBase64 =
    typeof incoming.audio_base64 === "string" ? incoming.audio_base64 : "";
  if (!audioBase64) {
    return json({ error: "audio_base64 is required" }, 400);
  }

  const hotwordsValidation = sanitizeStepFunHotwords(incoming.hotwords);
  if (!hotwordsValidation.ok) {
    return json({ error: hotwordsValidation.error }, 400);
  }

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

  const stepfunBody = buildStepFunTranscriptionBody({
    audioBase64,
    format: formatType,
    sampleRate,
    language,
    model: asrModel,
    hotwords: hotwordsValidation.hotwords,
  });

  const response = await fetch(STEPFUN_ASR_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STEPFUN_API_KEY}`,
      "content-type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(stepfunBody),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    logRedactedUpstreamError("/transcribe", response.status, responseBody);
    return json(
      redactedUpstreamErrorPayload(response.status, responseBody),
      response.status
    );
  }

  const sseText = await response.text();
  const transcript = parseStepFunAsrSse(sseText);

  return json({ text: transcript }, 200);
}

function parseStepFunAsrSse(sseText: string): string {
  let text = "";
  for (const line of sseText.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const event = JSON.parse(payload) as {
        type?: string;
        delta?: string;
        text?: string;
      };
      if (event.type === "transcript.text.delta") {
        text += event.delta || "";
      } else if (event.type === "transcript.text.done") {
        text = event.text || text;
      }
    } catch {
      // ignore malformed SSE chunks
    }
  }
  return text.trim();
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
  };
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      ...corsHeaders(),
    },
  });
}
