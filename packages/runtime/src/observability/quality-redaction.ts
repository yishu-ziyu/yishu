import {
  QUALITY_ATTRIBUTE_ALLOWLIST,
  QualityEventRejectedError,
  type QualityAttributeName,
  type QualityAttributeValue,
  type QualityAttributes,
} from "./quality-event.js";

const ALLOWED = new Set<string>(QUALITY_ATTRIBUTE_ALLOWLIST);

const FORBIDDEN_KEY_PATTERN = /(transcript|prompt|screenshot|windowtitle|filepath|file_path|url|cookie|authorization|apikey|api_key|token|password|email|username|label|axlabel|notecontent|payload)/i;

const SECRET_VALUE_PATTERN = [
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/iu,
  /\b(?:sk|xai|gh[pousr]|glpat|pat|ya29|AIza)[-_][a-z0-9._-]{8,}\b/iu,
  /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}(?:\.[a-z0-9_-]{8,})?\b/iu,
  /\b(?:bearer|basic)[\s._:=~-]+[a-z0-9+/_.~-]{8,}/iu,
];

export function isForbiddenAttributeKey(key: string): boolean {
  return FORBIDDEN_KEY_PATTERN.test(key.replaceAll(/[\s_-]/g, ""));
}

export function valueLooksLikeSecret(value: QualityAttributeValue): boolean {
  if (typeof value !== "string") return false;
  return SECRET_VALUE_PATTERN.some((pattern) => pattern.test(value));
}

export function sanitizeQualityAttributes(
  attributes: Record<string, unknown> | QualityAttributes | undefined,
): QualityAttributes {
  if (attributes === undefined) return {};
  const sanitized: QualityAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (isForbiddenAttributeKey(key) || !ALLOWED.has(key)) {
      throw new QualityEventRejectedError(`Quality attribute '${key}' is not allowlisted.`);
    }
    if (value === undefined) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new QualityEventRejectedError(`Quality attribute '${key}' must be a string, number, or boolean.`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new QualityEventRejectedError(`Quality attribute '${key}' must be finite.`);
    }
    if (valueLooksLikeSecret(value)) {
      throw new QualityEventRejectedError(`Quality attribute '${key}' looks like a secret.`);
    }
    sanitized[key as QualityAttributeName] = value;
  }
  return sanitized;
}

export function textLooksLikeSecret(text: string): boolean {
  return SECRET_VALUE_PATTERN.some((pattern) => pattern.test(text));
}
