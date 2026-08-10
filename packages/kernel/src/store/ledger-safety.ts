import type { SafeEventPayload, SafeEventScalar } from "./types.js"

/**
 * Durable ledger text is user-visible text, not a place to retain secrets.
 * Preserve the turn while replacing only the secret-looking value.
 */
const SECRET_PATTERNS: RegExp[] = [
  /(?<![A-Za-z0-9])(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|authorization|token|bearer|password|passwd|secret|credential|private[_-]?key)[\s:._=-]+(?:bearer[\s:._=-]+)?[A-Za-z0-9][A-Za-z0-9._~+/=-]{7,}/gi,
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|bearer|password|passwd|secret|credential|private[_-]?key)\b\s*[:=]\s*[^\s,;]+/gi,
  /\b(authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi,
  /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{12,}\b/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
  /(密码|密钥|令牌|凭据)\s*[:：=]\s*[^\s,，；;]+/g,
]

const MAX_VISIBLE_TEXT_LENGTH = 200_000
const MAX_EVENT_FIELDS = 32
const MAX_EVENT_KEY_LENGTH = 80
const MAX_EVENT_TEXT_LENGTH = 500

/** Fields that would turn a compact event receipt into hidden or sensitive data. */
const FORBIDDEN_KEY =
  /(?:screenshot|screen_capture|image|thumbnail|base64|data_uri|blob|pixel|password|passwd|secret|credential|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|authorization|bearer|private[_-]?key|cookie|chain[_-]?of[_-]?thought|hidden[_-]?reason|hidden[_-]?prompt|reasoning|thought|analysis|internal[_-]?prompt|system[_-]?prompt|密码|密钥|令牌|凭据)/i

// These markers identify material that must never become a durable memory,
// even when it is not written as a conventional `name=value` secret.
const FORBIDDEN_MEMORY_MARKER =
  /(?:screenshot|screen[\s_-]?capture|base64|data[\s_-]?uri|chain[\s_-]?of[\s_-]?thought|hidden[\s_-]?reason(?:ing)?|hidden[\s_-]?prompt|internal[\s_-]?prompt|system[\s_-]?prompt)\s*[:=]\s*\S+/i
const STANDALONE_MEMORY_SECRET =
  /^\s*(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|authorization|token|bearer|password|passwd|secret|credential|private[_-]?key|chain[_-]?of[_-]?thought|hidden[_-]?reason(?:ing)?|hidden[_-]?prompt|internal[_-]?prompt|system[_-]?prompt|密码|密钥|令牌|凭据)\s*$/i

/**
 * Stable, intentionally detail-free failure used at the durable memory
 * boundary.  Callers may log the code, but never receive the value that
 * caused the rejection.
 */
export const SENSITIVE_MEMORY_REJECTED = "sensitive_memory_rejected"
/** Fixed error for short-lived portable context/capsule boundaries. */
export const SENSITIVE_CONTENT_REJECTED = "sensitive_content_rejected"

function sensitiveMemoryError(): Error {
  return new Error(SENSITIVE_MEMORY_REJECTED)
}

function sensitiveContentError(): Error {
  return new Error(SENSITIVE_CONTENT_REJECTED)
}

function assertSafeText(value: string, fieldName: string, maxLength: number): void {
  if (value.length > maxLength) {
    throw new Error(`${fieldName} exceeds the durable ledger size limit`)
  }
  if (/data:[^;\s]+;base64,/i.test(value)) {
    throw new Error(`${fieldName} cannot contain a base64 data URI`)
  }
  // Raw image/base64 bytes should never be accepted just because a caller
  // forgot to name the field "base64Data".
  if (/(?:^|[^A-Za-z0-9+/])[A-Za-z0-9+/]{128,}={0,2}(?:$|[^A-Za-z0-9+/])/.test(value)) {
    throw new Error(`${fieldName} cannot contain base64-like data`)
  }
}

/** Sanitize visible text while retaining the rest of the user's turn. */
export function sanitizeVisibleText(value: string, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be text`)
  }
  assertSafeText(value, fieldName, MAX_VISIBLE_TEXT_LENGTH)
  return SECRET_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, "[redacted]"),
    value,
  )
}

const PORTABLE_DATA_URI = /data:[^;\s]+;base64,[A-Za-z0-9+/=]+/gi
const PORTABLE_RAW_BASE64 = /(?:^|[^A-Za-z0-9+/])[A-Za-z0-9+/]{96,}={0,2}(?=$|[^A-Za-z0-9+/])/g
const PORTABLE_PAYLOAD_ASSIGNMENT =
  /\b(?:screenshot|screen[\s_-]?capture|base64(?:data)?|data[\s_-]?uri|blob|pixel)\b\s*[:=]\s*[^\s,;]+/gi
const PORTABLE_CREDENTIAL_ASSIGNMENT =
  /\b(?:api[\s_-]?key|access[\s_-]?token|auth(?:orization)?|refresh[\s_-]?token|token|password|passwd|secret|credential|private[\s_-]?key|cookie|session[\s_-]?id|csrf[\s_-]?token|client[\s_-]?secret)\b\s*[:=]\s*[^\s,;]+/gi
const PORTABLE_HIDDEN_ASSIGNMENT =
  /\b(?:chain[\s_-]?of[\s_-]?thought|hidden[\s_-]?reason(?:ing)?|hidden[\s_-]?prompt|internal[\s_-]?prompt|system[\s_-]?prompt)\b\s*[:=]\s*[^\n]*/gi
const PORTABLE_QUERY_SECRET =
  /([?&#](?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|authorization|token|password|passwd|secret|credential|private[_-]?key)=)[^&#\s]+/gi
const PORTABLE_URL_USERINFO =
  /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+:[^/\s@]+@/gi

/**
 * Redact content that may cross a short-lived context/trail boundary. This
 * function is deliberately lossy: trail/capsule text is evidence, not a
 * durable claim, and a safe placeholder is preferable to retaining a
 * credential or image payload.
 */
export function sanitizePortableText(value: string, fieldName: string): string {
  if (typeof value !== "string") {
    throw sensitiveContentError()
  }
  if (value.length > MAX_VISIBLE_TEXT_LENGTH) {
    throw sensitiveContentError()
  }
  let sanitized = value
  sanitized = sanitized.replace(PORTABLE_DATA_URI, "[omitted]")
  sanitized = sanitized.replace(PORTABLE_PAYLOAD_ASSIGNMENT, "[omitted]")
  sanitized = sanitized.replace(PORTABLE_CREDENTIAL_ASSIGNMENT, "[redacted]")
  sanitized = sanitized.replace(PORTABLE_HIDDEN_ASSIGNMENT, "[omitted]")
  sanitized = sanitized.replace(PORTABLE_QUERY_SECRET, "$1[redacted]")
  sanitized = sanitized.replace(PORTABLE_URL_USERINFO, "$1[redacted]@")
  sanitized = sanitized.replace(PORTABLE_RAW_BASE64, "[omitted]")
  try {
    sanitized = sanitizeVisibleText(sanitized, fieldName)
  } catch {
    throw sensitiveContentError()
  }
  return sanitized
}

/** Strict counterpart for parser/persistence boundaries: any redaction fails. */
export function assertPersistableSafeText(
  value: unknown,
  fieldName: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw sensitiveContentError()
  }
  try {
    if (sanitizePortableText(value, fieldName) !== value) {
      throw sensitiveContentError()
    }
  } catch (error) {
    if (error instanceof Error && error.message === SENSITIVE_CONTENT_REJECTED) {
      throw error
    }
    throw sensitiveContentError()
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const FORBIDDEN_SKILL_FIELD =
  /(?:screenshot|screen[\s_-]?capture|image|thumbnail|base64|data[\s_-]?uri|blob|pixel|chain[\s_-]?of[\s_-]?thought|hidden[\s_-]?reason(?:ing)?|hidden[\s_-]?prompt|internal[\s_-]?prompt|system[\s_-]?prompt|reasoning|analysis|token|authorization|bearer|password|passwd|secret|credential|private[\s_-]?key|cookie|密码|密钥|令牌|凭据)/i

/**
 * Validate all user/tool-authored text crossing the Skill persistence
 * boundary. Skill rows are executable memory, so unlike conversation text we
 * fail closed rather than redacting a suspicious fragment.
 */
export function assertPersistableSkillFields(input: {
  id?: unknown
  name: unknown
  triggerPhrase?: unknown
  steps: unknown
  conditions: unknown
  verification: unknown
  sourceTrailFrom?: unknown
  sourceTrailTo?: unknown
  candidateId?: unknown
  verifiedAt?: unknown
  createdAt?: unknown
  status?: unknown
}): void {
  try {
    if (input.id !== undefined) assertPersistableSafeText(input.id, "skill id")
    assertPersistableSafeText(input.name, "skill name")
    if (input.triggerPhrase !== undefined) {
      assertPersistableSafeText(input.triggerPhrase, "skill trigger phrase")
    }
    if (!Array.isArray(input.steps)) throw new Error(SENSITIVE_CONTENT_REJECTED)
    for (const step of input.steps) {
      if (!isPlainRecord(step)) throw new Error(SENSITIVE_CONTENT_REJECTED)
      for (const key of Object.keys(step)) {
        if (key !== "id" && key !== "description" && key !== "kind") {
          throw new Error(SENSITIVE_CONTENT_REJECTED)
        }
      }
      assertPersistableSafeText(step.id, "skill step id")
      assertPersistableSafeText(step.description, "skill step description")
      assertPersistableSafeText(step.kind, "skill step kind")
    }
    if (!isPlainRecord(input.conditions)) throw new Error(SENSITIVE_CONTENT_REJECTED)
    for (const [key, value] of Object.entries(input.conditions)) {
      if (FORBIDDEN_SKILL_FIELD.test(key)) throw new Error(SENSITIVE_CONTENT_REJECTED)
      assertPersistableSafeText(key, "skill condition key")
      assertPersistableSafeText(value, "skill condition value")
    }
    if (!Array.isArray(input.verification)) throw new Error(SENSITIVE_CONTENT_REJECTED)
    for (const verification of input.verification) {
      assertPersistableSafeText(verification, "skill verification")
    }
    for (const [field, value] of [
      ["skill source trail from", input.sourceTrailFrom],
      ["skill source trail to", input.sourceTrailTo],
      ["skill candidate id", input.candidateId],
      ["skill verified at", input.verifiedAt],
      ["skill created at", input.createdAt],
    ] as const) {
      if (value !== undefined) assertPersistableSafeText(value, field)
    }
    if (input.status !== undefined) assertPersistableSafeText(input.status, "skill status")
  } catch (error) {
    if (error instanceof Error && error.message === SENSITIVE_CONTENT_REJECTED) {
      throw error
    }
    throw new Error(SENSITIVE_CONTENT_REJECTED)
  }
}

/**
 * Validate user-authored text before it enters a durable MemoryClaim or
 * Learning.  Conversation/UI text may be redacted for display; durable
 * memory is different: a redacted value is not a trustworthy memory, so any
 * sanitizer change (or unsafe encoding) rejects the whole write.
 */
export function assertPersistableMemoryText(
  value: unknown,
  fieldName: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw sensitiveMemoryError()
  }
  if (FORBIDDEN_MEMORY_MARKER.test(value) || STANDALONE_MEMORY_SECRET.test(value)) {
    throw sensitiveMemoryError()
  }
  try {
    const sanitized = sanitizeVisibleText(value, fieldName)
    if (sanitized !== value) {
      throw sensitiveMemoryError()
    }
  } catch (error) {
    if (error instanceof Error && error.message === SENSITIVE_MEMORY_REJECTED) {
      throw error
    }
    // Do not expose implementation details (or a value fragment) from the
    // safety checker.  The stable code is the only durable-memory error API.
    throw sensitiveMemoryError()
  }
}

/** Validate a MemoryClaim's user-controlled text fields atomically. */
export function assertPersistableMemoryFields(input: {
  claim: unknown
  scope: unknown
  tags: unknown
}): asserts input is { claim: string; scope: string; tags: string[] } {
  assertPersistableMemoryText(input.claim, "memory claim")
  assertPersistableMemoryText(input.scope, "memory scope")
  if (!Array.isArray(input.tags)) {
    throw sensitiveMemoryError()
  }
  for (const [index, tag] of input.tags.entries()) {
    assertPersistableMemoryText(tag, `memory tag ${index}`)
  }
}

/** Validate a Learning's user-controlled text fields atomically. */
export function assertPersistableLearningFields(input: {
  rule: unknown
  scope: unknown
  examples?: unknown
}): asserts input is { rule: string; scope: string; examples?: string[] } {
  assertPersistableMemoryText(input.rule, "learning rule")
  assertPersistableMemoryText(input.scope, "learning scope")
  if (input.examples === undefined) return
  if (!Array.isArray(input.examples)) {
    throw sensitiveMemoryError()
  }
  for (const [index, example] of input.examples.entries()) {
    assertPersistableMemoryText(example, `learning example ${index}`)
  }
}

export function assertPersistableEventType(type: string): void {
  if (type === "response.delta") {
    throw new Error("response.delta is transient and cannot be persisted in the ledger")
  }
}

function isSafeScalar(value: unknown): value is SafeEventScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
}

/**
 * Validate and copy event metadata.  Event payloads are intentionally flat,
 * bounded scalar receipts: nested objects, arrays, images, and secret-shaped
 * fields are rejected at the product boundary.
 */
export function sanitizeEventPayload(payload: unknown): SafeEventPayload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("conversation event payload must be a flat object")
  }
  const entries = Object.entries(payload as Record<string, unknown>)
  if (entries.length > MAX_EVENT_FIELDS) {
    throw new Error(`conversation event payload supports at most ${MAX_EVENT_FIELDS} fields`)
  }

  const sanitized: SafeEventPayload = {}
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > MAX_EVENT_KEY_LENGTH) {
      throw new Error("conversation event payload key is invalid")
    }
    if (FORBIDDEN_KEY.test(key)) {
      throw new Error(`conversation event payload contains forbidden field ${key}`)
    }
    if (!isSafeScalar(value)) {
      throw new Error(`conversation event payload field ${key} must be a scalar`)
    }
    if (typeof value === "string") {
      sanitized[key] = sanitizeVisibleText(
        value,
        `conversation event payload field ${key}`,
      )
      if (sanitized[key]!.length > MAX_EVENT_TEXT_LENGTH) {
        throw new Error(`conversation event payload field ${key} exceeds the durable ledger size limit`)
      }
      continue
    }
    sanitized[key] = value
  }
  return sanitized
}

export function cloneEventPayload(payload: SafeEventPayload): SafeEventPayload {
  // Payloads are flat scalars, so a shallow copy is complete and intentional.
  return { ...payload }
}

export function sameEventPayload(
  left: SafeEventPayload,
  right: SafeEventPayload,
): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
}
