import { randomUUID } from "node:crypto";
import {
  digestDesktopAction,
  isEffectfulDesktopAction,
  type DesktopActionProposal,
  type DesktopActionReceipt,
  type DesktopReceiptStatus,
} from "./desktop-action.js";
import type { DesktopObservation } from "./desktop-observation.js";
import {
  evaluateDesktopProposal,
  type ApprovalToken,
  type DesktopTurnPolicyState,
} from "./desktop-policy.js";

export interface DesktopLoopState extends DesktopTurnPolicyState {
  lastObservation?: DesktopObservation;
  unknownDigests: Set<string>;
}

export function createDesktopLoopState(input: {
  budget: number;
  privateScope?: boolean;
}): DesktopLoopState {
  return {
    actionCount: 0,
    budget: input.budget,
    cancelled: false,
    unknownDigests: new Set(),
    consecutiveVerifyFailures: 0,
    privateScope: input.privateScope === true,
  };
}

export interface DesktopCommitResult {
  status: DesktopReceiptStatus;
  committed: boolean;
  verified: boolean;
  evidenceCode?: string;
  nextObservation?: DesktopObservation;
}

export async function runDesktopStep(input: {
  proposal: DesktopActionProposal;
  state: DesktopLoopState;
  now: Date;
  approval?: ApprovalToken;
  commit: (proposal: DesktopActionProposal) => Promise<DesktopCommitResult>;
}): Promise<DesktopActionReceipt> {
  const receiptId = randomUUID();
  const attemptId = randomUUID();
  const actionDigest = digestDesktopAction(input.proposal.action);
  const decision = evaluateDesktopProposal({
    proposal: input.proposal,
    observation: input.state.lastObservation,
    state: input.state,
    now: input.now,
    ...(input.approval === undefined ? {} : { approval: input.approval }),
  });
  if (decision.decision === "block") {
    return {
      receiptId,
      requestId: input.proposal.requestId,
      attemptId,
      actionDigest,
      basisObservationId: input.proposal.basisObservationId,
      status: decision.code === "stale" || decision.code === "missing_target" ? "stale" : "blocked",
      committed: false,
      verified: false,
      evidenceCode: decision.code,
    };
  }
  if (decision.decision === "approval_required") {
    return {
      receiptId,
      requestId: input.proposal.requestId,
      attemptId,
      actionDigest,
      basisObservationId: input.proposal.basisObservationId,
      status: "blocked",
      committed: false,
      verified: false,
      evidenceCode: "approval_required",
    };
  }
  const result = await input.commit(input.proposal);
  if (isEffectfulDesktopAction(input.proposal.action)) {
    input.state.actionCount += 1;
  }
  if (result.status === "unknown" && result.committed) {
    input.state.unknownDigests.add(actionDigest);
  }
  if (result.verified) {
    input.state.consecutiveVerifyFailures = 0;
  } else if (result.status === "failed" || result.status === "stale") {
    input.state.consecutiveVerifyFailures += 1;
  }
  if (result.nextObservation !== undefined) {
    input.state.lastObservation = result.nextObservation;
  }
  const receipt: DesktopActionReceipt = {
    receiptId,
    requestId: input.proposal.requestId,
    attemptId,
    actionDigest,
    basisObservationId: input.proposal.basisObservationId,
    status: result.status,
    committed: result.committed,
    verified: result.verified,
  };
  if (result.evidenceCode !== undefined) receipt.evidenceCode = result.evidenceCode;
  if (result.nextObservation !== undefined) receipt.nextObservationId = result.nextObservation.observationId;
  return receipt;
}
