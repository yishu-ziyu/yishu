import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_EVEROS_IDENTITY,
  EverOSHttpClient,
  assertValidEverOSIdentity,
  type EverOSIdentity,
  type EverOSMemoryPort,
} from "@yishu/kernel";
import { createYishuCredentialStore } from "./auth-store.js";
import { oauthFlows } from "./model-loop/oauth.js";
import {
  migrateLegacyEverOSUserMemory,
  shouldMigrateLegacyEverOS,
} from "./everos-migration.js";

export const DEFAULT_EVEROS_PORT = 18765;

export interface EverOSSidecarOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly llmEnvResolver?: () => Promise<EverOSLlmEnv | undefined>;
}

function envOf(options: EverOSSidecarOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

export function everosEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.YISHU_EVEROS === "0" || env.YISHU_EVEROS === "false") return false;
  if (typeof env.YISHU_EVEROS_URL === "string" && env.YISHU_EVEROS_URL.length > 0) {
    return true;
  }
  return env.YISHU_EVEROS === "1" || env.YISHU_EVEROS === "true";
}

export function resolveEverOSBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.YISHU_EVEROS_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/u, "");
  const port = env.YISHU_EVEROS_PORT?.trim() || String(DEFAULT_EVEROS_PORT);
  return `http://127.0.0.1:${port}`;
}

export function resolveEverOSRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = path.resolve(env.HOME?.trim() || homedir());
  const raw = env.YISHU_EVEROS_ROOT?.trim()
    || env.EVEROS_ROOT?.trim()
    || path.join(home, "Library", "Application Support", "Yishu", "EverOS");
  const expanded = raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw;
  const resolved = path.resolve(expanded);
  if (
    resolved === path.parse(resolved).root
    || resolved === home
    || resolved === path.dirname(home)
    || resolved === path.resolve(process.cwd())
  ) {
    throw new Error("everos_root_too_broad");
  }
  return resolved;
}

async function initializeEverOSRoot(
  bin: string,
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (existsSync(path.join(root, "everos.toml"))) return;
  const child = spawn(bin, ["init", "--root", root], {
    env: { ...env, EVEROS_ROOT: root },
    stdio: "ignore",
    detached: false,
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("everos_init_timed_out"));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  if (exitCode !== 0) throw new Error("everos_init_failed");
}

export function explicitEverOSUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.YISHU_EVEROS_URL?.trim();
  return explicit ? explicit.replace(/\/+$/u, "") : undefined;
}

export function resolveEverOSPendingSessionsPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = explicitEverOSUrl(env);
  if (explicit === undefined) {
    return path.join(resolveEverOSRoot(env), ".yishu-pending-sessions.json");
  }
  const identity = resolveAttachedEverOSIdentity(explicit, env);
  const namespace = createHash("sha256")
    .update(JSON.stringify({ explicit, identity }), "utf8")
    .digest("hex")
    .slice(0, 24);
  const home = env.HOME?.trim() || homedir();
  return path.join(
    home,
    "Library",
    "Application Support",
    "Yishu",
    "EverOS Pending",
    `${namespace}.json`,
  );
}

export function resolveEverOSBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.YISHU_EVEROS_BIN && existsSync(env.YISHU_EVEROS_BIN)) return env.YISHU_EVEROS_BIN;
  const venvBin = path.join(env.YISHU_EVEROS_VENV || path.join(homedir(), ".yishu", "everos-venv"), "bin", "everos");
  if (existsSync(venvBin)) return venvBin;
  return undefined;
}

export interface EverOSLlmEnv {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

function oauthStillValid(expires: unknown): boolean {
  if (typeof expires !== "number" || !Number.isFinite(expires)) return true;
  const expiresMs = expires < 1e12 ? expires * 1000 : expires;
  return expiresMs > Date.now() + 30_000;
}

/**
 * EverOS refuses to boot without [llm] api_key + base_url.
 * Prefer process env. Else reuse the existing xAI login. Never write keys to toml.
 */
export async function resolveEverOSLlmEnv(
  env: NodeJS.ProcessEnv = process.env,
  productResolver?: () => Promise<EverOSLlmEnv | undefined>,
): Promise<EverOSLlmEnv | undefined> {
  const explicitKey = env.EVEROS_LLM__API_KEY?.trim();
  const explicitBase = env.EVEROS_LLM__BASE_URL?.trim();
  if (explicitKey && explicitBase) {
    return {
      apiKey: explicitKey,
      baseUrl: explicitBase,
      model: env.EVEROS_LLM__MODEL?.trim() || "grok-4.3",
    };
  }
  if (productResolver !== undefined) {
    const product = await productResolver().catch(() => undefined);
    if (product?.apiKey.trim() && product.baseUrl.trim() && product.model.trim()) {
      return product;
    }
    return undefined;
  }
  if (env.OPENROUTER_API_KEY?.trim()) {
    return {
      apiKey: env.OPENROUTER_API_KEY.trim(),
      baseUrl: "https://openrouter.ai/api/v1",
      model: env.EVEROS_LLM__MODEL?.trim() || "openai/gpt-4.1-mini",
    };
  }
  if (env.OPENAI_API_KEY?.trim()) {
    return {
      apiKey: env.OPENAI_API_KEY.trim(),
      baseUrl: env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
      model: env.EVEROS_LLM__MODEL?.trim() || "gpt-4.1-mini",
    };
  }
  try {
    const store = createYishuCredentialStore();
    const xai = await store.read("xai");
    if (xai?.type !== "oauth" || typeof xai.refresh !== "string" || xai.refresh.length === 0) {
      return undefined;
    }
    let access = typeof xai.access === "string" ? xai.access : "";
    if (access.length === 0 || !oauthStillValid(xai.expires)) {
      const refresh = oauthFlows.xai?.refresh;
      if (refresh === undefined) return undefined;
      const next = await refresh(xai.refresh);
      await store.modify("xai", async () => next);
      access = next.access;
    }
    if (access.length === 0) return undefined;
    return {
      apiKey: access,
      baseUrl: "https://api.x.ai/v1",
      model: env.EVEROS_LLM__MODEL?.trim() || "grok-4.3",
    };
  } catch {
    return undefined;
  }
}

async function healthSnapshot(
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; embed: boolean }> {
  try {
    const response = await fetchImpl(`${baseUrl}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return { ok: false, embed: false };
    const body = await response.json() as {
      status?: unknown;
      version?: unknown;
      capabilities?: { embed?: unknown };
      cascade?: { healthy?: unknown };
    };
    const compatible = body.status === "ok"
      && typeof body.version === "string"
      && /^1\./u.test(body.version)
      && body.cascade?.healthy === true;
    return { ok: compatible, embed: compatible && body.capabilities?.embed === true };
  } catch {
    return { ok: false, embed: false };
  }
}

export function resolveAttachedEverOSIdentity(
  _baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): EverOSIdentity {
  const identity = {
    appId: env.EVEROS_APP_ID?.trim() || DEFAULT_EVEROS_IDENTITY.appId,
    userId: env.EVEROS_USER_ID?.trim() || DEFAULT_EVEROS_IDENTITY.userId,
    personalProjectId: env.EVEROS_PERSONAL_PROJECT_ID?.trim()
      || DEFAULT_EVEROS_IDENTITY.personalProjectId,
  };
  assertValidEverOSIdentity(identity);
  return identity;
}

export class EverOSSidecar {
  private child: ChildProcess | undefined;
  private ready: Promise<EverOSMemoryPort> | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly llmEnvResolver: (() => Promise<EverOSLlmEnv | undefined>) | undefined;

  constructor(options: EverOSSidecarOptions = {}) {
    this.env = envOf(options);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.llmEnvResolver = options.llmEnvResolver;
  }

  memory(): EverOSMemoryPort {
    const pending = this;
    return {
      add: async (input) => {
        const client = await pending.ensure();
        await client.add(input);
      },
      flush: async (input) => {
        const client = await pending.ensure();
        await client.flush(input);
      },
      search: async (input) => {
        const client = await pending.ensure();
        return client.search(input);
      },
      profile: async (input) => {
        const client = await pending.ensure();
        return client.profile(input);
      },
      dispose: async () => pending.dispose(),
    };
  }

  async ensure(): Promise<EverOSMemoryPort> {
    if (this.ready === undefined) {
      this.ready = this.start();
    }
    return this.ready;
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child === undefined || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => {
        stopTimer = setTimeout(() => resolve(false), 750);
      }),
    ]);
    if (stopTimer !== undefined) clearTimeout(stopTimer);
    if (!stopped && child.exitCode === null) {
      child.kill("SIGKILL");
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          killTimer = setTimeout(resolve, 250);
        }),
      ]);
      if (killTimer !== undefined) clearTimeout(killTimer);
    }
  }

  private async start(): Promise<EverOSMemoryPort> {
    const explicit = explicitEverOSUrl(this.env);
    if (explicit !== undefined) {
      const health = await healthSnapshot(explicit, this.fetchImpl);
      if (!health.ok) throw new Error("everos_explicit_unhealthy");
      return new EverOSHttpClient({
        baseUrl: explicit,
        fetchImpl: this.fetchImpl,
        identity: resolveAttachedEverOSIdentity(explicit, this.env),
        searchMethod: health.embed ? "hybrid" : "keyword",
      });
    }
    const baseUrl = resolveEverOSBaseUrl(this.env);
    const bin = resolveEverOSBin(this.env);
    if (bin === undefined) {
      throw new Error("everos_cli_missing");
    }
    const llm = await resolveEverOSLlmEnv(this.env, this.llmEnvResolver);
    if (llm === undefined) {
      throw new Error("everos_llm_missing");
    }
    const root = resolveEverOSRoot(this.env);
    const identity = resolveAttachedEverOSIdentity(baseUrl, this.env);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await initializeEverOSRoot(bin, root, this.env);
    if (shouldMigrateLegacyEverOS(this.env)) {
      const home = this.env.HOME?.trim() || homedir();
      await migrateLegacyEverOSUserMemory({
        sourceUserRoot: this.env.YISHU_EVEROS_LEGACY_USER_ROOT?.trim()
          || path.join(home, ".everos", "jarvis", "yishu", "users", "yishu"),
        destinationRoot: root,
        destinationIdentity: identity,
        markerPath: path.join(home, ".everos", ".yishu-product-migrated-v1"),
      });
    }
    const port = Number(new URL(baseUrl).port || DEFAULT_EVEROS_PORT);
    const child = spawn(bin, ["server", "start", "--root", root, "--host", "127.0.0.1", "--port", String(port)], {
      env: {
        ...this.env,
        EVEROS_ROOT: root,
        EVEROS_API__HOST: "127.0.0.1",
        EVEROS_API__PORT: String(port),
        EVEROS_LLM__API_KEY: llm.apiKey,
        EVEROS_LLM__BASE_URL: llm.baseUrl,
        EVEROS_LLM__MODEL: llm.model,
        EVEROS_MEMORIZE__MODE: "chat",
      },
      stdio: "ignore",
      detached: false,
    });
    this.child = child;
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (child.exitCode !== null) {
      throw new Error("everos_sidecar_exited");
    }
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("everos_sidecar_exited");
      const health = await healthSnapshot(baseUrl, this.fetchImpl);
      if (health.ok && child.exitCode === null) {
        return new EverOSHttpClient({
          baseUrl,
          fetchImpl: this.fetchImpl,
          identity,
          searchMethod: health.embed ? "hybrid" : "keyword",
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    child.kill("SIGTERM");
    throw new Error("everos_sidecar_unhealthy");
  }
}

export function createProductEverOS(
  env: NodeJS.ProcessEnv = process.env,
  options: Pick<EverOSSidecarOptions, "llmEnvResolver"> = {},
): EverOSMemoryPort | undefined {
  if (!everosEnabled(env)) return undefined;
  return new EverOSSidecar({ env, ...options }).memory();
}

export function everosVendorPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../vendor/everos");
}
