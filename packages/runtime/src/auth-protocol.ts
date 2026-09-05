import { z } from "zod";

/**
 * Product-owned OAuth surface.  Pi may know about many more providers, but
 * only these two subscription paths are allowed to cross the Yishu runtime
 * boundary.  The local Grok proxy remains the default model route and is not
 * an OAuth provider here.
 */
export const AUTH_PROVIDER_IDS = ["openai-codex", "xai"] as const;
export type AuthProviderId = (typeof AUTH_PROVIDER_IDS)[number];
export const authProviderSchema = z.enum(AUTH_PROVIDER_IDS);

/**
 * Keep model exposure deliberately smaller than Pi's provider catalog.  These
 * IDs are product policy, not a promise that every future Pi model is exposed
 * to the desktop client.
 */
export const AUTH_CONTROLLED_MODEL_IDS = {
  "openai-codex": [
    "gpt-6-astra",
    "gpt-5.3-codex-spark",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
  ],
  xai: ["grok-4.3", "grok-build-0.1", "grok-4.5"],
} as const satisfies Record<AuthProviderId, readonly string[]>;

export const authModelPreferenceSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("openai-codex"),
    model: z.enum(AUTH_CONTROLLED_MODEL_IDS["openai-codex"]),
  }).strict(),
  z.object({
    provider: z.literal("xai"),
    model: z.enum(AUTH_CONTROLLED_MODEL_IDS.xai),
  }).strict(),
]);
export type AuthModelPreference = z.infer<typeof authModelPreferenceSchema>;

export const authTypeSchema = z.literal("oauth");
export type AuthType = z.infer<typeof authTypeSchema>;

export const authStatusPayloadSchema = z.object({
  provider: authProviderSchema.optional(),
}).strict();

export const authLoginStartPayloadSchema = z.object({
  provider: authProviderSchema,
  // First product version is OAuth-only.  In particular, an ambient API key
  // must not silently turn either subscription provider into a configured one.
  authType: authTypeSchema,
}).strict();

export const authPromptReplyPayloadSchema = z.object({
  provider: authProviderSchema,
  promptId: z.string().uuid(),
  // OAuth manual codes are short-lived input.  The value is accepted only for
  // the pending interaction and is never copied to an event, trace, or log.
  value: z.string().max(4096),
}).strict();

export const authLoginCancelPayloadSchema = z.object({
  provider: authProviderSchema,
  reason: z.string().trim().min(1).max(200).optional(),
}).strict();

export const authLogoutPayloadSchema = z.object({
  provider: authProviderSchema,
}).strict();

export const authPublicModelSchema = z.object({
  provider: authProviderSchema,
  id: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(200),
}).strict();
export type AuthPublicModel = z.infer<typeof authPublicModelSchema>;

const PUBLIC_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PUBLIC_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._+\-@ ]{0,62}[\p{L}\p{N}.]$/u;
const BLOCKED_ACCOUNT_LABEL
  = /access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|account[_-]?id|credential|authorization|password|secret|bearer|\btoken\b|jwt/i;
const LOOKS_LIKE_ACCOUNT_ID
  = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|acct[_-]|user[_-]?id|org[_-]|sess[_-])/i;

/** Email or a short login name. Never a token, JWT, or provider account id. */
export function sanitizePublicAccountLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > 120) return undefined;
  if (BLOCKED_ACCOUNT_LABEL.test(text)) return undefined;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text)) return undefined;
  if (PUBLIC_EMAIL.test(text)) return text;
  if (LOOKS_LIKE_ACCOUNT_ID.test(text)) return undefined;
  if (PUBLIC_NAME.test(text)) return text;
  return undefined;
}

export const authPublicStatusSchema = z.object({
  provider: authProviderSchema,
  configured: z.boolean(),
  authType: authTypeSchema,
  models: z.array(authPublicModelSchema).max(16),
  requiresRelogin: z.boolean().optional(),
  /** Safe email or login name only. Never an account id or credential. */
  accountLabel: z.string().trim().min(1).max(120).refine(
    (value) => sanitizePublicAccountLabel(value) === value,
  ).optional(),
  /** xAI OAuth is a local Pi subscription bridge, not a stable direct API contract. */
  experimental: z.literal("experimental_local_subscription").optional(),
}).strict();
export type AuthPublicStatus = z.infer<typeof authPublicStatusSchema>;

export const authPromptSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    message: z.string().trim().min(1).max(500),
    placeholder: z.string().max(200).optional(),
  }).strict(),
  z.object({
    type: z.literal("secret"),
    message: z.string().trim().min(1).max(500),
    placeholder: z.string().max(200).optional(),
  }).strict(),
  z.object({
    type: z.literal("select"),
    message: z.string().trim().min(1).max(500),
    options: z.array(z.object({
      id: z.string().trim().min(1).max(120),
      label: z.string().trim().min(1).max(200),
      description: z.string().max(500).optional(),
    }).strict()).max(16),
  }).strict(),
  z.object({
    type: z.literal("manual_code"),
    message: z.string().trim().min(1).max(500),
    placeholder: z.string().max(200).optional(),
  }).strict(),
]);
export type AuthPrompt = z.infer<typeof authPromptSchema>;

export const authFailureCodeSchema = z.enum([
  "cancelled",
  "invalid_request",
  "oauth_failed",
  "storage_failed",
  "relogin_required",
  "timeout",
  "unavailable",
]);
export type AuthFailureCode = z.infer<typeof authFailureCodeSchema>;

/**
 * These payload types are used by stdio-server and AuthService.  They are
 * intentionally separate from Pi's AuthEvent so Pi internals never become a
 * wire contract or accidentally carry credentials across the boundary.
 */
export type AuthInfoPayload = {
  provider: AuthProviderId;
  message: string;
  links?: readonly { url: string; label?: string }[];
};
export type AuthUrlPayload = {
  provider: AuthProviderId;
  url: string;
  instructions?: string;
};
export type AuthDeviceCodePayload = {
  provider: AuthProviderId;
  userCode: string;
  verificationUri: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
};
export type AuthProgressPayload = {
  provider: AuthProviderId;
  message: string;
};
export type AuthPromptPayload = {
  provider: AuthProviderId;
  promptId: string;
  prompt: AuthPrompt;
};
export type AuthFailurePayload = {
  provider: AuthProviderId;
  code: AuthFailureCode;
  message: string;
};
