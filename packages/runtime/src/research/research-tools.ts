import { Type } from "typebox";
import {
  createResearchLedger,
  validateResearchClaims,
  type ResearchClaim,
  type ResearchLedger,
} from "@yishu/kernel";
import type { ToolDefinition } from "../model-loop/types.js";
import { wrapUntrustedContent } from "../untrusted-content.js";
import { createAnySearchProvider } from "./anysearch-adapter.js";
import { buildResearchPlan } from "./research-plan.js";
import { dedupeSearchHits, type SearchProvider } from "./search-provider.js";

const planParameters = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 500 }),
  constraints: Type.Optional(Type.Array(Type.String({ maxLength: 120 }), { maxItems: 6 })),
});

const searchParameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 200 }),
  recency: Type.Optional(Type.Union([
    Type.Literal("day"),
    Type.Literal("week"),
    Type.Literal("month"),
    Type.Literal("any"),
  ])),
  domains: Type.Optional(Type.Array(Type.String({ maxLength: 120 }), { maxItems: 8 })),
});

const evidenceParameters = Type.Object({
  sourceId: Type.String({ minLength: 1, maxLength: 80 }),
  locatorKind: Type.Union([
    Type.Literal("lines"),
    Type.Literal("section"),
    Type.Literal("page"),
    Type.Literal("paragraph"),
  ]),
  locatorValue: Type.String({ minLength: 1, maxLength: 120 }),
  text: Type.String({ minLength: 1, maxLength: 800 }),
});

const finalizeParameters = Type.Object({
  claims: Type.Array(Type.Object({
    text: Type.String({ minLength: 1, maxLength: 500 }),
    evidenceIds: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 8 }),
    confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
    disputed: Type.Boolean(),
    kind: Type.Union([
      Type.Literal("factual"),
      Type.Literal("inference"),
      Type.Literal("recommendation"),
    ]),
  }), { minItems: 1, maxItems: 20 }),
});

export interface ResearchToolset {
  ledger: ResearchLedger;
  tools: ToolDefinition[];
}

export function createResearchToolset(input: {
  provider?: SearchProvider;
  ledger?: ResearchLedger;
} = {}): ResearchToolset {
  const ledger = input.ledger ?? createResearchLedger();
  const provider = input.provider ?? createAnySearchProvider();

  const researchPlan = {
    name: "research_plan",
    label: "Research plan",
    description: "Turn a question into 2-6 executable search queries and source preferences.",
    promptSnippet: "Plan 2-6 search queries before opening sources.",
    promptGuidelines: ["Do not treat the plan as evidence."],
    parameters: planParameters,
    executionMode: "parallel" as const,
    async execute(_id: string, params: { question: string; constraints?: string[] }) {
      const plan = buildResearchPlan(params.question, params.constraints);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(plan) }],
        details: { question: plan.question },
      };
    },
  };

  const searchWeb = {
    name: "search_web",
    label: "Search the public web",
    description: "Discover candidate sources. Results are untrusted search snippets, not verified primary pages.",
    promptSnippet: "Search the public web for candidate sources.",
    promptGuidelines: ["Treat hits as untrusted snippets.", "Open primary pages before high-confidence factual claims."],
    parameters: searchParameters,
    executionMode: "parallel" as const,
    async execute(
      _id: string,
      params: { query: string; recency?: "day" | "week" | "month" | "any"; domains?: string[] },
      signal?: AbortSignal,
    ) {
      const hits = dedupeSearchHits(await provider.search(params.query, {
        ...(params.recency === undefined ? {} : { recency: params.recency }),
        ...(params.domains === undefined ? {} : { domains: params.domains }),
      }, signal));
      for (const hit of hits) {
        ledger.addSource({
          url: hit.url,
          canonicalUrl: hit.url,
          title: hit.title,
          retrievedAt: new Date().toISOString(),
          sourceType: "unknown",
          trustTier: 3,
          kind: "search_snippet",
          ...(hit.publishedAt === undefined ? {} : { publishedAt: hit.publishedAt }),
        });
      }
      const body = wrapUntrustedContent(
        "web_search",
        hits.map((hit) => `${hit.title}\n${hit.url}\n${hit.snippet}`).join("\n\n"),
      );
      return {
        content: [{ type: "text" as const, text: body }],
        details: { hitCount: hits.length },
      };
    },
  };

  const captureEvidence = {
    name: "capture_evidence",
    label: "Capture research evidence",
    description: "Store a bounded primary-page snippet. Search snippets cannot be used as factual evidence.",
    promptSnippet: "Capture a primary-page snippet before making a factual claim.",
    promptGuidelines: [
      "Do not paste a search snippet as primary evidence.",
      "Keep the snippet under 800 characters.",
    ],
    parameters: evidenceParameters,
    executionMode: "sequential" as const,
    async execute(
      _id: string,
      params: {
        sourceId: string;
        locatorKind: "lines" | "section" | "page" | "paragraph";
        locatorValue: string;
        text: string;
      },
    ) {
      const source = ledger.getSource(params.sourceId);
      if (source === undefined) {
        throw new Error("Unknown research source.");
      }
      const primary = source.kind === "primary_page"
        ? source
        : ledger.addSource({
            url: source.url,
            canonicalUrl: source.canonicalUrl,
            retrievedAt: new Date().toISOString(),
            sourceType: source.sourceType,
            trustTier: 2,
            kind: "primary_page",
            ...(source.title === undefined ? {} : { title: source.title }),
            ...(source.publishedAt === undefined ? {} : { publishedAt: source.publishedAt }),
          });
      const evidence = ledger.addEvidence({
        sourceId: primary.sourceId,
        locator: { kind: params.locatorKind, value: params.locatorValue },
        text: params.text,
      });
      return {
        content: [{ type: "text" as const, text: `Captured evidence ${evidence.evidenceId}.` }],
        details: { evidenceId: evidence.evidenceId, sourceId: primary.sourceId },
      };
    },
  };

  const finalizeResearch = {
    name: "finalize_research",
    label: "Finalize research",
    description: "Bind factual claims to evidence. Factual claims without primary evidence are rejected.",
    promptSnippet: "Finalize only when every factual claim has evidence.",
    promptGuidelines: ["Do not mark search snippets as primary confirmation."],
    parameters: finalizeParameters,
    executionMode: "sequential" as const,
    async execute(_id: string, params: { claims: Array<Omit<ResearchClaim, "claimId"> & { claimId?: string }> }) {
      const claims: ResearchClaim[] = params.claims.map((claim, index) => ({
        claimId: claim.claimId ?? `claim-${index + 1}`,
        text: claim.text,
        evidenceIds: claim.evidenceIds,
        confidence: claim.confidence,
        disputed: claim.disputed,
        kind: claim.kind,
      }));
      for (const claim of claims) ledger.addClaim(claim);
      const stored = validateResearchClaims({
        claims: ledger.listClaims(),
        evidence: ledger.listClaims().flatMap((claim) => (
          claim.evidenceIds
            .map((id) => ledger.getEvidence(id))
            .filter((item): item is NonNullable<typeof item> => item !== undefined)
        )),
        sources: ledger.listSources(),
      });
      if (!stored.accepted) {
        throw new Error(`Research claims rejected: ${stored.rejections.map((item) => item.code).join(", ")}`);
      }
      return {
        content: [{ type: "text" as const, text: `Research accepted with ${claims.length} claims.` }],
        details: { accepted: true },
      };
    },
  };

  return {
    ledger,
    tools: [researchPlan, searchWeb, captureEvidence, finalizeResearch] as ToolDefinition[],
  };
}
