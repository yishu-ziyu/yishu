import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createCheckpointLedger,
  createProjectContinuity,
  createResearchLedger,
  createWorkspaceLedger,
  validateResearchClaims,
} from "@yishu/kernel";
import { BrowserSessionHub } from "../src/browser-session.js";
import { createDesktopLoopState, runDesktopStep } from "../src/desktop/desktop-loop.js";
import { digestDesktopAction } from "../src/desktop/desktop-action.js";
import type { DesktopObservation } from "../src/desktop/desktop-observation.js";
import { createFileTool } from "../src/files/file-tool.js";
import { createResearchToolset } from "../src/research/research-tools.js";
import { FakeFormDriver } from "./fake-browser-driver.js";

function observation(overrides: Partial<DesktopObservation> = {}): DesktopObservation {
  return {
    observationId: "obs-1",
    capturedAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-08-27T00:05:00.000Z",
    frontmostBundleId: "com.yishu.testbed",
    pixelSpace: "global-top-left",
    targets: [{ targetId: "1", role: "button", enabled: true }],
    warnings: [],
    ...overrides,
  };
}

const now = new Date("2026-08-27T00:00:00.000Z");

async function verifiedPress(step: number) {
  const state = createDesktopLoopState({ budget: 8 });
  const obs = observation({ observationId: `obs-${step}` });
  state.lastObservation = obs;
  return runDesktopStep({
    proposal: {
      action: { kind: "press", targetId: "1" },
      basisObservationId: `obs-${step}`,
      requestId: `r-${step}`,
    },
    state,
    now,
    commit: async () => ({
      status: "verified",
      committed: true,
      verified: true,
      nextObservation: observation({
        observationId: `obs-${step + 1}`,
        previousReadback: `effect-${step}`,
      }),
    }),
  });
}

test("oracle:screen.identify_frontmost", () => {
  const obs = observation({ frontmostBundleId: "com.apple.finder" });
  assert.equal(obs.frontmostBundleId, "com.apple.finder");
});

test("oracle:screen.explain_regions", () => {
  const obs = observation({
    targets: [
      { targetId: "1", role: "button" },
      { targetId: "2", role: "text-field" },
    ],
  });
  assert.deepEqual(obs.targets.map((target) => target.role), ["button", "text-field"]);
});

test("oracle:screen.multi_display_coordinates", () => {
  const obs = observation({ pixelSpace: "global-top-left" });
  assert.equal(obs.pixelSpace, "global-top-left");
});

test("oracle:screen.reject_stale_context_frame", async () => {
  const state = createDesktopLoopState({ budget: 8 });
  state.lastObservation = observation({ expiresAt: "2026-08-26T00:00:00.000Z" });
  const receipt = await runDesktopStep({
    proposal: { action: { kind: "press", targetId: "1" }, basisObservationId: "obs-1", requestId: "r1" },
    state,
    now,
    commit: async () => {
      throw new Error("stale observations must not commit");
    },
  });
  assert.equal(receipt.committed, false);
  assert.equal(receipt.status, "stale");
});

test("oracle:desktop.ax_press_verified", async () => {
  const receipt = await verifiedPress(1);
  assert.equal(receipt.status, "verified");
  assert.equal(receipt.verified, true);
  assert.equal(receipt.committed, true);
});

test("oracle:desktop.set_text_verified", async () => {
  const state = createDesktopLoopState({ budget: 8 });
  state.lastObservation = observation();
  const receipt = await runDesktopStep({
    proposal: {
      action: { kind: "set_text", targetId: "1", text: "hello", mode: "replace" },
      basisObservationId: "obs-1",
      requestId: "r1",
    },
    state,
    now,
    commit: async () => ({
      status: "verified",
      committed: true,
      verified: true,
      nextObservation: observation({ previousReadback: "hello" }),
    }),
  });
  assert.equal(receipt.verified, true);
});

test("oracle:desktop.input_then_submit", async () => {
  const state = createDesktopLoopState({ budget: 8 });
  for (const [index, action] of [
    { kind: "set_text" as const, targetId: "1", text: "hello", mode: "replace" as const },
    { kind: "key_press" as const, key: "enter" as const },
  ].entries()) {
    const observationId = `obs-${index + 1}`;
    state.lastObservation = observation({ observationId });
    const receipt = await runDesktopStep({
      proposal: { action, basisObservationId: observationId, requestId: `r${index}` },
      state,
      now,
      commit: async () => ({
        status: "verified",
        committed: true,
        verified: true,
        nextObservation: observation({ observationId: `obs-${index + 2}` }),
      }),
    });
    assert.equal(receipt.verified, true);
  }
});

test("oracle:desktop.scroll_reobserve", async () => {
  const state = createDesktopLoopState({ budget: 8 });
  state.lastObservation = observation({ observationId: "obs-1" });
  const first = await runDesktopStep({
    proposal: {
      action: { kind: "scroll", axis: "vertical", direction: "forward", amount: "page" },
      basisObservationId: "obs-1",
      requestId: "r1",
    },
    state,
    now,
    commit: async () => ({
      status: "verified",
      committed: true,
      verified: true,
      nextObservation: observation({ observationId: "obs-2", targets: [{ targetId: "40" }] }),
    }),
  });
  assert.equal(first.verified, true);
  const stale = await runDesktopStep({
    proposal: {
      action: { kind: "press", targetId: "1" },
      basisObservationId: "obs-1",
      requestId: "r2",
    },
    state,
    now,
    commit: async () => {
      throw new Error("must reobserve after scroll");
    },
  });
  assert.equal(stale.committed, false);
});

test("oracle:desktop.open_and_focus_app", async () => {
  const state = createDesktopLoopState({ budget: 8 });
  state.lastObservation = observation({ observationId: "obs-1" });
  const opened = await runDesktopStep({
    proposal: {
      action: { kind: "open_app", bundleId: "com.apple.finder" },
      basisObservationId: "obs-1",
      requestId: "r1",
    },
    state,
    now,
    commit: async () => ({
      status: "verified",
      committed: true,
      verified: true,
      nextObservation: observation({
        observationId: "obs-2",
        frontmostBundleId: "com.apple.finder",
        targets: [{ targetId: "w1" }],
      }),
    }),
  });
  assert.equal(opened.verified, true);
  const focused = await runDesktopStep({
    proposal: {
      action: { kind: "focus_window", targetId: "w1" },
      basisObservationId: "obs-2",
      requestId: "r2",
    },
    state,
    now,
    commit: async () => ({ status: "verified", committed: true, verified: true }),
  });
  assert.equal(focused.verified, true);
});

test("oracle:desktop.finder_open_file", async () => {
  const state = createDesktopLoopState({ budget: 8 });
  state.lastObservation = observation({
    observationId: "obs-1",
    frontmostBundleId: "com.apple.finder",
    targets: [{ targetId: "file-1", role: "row" }],
  });
  const receipt = await runDesktopStep({
    proposal: { action: { kind: "press", targetId: "file-1" }, basisObservationId: "obs-1", requestId: "r1" },
    state,
    now,
    commit: async () => ({ status: "verified", committed: true, verified: true }),
  });
  assert.equal(receipt.verified, true);
});

test("oracle:desktop.notes.create_verified", async () => {
  const state = createDesktopLoopState({ budget: 8 });
  state.lastObservation = observation({
    observationId: "obs-1",
    frontmostBundleId: "com.apple.Notes",
    targets: [{ targetId: "1", role: "text-field" }],
  });
  const receipt = await runDesktopStep({
    proposal: {
      action: { kind: "set_text", targetId: "1", text: "note", mode: "replace" },
      basisObservationId: "obs-1",
      requestId: "r1",
    },
    state,
    now,
    commit: async () => ({
      status: "verified",
      committed: true,
      verified: true,
      nextObservation: observation({ previousReadback: "note" }),
    }),
  });
  assert.equal(receipt.verified, true);
});

test("oracle:desktop.high_risk_requires_approval", async () => {
  const state = createDesktopLoopState({ budget: 8 });
  state.lastObservation = observation();
  const receipt = await runDesktopStep({
    proposal: {
      action: { kind: "select_menu_item", appBundleId: "com.apple.finder", path: ["File", "New"] },
      basisObservationId: "obs-1",
      requestId: "r1",
    },
    state,
    now,
    commit: async () => {
      throw new Error("high-risk menu must not commit without approval");
    },
  });
  assert.equal(receipt.committed, false);
  assert.equal(receipt.evidenceCode, "approval_required");
});

test("oracle:browser.open_extract_title", async () => {
  const hub = new BrowserSessionHub(async () => new FakeFormDriver());
  const browser = hub.bind("c1");
  await browser.perform({ op: "goto", url: "https://example.test/" });
  const extracted = await browser.perform({ op: "extract", format: "text" });
  assert.equal(extracted.succeeded, true);
  assert.equal(extracted.title, "Home");
  await hub.close("c1");
});

test("oracle:browser.scroll_offscreen_target", async () => {
  const hub = new BrowserSessionHub(async () => new FakeFormDriver());
  const browser = hub.bind("c1");
  await browser.perform({ op: "goto", url: "https://example.test/form" });
  await browser.perform({ op: "observe" });
  const scrolled = await browser.perform({ op: "scroll", direction: "down", amount: "page" });
  assert.equal(scrolled.succeeded, true);
  const stale = await browser.perform({ op: "click", targetId: "4" });
  assert.equal(stale.succeeded, false);
  await hub.close("c1");
});

test("oracle:browser.multistep_form_submit", async () => {
  const hub = new BrowserSessionHub(async () => new FakeFormDriver());
  const browser = hub.bind("c1");
  await browser.perform({ op: "goto", url: "https://example.test/" });
  await browser.perform({ op: "observe" });
  await browser.perform({ op: "click", targetId: "1" });
  await browser.perform({ op: "observe" });
  await browser.perform({ op: "type", targetId: "1", text: "Ada" });
  await browser.perform({ op: "observe" });
  await browser.perform({ op: "type", targetId: "2", text: "ada@example.test" });
  await browser.perform({ op: "observe" });
  const submitted = await browser.perform({ op: "click", targetId: "3" });
  assert.equal(submitted.succeeded, true);
  assert.equal(submitted.title, "Thanks");
  const extracted = await browser.perform({ op: "extract", format: "text" });
  assert.match(extracted.extracted ?? "", /thanks Ada/);
  await hub.close("c1");
});

test("oracle:browser.reobserve_after_navigation", async () => {
  const hub = new BrowserSessionHub(async () => new FakeFormDriver());
  const browser = hub.bind("c1");
  await browser.perform({ op: "goto", url: "https://example.test/" });
  await browser.perform({ op: "observe" });
  await browser.perform({ op: "click", targetId: "1" });
  const stale = await browser.perform({ op: "click", targetId: "1" });
  assert.equal(stale.succeeded, false);
  await hub.close("c1");
});

test("oracle:browser.profile_survives_restart", async () => {
  const jar = { cookies: [] as string[] };
  const hub = new BrowserSessionHub(async () => new FakeFormDriver(jar));
  const browser = hub.bind("c1");
  await browser.perform({ op: "goto", url: "https://example.test/login" });
  await hub.close("c1");
  const restarted = new BrowserSessionHub(async () => new FakeFormDriver(jar));
  assert.deepEqual(jar.cookies, ["session=1"]);
  await restarted.close("c1");
});

test("oracle:browser.download_to_workspace", async () => {
  const hub = new BrowserSessionHub(async () => new FakeFormDriver());
  const browser = hub.bind("c1");
  await browser.perform({ op: "goto", url: "https://example.test/form" });
  await browser.perform({ op: "observe" });
  const downloaded = await browser.perform({ op: "download", targetId: "1" });
  assert.equal(downloaded.extracted, "invoice.txt");
  const root = await mkdtemp(path.join(tmpdir(), "yishu-dl-"));
  const ledger = createWorkspaceLedger();
  const grant = ledger.create({
    displayName: "downloads",
    rootPathReference: root,
    scope: { kind: "personal" },
    capabilities: ["read", "create"],
  });
  const files = createFileTool({ ledger, resolveRoot: (ref) => ref, scope: { kind: "personal" } });
  const created = await files.execute("1", {
    op: "create_text",
    workspaceId: grant.id,
    path: "invoice.txt",
    content: "ok",
  } as never);
  assert.match(created.content[0]?.type === "text" ? created.content[0].text : "", /Created/);
  await hub.close("c1");
});

test("oracle:research.single_fact_query", async () => {
  const ledger = createResearchLedger();
  const toolset = createResearchToolset({
    ledger,
    provider: { id: "fake", async search() { return [{ url: "https://example.com/mars", title: "Mars", snippet: "red" }]; } },
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

test("oracle:research.multi_query_dedupe", async () => {
  const ledger = createResearchLedger();
  const toolset = createResearchToolset({
    ledger,
    provider: {
      id: "fake",
      async search() {
        return [
          { url: "https://example.com/a/", title: "A", snippet: "one" },
          { url: "https://example.com/a", title: "A", snippet: "one" },
        ];
      },
    },
  });
  const search = toolset.tools.find((tool) => tool.name === "search_web");
  assert.ok(search);
  await search.execute("1", { query: "a" } as never);
  await search.execute("2", { query: "a again" } as never);
  assert.equal(ledger.listSources().length, 1);
});

test("oracle:research.open_source_verify", () => {
  const result = validateResearchClaims({
    claims: [{
      claimId: "c1",
      text: "Mars is red",
      evidenceIds: ["e1"],
      confidence: "medium",
      disputed: false,
      kind: "factual",
    }],
    evidence: [{
      evidenceId: "e1",
      sourceId: "s1",
      locator: { kind: "paragraph", value: "p1" },
      text: "Mars is red",
      capturedAt: now.toISOString(),
    }],
    sources: [{
      sourceId: "s1",
      url: "https://example.com",
      canonicalUrl: "https://example.com",
      retrievedAt: now.toISOString(),
      sourceType: "unknown",
      trustTier: 3,
      kind: "search_snippet",
    }],
  });
  assert.equal(result.accepted, false);
  assert.equal(result.rejections[0]?.code, "snippet_claimed_as_primary");
});

test("oracle:research.claim_evidence_binding", () => {
  const result = validateResearchClaims({
    claims: [{
      claimId: "c1",
      text: "unsupported",
      evidenceIds: [],
      confidence: "high",
      disputed: false,
      kind: "factual",
    }],
    evidence: [],
    sources: [],
  });
  assert.equal(result.accepted, false);
  assert.equal(result.rejections[0]?.code, "missing_evidence");
});

test("oracle:memory.save_explicit_fact", () => {
  const continuity = createProjectContinuity();
  const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const fact = continuity.remember({
    projectId,
    text: "deadline is Friday",
    scope: { kind: "project", projectId },
  });
  assert.equal(fact.text, "deadline is Friday");
});

test("oracle:memory.recall_next_day", () => {
  const continuity = createProjectContinuity();
  const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  continuity.remember({
    projectId,
    text: "deadline is Friday",
    scope: { kind: "project", projectId },
  }, new Date("2026-08-26T00:00:00.000Z"));
  const recalled = continuity.recall(projectId, { kind: "project", projectId });
  assert.equal(recalled[0]?.text, "deadline is Friday");
});

test("oracle:memory.correction_supersedes", () => {
  const continuity = createProjectContinuity();
  const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const fact = continuity.remember({
    projectId,
    text: "deadline is Friday",
    scope: { kind: "project", projectId },
  });
  continuity.correct({
    projectId,
    factId: fact.id,
    text: "deadline is Monday",
    scope: { kind: "project", projectId },
  });
  const recalled = continuity.recall(projectId, { kind: "project", projectId });
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0]?.text, "deadline is Monday");
});

test("oracle:memory.scope_isolation", () => {
  const continuity = createProjectContinuity();
  const projectA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const projectB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  continuity.remember({
    projectId: projectA,
    text: "secret",
    scope: { kind: "project", projectId: projectA },
  });
  assert.throws(
    () => continuity.recall(projectA, { kind: "project", projectId: projectB }),
    /isolated/,
  );
});

test("oracle:recovery.ptt_barge_in_no_late_action", async () => {
  const state = createDesktopLoopState({ budget: 8 });
  state.lastObservation = observation();
  state.cancelled = true;
  const receipt = await runDesktopStep({
    proposal: { action: { kind: "press", targetId: "1" }, basisObservationId: "obs-1", requestId: "r1" },
    state,
    now,
    commit: async () => {
      throw new Error("cancelled turns must not commit");
    },
  });
  assert.equal(receipt.committed, false);
  assert.equal(receipt.evidenceCode, "cancelled");
});

test("oracle:recovery.unknown_commit_no_retry", async () => {
  const state = createDesktopLoopState({ budget: 8 });
  state.lastObservation = observation();
  const first = await runDesktopStep({
    proposal: { action: { kind: "press", targetId: "1" }, basisObservationId: "obs-1", requestId: "r1" },
    state,
    now,
    commit: async () => ({ status: "unknown", committed: true, verified: false }),
  });
  assert.equal(first.status, "unknown");
  const second = await runDesktopStep({
    proposal: { action: { kind: "press", targetId: "1" }, basisObservationId: "obs-1", requestId: "r2" },
    state,
    now,
    commit: async () => {
      throw new Error("unknown commits must not retry");
    },
  });
  assert.equal(second.committed, false);
  assert.equal(second.evidenceCode, "unknown_no_retry");
});

test("oracle:recovery.runtime_restart_deliver_once", () => {
  const live = createCheckpointLedger();
  const checkpoint = live.create({ taskId: "t1", requestId: "r1" });
  live.recordStep({
    checkpointId: checkpoint.checkpointId,
    stepId: "s1",
    idempotencyKey: digestDesktopAction({ kind: "press", targetId: "1" }),
    committed: true,
    receiptId: "rcpt-1",
  });
  const restored = createCheckpointLedger(JSON.parse(JSON.stringify(live.snapshot())) as ReturnType<typeof live.snapshot>);
  restored.resume(checkpoint.checkpointId);
  const again = restored.recordStep({
    checkpointId: checkpoint.checkpointId,
    stepId: "s1-dup",
    idempotencyKey: digestDesktopAction({ kind: "press", targetId: "1" }),
    committed: true,
  });
  assert.equal(again.steps.length, 1);
});

test("oracle:recovery.app_restart_no_fake_resume", () => {
  const live = createCheckpointLedger();
  const checkpoint = live.create({ taskId: "t1", requestId: "r1" });
  live.consume(checkpoint.checkpointId);
  const restored = createCheckpointLedger(JSON.parse(JSON.stringify(live.snapshot())) as ReturnType<typeof live.snapshot>);
  assert.throws(() => restored.resume(checkpoint.checkpointId), /Consumed/);
});
