import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DEFAULT_JUDGE_RUBRIC,
  heuristicJudge,
  llmJudge,
  runEvalWithJudge,
} from "../src/eval/judge.js";
import { builtinEvalCases } from "../src/eval/harness.js";
import { YishuAgent } from "../src/harness.js";
import type { LlmPort, LlmResponse } from "../src/llm.js";
import type { Trajectory } from "../src/types.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function mathTrajectory(): Trajectory {
  return {
    id: "judge-math-1",
    task: "计算 17*19+3",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    status: "completed",
    result: "326",
    steps: [
      {
        kind: "tool_call",
        at: "t1",
        data: { name: "code_exec", arguments: { expr: "17*19+3" } },
      },
      {
        kind: "tool_result",
        at: "t2",
        data: { name: "code_exec", ok: true, content: "326" },
      },
      {
        kind: "final",
        at: "t3",
        data: { text: "326" },
      },
    ],
  };
}

test("heuristicJudge: empty answer scores low and fails", () => {
  const v = heuristicJudge({
    finalText: "",
    toolsUsed: [],
    task: "计算 1+1",
  });
  assert.equal(v.method, "heuristic");
  assert.ok(v.score < 0.4);
  assert.equal(v.pass, false);
  assert.ok(v.reasons.some((r) => /empty/i.test(r)));
});

test("heuristicJudge: math with tools and digits scores high", () => {
  const v = heuristicJudge({
    finalText: "结果是 326",
    toolsUsed: ["code_exec"],
    task: "计算 17*19+3",
    trajectory: mathTrajectory(),
  });
  assert.equal(v.method, "heuristic");
  assert.ok(v.score >= DEFAULT_JUDGE_RUBRIC.passThreshold, `score=${v.score}`);
  assert.equal(v.pass, true);
  assert.ok(v.reasons.some((r) => /tool|digit|length|pass/i.test(r)));
});

test("heuristicJudge: tool-implying task without tools is penalized", () => {
  const v = heuristicJudge({
    finalText: "maybe later",
    toolsUsed: [],
    task: "写文件 notes.txt 内容 hi",
  });
  assert.ok(v.score < 0.7);
  assert.ok(v.reasons.some((r) => /implies tools|none were used/i.test(r)));
});

test("llmJudge: falls back to heuristic on bad JSON", async () => {
  const llm: LlmPort = {
    async complete(): Promise<LlmResponse> {
      return { type: "text", text: "not-json at all" };
    },
  };
  const v = await llmJudge(
    llm,
    {
      finalText: "326",
      toolsUsed: ["code_exec"],
      task: "计算 17*19+3",
      trajectory: mathTrajectory(),
    },
    DEFAULT_JUDGE_RUBRIC,
  );
  // method stays heuristic on fallback
  assert.equal(v.method, "heuristic");
  assert.ok(v.reasons.some((r) => /fallback|parse failed/i.test(r)));
  assert.ok(v.score > 0);
});

test("llmJudge: parses valid JSON score", async () => {
  const llm: LlmPort = {
    async complete(): Promise<LlmResponse> {
      return {
        type: "text",
        text: '```json\n{"score": 0.91, "reasons": ["solid tool use"]}\n```',
      };
    },
  };
  const v = await llmJudge(llm, {
    finalText: "326",
    toolsUsed: ["code_exec"],
    task: "计算 17*19+3",
  });
  assert.equal(v.method, "llm");
  assert.equal(v.score, 0.91);
  assert.equal(v.pass, true);
  assert.deepEqual(v.reasons, ["solid tool use"]);
});

test("runEvalWithJudge: heuristic judgments attached to report", async () => {
  const root = await mkdtemp(join(tmpdir(), "yishu-judge-eval-"));
  try {
    const report = await runEvalWithJudge(
      builtinEvalCases().slice(0, 2),
      () => ({
        run: async (task: string) => {
          const agent = new YishuAgent({
            workspaceDir: join(root, "ws"),
            skillsDir: join(packageRoot, "skills"),
            memoryPath: join(root, "memory.json"),
            trajectoriesDir: join(root, "traj"),
            enableReview: false,
            enableAutoSkillDraft: false,
          });
          await agent.init();
          const r = await agent.run(task);
          return {
            finalText: r.finalText,
            toolsUsed: r.toolsUsed,
            trajectory: r.trajectory,
            accepted: r.accepted,
          };
        },
      }),
      { judge: "heuristic" },
    );

    assert.equal(report.judgments.length, report.cases.length);
    assert.ok(report.total >= 2);
    for (const j of report.judgments) {
      assert.ok(typeof j.verdict.score === "number");
      assert.ok(j.verdict.score >= 0 && j.verdict.score <= 1);
      assert.equal(j.verdict.method, "heuristic");
      assert.ok(Array.isArray(j.verdict.reasons));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
