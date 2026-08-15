/**
 * OAuth flows for the two subscription providers (ADR 0014).
 *
 * Endpoint/client values are the public provider configurations the previous
 * engine shipped with; the flows are reimplemented against the product's own
 * interaction contract (see auth-service `AuthInteraction`).
 */

import { createHash, randomBytes } from "node:crypto";

export interface OAuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: AuthFlowPrompt): Promise<string>;
  notify(event: AuthFlowEvent): void;
}

export type AuthFlowPrompt =
  | {
    type: "select";
    message: string;
    options: readonly { id: string; label: string }[];
  }
  | {
    type: "manual_code";
    message: string;
    placeholder?: string;
  };

export type AuthFlowEvent =
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };

export interface OAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  [key: string]: unknown;
}

/** Uniform fetch wrapper so every call site satisfies one RequestInit shape. */
async function oauthFetch(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  return signal ? fetch(url, { ...init, signal }) : fetch(url, init);
}

const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTH_BASE = "https://auth.openai.com";
const CODEX_AUTHORIZE_URL = `${CODEX_AUTH_BASE}/oauth/authorize`;
const CODEX_TOKEN_URL = `${CODEX_AUTH_BASE}/oauth/token`;
const CODEX_DEVICE_USER_CODE_URL = `${CODEX_AUTH_BASE}/api/accounts/deviceauth/usercode`;
const CODEX_DEVICE_TOKEN_URL = `${CODEX_AUTH_BASE}/api/accounts/deviceauth/token`;
const CODEX_DEVICE_VERIFICATION_URI = `${CODEX_AUTH_BASE}/codex/device`;
const CODEX_DEVICE_REDIRECT_URI = `${CODEX_AUTH_BASE}/deviceauth/callback`;
const CODEX_BROWSER_REDIRECT_URI = "http://localhost:1455/auth/callback";
const CODEX_SCOPE = "openid profile email offline_access";
const CODEX_DEVICE_TIMEOUT_SECONDS = 15 * 60;

const REFRESH_SKEW_MS = 5 * 60 * 1000;

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && /cancel|abort/i.test(error.message);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Login cancelled"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("Login cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid OAuth response field: ${field}`);
  }
  return value;
}

function decodeJwtAccountId(token: string): string | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const claims = JSON.parse(decoded) as {
      "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
    };
    const accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
  } catch {
    return undefined;
  }
}

function credentialFromToken(access: string, refresh: string, expiresInSeconds: number): OAuthCredential {
  const credential: OAuthCredential = {
    type: "oauth",
    access,
    refresh,
    expires: Date.now() + expiresInSeconds * 1000,
  };
  const accountId = decodeJwtAccountId(access);
  return accountId ? { ...credential, accountId } : credential;
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// xAI device-code flow
// ---------------------------------------------------------------------------

async function loginXai(interaction: OAuthInteraction): Promise<OAuthCredential> {
  const startResponse = await oauthFetch(XAI_DEVICE_CODE_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: XAI_CLIENT_ID,
      scope: XAI_SCOPE,
    }),
  }, interaction.signal).catch((error: unknown) => {
    if (isAbort(error, interaction.signal)) throw new Error("Login cancelled");
    throw error;
  });
  if (!startResponse.ok) {
    throw new Error(`xAI device code request failed (${startResponse.status}).`);
  }
  const start = await startResponse.json() as Record<string, unknown>;
  const deviceCode = requireString(start, "device_code");
  const userCode = requireString(start, "user_code");
  const verificationUri = requireString(start, "verification_uri");
  if (!verificationUri.startsWith("https:")) {
    throw new Error("Untrusted verification URI in xAI OAuth response");
  }
  const rawInterval = start.interval;
  const intervalSeconds = typeof rawInterval === "number" && rawInterval > 0 ? rawInterval : 5;
  const expiresInSeconds
    = typeof start.expires_in === "number" && start.expires_in > 0 ? start.expires_in : 600;

  interaction.notify({ type: "device_code", userCode, verificationUri, intervalSeconds, expiresInSeconds });

  const deadline = Date.now() + expiresInSeconds * 1000;
  let intervalMs = Math.max(1_000, intervalSeconds * 1000);
  while (Date.now() < deadline) {
    await abortableSleep(intervalMs, interaction.signal);
    const tokenResponse = await oauthFetch(XAI_TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: XAI_CLIENT_ID,
        device_code: deviceCode,
      }),
    }, interaction.signal).catch((error: unknown) => {
      if (isAbort(error, interaction.signal)) throw new Error("Login cancelled");
      throw error;
    });
    if (tokenResponse.ok) {
      const token = await tokenResponse.json() as Record<string, unknown>;
      return credentialFromToken(
        requireString(token, "access_token"),
        requireString(token, "refresh_token"),
        typeof token.expires_in === "number" ? token.expires_in : 3600,
      );
    }
    const errorBody = await tokenResponse.json().catch(() => ({}) as Record<string, unknown>);
    const errorCode = typeof errorBody.error === "string" ? errorBody.error : undefined;
    if (errorCode === "authorization_pending") continue;
    if (errorCode === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    throw new Error(`xAI device login failed (${tokenResponse.status}).`);
  }
  throw new Error("Device flow timed out");
}

async function refreshXai(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredential> {
  const response = await oauthFetch(XAI_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: XAI_CLIENT_ID,
    }),
  }, signal);
  if (!response.ok) {
    throw new Error(`xAI token refresh failed (${response.status}).`);
  }
  const token = await response.json() as Record<string, unknown>;
  return credentialFromToken(
    requireString(token, "access_token"),
    requireString(token, "refresh_token"),
    typeof token.expires_in === "number" ? token.expires_in : 3600,
  );
}

// ---------------------------------------------------------------------------
// OpenAI Codex flows (device code + browser with manual-code fallback)
// ---------------------------------------------------------------------------

async function postCodexToken(
  fields: Record<string, string>,
  operation: "exchange" | "refresh",
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  const response = await oauthFetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  }, signal).catch((error: unknown) => {
    if (isAbort(error, signal)) throw new Error("Login cancelled");
    throw error;
  });
  if (!response.ok) {
    throw new Error(`OpenAI Codex token ${operation} failed (${response.status}).`);
  }
  const token = await response.json() as Record<string, unknown>;
  if (
    typeof token.access_token !== "string"
    || typeof token.refresh_token !== "string"
    || typeof token.expires_in !== "number"
  ) {
    throw new Error(`OpenAI Codex token ${operation} response missing fields.`);
  }
  return credentialFromToken(token.access_token, token.refresh_token, token.expires_in);
}

async function loginCodexDevice(interaction: OAuthInteraction): Promise<OAuthCredential> {
  const startResponse = await oauthFetch(CODEX_DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  }, interaction.signal);
  if (!startResponse.ok) {
    throw new Error(`OpenAI Codex device code request failed (${startResponse.status}).`);
  }
  const start = await startResponse.json() as Record<string, unknown>;
  if (
    typeof start.device_auth_id !== "string"
    || typeof start.user_code !== "string"
    || typeof start.interval !== "number"
  ) {
    throw new Error("Invalid OpenAI Codex device code response");
  }
  const deviceAuthId = start.device_auth_id;
  const userCode = start.user_code;
  const intervalSeconds = start.interval;

  interaction.notify({
    type: "device_code",
    userCode,
    verificationUri: CODEX_DEVICE_VERIFICATION_URI,
    intervalSeconds,
    expiresInSeconds: CODEX_DEVICE_TIMEOUT_SECONDS,
  });

  const deadline = Date.now() + CODEX_DEVICE_TIMEOUT_SECONDS * 1000;
  let intervalMs = Math.max(1_000, intervalSeconds * 1000);
  while (Date.now() < deadline) {
    await abortableSleep(intervalMs, interaction.signal);
    const pollResponse = await oauthFetch(CODEX_DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    }, interaction.signal).catch((error: unknown) => {
      if (isAbort(error, interaction.signal)) throw new Error("Login cancelled");
      throw error;
    });
    if (pollResponse.ok) {
      const poll = await pollResponse.json() as Record<string, unknown>;
      if (typeof poll.authorization_code !== "string" || typeof poll.code_verifier !== "string") {
        throw new Error("Invalid OpenAI Codex device token response");
      }
      return postCodexToken({
        grant_type: "authorization_code",
        client_id: CODEX_CLIENT_ID,
        code: poll.authorization_code,
        code_verifier: poll.code_verifier,
        redirect_uri: CODEX_DEVICE_REDIRECT_URI,
      }, "exchange", interaction.signal);
    }
    if (pollResponse.status === 403 || pollResponse.status === 404) continue;
    const body = await pollResponse.text().catch(() => "");
    if (body.includes("deviceauth_authorization_pending")) continue;
    if (body.includes("slow_down")) {
      intervalMs += 5_000;
      continue;
    }
    throw new Error(`OpenAI Codex device auth failed (${pollResponse.status}).`);
  }
  throw new Error("Device flow timed out");
}

async function loginCodexBrowser(interaction: OAuthInteraction): Promise<OAuthCredential> {
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("hex");
  const url = new URL(CODEX_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CODEX_CLIENT_ID);
  url.searchParams.set("redirect_uri", CODEX_BROWSER_REDIRECT_URI);
  url.searchParams.set("scope", CODEX_SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("originator", "codex_cli_rs");

  const { createServer } = await import("node:http");
  let settleWait: ((code: string | null) => void) | undefined;
  const waitForCode = new Promise<string | null>((resolve) => {
    settleWait = resolve;
  });
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const code = requestUrl.searchParams.get("code");
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(code ? "OpenAI authentication completed. You can close this window." : "Missing code.");
    settleWait?.(code);
  });
  await new Promise<void>((resolve) => {
    server.once("error", () => resolve());
    server.listen(1455, "127.0.0.1", () => resolve());
  });

  interaction.notify({
    type: "auth_url",
    url: url.toString(),
    instructions: "A browser window should open. Complete login to finish.",
  });

  try {
    const manualPromise = interaction.prompt({
      type: "manual_code",
      message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
      placeholder: CODEX_BROWSER_REDIRECT_URI,
    }).catch(() => null);
    let code = await Promise.race([waitForCode, manualPromise]);
    if (!code) code = await manualPromise;
    server.close();
    if (!code) throw new Error("Missing authorization code");
    const parsed = new URL(code, CODEX_BROWSER_REDIRECT_URI);
    const parsedCode = parsed.searchParams.get("code") ?? code;
    const parsedState = parsed.searchParams.get("state");
    if (parsedState && parsedState !== state) throw new Error("State mismatch");
    return postCodexToken({
      grant_type: "authorization_code",
      client_id: CODEX_CLIENT_ID,
      code: parsedCode,
      code_verifier: verifier,
      redirect_uri: CODEX_BROWSER_REDIRECT_URI,
    }, "exchange", interaction.signal);
  } finally {
    server.close();
  }
}

async function loginCodex(interaction: OAuthInteraction): Promise<OAuthCredential> {
  const method = await interaction.prompt({
    type: "select",
    message: "Select OpenAI Codex login method:",
    options: [
      { id: "browser", label: "Browser login (default)" },
      { id: "device_code", label: "Device code login (headless)" },
    ],
  });
  if (method === "device_code") return loginCodexDevice(interaction);
  if (method === "browser") return loginCodexBrowser(interaction);
  throw new Error(`Unknown OpenAI Codex login method: ${method}`);
}

async function refreshCodex(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredential> {
  return postCodexToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CODEX_CLIENT_ID,
  }, "refresh", signal);
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export function isExpiring(credential: OAuthCredential): boolean {
  return Date.now() >= credential.expires - REFRESH_SKEW_MS;
}

export const oauthFlows: Record<string, {
  login(interaction: OAuthInteraction): Promise<OAuthCredential>;
  refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredential>;
}> = {
  xai: { login: loginXai, refresh: refreshXai },
  "openai-codex": { login: loginCodex, refresh: refreshCodex },
};
