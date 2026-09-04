/**
 * Local model configuration (BYOK / bring-your-own-key).
 *
 * The product is model-agnostic: the user can point it at ANY OpenAI-compatible
 * endpoint with their own API key. A single local, user-edited JSON file
 * (never committed, mode 0600) declares the providers available to the
 * runtime. The runtime maps the product's "local model" preference to the
 * configured default provider so existing product flows keep working while
 * the endpoint/key/model are user-controlled.
 *
 * Security:
 * - API keys live ONLY in this local file (or an env var reference), never in
 *   git, protocol events, logs, receipts, or prompt text.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ChatExit = "direct" | "gateway";

export const GATEWAY_CHAT_BASE_URL = "http://127.0.0.1:8317/v1";
export const DIRECT_CHAT_BASE_URL = "https://api.minimaxi.com/v1";
const GATEWAY_CONFIG_RELATIVE = path.join(".cli-proxy-api", "config.yaml");
const PROBE_TIMEOUT_MS = 10_000;

export interface LocalModelProviderConfig {
  readonly id: string;
  readonly name: string;
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:8317/v1 */
  readonly baseUrl: string;
  /** Keychain or broker reference. Shipping configs must use this instead of apiKey. */
  readonly credentialRef?: string;
  /**
   * Legacy inline secret, accepted only while migrating into Keychain.
   * `writeModelConfig` refuses to persist this field.
   */
  readonly apiKey?: string;
  /** Alternative: read the key from this environment variable at runtime. */
  readonly apiKeyEnv?: string;
  readonly models: readonly string[];
  readonly defaultModel?: string;
  readonly exit?: ChatExit;
}

export interface LocalModelConfig {
  readonly defaultProvider: string;
  readonly chatExit?: ChatExit;
  readonly providers: readonly LocalModelProviderConfig[];
}

export interface ProbedModel {
  readonly providerId: string;
  readonly id: string;
  readonly name: string;
  readonly reachable: boolean;
  readonly baseUrlHost: string;
  readonly error?: string;
}

export function resolveModelConfigPath(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, "Library", "Application Support", "Yishu", "model-config.json");
}

export const DEFAULT_LOCAL_MODEL_CONFIG_PATH = resolveModelConfigPath();

/** Built-in fallback so the product never silently starts with no model config. */
export function defaultLocalModelConfig(): LocalModelConfig {
  return {
    defaultProvider: "yishu-local-grok",
    chatExit: "direct",
    providers: [
      {
        id: "yishu-local-grok",
        name: "MiniMax 直连",
        baseUrl: DIRECT_CHAT_BASE_URL,
        apiKeyEnv: "MINIMAX_API_KEY",
        models: ["MiniMax-M3"],
        defaultModel: "MiniMax-M3",
        exit: "direct",
      },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, field: string, context: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`model-config: ${context}.${field} must be a non-empty string`);
  }
}

function parseChatExit(value: unknown): ChatExit | undefined {
  return value === "direct" || value === "gateway" ? value : undefined;
}

export function parseModelConfig(raw: string): LocalModelConfig {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("model-config: root must be an object");
  assertString(parsed.defaultProvider, "defaultProvider", "model-config");
  if (!Array.isArray(parsed.providers) || parsed.providers.length === 0) {
    throw new Error("model-config: providers must be a non-empty array");
  }
  const chatExit = parseChatExit(parsed.chatExit);
  const providers = parsed.providers.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`model-config: providers[${index}] must be an object`);
    const exit = parseChatExit(entry.exit);
    const provider: LocalModelProviderConfig = {
      id: entry.id as string,
      name: typeof entry.name === "string" ? entry.name : (entry.id as string),
      baseUrl: entry.baseUrl as string,
      ...(typeof entry.credentialRef === "string" ? { credentialRef: entry.credentialRef } : {}),
      ...(typeof entry.apiKey === "string" ? { apiKey: entry.apiKey } : {}),
      ...(typeof entry.apiKeyEnv === "string" ? { apiKeyEnv: entry.apiKeyEnv } : {}),
      models: Array.isArray(entry.models)
        ? entry.models.filter((m): m is string => typeof m === "string")
        : [],
      ...(typeof entry.defaultModel === "string" ? { defaultModel: entry.defaultModel } : {}),
      ...(exit === undefined ? {} : { exit }),
    };
    assertString(provider.id, "id", `model-config.providers[${index}]`);
    assertString(provider.baseUrl, "baseUrl", `model-config.providers[${index}]`);
    return provider;
  });
  const defaultProvider = providers.find((p) => p.id === parsed.defaultProvider);
  if (!defaultProvider) throw new Error("model-config: defaultProvider not found in providers");
  return {
    defaultProvider: parsed.defaultProvider as string,
    ...(chatExit === undefined ? {} : { chatExit }),
    providers,
  };
}

export async function loadModelConfig(
  pathToFile = DEFAULT_LOCAL_MODEL_CONFIG_PATH,
): Promise<LocalModelConfig> {
  if (!existsSync(pathToFile)) return defaultLocalModelConfig();
  const raw = await readFile(pathToFile, "utf8");
  return parseModelConfig(raw);
}

export function readModelConfigSync(pathToFile = DEFAULT_LOCAL_MODEL_CONFIG_PATH): LocalModelConfig {
  if (!existsSync(pathToFile)) return defaultLocalModelConfig();
  return parseModelConfig(readFileSync(pathToFile, "utf8"));
}

export function resolveChatExit(
  config: LocalModelConfig,
  provider?: LocalModelProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): ChatExit {
  const fromEnv = env.YISHU_CHAT_EXIT;
  if (fromEnv === "direct" || fromEnv === "gateway") return fromEnv;
  if (provider?.exit === "direct" || provider?.exit === "gateway") return provider.exit;
  if (config.chatExit === "direct" || config.chatExit === "gateway") return config.chatExit;
  return "direct";
}

export function displayNameForChatExit(exit: ChatExit): string {
  return exit === "gateway" ? "CLI 网关" : "MiniMax 直连";
}

export function baseUrlHost(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return baseUrl;
  }
}

export function resolveChatBaseUrl(
  config: LocalModelConfig,
  provider: LocalModelProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const exit = resolveChatExit(config, provider, env);
  if (exit === "gateway") return GATEWAY_CHAT_BASE_URL;
  const configured = provider.baseUrl.trim();
  if (
    configured.includes("127.0.0.1:8317")
    || configured.includes("127.0.0.1:8787")
  ) {
    return DIRECT_CHAT_BASE_URL;
  }
  return configured.length > 0 ? configured : DIRECT_CHAT_BASE_URL;
}

/** First `api-keys` entry from CLIProxyAPI. Never log the value. */
export function readGatewayApiKey(
  homeDirectory = os.homedir(),
): string | undefined {
  const filePath = path.join(homeDirectory, GATEWAY_CONFIG_RELATIVE);
  if (!existsSync(filePath)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  const block = raw.match(/api-keys\s*:\s*\n((?:\s*-\s*.+\n?)+)/u);
  const fromBlock = block?.[1]?.match(/-\s*["']?([^\s"']+)/u)?.[1];
  if (fromBlock && fromBlock.length > 0) return fromBlock;
  const inline = raw.match(/api-keys\s*:\s*\[\s*["']?([^"'\s,\]]+)/u);
  const fromInline = inline?.[1];
  return fromInline && fromInline.length > 0 ? fromInline : undefined;
}

/** Resolve the effective API key for a provider: inline key wins, else env ref. */
export function resolveProviderApiKey(provider: LocalModelProviderConfig): string | undefined {
  return provider.apiKey ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined);
}

export function resolveEffectiveApiKey(
  config: LocalModelConfig,
  provider: LocalModelProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string | undefined {
  const exit = resolveChatExit(config, provider, env);
  if (exit === "gateway") {
    return readGatewayApiKey(homeDirectory)
      ?? resolveProviderApiKey(provider)
      ?? env.YISHU_LOCAL_MODEL_API_KEY;
  }
  return resolveProviderApiKey(provider)
    ?? env.MINIMAX_API_KEY
    ?? env.YISHU_LOCAL_MODEL_API_KEY;
}

export function providerById(config: LocalModelConfig, id?: string): LocalModelProviderConfig {
  const target = id ?? config.defaultProvider;
  const provider = config.providers.find((p) => p.id === target);
  if (!provider) throw new Error(`model-config: provider "${target}" not found`);
  return provider;
}

export function withEffectiveChatExit(
  config: LocalModelConfig,
  provider: LocalModelProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): LocalModelProviderConfig {
  const exit = resolveChatExit(config, provider, env);
  const baseUrl = resolveChatBaseUrl(config, provider, env);
  const truthful = provider.id === "yishu-local-grok"
    ? displayNameForChatExit(exit)
    : provider.name;
  return {
    ...provider,
    name: truthful,
    baseUrl,
    exit,
  };
}

export function configContainsInlineSecrets(config: LocalModelConfig): boolean {
  return config.providers.some((provider) => typeof provider.apiKey === "string" && provider.apiKey.length > 0);
}

export function redactModelConfigForWrite(config: LocalModelConfig): LocalModelConfig {
  return {
    defaultProvider: config.defaultProvider,
    ...(config.chatExit === undefined ? {} : { chatExit: config.chatExit }),
    providers: config.providers.map((provider) => {
      const { apiKey: _omit, ...rest } = provider;
      return rest;
    }),
  };
}

export async function writeModelConfig(
  config: LocalModelConfig,
  pathToFile = DEFAULT_LOCAL_MODEL_CONFIG_PATH,
): Promise<void> {
  if (configContainsInlineSecrets(config)) {
    throw new Error("model-config: refusing to write inline apiKey; store the secret in Keychain and use credentialRef");
  }
  const directory = path.dirname(pathToFile);
  await mkdir(directory, { recursive: true });
  await writeFile(pathToFile, `${JSON.stringify(redactModelConfigForWrite(config), null, 2)}\n`, { mode: 0o600 });
  await chmod(pathToFile, 0o600);
}

async function probeOneModel(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ reachable: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        max_tokens: 1,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { reachable: false, error: `http_${response.status}` };
    }
    if (!response.body) return { reachable: false, error: "empty_body" };
    const reader = response.body.getReader();
    const first = await reader.read();
    await reader.cancel().catch(() => undefined);
    if (first.done && first.value === undefined) return { reachable: false, error: "no_bytes" };
    return { reachable: true };
  } catch (error) {
    const aborted = controller.signal.aborted
      || (error instanceof Error && /abort/i.test(error.message));
    return { reachable: false, error: aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One-token streaming probe per configured model. Never logs the key.
 * Returns every candidate with a reachable flag; callers should expose only reachable rows.
 */
export async function probeModels(
  config: LocalModelConfig = readModelConfigSync(),
  options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    homeDirectory?: string;
  } = {},
): Promise<readonly ProbedModel[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const results: ProbedModel[] = [];
  for (const provider of config.providers) {
    const effective = withEffectiveChatExit(config, provider, env);
    const apiKey = resolveEffectiveApiKey(config, provider, env, homeDirectory) ?? "";
    const host = baseUrlHost(effective.baseUrl);
    const modelIds = effective.models.length > 0
      ? effective.models
      : (effective.defaultModel ? [effective.defaultModel] : []);
    for (const modelId of modelIds) {
      if (!apiKey) {
        results.push({
          providerId: effective.id,
          id: modelId,
          name: `${effective.name} / ${modelId}`,
          reachable: false,
          baseUrlHost: host,
          error: "missing_key",
        });
        continue;
      }
      const probed = await probeOneModel(effective.baseUrl, apiKey, modelId, fetchImpl, timeoutMs);
      results.push({
        providerId: effective.id,
        id: modelId,
        name: `${effective.name} / ${modelId}`,
        reachable: probed.reachable,
        baseUrlHost: host,
        ...(probed.error === undefined ? {} : { error: probed.error }),
      });
    }
  }
  return results;
}

export function reachableProbedModels(results: readonly ProbedModel[]): readonly ProbedModel[] {
  return results.filter((row) => row.reachable);
}
