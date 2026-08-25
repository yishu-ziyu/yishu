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

export interface LocalModelProviderConfig {
  readonly id: string;
  readonly name: string;
  /** OpenAI-compatible base URL, e.g. http://127.0.0.1:8317/v1 */
  readonly baseUrl: string;
  /** Key stored inline in the local file (0600). Prefer apiKeyEnv for secrets. */
  readonly apiKey?: string;
  /** Alternative: read the key from this environment variable at runtime. */
  readonly apiKeyEnv?: string;
  readonly models: readonly string[];
  readonly defaultModel?: string;
}

export interface LocalModelConfig {
  readonly defaultProvider: string;
  readonly providers: readonly LocalModelProviderConfig[];
}

export function resolveModelConfigPath(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, "Library", "Application Support", "Yishu", "model-config.json");
}

export const DEFAULT_LOCAL_MODEL_CONFIG_PATH = resolveModelConfigPath();

/** Built-in fallback so the product never silently starts with no model config. */
export function defaultLocalModelConfig(): LocalModelConfig {
  return {
    defaultProvider: "yishu-local-grok",
    providers: [
      {
        id: "yishu-local-grok",
        name: "本地模型 (BYOK)",
        baseUrl: "http://127.0.0.1:8317/v1",
        apiKeyEnv: "YISHU_LOCAL_MODEL_API_KEY",
        models: ["grok-4.6", "grok-4.5", "grok-4.3"],
        defaultModel: "grok-4.6",
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

export function parseModelConfig(raw: string): LocalModelConfig {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("model-config: root must be an object");
  assertString(parsed.defaultProvider, "defaultProvider", "model-config");
  if (!Array.isArray(parsed.providers) || parsed.providers.length === 0) {
    throw new Error("model-config: providers must be a non-empty array");
  }
  const providers = parsed.providers.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`model-config: providers[${index}] must be an object`);
    const provider: LocalModelProviderConfig = {
      id: entry.id as string,
      name: typeof entry.name === "string" ? entry.name : (entry.id as string),
      baseUrl: entry.baseUrl as string,
      ...(typeof entry.apiKey === "string" ? { apiKey: entry.apiKey } : {}),
      ...(typeof entry.apiKeyEnv === "string" ? { apiKeyEnv: entry.apiKeyEnv } : {}),
      models: Array.isArray(entry.models)
        ? entry.models.filter((m): m is string => typeof m === "string")
        : [],
      ...(typeof entry.defaultModel === "string" ? { defaultModel: entry.defaultModel } : {}),
    };
    assertString(provider.id, "id", `model-config.providers[${index}]`);
    assertString(provider.baseUrl, "baseUrl", `model-config.providers[${index}]`);
    return provider;
  });
  const defaultProvider = providers.find((p) => p.id === parsed.defaultProvider);
  if (!defaultProvider) throw new Error("model-config: defaultProvider not found in providers");
  return { defaultProvider: parsed.defaultProvider as string, providers };
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

/** Resolve the effective API key for a provider: inline key wins, else env ref. */
export function resolveProviderApiKey(provider: LocalModelProviderConfig): string | undefined {
  return provider.apiKey ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined);
}

export function providerById(config: LocalModelConfig, id?: string): LocalModelProviderConfig {
  const target = id ?? config.defaultProvider;
  const provider = config.providers.find((p) => p.id === target);
  if (!provider) throw new Error(`model-config: provider "${target}" not found`);
  return provider;
}

export async function writeModelConfig(
  config: LocalModelConfig,
  pathToFile = DEFAULT_LOCAL_MODEL_CONFIG_PATH,
): Promise<void> {
  const directory = path.dirname(pathToFile);
  await mkdir(directory, { recursive: true });
  await writeFile(pathToFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(pathToFile, 0o600);
}
