/**
 * Product-owned session scope. The execution harness receives this value; it
 * must never infer a project namespace from the current app or working path.
 */
export type SessionScope =
  | { kind: "personal" }
  | { kind: "project"; projectId: string; projectLabel?: string }
  | { kind: "private" }

export const PERSONAL_SESSION_SCOPE: SessionScope = Object.freeze({
  kind: "personal",
})

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeProjectLabel(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error("invalid_session_scope")
  const label = value.replace(/\s+/gu, " ").trim()
  if (label.length === 0 || label.length > 80) {
    throw new Error("invalid_session_scope")
  }
  return label
}

/** Parse persisted/transport scope data. Missing legacy scope becomes personal. */
export function normalizeSessionScope(value: unknown): SessionScope {
  if (value === undefined || value === null) return { kind: "personal" }
  if (!isRecord(value)) throw new Error("invalid_session_scope")
  if (value.kind === "personal") return { kind: "personal" }
  if (value.kind === "private") return { kind: "private" }
  if (value.kind !== "project" || typeof value.projectId !== "string") {
    throw new Error("invalid_session_scope")
  }
  const projectId = value.projectId.trim().toLowerCase()
  if (!UUID_PATTERN.test(projectId)) throw new Error("invalid_session_scope")
  const projectLabel = normalizeProjectLabel(value.projectLabel)
  return projectLabel === undefined
    ? { kind: "project", projectId }
    : { kind: "project", projectId, projectLabel }
}

export function cloneSessionScope(scope: SessionScope): SessionScope {
  return normalizeSessionScope(scope)
}

export function sessionScopeKey(scope: SessionScope): string {
  if (scope.kind === "project") return `project:${scope.projectId}`
  return scope.kind
}

export function sessionScopesEqual(left: SessionScope, right: SessionScope): boolean {
  return sessionScopeKey(left) === sessionScopeKey(right)
}

/** Long-term memory namespace for a session; private sessions have none. */
export function memoryScopeForSession(scope: SessionScope): string | null {
  if (scope.kind === "private") return null
  return sessionScopeKey(scope)
}

export function assertDurableSessionScope(scope: SessionScope): void {
  if (scope.kind === "private") throw new Error("private_session_not_persistable")
}
