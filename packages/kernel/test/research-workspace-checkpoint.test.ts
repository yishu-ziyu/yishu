import assert from "node:assert/strict";
import test from "node:test";
import {
  createAutomationLedger,
  createCheckpointLedger,
  createProjectContinuity,
  createResearchLedger,
  createWorkspaceLedger,
  validateResearchClaims,
  createYishuKernel,
} from "../src/index.js";

test("kernel exposes workspace, research, checkpoint, and automation ledgers", () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  assert.ok(kernel.workspaces);
  assert.ok(kernel.research);
  assert.ok(kernel.checkpoints);
  assert.ok(kernel.automation);
  assert.ok(kernel.projects);
});

test("private automation rules are rejected", () => {
  const ledger = createAutomationLedger();
  assert.throws(() => ledger.create({
    name: "nightly",
    objective: "summarize",
    triggerKind: "schedule",
    scope: { kind: "private" },
    budget: { maxDurationMs: 1000, maxSteps: 4, maxModelCalls: 2, maxRunsPerDay: 1 },
    toolGrants: [],
    dedupeWindowMs: 60_000,
  }), /Private scope/);
});

test("false completion pauses an automation rule", () => {
  const ledger = createAutomationLedger();
  const rule = ledger.create({
    name: "nightly",
    objective: "summarize",
    triggerKind: "schedule",
    scope: { kind: "personal" },
    budget: { maxDurationMs: 1000, maxSteps: 4, maxModelCalls: 2, maxRunsPerDay: 1 },
    toolGrants: [{ tool: "research", operations: ["search_web"], mode: "automatic" }],
    dedupeWindowMs: 60_000,
  });
  const paused = ledger.recordFailure(rule.id, true);
  assert.equal(paused.status, "paused");
});

test("checkpoint idempotency keys do not double-commit", () => {
  const ledger = createCheckpointLedger();
  const checkpoint = ledger.create({ taskId: "t1", requestId: "r1" });
  ledger.recordStep({
    checkpointId: checkpoint.checkpointId,
    stepId: "s1",
    idempotencyKey: "k1",
    committed: true,
    receiptId: "rcpt-1",
  });
  const again = ledger.recordStep({
    checkpointId: checkpoint.checkpointId,
    stepId: "s1-dup",
    idempotencyKey: "k1",
    committed: true,
  });
  assert.equal(again.steps.length, 1);
  assert.throws(() => ledger.resume(ledger.consume(checkpoint.checkpointId).checkpointId), /Consumed/);
});

test("project continuity isolates projects and honors corrections", () => {
  const continuity = createProjectContinuity();
  const projectA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const projectB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const fact = continuity.remember({
    projectId: projectA,
    text: "deadline is Friday",
    scope: { kind: "project", projectId: projectA },
  });
  assert.equal(continuity.recall(projectA, { kind: "project", projectId: projectA })[0]?.text, "deadline is Friday");
  assert.throws(() => continuity.recall(projectA, { kind: "project", projectId: projectB }), /isolated/);
  continuity.correct({
    projectId: projectA,
    factId: fact.id,
    text: "deadline is Monday",
    scope: { kind: "project", projectId: projectA },
  });
  assert.deepEqual(
    continuity.recall(projectA, { kind: "project", projectId: projectA }).map((item) => item.text),
    ["deadline is Monday"],
  );
});

test("factual claims without primary evidence are rejected", () => {
  const ledger = createResearchLedger();
  const source = ledger.addSource({
    url: "https://example.com",
    canonicalUrl: "https://example.com",
    retrievedAt: "2026-08-27T00:00:00.000Z",
    sourceType: "news",
    trustTier: 3,
    kind: "search_snippet",
  });
  const evidence = ledger.addEvidence({
    sourceId: source.sourceId,
    locator: { kind: "paragraph", value: "1" },
    text: "Example snippet",
  });
  const result = validateResearchClaims({
    claims: [{
      claimId: "c1",
      text: "The sky is green",
      evidenceIds: [evidence.evidenceId],
      confidence: "high",
      disputed: false,
      kind: "factual",
    }],
    evidence: [evidence],
    sources: [source],
  });
  assert.equal(result.accepted, false);
  assert.ok(result.rejections.some((item) => item.code === "snippet_claimed_as_primary"));
});

test("workspace grants do not leak across projects", () => {
  const ledger = createWorkspaceLedger();
  const project = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const grant = ledger.create({
    displayName: "A",
    rootPathReference: "/tmp/a",
    scope: { kind: "project", projectId: project },
    capabilities: ["read"],
  });
  assert.equal(ledger.list({ kind: "project", projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }).length, 0);
  assert.equal(ledger.list({ kind: "project", projectId: project })[0]?.id, grant.id);
});
