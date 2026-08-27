import type { EvidenceSnippet, ResearchClaim, ResearchSource } from "./research-record.js";

export type ClaimRejectionCode =
  | "missing_evidence"
  | "snippet_claimed_as_primary"
  | "stale_source"
  | "low_trust_high_confidence"
  | "undisputed_conflict"
  | "unknown_source"
  | "unknown_evidence";

export interface ClaimValidation {
  accepted: boolean;
  rejections: Array<{ claimId: string; code: ClaimRejectionCode }>;
}

export function validateResearchClaims(input: {
  claims: readonly ResearchClaim[];
  evidence: readonly EvidenceSnippet[];
  sources: readonly ResearchSource[];
  now?: Date;
  staleBefore?: string;
}): ClaimValidation {
  const sources = new Map(input.sources.map((source) => [source.sourceId, source]));
  const evidence = new Map(input.evidence.map((item) => [item.evidenceId, item]));
  const rejections: ClaimValidation["rejections"] = [];
  const staleCutoff = input.staleBefore === undefined ? undefined : Date.parse(input.staleBefore);

  for (const claim of input.claims) {
    if (claim.kind !== "factual") continue;
    if (claim.evidenceIds.length === 0) {
      rejections.push({ claimId: claim.claimId, code: "missing_evidence" });
      continue;
    }
    const snippets: EvidenceSnippet[] = [];
    let unknown = false;
    for (const evidenceId of claim.evidenceIds) {
      const snippet = evidence.get(evidenceId);
      if (snippet === undefined) {
        rejections.push({ claimId: claim.claimId, code: "unknown_evidence" });
        unknown = true;
        break;
      }
      snippets.push(snippet);
    }
    if (unknown) continue;
    const linkedSources: ResearchSource[] = [];
    for (const snippet of snippets) {
      const source = sources.get(snippet.sourceId);
      if (source === undefined) {
        rejections.push({ claimId: claim.claimId, code: "unknown_source" });
        unknown = true;
        break;
      }
      linkedSources.push(source);
    }
    if (unknown) continue;
    if (!linkedSources.some((source) => source.kind === "primary_page")) {
      rejections.push({ claimId: claim.claimId, code: "snippet_claimed_as_primary" });
    }
    if (staleCutoff !== undefined && linkedSources.every((source) => {
      const published = source.publishedAt === undefined ? Number.NaN : Date.parse(source.publishedAt);
      return Number.isFinite(published) && published < staleCutoff;
    })) {
      rejections.push({ claimId: claim.claimId, code: "stale_source" });
    }
    if (claim.confidence === "high" && linkedSources.every((source) => source.trustTier >= 3) && linkedSources.length < 2) {
      rejections.push({ claimId: claim.claimId, code: "low_trust_high_confidence" });
    }
  }

  const factualTexts = input.claims.filter((claim) => claim.kind === "factual");
  for (let i = 0; i < factualTexts.length; i += 1) {
    for (let j = i + 1; j < factualTexts.length; j += 1) {
      const left = factualTexts[i]!;
      const right = factualTexts[j]!;
      if (left.text === right.text) continue;
      const shared = left.evidenceIds.some((id) => right.evidenceIds.includes(id));
      if (!shared && !left.disputed && !right.disputed && left.text.toLowerCase().includes("not") !== right.text.toLowerCase().includes("not") && overlapTokens(left.text, right.text)) {
        rejections.push({ claimId: left.claimId, code: "undisputed_conflict" });
        rejections.push({ claimId: right.claimId, code: "undisputed_conflict" });
      }
    }
  }

  return { accepted: rejections.length === 0, rejections };
}

function overlapTokens(left: string, right: string): boolean {
  const leftTokens = new Set(left.toLowerCase().split(/\W+/).filter((token) => token.length > 3));
  const rightTokens = right.toLowerCase().split(/\W+/).filter((token) => token.length > 3);
  return rightTokens.filter((token) => leftTokens.has(token)).length >= 3;
}
