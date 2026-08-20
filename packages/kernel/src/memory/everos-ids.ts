/**
 * Map Yishu session scope onto EverOS path-safe ids.
 * EverOS rejects `.` / `..` and anything outside [a-zA-Z0-9_.@+-].
 */

export const EVEROS_APP_ID = "yishu";
export const EVEROS_USER_ID = "owner";
export const EVEROS_ASSISTANT_SENDER_ID = "yishu";

export interface EverOSIdentity {
  readonly appId: string;
  readonly userId: string;
  readonly personalProjectId: string;
}

export const DEFAULT_EVEROS_IDENTITY: EverOSIdentity = {
  appId: EVEROS_APP_ID,
  userId: EVEROS_USER_ID,
  personalProjectId: "personal",
};

const PATH_SAFE = /^[a-zA-Z0-9_.@+-]+$/;

export function assertValidEverOSIdentity(identity: EverOSIdentity): void {
  for (const value of [identity.appId, identity.userId, identity.personalProjectId]) {
    if (!PATH_SAFE.test(value) || value === "." || value === ".." || value.includes("..")) {
      throw new Error("everos_invalid_identity");
    }
  }
  if (identity.userId === EVEROS_ASSISTANT_SENDER_ID) {
    throw new Error("everos_user_assistant_identity_collision");
  }
}

export function everosProjectId(
  scopeKey: string,
  identity: EverOSIdentity = DEFAULT_EVEROS_IDENTITY,
): string {
  const trimmed = scopeKey.trim();
  if (trimmed === "personal" || trimmed.length === 0) return identity.personalProjectId;
  const raw = trimmed.startsWith("project:") ? trimmed.slice("project:".length) : trimmed;
  if (raw.includes("..") || raw.includes("/") || raw.includes("\\")) {
    return identity.personalProjectId;
  }
  const safe = raw.replace(/[^a-zA-Z0-9_.@+-]/g, "-");
  if (safe.length === 0 || !PATH_SAFE.test(safe) || safe === "." || safe === "..") {
    return identity.personalProjectId;
  }
  return safe;
}

export function memoryScopeFromEverOSProject(
  projectId: string,
  identity: EverOSIdentity = DEFAULT_EVEROS_IDENTITY,
): string {
  if (
    projectId === identity.personalProjectId
    || projectId === "personal"
    || projectId === "default"
  ) return "personal";
  return projectId.startsWith("project:") ? projectId : `project:${projectId}`;
}
