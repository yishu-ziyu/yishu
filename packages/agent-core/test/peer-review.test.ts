import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { runPeerReviewLoop } from "../src/multi/peer-review.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createBuiltinTools } from "../src/tools/builtin.js";
import { FileMemoryStore } from "../src/memory/store.js";
import { DeterministicLlm } from "../src/llm.js";
import type { AgentConfig } from "../src/types.js";

const dir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".tmp-peer",
);

async function setup(): Promise<{
  tools: ToolRegistry;
  config: AgentConfig;
}> {
  await fs.mkdir(dir, { recursive: true });
  const workspaceDir = path.join(dir, "ws");
  await fs.mkdir(workspaceDir, { recursive: true });
  const memory = new FileMemoryStore(path.join(dir, "m.json"));
  await memory.load();
  const tools = new ToolRegistry();
  tools.registerAll(createBuiltinTools({ workspaceDir, memory }));
  const config: AgentConfig = {
    maxIterations: 5,
    maxReviewRounds: 1,
    workspaceDir,
    skillsDir: path.join(dir, "skills"),
    memoryPath: path.join(dir, "m.json"),
    enableReview: false,
  };
  return { tools, config };
}

describe("peer review (ch10 peer collaboration)", () => {
  it("accepts math proposal when proposer used code_exec", async () => {
    const { tools, config } = await setup();
    const result = await runPeerReviewLoop({
      task: "计算 10+5",
      tools,
      config,
      llm: new DeterministicLlm(),
      rounds: 3,
    });

    assert.equal(result.accepted, true);
    assert.ok(result.rounds.length >= 1);
    assert.ok(result.rounds.length <= 3);
    assert.ok(result.finalText.length > 0);
    assert.ok(
      result.rounds[0]!.proposerTools.includes("code_exec"),
      "proposer should use code_exec",
    );
    assert.ok(result.rounds.some((r) => r.accepted));
    assert.ok(result.trajectory.steps.some((s) => s.kind === "review"));
    assert.match(result.rounds[result.rounds.length - 1]!.critique, /ACCEPT/i);
  });

  it("isolates contexts: only critique text is the handoff", async () => {
    const { tools, config } = await setup();
    const result = await runPeerReviewLoop({
      task: "列目录 .",
      tools,
      config,
      llm: new DeterministicLlm(),
      rounds: 2,
    });

    assert.ok(result.rounds.length >= 1);
    assert.ok(result.finalText.length > 0);
    // Trajectory records propose + critique phases
    const phases = result.trajectory.steps
      .filter((s) => s.kind === "status")
      .map((s) => (s.data as { phase?: string }).phase);
    assert.ok(phases.includes("peer_review"));
    assert.ok(phases.includes("propose"));
    assert.ok(phases.includes("critique"));
  });

  it("respects max rounds cap", async () => {
    const { tools, config } = await setup();
    const result = await runPeerReviewLoop({
      task: "计算 3+4",
      tools,
      config,
      llm: new DeterministicLlm(),
      rounds: 1,
    });
    assert.ok(result.rounds.length <= 1);
  });
});
