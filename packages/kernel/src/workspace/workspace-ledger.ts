import { randomUUID } from "node:crypto";
import type { SessionScope } from "../session-scope.js";
import { sessionScopesEqual } from "../session-scope.js";
import {
  assertGrantMatchesScope,
  grantIsActive,
  type WorkspaceCapability,
  type WorkspaceGrant,
} from "./workspace-grant.js";

const GRANT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface CreateWorkspaceGrantInput {
  displayName: string;
  rootPathReference: string;
  scope: SessionScope;
  capabilities: WorkspaceCapability[];
  expiresAt?: string;
}

export interface IngestWorkspaceGrantInput extends CreateWorkspaceGrantInput {
  id: string;
}

export interface WorkspaceLedger {
  create(input: CreateWorkspaceGrantInput, now?: Date): WorkspaceGrant;
  /** Upsert an active grant with a client-supplied id (Clicky bookmark ingest). */
  ingest(input: IngestWorkspaceGrantInput, now?: Date): WorkspaceGrant;
  get(id: string): WorkspaceGrant | undefined;
  list(scope?: SessionScope): WorkspaceGrant[];
  revoke(id: string, now?: Date): WorkspaceGrant | undefined;
  expirePrivate(now?: Date): number;
}

function assertCreatableGrant(input: CreateWorkspaceGrantInput): string {
  if (input.scope.kind === "private" && input.expiresAt === undefined) {
    throw new Error("Private workspace grants must expire with the session.");
  }
  const displayName = input.displayName.trim();
  if (displayName.length === 0) {
    throw new Error("Workspace grant requires a display name.");
  }
  if (input.rootPathReference.trim().length === 0) {
    throw new Error("Workspace grant requires a root path.");
  }
  if (input.capabilities.length === 0) {
    throw new Error("Workspace grant requires at least one capability.");
  }
  return displayName;
}

function grantFromInput(
  id: string,
  input: CreateWorkspaceGrantInput,
  displayName: string,
  now: Date,
): WorkspaceGrant {
  const grant: WorkspaceGrant = {
    id,
    displayName,
    rootPathReference: input.rootPathReference,
    scope: input.scope,
    capabilities: [...input.capabilities],
    createdAt: now.toISOString(),
  };
  if (input.expiresAt !== undefined) grant.expiresAt = input.expiresAt;
  return grant;
}

export function createWorkspaceLedger(): WorkspaceLedger {
  const grants = new Map<string, WorkspaceGrant>();

  return {
    create(input, now = new Date()) {
      const displayName = assertCreatableGrant(input);
      const grant = grantFromInput(randomUUID(), input, displayName, now);
      grants.set(grant.id, grant);
      return grant;
    },
    ingest(input, now = new Date()) {
      if (!GRANT_ID_PATTERN.test(input.id)) {
        throw new Error("Workspace grant id must be a UUID.");
      }
      const displayName = assertCreatableGrant(input);
      const existing = grants.get(input.id);
      if (existing !== undefined) {
        const ingested: WorkspaceGrant = {
          ...existing,
          displayName,
          rootPathReference: input.rootPathReference,
          scope: input.scope,
          capabilities: [...input.capabilities],
        };
        delete ingested.revokedAt;
        if (input.expiresAt !== undefined) ingested.expiresAt = input.expiresAt;
        else delete ingested.expiresAt;
        grants.set(input.id, ingested);
        return ingested;
      }
      const grant = grantFromInput(input.id, input, displayName, now);
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
