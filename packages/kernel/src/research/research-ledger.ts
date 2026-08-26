import { randomUUID } from "node:crypto";
import {
  EVIDENCE_SNIPPET_MAX_CHARS,
  type EvidenceSnippet,
  type ResearchClaim,
  type ResearchSource,
} from "./research-record.js";

export interface ResearchLedger {
  addSource(source: Omit<ResearchSource, "sourceId"> & { sourceId?: string }): ResearchSource;
  addEvidence(input: Omit<EvidenceSnippet, "evidenceId" | "capturedAt"> & { capturedAt?: string }): EvidenceSnippet;
  addClaim(claim: Omit<ResearchClaim, "claimId"> & { claimId?: string }): ResearchClaim;
  getSource(sourceId: string): ResearchSource | undefined;
  getEvidence(evidenceId: string): EvidenceSnippet | undefined;
  listSources(): ResearchSource[];
  listClaims(): ResearchClaim[];
}

export function createResearchLedger(): ResearchLedger {
  const sources = new Map<string, ResearchSource>();
  const evidence = new Map<string, EvidenceSnippet>();
  const claims = new Map<string, ResearchClaim>();

  return {
    addSource(source) {
      const sourceId = source.sourceId ?? randomUUID();
      const record: ResearchSource = { ...source, sourceId };
      sources.set(sourceId, record);
      return record;
    },
    addEvidence(input) {
      if (input.text.length > EVIDENCE_SNIPPET_MAX_CHARS) {
        throw new Error("Evidence snippet exceeds the size limit.");
      }
      if (!sources.has(input.sourceId)) {
        throw new Error("Evidence refers to an unknown source.");
      }
      const snippet: EvidenceSnippet = {
        evidenceId: randomUUID(),
        sourceId: input.sourceId,
        locator: input.locator,
        text: input.text,
        capturedAt: input.capturedAt ?? new Date().toISOString(),
      };
      evidence.set(snippet.evidenceId, snippet);
      return snippet;
    },
    addClaim(claim) {
      const record: ResearchClaim = { ...claim, claimId: claim.claimId ?? randomUUID() };
      claims.set(record.claimId, record);
      return record;
    },
    getSource(sourceId) {
      return sources.get(sourceId);
    },
    getEvidence(evidenceId) {
      return evidence.get(evidenceId);
    },
    listSources() {
      return [...sources.values()];
    },
    listClaims() {
      return [...claims.values()];
    },
  };
}
