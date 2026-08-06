import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { DeterministicLlm } from "../src/llm.js";
import { createBuiltinTools } from "../src/tools/builtin.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { FileMemoryStore } from "../src/memory/store.js";
import { runReactAgent } from "../src/loop/react.js";
import type { AgentConfig } from "../src/types.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(root, ".tmp-react");

async function setup() {
  await fs.mkdir(tmp, { recursive: true });
  const workspaceDir = path.join(tmp, "ws");
  await fs.mkdir(workspaceDir, { recursive: true });
  const memory = new FileMemoryStore(path.join(tmp, "mem.json"));
  await memory.load();
  const tools = new ToolRegistry();
  tools.registerAll(createBuiltinTools({ workspaceDir, memory }));
  const config: AgentConfig = {
    maxIterations: 6,
    maxReviewRounds: 1,
    workspaceDir,
    skillsDir: path.join(tmp, "skills"),
    memoryPath: path.join(tmp, "mem.json"),
    enableReview: false,
  };
  return { tools, config, memory, workspaceDir };
}

describe("react loop", () => {
  it("uses code_exec for math and returns 326 evidence", async () => {
    const { tools, config } = await setup();
    const llm = new DeterministicLlm();
    const result = await runReactAgent({
      llm,
      tools,
      messages: [{ role: "user", content: "计算 17*19+3" }],
      config,
      task: "计算 17*19+3",
    });
    assert.ok(result.toolsUsed.includes("code_exec"));
    const blob = JSON.stringify(result.trajectory.steps);
    assert.ok(blob.includes("326") || result.finalText.includes("326"));
  });
});
