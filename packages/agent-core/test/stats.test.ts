import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  binomialWilsonInterval,
  comparePassRates,
  formatWilsonCi,
} from "../src/eval/stats.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("binomialWilsonInterval: n=0 returns mean 0 and full [0,1]", () => {
  const r = binomialWilsonInterval(0, 0);
  assert.equal(r.mean, 0);
  assert.equal(r.low, 0);
  assert.equal(r.high, 1);
});

test("binomialWilsonInterval: all success mean=1 and low < 1 for small n", () => {
  const r = binomialWilsonInterval(5, 5);
  assert.equal(r.mean, 1);
  assert.ok(r.low > 0.4 && r.low < 1, `low=${r.low}`);
  assert.equal(r.high, 1);
});

test("binomialWilsonInterval: all fail mean=0 and high > 0 for small n", () => {
  const r = binomialWilsonInterval(0, 5);
  assert.equal(r.mean, 0);
  assert.equal(r.low, 0);
  assert.ok(r.high > 0 && r.high < 0.6, `high=${r.high}`);
});

test("binomialWilsonInterval: known 50/100 ≈ 0.5 with tight band", () => {
  const r = binomialWilsonInterval(50, 100);
  assert.equal(r.mean, 0.5);
  // Wilson 95% for 50/100 is roughly [0.403, 0.597]
  assert.ok(r.low > 0.39 && r.low < 0.42, `low=${r.low}`);
  assert.ok(r.high > 0.58 && r.high < 0.61, `high=${r.high}`);
});

test("binomialWilsonInterval: clamps successes to [0,n]", () => {
  const over = binomialWilsonInterval(12, 10);
  assert.equal(over.mean, 1);
  const under = binomialWilsonInterval(-3, 10);
  assert.equal(under.mean, 0);
});

test("comparePassRates: non-overlapping intervals → significant", () => {
  // 9/10 vs 1/10: intervals clearly separate
  const c = comparePassRates({ pass: 9, total: 10 }, { pass: 1, total: 10 });
  assert.equal(c.aMean, 0.9);
  assert.equal(c.bMean, 0.1);
  assert.ok(c.delta < 0);
  assert.equal(c.significant, true);
  assert.match(c.note, /not overlap|delta/i);
});

test("comparePassRates: large delta with n>=5 even if intervals might touch", () => {
  // 8/10 vs 5/10: |delta|=0.3 >= 0.2, both n>=5
  const c = comparePassRates({ pass: 8, total: 10 }, { pass: 5, total: 10 });
  assert.ok(Math.abs(c.delta - -0.3) < 1e-9);
  assert.equal(c.significant, true);
});

test("comparePassRates: tiny n and close rates → not significant", () => {
  const c = comparePassRates({ pass: 1, total: 2 }, { pass: 1, total: 2 });
  assert.equal(c.delta, 0);
  assert.equal(c.significant, false);
  assert.match(c.note, /not significant/i);
});

test("comparePassRates: small delta with overlapping intervals → not significant", () => {
  // 51/100 vs 50/100
  const c = comparePassRates({ pass: 51, total: 100 }, { pass: 50, total: 100 });
  assert.ok(Math.abs(c.delta + 0.01) < 1e-9);
  assert.equal(c.significant, false);
});

test("formatWilsonCi includes percent and n", () => {
  const s = formatWilsonCi(3, 5);
  assert.match(s, /60\.0%/);
  assert.match(s, /Wilson 95%/);
  assert.match(s, /n=5/);
});

test("CLI promote-skill --dry-run prints draft body without writing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yishu-promote-skill-"));
  try {
    const trajPath = join(dir, "traj.json");
    await writeFile(
      trajPath,
      JSON.stringify({
        id: "promote-cli-1",
        task: "计算 1+1",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:01.000Z",
        status: "completed",
        result: "2",
        steps: [
          {
            kind: "tool_call",
            at: "t1",
            data: { name: "code_exec", arguments: { expr: "1+1" } },
          },
          {
            kind: "final",
            at: "t2",
            data: { text: "2" },
          },
        ],
      }),
      "utf8",
    );

    const r = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(packageRoot, "src/cli.ts"),
        "promote-skill",
        trajPath,
        "--dry-run",
      ],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: { ...process.env },
      },
    );
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /promote-skill/);
    assert.match(r.stdout, /dry-run/);
    assert.match(r.stdout, /code_exec/);
    assert.match(r.stdout, /Procedure/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
