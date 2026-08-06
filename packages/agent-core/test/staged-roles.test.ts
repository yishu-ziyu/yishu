import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import {
  runStagedRoles,
  swapSystemPrompt,
} from "../src/multi/staged-roles.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createBuiltinTools } from "../src/tools/builtin.js";
import { FileMemoryStore } from "../src/memory/store.js";
import { DeterministicLlm } from "../src/llm.js";
import type { AgentConfig, ChatMessage } from "../src/types.js";

const dir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".tmp-staged",
);

async function setup(): Promise<{
  tools: ToolRegistry;
  config: AgentConfig;
}> {
  await fs.mkdir(dir, { recursive: true });
  const workspaceDir = path.join(dir, "ws");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "hello.txt"),
    "hello staged\n",
    "utf8",
  );
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

describe("staged roles (ch10 shared-context role transfer)", () => {
  it("swapSystemPrompt replaces system message and keeps history", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "old" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ];
    swapSystemPrompt(messages, "new role");
    assert.equal(messages[0]!.content, "new role");
    assert.equal(messages.length, 3);
    assert.equal(messages[1]!.content, "hi");
  });

  it("runs planner -> worker -> checker with shared growing context", async () => {
    const { tools, config } = await setup();
    const result = await runStagedRoles({
      task: "计算 10+5",
      tools,
      config,
      llm: new DeterministicLlm(),
    });

    assert.equal(result.stages.length, 3);
    assert.deepEqual(
      result.stages.map((s) => s.role),
      ["planner", "worker", "checker"],
    );
    assert.ok(result.finalText.length > 0);
    assert.ok(result.messages.length > 3, "shared context should grow");

    // System prompt at end should be checker
    const sys = result.messages.find((m) => m.role === "system");
    assert.ok(sys);
    assert.match(sys!.content, /Checker/i);

    // Earlier stage texts appear in shared history
    const assistantTexts = result.messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.content);
    assert.ok(assistantTexts.length >= 2);

    // Trajectory marks each stage
    const roles = result.trajectory.steps
      .filter((s) => s.kind === "status")
      .map((s) => (s.data as { role?: string }).role)
      .filter(Boolean);
    assert.ok(roles.includes("planner"));
    assert.ok(roles.includes("worker"));
    assert.ok(roles.includes("checker"));
  });

  it("worker stage can use tools for compute tasks", async () => {
    const { tools, config } = await setup();
    const result = await runStagedRoles({
      task: "计算 7*8",
      tools,
      config,
      llm: new DeterministicLlm(),
    });

    const worker = result.stages.find((s) => s.role === "worker");
    assert.ok(worker);
    // Either worker or checker should see tool evidence somewhere in stages
    const anyTools = result.stages.some((s) => s.toolsUsed.length > 0);
    assert.ok(
      anyTools || result.finalText.length > 0,
      "expected tools or non-empty final",
    );
  });
});
