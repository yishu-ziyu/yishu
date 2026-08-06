import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decideGate } from "../src/evolution/gate.js";
import { runSelfEvolveRound } from "../src/evolution/loop.js";
import { loadScoreboard } from "../src/evolution/scoreboard.js";
import type { EvalMatrix } from "../src/evolution/types.js";

function matrix(mean: number, cases: Array<{ id: string; score: number }>): EvalMatrix {
  return {
    label: "t",
    version: 1,
    mean,
    maxMean: 1,
    runsPerCase: 1,
    cases: cases.map((c) => ({
      caseId: c.id,
      score: c.score,
      max: 10,
      dimensions: [],
    })),
  };
}

test("gate promotes only on strict improvement + retention", () => {
  const baseline = matrix(0.4, [
    { id: "a", score: 4 },
    { id: "ret", score: 5 },
  ]);
  const good = matrix(0.8, [
    { id: "a", score: 9 },
    { id: "ret", score: 5 },
  ]);
  const g = decideGate({
    baseline,
    candidate: good,
    retentionCaseIds: ["ret"],
  });
  assert.equal(g.decision, "promote");

  const worseRetention = matrix(0.9, [
    { id: "a", score: 10 },
    { id: "ret", score: 2 },
  ]);
  const g2 = decideGate({
    baseline,
    candidate: worseRetention,
    retentionCaseIds: ["ret"],
  });
  assert.equal(g2.decision, "rollback");
});

test("self-evolve round promotes when instructions fix convention", async () => {
  const root = await mkdtemp(join(tmpdir(), "yishu-evolve-"));
  try {
    const report = await runSelfEvolveRound({
      stateDir: join(root, "state"),
      snapshotsDir: join(root, "snapshots"),
      scoreboardPath: join(root, "scoreboard.json"),
      workRoot: join(root, "work"),
      version: 1,
    });

    assert.ok(report.baseline.mean < report.candidateEval.mean);
    assert.equal(report.gate.decision, "promote");
    assert.equal(report.promotedVersion, 2);

    const instructions = await readFile(
      join(root, "state", "identity", "INSTRUCTIONS.md"),
      "utf8",
    );
    assert.match(instructions, /YISHU-REPORT/);

    const board = await loadScoreboard(join(root, "scoreboard.json"));
    assert.equal(board.length, 1);
    assert.equal(board[0]?.decision, "promote");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("self-evolve rolls back bad candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "yishu-evolve-bad-"));
  try {
    // Seed good blank baseline state
    const stateDir = join(root, "state");
    const report = await runSelfEvolveRound({
      stateDir,
      snapshotsDir: join(root, "snapshots"),
      scoreboardPath: join(root, "scoreboard.json"),
      workRoot: join(root, "work"),
      version: 1,
      injectBadCandidate: true,
    });

    assert.equal(report.gate.decision, "rollback");
    assert.equal(report.promotedVersion, 1);

    // Instructions restored to empty/missing good content
    let text = "";
    try {
      text = await readFile(join(stateDir, "identity", "INSTRUCTIONS.md"), "utf8");
    } catch {
      text = "";
    }
    assert.ok(!/broken/i.test(text));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
