import assert from "node:assert/strict";
import test from "node:test";
import { desktopActionFromLegacy } from "../src/desktop/desktop-action.js";
import { createDesktopLoopState, runDesktopStep } from "../src/desktop/desktop-loop.js";
import { desktopStepBudget, evaluateDesktopProposal } from "../src/desktop/desktop-policy.js";
import type { DesktopObservation } from "../src/desktop/desktop-observation.js";
import {
  desktopActionBudgetForTurn,
  digestComputerControlAction,
  isDesktopWorkUtterance,
  nextDesktopObservation,
  rememberUnknownCommit,
  unknownCommitBlocksRetry,
} from "../src/desktop/computer-turn.js";

function observation(overrides: Partial<DesktopObservation> = {}): DesktopObservation {
  return {
    observationId: "obs-1",
    capturedAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-08-27T00:05:00.000Z",
    targets: [{ targetId: "1" }],
    warnings: [],
    ...overrides,
  };
}

test("desktop budget is 8 by default and 12 for authorized combo tasks", () => {
  assert.equal(desktopStepBudget(), 8);
  assert.equal(desktopStepBudget({ authorizedCombo: true }), 12);
});

test("stale or missing observation blocks commit", () => {
  const state = createDesktopLoopState({ budget: 8 });
  const decision = evaluateDesktopProposal({
    proposal: { action: { kind: "press", targetId: "1" }, basisObservationId: "obs-1", requestId: "r1" },
    observation: observation({ expiresAt: "2026-08-26T00:00:00.000Z" }),
    state,
    now: new Date("2026-08-27T00:00:00.000Z"),
  });
  assert.equal(decision.decision, "block");
  if (decision.decision === "block") assert.equal(decision.code, "stale");
});

test("unknown after commit is not retried", async () => {
  const state = createDesktopLoopState({ budget: 8 });
  state.lastObservation = observation();
  const first = await runDesktopStep({
    proposal: { action: { kind: "press", targetId: "1" }, basisObservationId: "obs-1", requestId: "r1" },
    state,
    now: new Date("2026-08-27T00:00:00.000Z"),
    commit: async () => ({ status: "unknown", committed: true, verified: false }),
  });
  assert.equal(first.status, "unknown");
  const second = await runDesktopStep({
    proposal: { action: { kind: "press", targetId: "1" }, basisObservationId: "obs-1", requestId: "r1" },
    state,
    now: new Date("2026-08-27T00:00:00.000Z"),
    commit: async () => {
      throw new Error("must not commit again");
    },
  });
  assert.equal(second.status, "blocked");
  assert.equal(second.evidenceCode, "unknown_no_retry");
});

test("menu selection requires a bound approval token", () => {
  const state = createDesktopLoopState({ budget: 8 });
  const decision = evaluateDesktopProposal({
    proposal: {
      action: { kind: "select_menu_item", appBundleId: "com.apple.finder", path: ["File", "New"] },
      basisObservationId: "obs-1",
      requestId: "r1",
    },
    observation: observation(),
    state,
    now: new Date("2026-08-27T00:00:00.000Z"),
  });
  assert.equal(decision.decision, "approval_required");
});

test("multi-step look/click/type/submit utterances are not actionBudget 0", () => {
  assert.equal(isDesktopWorkUtterance("先点击 A，再点击 B"), true);
  assert.equal(isDesktopWorkUtterance("look / click / type / submit"), true);
  assert.equal(isDesktopWorkUtterance("看一下然后点 Primary"), true);
  assert.equal(desktopActionBudgetForTurn({
    utterance: "先点击 A，再点击 B",
    intentAllowsEffect: true,
  }), 8);
  assert.equal(desktopActionBudgetForTurn({
    utterance: "输入 hello，然后点发送",
    intentAllowsEffect: true,
  }), 12);
  assert.equal(desktopActionBudgetForTurn({
    utterance: "解释这个界面",
    intentAllowsEffect: true,
  }), 0);
  assert.equal(desktopActionBudgetForTurn({
    utterance: "先点击 A，再点击 B",
    intentAllowsEffect: false,
  }), 0);
});

test("unknown commits are remembered and not retried", () => {
  const state = createDesktopLoopState({ budget: 8 });
  const action = { action: "left_click" as const, targetId: "1" };
  const digest = digestComputerControlAction(action);
  rememberUnknownCommit(state, digest, {
    succeeded: true,
    verified: false,
    status: "unverified",
    message: "AXPress delivery is uncertain.",
  });
  assert.equal(unknownCommitBlocksRetry(state, digest), true);
  const next = nextDesktopObservation(observation(), {
    succeeded: true,
    verified: false,
    evidence: "testbed-effect=idle",
    message: "unverified",
  }, action);
  assert.notEqual(next.observationId, "obs-1");
  assert.equal(next.previousReadback, "testbed-effect=idle");
});

test("fresh observation prefers recaptured numbered targets over the turn-start list", () => {
  const next = nextDesktopObservation(observation({ targets: [{ targetId: "1" }] }), {
    succeeded: true,
    verified: true,
    message: "clicked",
    numberedTargets: [{ targetId: "2", role: "AXButton" }],
  }, { action: "left_click", targetId: "1" });
  assert.deepEqual(next.targets, [{ targetId: "2", role: "AXButton" }]);
  assert.notEqual(next.observationId, "obs-1");
});

test("legacy left_click maps onto press", () => {
  assert.deepEqual(desktopActionFromLegacy({ action: "left_click", targetId: "3" }), {
    kind: "press",
    targetId: "3",
  });
});

test("five-step desktop loop requires a fresh observation every commit", async () => {
  const state = createDesktopLoopState({ budget: 8 });
  for (let step = 1; step <= 5; step += 1) {
    const observationId = `obs-${step}`;
    state.lastObservation = observation({
      observationId,
      previousReadback: step === 1 ? undefined : `effect-${step - 1}`,
    });
    const receipt = await runDesktopStep({
      proposal: {
        action: { kind: "press", targetId: "1" },
        basisObservationId: observationId,
        requestId: `r${step}`,
      },
      state,
      now: new Date("2026-08-27T00:00:00.000Z"),
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
    assert.equal(receipt.verified, true);
    assert.equal(receipt.committed, true);
  }
  const stale = await runDesktopStep({
    proposal: { action: { kind: "press", targetId: "1" }, basisObservationId: "obs-1", requestId: "late" },
    state,
    now: new Date("2026-08-27T00:00:00.000Z"),
    commit: async () => {
      throw new Error("old observation must not drive a sixth click");
    },
  });
  assert.equal(stale.committed, false);
});
