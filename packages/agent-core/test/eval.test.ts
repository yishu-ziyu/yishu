import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { YishuAgent } from "../src/harness.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), ".tmp-eval");

describe("eval harness", () => {
  it("pass rate > 0.5", async () => {
    await fs.mkdir(dir, { recursive: true });
    const workspaceDir = path.join(dir, "ws");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "hello.txt"), "hi\n");

    const agent = new YishuAgent({
      workspaceDir,
      skillsDir: path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../skills",
      ),
      memoryPath: path.join(dir, "memory.json"),
      trajectoriesDir: path.join(dir, "traj"),
      enableReview: false,
    });

    const report = await agent.eval();
    assert.ok(
      report.passRate > 0.5,
      `passRate ${report.passRate} cases=${JSON.stringify(report.cases)}`,
    );
  });
});
