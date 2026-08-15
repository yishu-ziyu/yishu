import { randomUUID } from "node:crypto";
import {
  AUTH_CONTROLLED_MODEL_IDS,
  AUTH_PROVIDER_IDS,
  type AuthDeviceCodePayload,
  type AuthFailureCode,
  type AuthFailurePayload,
  type AuthInfoPayload,
  type AuthProgressPayload,
  type AuthPrompt,
  type AuthPromptPayload,
  type AuthProviderId,
  type AuthPublicModel,
  type AuthPublicStatus,
  type AuthUrlPayload,
} from "./auth-protocol.js";

type PiAuthPrompt = AuthPrompt & { signal?: AbortSignal };
type PiAuthEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };

export interface AuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: PiAuthPrompt): Promise<string>;
  notify(event: PiAuthEvent): void;
}

interface AuthModelLike {
  id: string;
  name?: string;
  provider?: string;
}

interface AuthProviderLike {
  id: string;
  auth?: {
    oauth?: unknown;
    apiKey?: unknown;
  };
}

/** Structural subset makes AuthService straightforward to test without login/network. */
export interface AuthModelRuntime {
  getProvider(providerId: string): AuthProviderLike | undefined;
  getAvailable(providerId: string): Promise<readonly AuthModelLike[]>;
  checkAuth(providerId: string): Promise<{ type: "api_key" | "oauth" } | undefined>;
  getAuth(providerId: string): Promise<unknown>;
  login(providerId: string, type: "oauth", interaction: AuthInteraction): Promise<unknown>;
  logout(providerId: string): Promise<void>;
}

export type AuthTransitionKind = "login" | "logout" | "relogin_required";

export class AuthServiceError extends Error {
  constructor(readonly code: AuthFailureCode, message: string) {
    super(message);
    this.name = "AuthServiceError";
  }
}

/** Runtime-owned barrier for dropping old provider sessions before credentials change. */
export interface AuthTransitionHooks {
  beginProviderTransition?(provider: AuthProviderId, kind: AuthTransitionKind): Promise<void>;
  endProviderTransition?(provider: AuthProviderId, kind: AuthTransitionKind): void;
}

export type AuthServiceEvent =
  | { type: "auth.status"; payload: AuthPublicStatus }
  | { type: "auth.prompt"; payload: AuthPromptPayload }
  | { type: "auth.info"; payload: AuthInfoPayload }
  | { type: "auth.url"; payload: AuthUrlPayload }
  | { type: "auth.device_code"; payload: AuthDeviceCodePayload }
  | { type: "auth.progress"; payload: AuthProgressPayload }
  | { type: "auth.completed"; payload: AuthPublicStatus }
  | { type: "auth.failed"; payload: AuthFailurePayload }
  | { type: "auth.logged_out"; payload: AuthPublicStatus };

export interface AuthRequestContext {
  requestId: string;
  traceId: string;
}

interface PendingPrompt {
  resolve(value: string): void;
  reject(error: Error): void;
  cleanup(): void;
}

interface PendingLogin {
  provider: AuthProviderId;
  abort: AbortController;
  prompts: Map<string, PendingPrompt>;
  settled: Promise<void>;
  settle(): void;
  transitionBegun: boolean;
}

function isAuthProvider(value: string): value is AuthProviderId {
  return (AUTH_PROVIDER_IDS as readonly string[]).includes(value);
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && /cancel|abort/i.test(error.message);
}

function safeText(value: unknown, fallback: string, maxLength = 500): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return fallback;
  return text.slice(0, maxLength);
}

const SENSITIVE_MESSAGE_MARKER = /access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|account[_-]?id|credential|authorization|password|secret|bearer|\btoken\b|jwt|\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/i;

function safePublicMessage(value: unknown, fallback: string, maxLength = 500): string {
  const text = safeText(value, fallback, maxLength);
  return SENSITIVE_MESSAGE_MARKER.test(text) ? fallback : text;
}

/** Do not expose OAuth response bodies, bearer values, JWTs, or account ids. */
export function safeRuntimeErrorMessage(error: unknown, fallback = "Pi runtime operation failed."): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!raw) return fallback;
  if (
    /access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|password|authorization|bearer|account[_-]?id|credential|secret|\btoken\b|\bjwt\b/i.test(raw)
    || /\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/.test(raw)
  ) {
    return fallback;
  }
  return raw.slice(0, 500);
}

function safeAuthFailure(error: unknown, signal?: AbortSignal): { code: AuthFailureCode; message: string } {
  if (isAbortError(error, signal)) {
    return { code: "cancelled", message: "OAuth 登录已取消。" };
  }
  const raw = error instanceof Error ? error.message : "";
  if (/storage|auth\.json|credential|lock/i.test(raw)) {
    return { code: "storage_failed", message: "登录凭据存储失败，请稍后重试。" };
  }
  if (/relogin|expired|refresh|unauthori[sz]|401/i.test(raw)) {
    return { code: "relogin_required", message: "登录已失效，请重新登录。" };
  }
  return { code: "oauth_failed", message: "OAuth 登录失败，请重试。" };
}

function isStorageError(error: unknown): boolean {
  if (error instanceof AuthServiceError) return error.code === "storage_failed";
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /auth\.json|credential store|storage|lock|EACCES|EPERM|EISDIR/i.test(raw);
}

export function safeAuthUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return undefined;
  // Authorization URLs normally contain state/code_challenge.  A URL carrying
  // a token or a callback code is not safe to put on the wire.
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return undefined;
    if (parsed.username || parsed.password) return undefined;
    const sensitiveKey = /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|code|code[_-]?verifier|api[_-]?key|client[_-]?secret|secret|authorization|bearer)$/i;
    const credentialValue = /^(?:bearer\s+)?eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}$/i;
    for (const [key, parameterValue] of parsed.searchParams) {
      if (sensitiveKey.test(key)) return undefined;
      if (credentialValue.test(parameterValue)) return undefined;
    }
    const fragment = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
    if (fragment) {
      for (const [key, parameterValue] of new URLSearchParams(fragment)) {
        if (sensitiveKey.test(key)) return undefined;
        if (credentialValue.test(parameterValue)) return undefined;
      }
    }
  } catch {
    return undefined;
  }
  return value;
}

function publicPrompt(prompt: PiAuthPrompt): AuthPrompt {
  switch (prompt.type) {
    case "select":
      return {
        type: "select",
        message: safeText(prompt.message, "选择登录方式。"),
        options: prompt.options.slice(0, 16).map((option) => ({
          id: safeText(option.id, "option", 120),
          label: safeText(option.label, "选项", 200),
          ...(option.description ? { description: safeText(option.description, "", 500) } : {}),
        })),
      };
    case "secret":
      return {
        type: "secret",
        message: safeText(prompt.message, "请输入登录信息。"),
        ...(prompt.placeholder ? { placeholder: safeText(prompt.placeholder, "", 200) } : {}),
      };
    case "manual_code":
      return {
        type: "manual_code",
        message: safeText(prompt.message, "请输入授权码。"),
        ...(prompt.placeholder ? { placeholder: safeText(prompt.placeholder, "", 200) } : {}),
      };
    case "text":
      return {
        type: "text",
        message: safeText(prompt.message, "请输入信息。"),
        ...(prompt.placeholder ? { placeholder: safeText(prompt.placeholder, "", 200) } : {}),
      };
  }
}

/**
 * Fail-closed invariant guard for the product-owned provider registry: the
 * subscription providers must never carry an ambient API-key path. The
 * registry is OAuth-only by construction (ADR 0014), so this only asserts
 * that structural property instead of rewriting providers.
 */
export function installProductOAuthProviderPolicy(
  runtime: Pick<AuthModelRuntime, "getProvider">,
): void {
  for (const providerId of AUTH_PROVIDER_IDS) {
    const provider = runtime.getProvider(providerId);
    if (provider?.auth?.apiKey) {
      throw new Error(`Ambient API-key auth must not exist for ${providerId}.`);
    }
  }
}

/** Require an OAuth subscription credential, never an API-key credential. */
export async function requireOAuthSubscriptionAuth(
  runtime: Pick<AuthModelRuntime, "checkAuth" | "getAuth">,
  provider: AuthProviderId,
): Promise<unknown> {
  const check = await runtime.checkAuth(provider);
  if (check?.type !== "oauth") {
    throw new Error(`OAuth is not configured for ${provider}.`);
  }
  const auth = await runtime.getAuth(provider);
  if (!auth) throw new Error(`OAuth is not configured for ${provider}.`);
  return auth;
}

export class YishuAuthService {
  private readonly pending = new Map<string, PendingLogin>();
  /** Serializes login/logout transitions per provider, not just per request. */
  private readonly providerTransitions = new Map<AuthProviderId, AuthTransitionKind>();

  constructor(
    private readonly runtimePromise: Promise<AuthModelRuntime>,
    private readonly hooks: AuthTransitionHooks = {},
  ) {}

  async status(providerId?: AuthProviderId): Promise<readonly AuthPublicStatus[]> {
    const runtime = await this.runtimePromise;
    const providers = providerId ? [providerId] : [...AUTH_PROVIDER_IDS];
    const statuses = await Promise.all(providers.map((provider) => this.statusOne(runtime, provider)));
    for (const status of statuses) {
      if (status.requiresRelogin) await this.reloginRequired(status.provider);
    }
    return statuses;
  }

  async startLogin(
    context: AuthRequestContext,
    provider: AuthProviderId,
    emit: (event: AuthServiceEvent) => void,
  ): Promise<void> {
    if (!isAuthProvider(provider)) {
      emit({
        type: "auth.failed",
        payload: { provider: "xai", code: "invalid_request", message: "不支持的登录提供方。" },
      });
      return;
    }
    if (
      this.pending.has(context.requestId)
      || this.providerTransitions.has(provider)
      || [...this.pending.values()].some((session) => session.provider === provider)
    ) {
      emit({
        type: "auth.failed",
        payload: { provider, code: "invalid_request", message: "已有登录流程正在进行。" },
      });
      return;
    }

    let settle!: () => void;
    const session: PendingLogin = {
      provider,
      abort: new AbortController(),
      prompts: new Map(),
      settled: new Promise<void>((resolve) => { settle = resolve; }),
      settle: () => settle(),
      transitionBegun: false,
    };
    this.providerTransitions.set(provider, "login");
    this.pending.set(context.requestId, session);

    const interaction: AuthInteraction = {
      signal: session.abort.signal,
      prompt: (prompt) => this.waitForPrompt(context, session, prompt, emit),
      notify: (event) => this.forwardPiEvent(provider, event, emit),
    };

    try {
      const runtime = await this.runtimePromise;
      const existingAuth = await runtime.checkAuth(provider);
      if (existingAuth?.type === "oauth") {
        let existingCredentialIsUsable = false;
        try {
          existingCredentialIsUsable = Boolean(await runtime.getAuth(provider));
        } catch {
          // Expired/refresh-failed credentials are the explicit relogin case.
        }
        if (existingCredentialIsUsable) {
          emit({
            type: "auth.failed",
            payload: { provider, code: "invalid_request", message: "请先退出当前账号，再登录其他账号。" },
          });
          return;
        }
      }
      await this.hooks.beginProviderTransition?.(provider, "login");
      session.transitionBegun = true;
      if (existingAuth?.type === "oauth") {
        // A refresh-failed credential is explicitly a relogin path. Remove it
        // before OAuth starts so cancelling cannot delete a still-usable A
        // account or leave a stale credential behind.
        await runtime.logout(provider);
      }
      await runtime.login(provider, "oauth", interaction);
      if (session.abort.signal.aborted) {
        await this.discardCancelledCredential(runtime, provider, emit);
        return;
      }
      const status = (await this.status(provider))[0];
      if (session.abort.signal.aborted) {
        await this.discardCancelledCredential(runtime, provider, emit);
        return;
      }
      if (!status?.configured) {
        emit({
          type: "auth.failed",
          payload: { provider, code: "oauth_failed", message: "登录未完成，请重试。" },
        });
        return;
      }
      emit({ type: "auth.completed", payload: status });
    } catch (error) {
      const runtime = await this.runtimePromise.catch(() => undefined);
      if (session.abort.signal.aborted) {
        if (runtime) await this.discardCancelledCredential(runtime, provider, emit);
        else emit({ type: "auth.failed", payload: { provider, code: "cancelled", message: "OAuth 登录已取消。" } });
      } else {
        const failure = safeAuthFailure(error, session.abort.signal);
        emit({ type: "auth.failed", payload: { provider, ...failure } });
      }
    } finally {
      for (const prompt of session.prompts.values()) {
        prompt.cleanup();
        prompt.reject(new Error("OAuth login cancelled."));
      }
      this.pending.delete(context.requestId);
      session.settle();
      if (this.providerTransitions.get(provider) === "login") {
        this.providerTransitions.delete(provider);
        if (session.transitionBegun) this.hooks.endProviderTransition?.(provider, "login");
      }
    }
  }

  replyPrompt(requestId: string, provider: AuthProviderId, promptId: string, value: string): boolean {
    const session = this.pending.get(requestId);
    const prompt = session?.prompts.get(promptId);
    if (!session || session.provider !== provider || !prompt) return false;
    session.prompts.delete(promptId);
    prompt.cleanup();
    // The value remains transient input to Pi's OAuth flow.  It is never put
    // in an event payload, exception, log, or trace.
    prompt.resolve(value);
    return true;
  }

  cancelLogin(requestId: string, provider: AuthProviderId): boolean {
    const session = this.pending.get(requestId);
    if (!session || session.provider !== provider) return false;
    session.abort.abort();
    return true;
  }

  async logout(
    context: AuthRequestContext,
    provider: AuthProviderId,
    emit: (event: AuthServiceEvent) => void,
  ): Promise<void> {
    const existingTransition = this.providerTransitions.get(provider);
    if (existingTransition === "logout") {
      emit({
        type: "auth.failed",
        payload: { provider, code: "invalid_request", message: "提供方正在切换登录状态。" },
      });
      return;
    }
    this.providerTransitions.set(provider, "logout");
    const pending = [...this.pending.values()].filter((session) => session.provider === provider);
    for (const session of pending) session.abort.abort();
    try {
      // A provider logout must wait for every in-flight login, including a Pi
      // flow that ignores AbortSignal briefly, before deleting credentials.
      await Promise.all(pending.map((session) => session.settled));
      if (!pending.some((session) => session.transitionBegun)) {
        await this.hooks.beginProviderTransition?.(provider, "logout");
      }
      const runtime = await this.runtimePromise;
      await runtime.logout(provider);
      const status = (await this.status(provider))[0];
      if (status) emit({ type: "auth.logged_out", payload: status });
    } catch (error) {
      const failure = safeAuthFailure(error);
      emit({ type: "auth.failed", payload: { provider, ...failure } });
    } finally {
      if (this.providerTransitions.get(provider) === "logout") {
        this.providerTransitions.delete(provider);
        this.hooks.endProviderTransition?.(provider, "logout");
      }
    }
  }

  async reloginRequired(provider: AuthProviderId): Promise<void> {
    if (this.providerTransitions.has(provider)) return;
    this.providerTransitions.set(provider, "relogin_required");
    try {
      await this.hooks.beginProviderTransition?.(provider, "relogin_required");
    } finally {
      if (this.providerTransitions.get(provider) === "relogin_required") {
        this.providerTransitions.delete(provider);
        this.hooks.endProviderTransition?.(provider, "relogin_required");
      }
    }
  }

  private async discardCancelledCredential(
    runtime: AuthModelRuntime,
    provider: AuthProviderId,
    emit: (event: AuthServiceEvent) => void,
  ): Promise<void> {
    try {
      // Pi may return a credential despite AbortSignal. Logout is the only
      // product-owned cleanup path that guarantees it cannot survive cancel.
      await runtime.logout(provider);
      emit({ type: "auth.failed", payload: { provider, code: "cancelled", message: "OAuth 登录已取消。" } });
    } catch (error) {
      const failure = safeAuthFailure(error);
      emit({ type: "auth.failed", payload: { provider, ...failure } });
    }
  }

  private async statusOne(runtime: AuthModelRuntime, provider: AuthProviderId): Promise<AuthPublicStatus> {
    let configured = false;
    let requiresRelogin = false;
    try {
      // checkAuth is provider-scoped and therefore cannot treat an ambient
      // OPENAI_API_KEY/XAI_API_KEY as a subscription after the policy wrapper.
      const check = await runtime.checkAuth(provider);
      configured = check?.type === "oauth";
      if (configured) {
        try {
          // getAuth owns refresh under Pi's credential-store lock.  We discard
          // the result immediately and only expose the boolean outcome.
          const resolved = await runtime.getAuth(provider);
          if (!resolved) {
            configured = false;
            requiresRelogin = true;
          }
        } catch (error) {
          if (isStorageError(error)) throw new AuthServiceError("storage_failed", "登录凭据存储不可用。");
          requiresRelogin = true;
        }
      }
    } catch (error) {
      if (isStorageError(error)) throw new AuthServiceError("storage_failed", "登录凭据存储不可用。");
      requiresRelogin = configured;
    }

    let models: AuthPublicModel[] = [];
    if (configured) {
      try {
        const allowed = new Set<string>(AUTH_CONTROLLED_MODEL_IDS[provider]);
        const available = await runtime.getAvailable(provider);
        models = available
          .filter((model) => allowed.has(model.id))
          .map((model) => ({
            provider,
            id: model.id,
            name: safeText(model.name, model.id, 200),
          }));
      } catch (error) {
        if (isStorageError(error)) throw new AuthServiceError("storage_failed", "登录凭据存储不可用。");
        models = [];
      }
    }

    return {
      provider,
      configured,
      authType: "oauth",
      models,
      ...(requiresRelogin ? { requiresRelogin: true } : {}),
      ...(provider === "xai" ? { experimental: "experimental_local_subscription" as const } : {}),
    };
  }

  private waitForPrompt(
    context: AuthRequestContext,
    session: PendingLogin,
    prompt: PiAuthPrompt,
    emit: (event: AuthServiceEvent) => void,
  ): Promise<string> {
    const promptId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        session.prompts.delete(promptId);
        cleanup();
        reject(new Error("OAuth login cancelled."));
      };
      const cleanup = (): void => {
        session.abort.signal.removeEventListener("abort", onAbort);
        prompt.signal?.removeEventListener("abort", onAbort);
      };
      session.prompts.set(promptId, { resolve, reject, cleanup });
      session.abort.signal.addEventListener("abort", onAbort, { once: true });
      prompt.signal?.addEventListener("abort", onAbort, { once: true });
      if (session.abort.signal.aborted || prompt.signal?.aborted) {
        onAbort();
        return;
      }
      emit({
        type: "auth.prompt",
        payload: {
          provider: session.provider,
          promptId,
          prompt: publicPrompt(prompt),
        },
      });
    });
  }

  private forwardPiEvent(
    provider: AuthProviderId,
    event: PiAuthEvent,
    emit: (event: AuthServiceEvent) => void,
  ): void {
    if (event.type === "info") {
      const links = event.links
        ?.map((link) => {
          const url = safeAuthUrl(link.url);
          return url ? { url, ...(link.label ? { label: safeText(link.label, "", 200) } : {}) } : undefined;
        })
        .filter((link): link is { url: string; label?: string } => link !== undefined);
      emit({
        type: "auth.info",
        payload: {
          provider,
          message: safePublicMessage(event.message, "请按提示完成登录。"),
          ...(links && links.length > 0 ? { links } : {}),
        },
      });
      return;
    }
    if (event.type === "auth_url") {
      const url = safeAuthUrl(event.url);
      if (!url) {
        emit({ type: "auth.info", payload: { provider, message: "请在登录页面完成授权。" } });
        return;
      }
      emit({
        type: "auth.url",
        payload: {
          provider,
          url,
          ...(event.instructions ? { instructions: safePublicMessage(event.instructions, "请在登录页面完成授权。", 500) } : {}),
        },
      });
      return;
    }
    if (event.type === "device_code") {
      emit({
        type: "auth.device_code",
        payload: {
          provider,
          userCode: safeText(event.userCode, "", 200),
          verificationUri: safeAuthUrl(event.verificationUri) ?? "https://example.invalid/",
          ...(event.intervalSeconds !== undefined ? { intervalSeconds: event.intervalSeconds } : {}),
          ...(event.expiresInSeconds !== undefined ? { expiresInSeconds: event.expiresInSeconds } : {}),
        },
      });
      return;
    }
    emit({
      type: "auth.progress",
      payload: { provider, message: safePublicMessage(event.message, "正在完成登录。") },
    });
  }
}

export function authServiceEventType(event: AuthServiceEvent): AuthServiceEvent["type"] {
  return event.type;
}
