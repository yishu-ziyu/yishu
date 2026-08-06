import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reviewProposal, runWithReviewer } from "../src/loop/verify.js";
import type { ReactRunResult } from "../src/loop/react.js";

describe("reviewer", () => {
  it("rejects false completion without code_exec for math", () => {
    const v = reviewProposal("计算 17*19+3", "结果是 326", []);
    assert.equal(v.accepted, false);
    assert.ok(v.reason.includes("code_exec"));
  });

  it("accepts when code_exec used", () => {
    const v = reviewProposal("计算 17*19+3", "结果是 326", ["code_exec"]);
    assert.equal(v.accepted, true);
  });

  it("rejects empty final text", () => {
    const v = reviewProposal("hello", "   ", []);
    assert.equal(v.accepted, false);
  });

  it("runWithReviewer marks rejected after failed rounds", async () => {
    const fake: ReactRunResult = {
      messages: [],
      finalText: "结果是 326",
      toolsUsed: [],
      trajectory: {
        id: "t1",
        task: "计算 1+1",
        startedAt: new Date().toISOString(),
        steps: [],
        status: "completed",
      },
    };
    const result = await runWithReviewer({
      task: "计算 1+1",
      maxRounds: 1,
      proposerRun: async () => fake,
    });
    assert.equal(result.accepted, false);
    assert.ok(result.reviews.length >= 1);
  });
});
