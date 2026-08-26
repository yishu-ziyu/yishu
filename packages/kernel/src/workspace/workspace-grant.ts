import type { SessionScope } from "../session-scope.js";

export type WorkspaceCapability = "read" | "create" | "edit" | "move" | "trash";

export interface WorkspaceGrant {
  id: string;
  displayName: string;
  rootPathReference: string;
  scope: SessionScope;
  capabilities: WorkspaceCapability[];
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
}

export function grantIsActive(grant: WorkspaceGrant, now: Date): boolean {
  if (grant.revokedAt !== undefined) return false;
  if (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= now.getTime()) return false;
  return true;
}

export function assertGrantMatchesScope(grant: WorkspaceGrant, scope: SessionScope): void {
  if (grant.scope.kind !== scope.kind) {
    throw new Error("Workspace grant does not match the current session scope.");
  }
  if (grant.scope.kind === "project" && scope.kind === "project" && grant.scope.projectId !== scope.projectId) {
    throw new Error("Workspace grant belongs to a different project.");
  }
}
