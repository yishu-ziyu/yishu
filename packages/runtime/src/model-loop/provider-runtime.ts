import type { CodexAccount } from "../providers/codex-account.js";
/**
 * Product-owned provider registry (ADR 0014).
 *
 * Replaces the previous engine's ModelRuntime. Providers are OAuth-only by
 * construction: there is no ambient API-key resolution path (the previous
 * `installProductOAuthProviderPolicy` guard is now structural).
 */

import type { YishuCredentialStore } from "../auth-store.js";
import {
  defaultLocalModelConfig,
  providerById,
  resolveEffectiveApiKey,
  withEffectiveChatExit,
  type LocalModelConfig,
  type LocalModelProviderConfig,
} from "../model-config.js";
import { LOCAL_GROK_BASE_URL, LOCAL_GROK_PROVIDER } from "../protocol.js";
import {
  isExpiring,
  oauthFlows,
  type OAuthCredential,
  type OAuthInteraction,
} from "./oauth.js";
import type {
  ModelProviderRuntime,
  ProviderDefinition,
  ProviderModelListing,
  ResolvedModel,
} from "./types.js";

export { LOCAL_GROK_BASE_URL, LOCAL_GROK_PROVIDER };

/** The local Grok loopback bearer. Not a secret; see the loop adapter. */
export interface LocalGrokBearer {
  value(): string;
}

const LOCAL_GROK_CONTEXT_WINDOW = 128_000;
const LOCAL_GROK_MAX_TOKENS = 8_192;

function localGrokModel(id: string, baseUrl: string): ProviderModelListing & ResolvedModel {
  return {
    id,
    name: id,
    providerId: LOCAL_GROK_PROVIDER,
    api: "openai-completions",
    baseUrl,
    input: ["text", "image"],
    contextWindow: LOCAL_GROK_CONTEXT_WINDOW,
    maxTokens: LOCAL_GROK_MAX_TOKENS,
  };
}

const XAI_PROVIDER: ProviderDefinition = {
  id: "xai",
  name: "xAI",
  baseUrl: "https://api.x.ai/v1",
  oauth: true,
  models: [
    { id: "grok-4.3", name: "Grok 4.3" },
    { id: "grok-build-0.1", name: "Grok Build 0.1" },
  ],
};

const CODEX_PROVIDER: ProviderDefinition = {
  id: "openai-codex",
  name: "OpenAI Codex",
  baseUrl: "https://chatgpt.com/backend-api",
  oauth: true,
  models: [
    { id: "gpt-6-astra", name: "GPT-6 Astra" },
    { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
  ],
};

export interface YishuProviderRuntimeOptions {
  credentialStore: YishuCredentialStore;
  localGrokBearer: LocalGrokBearer;
  modelConfig?: LocalModelConfig;
  codexAccount?: CodexAccount;
}

export class YishuProviderRuntime implements ModelProviderRuntime {
  private readonly localGrokModels = new Map<string, ReturnType<typeof localGrokModel>>();
  private readonly providerVersions = new Map<string, number>();

  constructor(private readonly options: YishuProviderRuntimeOptions) {
    const cfg = this.localGrokProvider();
    for (const modelId of cfg.models) {
      this.localGrokModels.set(modelId, localGrokModel(modelId, cfg.baseUrl));
    }
  }

  private modelConfig(): LocalModelConfig {
    return this.options.modelConfig ?? defaultLocalModelConfig();
  }

  private localGrokProvider(): LocalModelProviderConfig {
    const config = this.modelConfig();
    return withEffectiveChatExit(config, providerById(config));
  }

  getProvider(providerId: string): ProviderDefinition | undefined {
    if (providerId === LOCAL_GROK_PROVIDER) {
      return {
        id: LOCAL_GROK_PROVIDER,
        name: this.localGrokProvider().name,
        baseUrl: this.localGrokProvider().baseUrl,
        oauth: false,
        models: [...this.localGrokModels.values()].map(({ id, name }) => ({ id, name })),
      };
    }
    if (providerId === XAI_PROVIDER.id) return XAI_PROVIDER;
    if (providerId === CODEX_PROVIDER.id) return CODEX_PROVIDER;
    return undefined;
  }

  async getAvailable(providerId: string): Promise<readonly ProviderModelListing[]> {
    if (providerId === CODEX_PROVIDER.id && this.options.codexAccount) {
      return (await this.options.codexAccount.read()).models;
    }
    const provider = this.getProvider(providerId);
    return provider?.models ?? [];
  }

  async checkAuth(providerId: string): Promise<{ type: "api_key" | "oauth" } | undefined> {
    if (providerId === LOCAL_GROK_PROVIDER) {
      const config = this.modelConfig();
      const provider = this.localGrokProvider();
      const key = resolveEffectiveApiKey(config, providerById(config))
        ?? this.options.localGrokBearer.value();
      return key && key.length > 0 ? { type: "api_key" } : undefined;
    }
    if (providerId === CODEX_PROVIDER.id && this.options.codexAccount) {
      return (await this.options.codexAccount.read()).account ? { type: "oauth" } : undefined;
    }
    const provider = this.getProvider(providerId);
    if (!provider?.oauth) return undefined;
    const credential = await this.readCredential(providerId);
    return credential?.type === "oauth" ? { type: "oauth" } : undefined;
  }

  async getAuth(providerId: string): Promise<unknown> {
    if (providerId === CODEX_PROVIDER.id && this.options.codexAccount) return (await this.options.codexAccount.read()).account;
    if (providerId === LOCAL_GROK_PROVIDER) {
      const config = this.modelConfig();
      const key = resolveEffectiveApiKey(config, providerById(config))
        ?? this.options.localGrokBearer.value();
      return key && key.length > 0 ? { apiKey: key } : undefined;
    }
    const credential = await this.usableCredential(providerId);
    if (!credential) return undefined;
    const email = typeof credential.email === "string" ? credential.email : undefined;
    return email
      ? { apiKey: credential.access, email }
      : { apiKey: credential.access };
  }

  async login(providerId: string, _type: "oauth", interaction: OAuthInteraction): Promise<unknown> {
    if (providerId === CODEX_PROVIDER.id && this.options.codexAccount) {
      const account = await this.options.codexAccount.login(interaction);
      this.bumpVersion(providerId);
      return account;
    }
    const flow = oauthFlows[providerId];
    if (!flow) throw new Error(`OAuth is not supported for ${providerId}.`);
    const credential = await flow.login(interaction);
    await this.options.credentialStore.modify(providerId, async () => credential);
    this.bumpVersion(providerId);
    return { apiKey: credential.access };
  }

  async logout(providerId: string): Promise<void> {
    if (providerId === CODEX_PROVIDER.id && this.options.codexAccount) {
      await this.options.codexAccount.logout(); this.bumpVersion(providerId); return;
    }
    await this.options.credentialStore.delete(providerId);
    this.bumpVersion(providerId);
  }

  async resolveModel(providerId: string, modelId: string): Promise<ResolvedModel> {
    if (providerId === LOCAL_GROK_PROVIDER) {
      const baseUrl = this.localGrokProvider().baseUrl;
      let model = this.localGrokModels.get(modelId);
      if (!model || model.baseUrl !== baseUrl) {
        model = localGrokModel(modelId, baseUrl);
        this.localGrokModels.set(modelId, model);
      }
      return model;
    }
    const provider = this.getProvider(providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    const listing = provider.models.find((candidate) => candidate.id === modelId);
    if (!listing) throw new Error(`Model is unavailable: ${providerId}/${modelId}`);
    if (providerId === CODEX_PROVIDER.id && this.options.codexAccount) {
      const state = await this.options.codexAccount.read();
      if (!state.account || !state.models.some((model) => model.id === modelId)) throw new Error("Codex 登录或模型不可用。");
      return { providerId, id: modelId, name: listing.name ?? modelId, api: "codex-app-server",
        baseUrl: "stdio://codex-app-server", input: ["text", "image"], contextWindow: 128_000, maxTokens: 16_384 };
    }
    if (provider.oauth) {
      const credential = await this.usableCredential(providerId);
      if (!credential) throw new Error(`OAuth is not configured for ${providerId}.`);
    }
    return {
      providerId,
      id: listing.id,
      name: listing.name ?? listing.id,
      api: providerId === CODEX_PROVIDER.id ? "codex-responses" : "openai-completions",
      baseUrl: provider.baseUrl,
      input: providerId === CODEX_PROVIDER.id ? ["text"] : ["text", "image"],
      contextWindow: 128_000,
      maxTokens: 16_384,
    };
  }

  async bearer(providerId: string): Promise<string> {
    if (providerId === CODEX_PROVIDER.id && this.options.codexAccount) throw new Error("Codex 订阅通过 App Server 执行，不提供 bearer。");
    if (providerId === LOCAL_GROK_PROVIDER) {
      const config = this.modelConfig();
      const key = resolveEffectiveApiKey(config, providerById(config))
        ?? this.options.localGrokBearer.value();
      if (key && key.length > 0) return key;
    }
    const credential = await this.usableCredential(providerId);
    if (!credential) throw new Error(`OAuth is not configured for ${providerId}.`);
    return credential.access;
  }

  async extraHeaders(providerId: string): Promise<Record<string, string>> {
    if (providerId !== CODEX_PROVIDER.id || this.options.codexAccount) return {};
    const credential = await this.usableCredential(providerId);
    if (!credential?.accountId) return {};
    return { "chatgpt-account-id": credential.accountId };
  }

  providerVersion(providerId: string): number {
    return this.providerVersions.get(providerId) ?? 0;
  }

  private bumpVersion(providerId: string): void {
    this.providerVersions.set(providerId, (this.providerVersions.get(providerId) ?? 0) + 1);
  }

  private async readCredential(providerId: string): Promise<OAuthCredential | undefined> {
    const credential = await this.options.credentialStore.read(providerId);
    return credential?.type === "oauth" ? credential : undefined;
  }

  /** Returns a credential with a live access token, refreshing when near expiry. */
  private async usableCredential(providerId: string): Promise<OAuthCredential | undefined> {
    let credential = await this.readCredential(providerId);
    if (!credential) return undefined;
    if (!isExpiring(credential)) return credential;
    const flow = oauthFlows[providerId];
    if (!flow) return credential;
    try {
      const refreshed = await this.options.credentialStore.modify(
        providerId,
        async (current) => {
          // Another process may have refreshed while we waited on the lock.
          if (current?.type === "oauth" && !isExpiring(current)) return current;
          if (current?.type !== "oauth") return undefined;
          const next = await flow.refresh(current.refresh);
          if (typeof current.email === "string" && typeof next.email !== "string") {
            return { ...next, email: current.email };
          }
          return next;
        },
      );
      if (refreshed?.type === "oauth") credential = refreshed;
    } catch {
      // A failed refresh surfaces as an auth failure on the next turn; the
      // stale credential is kept so status() can flag relogin.
    }
    return credential;
  }
}

export function createYishuProviderRuntime(options: YishuProviderRuntimeOptions): YishuProviderRuntime {
  return new YishuProviderRuntime(options);
}
