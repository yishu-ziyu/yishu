import type { FalseCompletionFinding } from "../observability/false-completion.js";

export interface ResearchCompletionTrace {
  searchUsed: boolean;
  captureSucceeded: boolean;
  finalizeAccepted: boolean;
}

export function emptyResearchCompletionTrace(): ResearchCompletionTrace {
  return { searchUsed: false, captureSucceeded: false, finalizeAccepted: false };
}

export function noteResearchTool(
  trace: ResearchCompletionTrace,
  toolName: string,
  isError: boolean,
): void {
  if (isError) return;
  if (toolName === "web_search" || toolName === "search_web") trace.searchUsed = true;
  else if (toolName === "capture_evidence") trace.captureSucceeded = true;
  else if (toolName === "finalize_research") trace.finalizeAccepted = true;
}

export function researchFactualAnswerVerified(trace: ResearchCompletionTrace): boolean {
  return trace.captureSucceeded && trace.finalizeAccepted;
}

export function researchCompletionFields(
  trace: ResearchCompletionTrace,
  computerActionCount: number,
  allComputerActionsVerified: boolean,
): { verified: boolean; verifier: string } {
  if (computerActionCount > 0) {
    return {
      verified: allComputerActionsVerified,
      verifier: "macos-accessibility-result",
    };
  }
  if (trace.searchUsed && !researchFactualAnswerVerified(trace)) {
    return { verified: false, verifier: "research-unverified" };
  }
  return { verified: false, verifier: "conversation-response-only" };
}

export function gateResearchTurnCompletion(input: {
  toolsUsed: readonly { name: string; isError?: boolean }[];
  speech: string;
  verified?: boolean;
}): {
  verified: boolean;
  verifier: string;
  findings: FalseCompletionFinding[];
} {
  const trace = emptyResearchCompletionTrace();
  for (const tool of input.toolsUsed) {
    noteResearchTool(trace, tool.name, tool.isError === true);
  }
  const blocked = trace.searchUsed && !researchFactualAnswerVerified(trace);
  const findings: FalseCompletionFinding[] = blocked && input.speech.trim().length > 0
    ? [{ code: "search_without_primary_evidence" }]
    : [];
  return {
    verified: blocked ? false : input.verified === true,
    verifier: researchCompletionFields(trace, 0, false).verifier,
    findings,
  };
}
