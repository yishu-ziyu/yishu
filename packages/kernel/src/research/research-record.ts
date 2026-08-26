export type ResearchSourceType =
  | "official"
  | "paper"
  | "news"
  | "documentation"
  | "community"
  | "unknown";

export type ResearchTrustTier = 1 | 2 | 3 | 4;

export type ResearchConfidence = "high" | "medium" | "low";

export interface ResearchSource {
  sourceId: string;
  url: string;
  canonicalUrl: string;
  title?: string;
  publisher?: string;
  publishedAt?: string;
  retrievedAt: string;
  sourceType: ResearchSourceType;
  trustTier: ResearchTrustTier;
  contentHash?: string;
  kind: "search_snippet" | "primary_page" | "inference";
}

export interface EvidenceSnippet {
  evidenceId: string;
  sourceId: string;
  locator: { kind: "lines" | "section" | "page" | "paragraph"; value: string };
  text: string;
  capturedAt: string;
}

export interface ResearchClaim {
  claimId: string;
  text: string;
  evidenceIds: string[];
  confidence: ResearchConfidence;
  disputed: boolean;
  kind: "factual" | "inference" | "recommendation";
}

export const EVIDENCE_SNIPPET_MAX_CHARS = 800;
