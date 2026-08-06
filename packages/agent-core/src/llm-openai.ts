import { DeterministicLlm, type LlmPort, type LlmResponse } from "./llm.js";
import type { ChatMessage, ToolCallRequest, ToolDefinition } from "./types.js";

export interface OpenAiCompatibleLlmOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Override fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";
const DEFAULT_OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 60_000;

type OpenAiToolCall = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type OpenAiMessage = {
  role: string;
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
};

type OpenAiChatResponse = {
  choices?: Array<{
    message?: OpenAiMessage;
    finish_reason?: string;
  }>;
  error?: { message?: string; type?: string };
};

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function mapMessages(messages: ChatMessage[]): OpenAiMessage[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      const out: OpenAiMessage = {
        role: "tool",
        content: m.content,
        tool_call_id: m.toolCallId ?? "",
      };
      if (m.name) out.name = m.name;
      return out;
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments ?? {}),
          },
        })),
      };
    }
    return {
      role: m.role,
      content: m.content,
    };
  });
}

function mapTools(
  tools: ToolDefinition[],
): Array<{
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: (t.parameters ?? { type: "object", properties: {} }) as Record<
        string,
        unknown
      >,
    },
  }));
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

function parseToolCalls(toolCalls: OpenAiToolCall[]): ToolCallRequest[] {
  return toolCalls
    .filter((tc) => tc.function?.name)
    .map((tc, i) => ({
      id: tc.id ?? `call_${tc.function!.name}_${i + 1}`,
      name: tc.function!.name as string,
      arguments: parseToolArguments(tc.function?.arguments),
    }));
}

/**
 * OpenAI-compatible chat completions client (OpenAI, OpenRouter, local proxies).
 */
export class OpenAiCompatibleLlm implements LlmPort {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleLlmOptions) {
    this.baseUrl = trimSlash(options.baseUrl);
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async complete(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
  ): Promise<LlmResponse> {
    if (typeof this.fetchImpl !== "function") {
      throw new Error(
        "OpenAiCompatibleLlm requires fetch (Node 18+ or provide fetchImpl)",
      );
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: mapMessages(messages),
    };
    if (tools && tools.length > 0) {
      body.tools = mapTools(tools);
      body.tool_choice = "auto";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted) {
        throw new Error(
          `OpenAI-compatible LLM timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new Error(`OpenAI-compatible LLM request failed: ${msg}`);
    }
    clearTimeout(timer);

    const text = await res.text();
    let data: OpenAiChatResponse;
    try {
      data = JSON.parse(text) as OpenAiChatResponse;
    } catch {
      throw new Error(
        `OpenAI-compatible LLM non-JSON response (${res.status}): ${text.slice(0, 200)}`,
      );
    }

    if (!res.ok) {
      const errMsg =
        data.error?.message ?? text.slice(0, 300) ?? `HTTP ${res.status}`;
      throw new Error(`OpenAI-compatible LLM error (${res.status}): ${errMsg}`);
    }

    const message = data.choices?.[0]?.message;
    if (!message) {
      throw new Error("OpenAI-compatible LLM returned no choices");
    }

    const toolCalls = message.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      return {
        type: "tool_calls",
        toolCalls: parseToolCalls(toolCalls),
      };
    }

    return {
      type: "text",
      text: message.content ?? "",
    };
  }
}

export type EnvLike = Record<string, string | undefined>;

function resolveApiKey(env: EnvLike): string | undefined {
  return env.OPENAI_API_KEY || env.OPENROUTER_API_KEY || undefined;
}

function resolveBaseUrl(env: EnvLike): string {
  if (env.OPENAI_BASE_URL?.trim()) {
    return env.OPENAI_BASE_URL.trim();
  }
  // Prefer OpenRouter base when only OpenRouter key is present
  if (env.OPENROUTER_API_KEY && !env.OPENAI_API_KEY) {
    return DEFAULT_OPENROUTER_BASE;
  }
  return DEFAULT_OPENAI_BASE;
}

function resolveModel(env: EnvLike): string {
  return env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
}

/**
 * True when env asks for a real OpenAI-compatible client.
 * - YISHU_AGENT_LLM=openai always selects OpenAI path
 * - or OPENAI_API_KEY / OPENROUTER_API_KEY present and YISHU_AGENT_LLM != mock
 */
export function shouldUseOpenAiFromEnv(env: EnvLike = process.env): boolean {
  const mode = (env.YISHU_AGENT_LLM ?? "").trim().toLowerCase();
  // Explicit mock always forces DeterministicLlm, even if API keys exist.
  if (mode === "mock") return false;
  if (mode === "openai") return true;
  // Any OpenAI/OpenRouter key opts in unless mock.
  return Boolean(resolveApiKey(env));
}

/** Build OpenAiCompatibleLlm from env vars (throws if key missing). */
export function createOpenAiFromEnv(env: EnvLike = process.env): OpenAiCompatibleLlm {
  const apiKey = resolveApiKey(env);
  if (!apiKey) {
    throw new Error(
      "OpenAI-compatible LLM selected but no OPENAI_API_KEY or OPENROUTER_API_KEY set",
    );
  }
  const opts: OpenAiCompatibleLlmOptions = {
    baseUrl: resolveBaseUrl(env),
    apiKey,
    model: resolveModel(env),
  };
  if (env.OPENAI_TIMEOUT_MS) {
    const n = Number(env.OPENAI_TIMEOUT_MS);
    if (Number.isFinite(n) && n > 0) opts.timeoutMs = n;
  }
  return new OpenAiCompatibleLlm(opts);
}

/**
 * Env factory:
 * - YISHU_AGENT_LLM=openai, or API key present (and not mock) → OpenAiCompatibleLlm
 * - else → DeterministicLlm
 */
export function createLlmFromEnv(env: EnvLike = process.env): LlmPort {
  if (shouldUseOpenAiFromEnv(env)) {
    return createOpenAiFromEnv(env);
  }
  return new DeterministicLlm();
}
