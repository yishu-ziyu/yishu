import type { ActionRisk, AuthorityLevel } from "./action/types.js"

/** Product-owned success rule for one immutable execution contract. */
export type TaskSuccessMode = "read_only_delivery" | "external_effect"

export interface TaskExecutionContract {
  readonly objective: string
  readonly successMode: TaskSuccessMode
  readonly authority: AuthorityLevel
  readonly risk: ActionRisk
  /** Total dispatched attempts, including the first attempt. */
  readonly maxAttempts: number
}

export type TaskExecutionContractInput = TaskExecutionContract

export function createTaskExecutionContract(
  input: TaskExecutionContractInput,
): TaskExecutionContract {
  const objective = input.objective.replace(/\s+/gu, " ").trim().slice(0, 160)
  if (objective.length === 0) {
    throw new Error("Task execution contract requires an objective")
  }
  if (input.maxAttempts !== 1) {
    throw new Error("Task execution contract requires maxAttempts = 1")
  }
  if (input.successMode !== "read_only_delivery" && input.successMode !== "external_effect") {
    throw new Error("Task execution contract has an invalid success mode")
  }
  if (!["automatic", "reversible", "standing_mandate", "explicit_approval"].includes(input.authority)) {
    throw new Error("Task execution contract has an invalid authority")
  }
  if (!["low", "medium", "high", "critical"].includes(input.risk)) {
    throw new Error("Task execution contract has an invalid risk")
  }
  return Object.freeze({
    objective,
    successMode: input.successMode,
    authority: input.authority,
    risk: input.risk,
    maxAttempts: input.maxAttempts,
  })
}

/** Trusted evidence produced by an actuator receipt or a fresh read-back. */
export interface ExternalTaskVerification {
  readonly source: "action_receipt" | "read_back"
  readonly verified: boolean
}

export interface TaskCompletionObservation {
  readonly responseText?: string
  readonly externalVerification?: ExternalTaskVerification
}

export type TaskCompletionKind = "completed" | "verified" | "unverified"

export function evaluateTaskCompletion(
  contract: TaskExecutionContract,
  observation: TaskCompletionObservation,
): TaskCompletionKind {
  if (contract.successMode === "read_only_delivery") {
    return observation.responseText?.trim() ? "completed" : "unverified"
  }
  return observation.externalVerification?.verified === true
    ? "verified"
    : "unverified"
}

export interface TaskRetryInput {
  /** Number of attempts already dispatched. */
  readonly attemptsUsed: number
  readonly proposedAuthority: AuthorityLevel
  readonly proposedRisk: ActionRisk
}

export interface ActionBoundaryInput {
  readonly proposedAuthority: AuthorityLevel
  readonly proposedRisk: ActionRisk
}

export type ActionBoundaryDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "escalate"; readonly reason: "authority_changed" | "risk_increased" }

/** Validate an in-turn action boundary without consuming a task attempt. */
export function evaluateActionBoundary(
  contract: TaskExecutionContract,
  input: ActionBoundaryInput,
): ActionBoundaryDecision {
  if (input.proposedAuthority !== contract.authority) {
    return { decision: "escalate", reason: "authority_changed" }
  }
  if (RISK_RANK[input.proposedRisk] > RISK_RANK[contract.risk]) {
    return { decision: "escalate", reason: "risk_increased" }
  }
  return { decision: "allow" }
}

export type TaskRetryDecision =
  | { readonly decision: "retry"; readonly nextAttempt: number }
  | {
      readonly decision: "escalate"
      readonly reason: "authority_changed" | "risk_increased" | "attempt_budget_exhausted"
    }

const RISK_RANK: Readonly<Record<ActionRisk, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
}

export function decideTaskRetry(
  contract: TaskExecutionContract,
  input: TaskRetryInput,
): TaskRetryDecision {
  if (!Number.isInteger(input.attemptsUsed) || input.attemptsUsed < 0) {
    throw new Error("Task retry decision requires attemptsUsed >= 0")
  }
  if (input.proposedAuthority !== contract.authority) {
    return { decision: "escalate", reason: "authority_changed" }
  }
  if (RISK_RANK[input.proposedRisk] > RISK_RANK[contract.risk]) {
    return { decision: "escalate", reason: "risk_increased" }
  }
  if (input.attemptsUsed >= contract.maxAttempts) {
    return { decision: "escalate", reason: "attempt_budget_exhausted" }
  }
  return { decision: "retry", nextAttempt: input.attemptsUsed + 1 }
}
