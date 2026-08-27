import { randomUUID } from "node:crypto";
import type { SessionScope } from "../session-scope.js";
import { sessionScopesEqual } from "../session-scope.js";
import {
  assertGrantMatchesScope,
  grantIsActive,
  type WorkspaceCapability,
  type WorkspaceGrant,
} from "./workspace-grant.js";

export interface CreateWorkspaceGrantInput {
  displayName: string;
  rootPathReference: string;
  scope: SessionScope;
  capabilities: WorkspaceCapability[];
  expiresAt?: string;
}

export interface WorkspaceLedger {
  create(input: CreateWorkspaceGrantInput, now?: Date): WorkspaceGrant;
  get(id: string): WorkspaceGrant | undefined;
  list(scope?: SessionScope): WorkspaceGrant[];
  revoke(id: string, now?: Date): WorkspaceGrant | undefined;
  expirePrivate(now?: Date): number;
}

export function createWorkspaceLedger(): WorkspaceLedger {
  const grants = new Map<string, WorkspaceGrant>();

  return {
    create(input, now = new Date()) {
      if (input.scope.kind === "private" && input.expiresAt === undefined) {
        throw new Error("Private workspace grants must expire with the session.");
      }
      if (input.displayName.trim().length === 0) {
        throw new Error("Workspace grant requires a display name.");
      }
      const grant: WorkspaceGrant = {
        id: randomUUID(),
        displayName: input.displayName.trim(),
        rootPathReference: input.rootPathReference,
        scope: input.scope,
        capabilities: [...input.capabilities],
        createdAt: now.toISOString(),
      };
      if (input.expiresAt !== undefined) grant.expiresAt = input.expiresAt;
      grants.set(grant.id, grant);
      return grant;
    },
    get(id) {
      return grants.get(id);
    },
    list(scope) {
      return [...grants.values()].filter((grant) => (
        scope === undefined || sessionScopesEqual(grant.scope, scope)
      ));
    },
    revoke(id, now = new Date()) {
      const grant = grants.get(id);
      if (grant === undefined) return undefined;
      const revoked: WorkspaceGrant = { ...grant, revokedAt: now.toISOString() };
      grants.set(id, revoked);
      return revoked;
    },
    expirePrivate(now = new Date()) {
      let count = 0;
      for (const grant of grants.values()) {
        if (grant.scope.kind === "private" && grantIsActive(grant, now)) {
          grants.set(grant.id, { ...grant, revokedAt: now.toISOString() });
          count += 1;
        }
      }
      return count;
    },
  };
}

export function requireActiveGrant(
  ledger: WorkspaceLedger,
  id: string,
  scope: SessionScope,
  now = new Date(),
): WorkspaceGrant {
  const grant = ledger.get(id);
  if (grant === undefined) throw new Error("Unknown workspace grant.");
  assertGrantMatchesScope(grant, scope);
  if (!grantIsActive(grant, now)) throw new Error("Workspace grant is not active.");
  return grant;
}
