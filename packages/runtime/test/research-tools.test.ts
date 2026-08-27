import assert from "node:assert/strict";
import test from "node:test";
import { createResearchLedger, type ResearchLedger } from "@yishu/kernel";
import { detectFalseCompletions } from "../src/observability/false-completion.js";
import { buildResearchPlan } from "../src/research/research-plan.js";
import {
  gateResearchTurnCompletion,
  researchFactualAnswerVerified,
} from "../src/research/research-completion-gate.js";
import { canonicalizeUrl, dedupeSearchHits } from "../src/research/search-provider.js";
import { createResearchToolset, recordOpenedPrimaryPage } from "../src/research/research-tools.js";
import { issueApprovalToken, verifyApprovalToken } from "../src/executor/approval-token.js";
import { isPrivilegedActionKind } from "../src/executor/privileged-action.js";

function addOpenedPrimaryPage(ledger: ResearchLedger, url = "https://example.com/mars") {
  return ledger.addSource({
    url,
    canonicalUrl: url,
    title: "Mars",
    retrievedAt: "2026-08-27T00:00:00.000Z",
    sourceType: "documentation",
    trustTier: 2,
    kind: "primary_page",
  });
}

test("research plan stays between 2 and 6 queries", () => {
  const plan = buildResearchPlan("What is Yishu?");
  assert.ok(plan.queries.length >= 2 && plan.queries.length <= 6);
});

test("search hits are canonicalized and deduped", () => {
  const hits = dedupeSearchHits([
    { url: "https://example.com/a/", title: "A", snippet: "one" },
    { url: "https://example.com/a", title: "A again", snippet: "two" },
  ]);
  assert.equal(hits.length, 1);
  assert.equal(canonicalizeUrl("https://example.com/a/"), "https://example.com/a");
});

test("capture_evidence plus finalize accepts a sourced factual claim", async () => {
  const ledger = createResearchLedger();
  const toolset = createResearchToolset({
    ledger,
    provider: {
      id: "fake",
      async search() {
        return [{ url: "https://example.com/mars", title: "Mars", snippet: "red" }];
      },
    },
  });
  const search = toolset.tools.find((tool) => tool.name === "search_web");
  const capture = toolset.tools.find((tool) => tool.name === "capture_evidence");
  const finalize = toolset.tools.find((tool) => tool.name === "finalize_research");
  assert.ok(search && capture && finalize);
  await search.execute("1", { query: "mars color" } as never);
  const snippetId = ledger.listSources()[0]?.sourceId;
  assert.ok(snippetId);
  await assert.rejects(
    () => capture.execute("2", {
      sourceId: snippetId,
      locatorKind: "paragraph",
      locatorValue: "p1",
      text: "Mars appears red because of iron oxide.",
    } as never),
    /snippet_claimed_as_primary/,
  );
  assert.equal(ledger.listSources().every((source) => source.kind === "search_snippet"), true);
  const primary = addOpenedPrimaryPage(ledger);
  const captured = await capture.execute("3", {
    sourceId: primary.sourceId,
    locatorKind: "paragraph",
    locatorValue: "p1",
    text: "Mars appears red because of iron oxide.",
  } as never);
  const evidenceId = (captured.details as { evidenceId: string }).evidenceId;
  const done = await finalize.execute("4", {
    claims: [{
      text: "Mars appears red because of iron oxide.",
      evidenceIds: [evidenceId],
      confidence: "medium",
      disputed: false,
      kind: "factual",
    }],
  } as never);
  assert.match(done.content[0]?.type === "text" ? done.content[0].text : "", /accepted/);
  assert.match(done.content[0]?.type === "text" ? done.content[0].text : "", /https:\/\/example.com\/mars/);
  assert.deepEqual((done.details as { openedPages?: string[] }).openedPages, ["https://example.com/mars"]);
});

test("web_search then speak without capture or finalize is not a verified completion", () => {
  const gated = gateResearchTurnCompletion({
    toolsUsed: [{ name: "web_search" }],
    speech: "Mars is red because of iron oxide.",
    verified: true,
  });
  assert.equal(gated.verified, false);
  assert.equal(gated.verifier, "research-unverified");
  assert.equal(researchFactualAnswerVerified({
    searchUsed: true,
    captureSucceeded: false,
    finalizeAccepted: false,
  }), false);
  assert.ok(gated.findings.some((item) => item.code === "search_without_primary_evidence"));
  const captureOnly = gateResearchTurnCompletion({
    toolsUsed: [{ name: "search_web" }, { name: "capture_evidence" }],
    speech: "Mars is red because of iron oxide.",
    verified: true,
  });
  assert.equal(captureOnly.verified, false);
  const finalizeWithoutCapture = gateResearchTurnCompletion({
    toolsUsed: [{ name: "web_search" }, { name: "finalize_research" }],
    speech: "Mars is red because of iron oxide.",
    verified: true,
  });
  assert.equal(finalizeWithoutCapture.verified, false);
  const honest = gateResearchTurnCompletion({
    toolsUsed: [
      { name: "search_web" },
      { name: "capture_evidence" },
      { name: "finalize_research" },
    ],
    speech: "Mars is red because of iron oxide.",
    verified: false,
  });
  assert.equal(honest.verified, false);
  assert.equal(honest.findings.length, 0);
  assert.equal(honest.verifier, "conversation-response-only");
  const findings = detectFalseCompletions({
    tasks: [{
      taskId: "t-search",
      status: "completed",
      verified: true,
      searchUsed: true,
      researchFinalized: false,
    }],
    utterances: [{ text: "Mars is red because of iron oxide.", taskId: "t-search" }],
  });
  assert.ok(findings.some((item) => item.code === "search_without_primary_evidence"));
});

test("opening a page records primary_page and does not upgrade the search snippet", () => {
  const ledger = createResearchLedger();
  const snippet = ledger.addSource({
    url: "https://example.com/mars",
    canonicalUrl: "https://example.com/mars",
    retrievedAt: "2026-08-27T00:00:00.000Z",
    sourceType: "unknown",
    trustTier: 3,
    kind: "search_snippet",
  });
  recordOpenedPrimaryPage(ledger, { url: "https://example.com/mars/", title: "Mars" });
  const kinds = ledger.listSources().map((source) => source.kind).sort();
  assert.deepEqual(kinds, ["primary_page", "search_snippet"]);
  assert.equal(ledger.getSource(snippet.sourceId)?.kind, "search_snippet");
  const primary = ledger.listSources().find((source) => source.kind === "primary_page");
  assert.equal(primary?.canonicalUrl, "https://example.com/mars");
});

test("finalize_research rejects factual claims with no evidence", async () => {
  const toolset = createResearchToolset({
    ledger: createResearchLedger(),
    provider: { id: "fake", async search() { return []; } },
  });
  const finalize = toolset.tools.find((tool) => tool.name === "finalize_research");
  assert.ok(finalize);
  await assert.rejects(
    () => finalize.execute("1", {
      claims: [{
        text: "Mars is green",
        evidenceIds: [],
        confidence: "high",
        disputed: false,
        kind: "factual",
      }],
    } as never),
    /missing_evidence|rejected/,
  );
});

test("approval tokens cannot be replayed or rebound", () => {
  const secret = "test-secret";
  const token = issueApprovalToken({
    secret,
    requestId: "r1",
    actionDigest: "digest",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  const seen = new Set<string>();
  assert.equal(verifyApprovalToken({
    secret,
    token,
    requestId: "r1",
    actionDigest: "digest",
    now: new Date("2026-08-27T00:00:00.000Z"),
    seenNonces: seen,
  }), true);
  assert.equal(verifyApprovalToken({
    secret,
    token,
    requestId: "r1",
    actionDigest: "digest",
    now: new Date("2026-08-27T00:00:00.000Z"),
    seenNonces: seen,
  }), false);
  assert.equal(isPrivilegedActionKind("arbitrary_shell"), false);
  assert.equal(isPrivilegedActionKind("desktop_action"), true);
});
