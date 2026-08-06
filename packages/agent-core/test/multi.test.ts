import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { ManagerOrchestrator, decomposeTask } from "../src/multi/orchestrator.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createBuiltinTools } from "../src/tools/builtin.js";
import { FileMemoryStore } from "../src/memory/store.js";
import type { AgentConfig } from "../src/types.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), ".tmp-multi");

describe("multi orchestrator", () => {
  it("decomposes and produces handoff", async () => {
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

    const task = "搜索 react agent 并计算 10+5";
    const subs = decomposeTask(task);
    assert.ok(subs.some((s) => s.role === "researcher"));
    assert.ok(subs.some((s) => s.role === "coder"));
    assert.ok(subs.some((s) => s.role === "reviewer"));

    const orch = new ManagerOrchestrator({ tools, config });
    const result = await orch.run(task);
    assert.ok(result.handoffs.length > 0, "expected at least one handoff");
    assert.ok(result.results.length >= 2);
    assert.ok(result.finalText.length > 0);
  });
});
