import type { DesktopAction, DesktopActionProposal } from "./desktop-action.js";
import { observationHasTarget, observationIsFresh, type DesktopObservation } from "./desktop-observation.js";

export const DEFAULT_DESKTOP_STEP_BUDGET = 8;
export const AUTHORIZED_COMBO_STEP_BUDGET = 12;
export const MAX_CONSECUTIVE_VERIFY_FAILURES = 2;

export type DesktopPolicyDecision =
  | { decision: "allow"; budget: number }
  | { decision: "block"; code: "stale" | "action_limit_reached" | "unknown_no_retry" | "verify_failures" | "cancelled" | "missing_target" | "private_context"; message: string }
  | { decision: "approval_required"; message: string };

export interface DesktopTurnPolicyState {
  actionCount: number;
  budget: number;
  cancelled: boolean;
  unknownDigests: ReadonlySet<string>;
  consecutiveVerifyFailures: number;
  privateScope: boolean;
}

export interface ApprovalToken {
  requestId: string;
  actionDigest: string;
  appBundleId?: string;
  expiresAt: string;
  nonce: string;
}

export function desktopStepBudget(input: { authorizedCombo?: boolean } = {}): number {
  return input.authorizedCombo === true ? AUTHORIZED_COMBO_STEP_BUDGET : DEFAULT_DESKTOP_STEP_BUDGET;
}

export function desktopRisk(action: DesktopAction): "low" | "medium" | "high" {
  switch (action.kind) {
    case "wait":
    case "copy":
    case "scroll":
    case "focus_window":
      return "low";
    case "press":
    case "set_text":
    case "key_press":
    case "open_app":
    case "paste":
      return "medium";
    case "select_menu_item":
      return "high";
  }
}

export function evaluateDesktopProposal(input: {
  proposal: DesktopActionProposal;
  observation: DesktopObservation | undefined;
  state: DesktopTurnPolicyState;
  now: Date;
  approval?: ApprovalToken;
}): DesktopPolicyDecision {
  if (input.state.cancelled) {
    return { decision: "block", code: "cancelled", message: "Desktop action was cancelled before commit." };
  }
  if (input.state.privateScope) {
    return { decision: "block", code: "private_context", message: "Private turns do not persist desktop context or retry actions." };
  }
  if (input.state.actionCount >= input.state.budget) {
    return {
      decision: "block",
      code: "action_limit_reached",
      message: `This turn reached its desktop action budget of ${input.state.budget}.`,
    };
  }
  if (input.state.consecutiveVerifyFailures >= MAX_CONSECUTIVE_VERIFY_FAILURES) {
    return {
      decision: "block",
      code: "verify_failures",
      message: "Two consecutive desktop verifications failed; the user needs to take over.",
    };
  }
  const digest = JSON.stringify(input.proposal.action);
  if (input.state.unknownDigests.has(digest)) {
    return {
      decision: "block",
      code: "unknown_no_retry",
      message: "An earlier commit for this action returned unknown; it will not be retried.",
    };
  }
  const observation = input.observation;
  if (observation === undefined || observation.observationId !== input.proposal.basisObservationId) {
    return { decision: "block", code: "stale", message: "Desktop action is missing a matching fresh observation." };
  }
  if (!observationIsFresh(observation, input.now)) {
    return { decision: "block", code: "stale", message: "Desktop observation expired before commit." };
  }
  const targetId = "targetId" in input.proposal.action ? input.proposal.action.targetId : undefined;
  if (targetId !== undefined && !observationHasTarget(observation, targetId)) {
    return { decision: "block", code: "missing_target", message: "Target is not in the current observation." };
  }
  if (desktopRisk(input.proposal.action) === "high") {
    if (input.approval === undefined
      || input.approval.requestId !== input.proposal.requestId
      || input.approval.actionDigest !== digest
      || Date.parse(input.approval.expiresAt) <= input.now.getTime()) {
      return {
        decision: "approval_required",
        message: "This desktop action requires a one-time approval token bound to the current request.",
      };
    }
  }
  return { decision: "allow", budget: input.state.budget };
}
