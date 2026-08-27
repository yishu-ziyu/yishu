import assert from "node:assert/strict";
import test from "node:test";
import { createResearchLedger } from "@yishu/kernel";
import { buildResearchPlan } from "../src/research/research-plan.js";
import { canonicalizeUrl, dedupeSearchHits } from "../src/research/search-provider.js";
import { createResearchToolset } from "../src/research/research-tools.js";
import { issueApprovalToken, verifyApprovalToken } from "../src/executor/approval-token.js";
import { isPrivilegedActionKind } from "../src/executor/privileged-action.js";

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
  const sourceId = ledger.listSources()[0]?.sourceId;
  assert.ok(sourceId);
  const captured = await capture.execute("2", {
    sourceId,
    locatorKind: "paragraph",
    locatorValue: "p1",
    text: "Mars appears red because of iron oxide.",
  } as never);
  const evidenceId = (captured.details as { evidenceId: string }).evidenceId;
  const done = await finalize.execute("3", {
    claims: [{
      text: "Mars appears red because of iron oxide.",
      evidenceIds: [evidenceId],
      confidence: "medium",
      disputed: false,
      kind: "factual",
    }],
  } as never);
  assert.match(done.content[0]?.type === "text" ? done.content[0].text : "", /accepted/);
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
