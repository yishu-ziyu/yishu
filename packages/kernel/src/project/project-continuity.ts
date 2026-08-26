import type { SessionScope } from "../session-scope.js";
import { sessionScopesEqual } from "../session-scope.js";

export interface ProjectFact {
  id: string;
  projectId: string;
  text: string;
  capturedAt: string;
  supersededBy?: string;
}

export interface ProjectContinuity {
  remember(input: { projectId: string; text: string; scope: SessionScope }, now?: Date): ProjectFact;
  recall(projectId: string, scope: SessionScope): ProjectFact[];
  correct(input: { projectId: string; factId: string; text: string; scope: SessionScope }, now?: Date): ProjectFact;
}

export function createProjectContinuity(): ProjectContinuity {
  const facts = new Map<string, ProjectFact[]>();

  function list(projectId: string): ProjectFact[] {
    return facts.get(projectId) ?? [];
  }

  return {
    remember(input, now = new Date()) {
      assertProjectScope(input.scope, input.projectId);
      const fact: ProjectFact = {
        id: crypto.randomUUID(),
        projectId: input.projectId,
        text: input.text.trim(),
        capturedAt: now.toISOString(),
      };
      facts.set(input.projectId, [...list(input.projectId), fact]);
      return fact;
    },
    recall(projectId, scope) {
      assertProjectScope(scope, projectId);
      return list(projectId).filter((fact) => fact.supersededBy === undefined);
    },
    correct(input, now = new Date()) {
      assertProjectScope(input.scope, input.projectId);
      const current = list(input.projectId);
      const target = current.find((fact) => fact.id === input.factId);
      if (target === undefined) throw new Error("Unknown project fact.");
      const replacement: ProjectFact = {
        id: crypto.randomUUID(),
        projectId: input.projectId,
        text: input.text.trim(),
        capturedAt: now.toISOString(),
      };
      const next = current.map((fact) => (
        fact.id === target.id ? { ...fact, supersededBy: replacement.id } : fact
      ));
      facts.set(input.projectId, [...next, replacement]);
      return replacement;
    },
  };
}

function assertProjectScope(scope: SessionScope, projectId: string): void {
  if (scope.kind === "private") throw new Error("Private scope cannot use project continuity.");
  if (scope.kind === "project" && !sessionScopesEqual(scope, { kind: "project", projectId })) {
    throw new Error("Project continuity is isolated to the granted project.");
  }
  if (scope.kind === "personal") throw new Error("Personal scope cannot read another project's facts.");
}
