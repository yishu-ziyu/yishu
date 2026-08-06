import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { compressMessages } from "../src/context/compress.js";
import { loadSkills, matchSkills } from "../src/context/skills.js";
import { YishuAgent } from "../src/harness.js";
import { reviewProposal } from "../src/loop/verify.js";
import { FileMemoryStore } from "../src/memory/store.js";
import {
  createBuiltinTools,
  resolveWorkspacePath,
} from "../src/tools/builtin.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ChatMessage } from "../src/types.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function withTempAgent(
  fn: (agent: YishuAgent, root: string) => Promise<void>,
  options?: { enableReview?: boolean },
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "yishu-agent-"));
  const agent = new YishuAgent({
    workspaceDir: join(root, "workspace"),
    skillsDir: join(packageRoot, "skills"),
    memoryPath: join(root, "memory.json"),
    trajectoriesDir: join(root, "trajectories"),
    enableReview: options?.enableReview ?? true,
  });
  try {
    await agent.init();
    await fn(agent, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("react loop uses code_exec for math and gets 326", async () => {
  await withTempAgent(async (agent) => {
    const r = await agent.run("计算 17*19+3");
    assert.equal(r.toolsUsed.includes("code_exec"), true);
    assert.match(r.finalText, /326/);
    assert.equal(r.accepted, true);
  });
});

test("memory write then search", async () => {
  await withTempAgent(async (agent) => {
    const w = await agent.run("记住：我偏好简洁中文回答");
    assert.equal(w.toolsUsed.includes("memory_write"), true);
    const s = await agent.run("你还记得我的偏好吗");
    assert.equal(s.toolsUsed.includes("memory_search"), true);
    assert.match(s.finalText, /简洁|偏好|记忆|中文/);
  });
});

test("path sandbox blocks escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "yishu-sandbox-"));
  try {
    const memory = new FileMemoryStore(join(root, "m.json"));
    const tools = createBuiltinTools({
      workspaceDir: join(root, "ws"),
      memory,
    });
    const reg = new ToolRegistry();
    reg.registerAll(tools);
    const result = await reg.execute("write_file", {
      path: "../escape.txt",
      content: "nope",
    });
    assert.equal(result.ok, false);
    assert.match(String(result.error ?? result.content), /escape|path|denied|sandbox/i);

    assert.throws(() => {
      resolveWorkspacePath(join(root, "ws"), "../escape.txt");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compress keeps system messages", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "SYS" },
    ...Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: `msg-${i}-${"x".repeat(200)}`,
    })),
  ];
  const out = compressMessages(messages, 800);
  assert.equal(out.some((m) => m.role === "system" && m.content.includes("SYS")), true);
});

test("reviewer rejects false completion without tools", () => {
  const verdict = reviewProposal("计算 1+1", "答案是 2", []);
  assert.equal(verdict.accepted, false);
  assert.match(verdict.reason, /code_exec|computation/i);
});

test("multi agent produces handoffs", async () => {
  await withTempAgent(async (agent) => {
    const r = await agent.multi("搜索 react agent 并计算 10+5");
    assert.ok(r.subtasks.length >= 2);
    assert.ok(r.handoffs.length >= 1);
    assert.ok(r.results.length >= 2);
    assert.ok(r.finalText.length > 0);
  });
});

test("eval pass rate is high", async () => {
  await withTempAgent(async (agent) => {
    const report = await agent.eval();
    assert.ok(
      report.passRate >= 0.75,
      `passRate=${report.passRate} cases=${JSON.stringify(report.cases)}`,
    );
  });
});

test("skills load from package", async () => {
  const skills = await loadSkills(join(packageRoot, "skills"));
  assert.ok(skills.length >= 3);
  const matched = matchSkills("调研 harness 并记住偏好", skills);
  assert.ok(matched.catalog.length >= 3);
  assert.ok(matched.matched.length >= 1);
});

test("write_file creates workspace artifact", async () => {
  await withTempAgent(async (agent, root) => {
    const r = await agent.run("写文件 note.md 内容 hello-from-test");
    assert.equal(r.toolsUsed.includes("write_file"), true);
    const body = await readFile(join(root, "workspace", "note.md"), "utf8");
    assert.match(body, /hello-from-test/);
  });
});
