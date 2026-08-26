import type { SessionScope } from "../session-scope.js";

export type AutomationStatus = "draft" | "active" | "paused" | "expired" | "degraded" | "archived";

export type AutomationTriggerKind =
  | "schedule"
  | "app_transition"
  | "file_change"
  | "task_state"
  | "manual"
  | "system_resume";

export interface AutomationBudget {
  maxDurationMs: number;
  maxSteps: number;
  maxModelCalls: number;
  maxRunsPerDay: number;
}

export interface ToolGrant {
  tool: "research" | "browser" | "files" | "desktop" | "skill";
  operations: string[];
  mode: "automatic" | "approval_required" | "denied";
}

export interface AutomationRule {
  id: string;
  name: string;
  objective: string;
  status: AutomationStatus;
  triggerKind: AutomationTriggerKind;
  scope: SessionScope;
  budget: AutomationBudget;
  toolGrants: ToolGrant[];
  dedupeWindowMs: number;
  createdAt: string;
  updatedAt: string;
  consecutiveFailures: number;
}

export interface AutomationLedger {
  create(rule: Omit<AutomationRule, "id" | "createdAt" | "updatedAt" | "consecutiveFailures" | "status"> & { status?: AutomationStatus }): AutomationRule;
  get(id: string): AutomationRule | undefined;
  list(): AutomationRule[];
  pause(id: string, now?: Date): AutomationRule;
  recordFailure(id: string, falseCompletion: boolean, now?: Date): AutomationRule;
  recordSuccess(id: string, now?: Date): AutomationRule;
}

export function createAutomationLedger(): AutomationLedger {
  const rules = new Map<string, AutomationRule>();
  return {
    create(input) {
      if (input.scope.kind === "private") {
        throw new Error("Private scope cannot persist automation rules.");
      }
      const now = new Date().toISOString();
      const rule: AutomationRule = {
        ...input,
        id: crypto.randomUUID(),
        status: input.status ?? "draft",
        consecutiveFailures: 0,
        createdAt: now,
        updatedAt: now,
      };
      rules.set(rule.id, rule);
      return rule;
    },
    get(id) {
      return rules.get(id);
    },
    list() {
      return [...rules.values()];
    },
    pause(id, now = new Date()) {
      const current = requireRule(rules, id);
      const next = { ...current, status: "paused" as const, updatedAt: now.toISOString() };
      rules.set(id, next);
      return next;
    },
    recordFailure(id, falseCompletion, now = new Date()) {
      const current = requireRule(rules, id);
      const failures = current.consecutiveFailures + 1;
      const status = falseCompletion || failures >= 3 ? "degraded" : current.status;
      const next = {
        ...current,
        consecutiveFailures: failures,
        status: status === "degraded" ? "paused" as const : status,
        updatedAt: now.toISOString(),
      };
      if (falseCompletion) next.status = "paused";
      rules.set(id, next);
      return next;
    },
    recordSuccess(id, now = new Date()) {
      const current = requireRule(rules, id);
      const next = { ...current, consecutiveFailures: 0, updatedAt: now.toISOString() };
      rules.set(id, next);
      return next;
    },
  };
}

function requireRule(rules: Map<string, AutomationRule>, id: string): AutomationRule {
  const current = rules.get(id);
  if (current === undefined) throw new Error("Unknown automation rule.");
  return current;
}
