import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bootstrapMean,
  formatBootstrapMean,
  mulberry32,
  pairedBootstrapDiff,
} from "../src/eval/significance.js";

describe("mulberry32", () => {
  it("is deterministic for the same seed", () => {
    const a = mulberry32(1);
    const b = mulberry32(1);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    assert.deepEqual(seqA, seqB);
  });

  it("differs across seeds", () => {
    const a = mulberry32(1)();
    const b = mulberry32(2)();
    assert.notEqual(a, b);
  });
});

describe("bootstrapMean", () => {
  it("returns zero CI for empty list", () => {
    const r = bootstrapMean([]);
    assert.equal(r.mean, 0);
    assert.equal(r.n, 0);
    assert.equal(r.ciLow, 0);
    assert.equal(r.ciHigh, 0);
  });

  it("collapses CI to the single value when n=1", () => {
    const r = bootstrapMean([0.8]);
    assert.equal(r.mean, 0.8);
    assert.equal(r.ciLow, 0.8);
    assert.equal(r.ciHigh, 0.8);
  });

  it("is deterministic with fixed seed and CI covers mean", () => {
    const scores = [0.7, 0.8, 0.9, 0.75, 0.85, 1.0];
    const r1 = bootstrapMean(scores, { samples: 500, seed: 7 });
    const r2 = bootstrapMean(scores, { samples: 500, seed: 7 });
    assert.deepEqual(r1, r2);
    assert.ok(r1.ciLow <= r1.mean && r1.mean <= r1.ciHigh);
    assert.ok(r1.ciHigh - r1.ciLow < 0.5);
  });

  it("formatBootstrapMean includes mean and CI", () => {
    const r = bootstrapMean([1, 1, 1], { samples: 100 });
    const s = formatBootstrapMean(r);
    assert.match(s, /mean=1\.000/);
    assert.match(s, /95%CI=/);
  });
});

describe("pairedBootstrapDiff", () => {
  it("throws on length mismatch", () => {
    assert.throws(() => pairedBootstrapDiff([1], [1, 2]), /length mismatch/);
  });

  it("detects significant positive shift", () => {
    const a = [0.9, 0.95, 1.0, 0.92, 0.98, 0.91];
    const b = [0.4, 0.45, 0.5, 0.42, 0.48, 0.41];
    const r = pairedBootstrapDiff(a, b, { samples: 800, seed: 3 });
    assert.ok(r.meanDiff > 0.4);
    assert.equal(r.significant, true);
    assert.ok(r.ciLow > 0);
  });

  it("not significant when systems match", () => {
    const a = [0.8, 0.8, 0.8, 0.8, 0.8, 0.8];
    const b = [0.8, 0.8, 0.8, 0.8, 0.8, 0.8];
    const r = pairedBootstrapDiff(a, b, { samples: 400, seed: 9 });
    assert.equal(r.meanDiff, 0);
    assert.equal(r.significant, false);
    assert.equal(r.ciLow, 0);
    assert.equal(r.ciHigh, 0);
  });
});
