import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { YishuAgent } from "../src/harness.js";
import { builtinEvalCases, runEval } from "../src/eval/harness.js";

const dir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".tmp-eval-ext",
);

describe("eval extended gold cases", () => {
  it("write-file case requires write_file tool", async () => {
    await fs.mkdir(dir, { recursive: true });
    const workspaceDir = path.join(dir, "ws");
    await fs.mkdir(workspaceDir, { recursive: true });
    const skillsDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../skills",
    );
    const memoryPath = path.join(dir, "memory.json");
    const trajectoriesDir = path.join(dir, "traj");

    const cases = builtinEvalCases().filter((c) => c.id === "write-file");
    assert.equal(cases.length, 1);
    assert.match(cases[0]!.task, /写文件 eval-note\.md 内容 eval-ok/);

    const report = await runEval(cases, () => ({
      run: async (task: string) => {
        const a = new YishuAgent({
          workspaceDir,
          skillsDir,
          memoryPath,
          trajectoriesDir,
          enableReview: false,
        });
        await a.init();
        return a.run(task);
      },
    }));

    assert.equal(report.total, 1);
    assert.equal(report.passed, 1, JSON.stringify(report.cases));
    assert.ok(report.cases[0]!.toolsUsed.includes("write_file"));

    const body = await fs.readFile(
      path.join(workspaceDir, "eval-note.md"),
      "utf8",
    );
    assert.match(body, /eval-ok/);
  });

  it("full builtin set stays above pass-rate gates", async () => {
    await fs.mkdir(dir, { recursive: true });
    const workspaceDir = path.join(dir, "ws-full");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "hello.txt"), "hi\n");

    const agent = new YishuAgent({
      workspaceDir,
      skillsDir: path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../skills",
      ),
      memoryPath: path.join(dir, "memory-full.json"),
      trajectoriesDir: path.join(dir, "traj-full"),
      enableReview: false,
    });

    const report = await agent.eval();
    // Keep compatible with agent-core.test (>=0.75) and eval.test (>0.5)
    assert.ok(
      report.passRate >= 0.75,
      `passRate=${report.passRate} cases=${JSON.stringify(report.cases)}`,
    );
    const ids = report.cases.map((c) => c.id);
    assert.ok(ids.includes("write-file"));
    assert.ok(ids.includes("math"));
    assert.ok(ids.includes("knowledge-write"));
  });

  it("knowledge-write case uses knowledge_search then write_file", async () => {
    await fs.mkdir(dir, { recursive: true });
    const workspaceDir = path.join(dir, "ws-kw");
    await fs.mkdir(workspaceDir, { recursive: true });
    const skillsDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../skills",
    );

    const cases = builtinEvalCases().filter((c) => c.id === "knowledge-write");
    assert.equal(cases.length, 1);

    const report = await runEval(cases, () => ({
      run: async (task: string) => {
        const a = new YishuAgent({
          workspaceDir,
          skillsDir,
          memoryPath: path.join(dir, "memory-kw.json"),
          trajectoriesDir: path.join(dir, "traj-kw"),
          enableReview: false,
        });
        await a.init();
        return a.run(task);
      },
    }));

    assert.equal(report.total, 1);
    assert.equal(report.passed, 1, JSON.stringify(report.cases));
    const tools = report.cases[0]!.toolsUsed;
    assert.ok(tools.includes("knowledge_search"), `tools=${tools.join(",")}`);
    assert.ok(tools.includes("write_file"), `tools=${tools.join(",")}`);

    const body = await fs.readFile(
      path.join(workspaceDir, "formula-summary.md"),
      "utf8",
    );
    assert.match(body, /知识摘要|Agent|LLM|formula/i);
  });
});
