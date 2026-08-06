import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  appendExperience,
  extractLearningSignal,
  loadExperiences,
} from "../src/evolution/learning-signal.js";
import { YishuAgent } from "../src/harness.js";
import type { Trajectory } from "../src/types.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function traj(partial: Partial<Trajectory> & Pick<Trajectory, "status">): Trajectory {
  return {
    id: partial.id ?? "traj-1",
    task: partial.task ?? "计算 1+1",
    startedAt: partial.startedAt ?? "2026-01-01T00:00:00.000Z",
    endedAt: partial.endedAt ?? "2026-01-01T00:00:01.000Z",
    steps: partial.steps ?? [],
    status: partial.status,
    ...(partial.result !== undefined ? { result: partial.result } : {}),
  };
}

test("extractLearningSignal success with tools", () => {
  const t = traj({
    status: "completed",
    steps: [
      {
        kind: "tool_call",
        at: "2026-01-01T00:00:00.100Z",
        data: { id: "c1", name: "code_exec", arguments: {} },
      },
      {
        kind: "final",
        at: "2026-01-01T00:00:00.200Z",
        data: { text: "2" },
      },
    ],
    result: "2",
  });
  const s = extractLearningSignal(t);
  assert.equal(s.outcome, "success");
  assert.deepEqual(s.toolsUsed, ["code_exec"]);
  assert.equal(s.reviewAccepted, undefined);
  assert.ok(s.lessons.length >= 1);
  assert.match(s.lessons[0] ?? "", /code_exec/);
});

test("extractLearningSignal fail on rejected / failed", () => {
  const failed = extractLearningSignal(
    traj({
      status: "failed",
      steps: [],
    }),
  );
  assert.equal(failed.outcome, "fail");
  assert.ok(failed.lessons.some((l) => /failed|no tools/i.test(l)));

  const rejected = extractLearningSignal(
    traj({
      status: "rejected",
      steps: [
        {
          kind: "review",
          at: "2026-01-01T00:00:00.100Z",
          data: { accepted: false, reason: "no evidence", round: 1 },
        },
      ],
    }),
  );
  assert.equal(rejected.outcome, "fail");
  assert.equal(rejected.reviewAccepted, false);
  assert.ok(rejected.lessons.some((l) => /review/i.test(l)));
});

test("extractLearningSignal partial on max_iterations", () => {
  const s = extractLearningSignal(
    traj({
      status: "max_iterations",
      steps: [
        {
          kind: "tool_call",
          at: "2026-01-01T00:00:00.100Z",
          data: { id: "c1", name: "web_search", arguments: {} },
        },
      ],
    }),
  );
  assert.equal(s.outcome, "partial");
  assert.deepEqual(s.toolsUsed, ["web_search"]);
  assert.ok(s.lessons.some((l) => /max iterations/i.test(l)));
});

test("appendExperience and loadExperiences JSONL roundtrip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yishu-learn-"));
  const file = join(dir, "exp.jsonl");
  try {
    const empty = await loadExperiences(file);
    assert.deepEqual(empty, []);

    const a = extractLearningSignal(
      traj({
        status: "completed",
        steps: [
          {
            kind: "tool_call",
            at: "t",
            data: { name: "memory_write" },
          },
        ],
      }),
    );
    const b = extractLearningSignal(traj({ status: "failed" }));

    await appendExperience(file, a);
    await appendExperience(file, b);

    const loaded = await loadExperiences(file);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0]?.outcome, "success");
    assert.equal(loaded[1]?.outcome, "fail");
    assert.deepEqual(loaded[0]?.toolsUsed, ["memory_write"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("YishuAgent.run writes ${id}.signal.json next to trajectory", async () => {
  const root = await mkdtemp(join(tmpdir(), "yishu-agent-sig-"));
  try {
    const trajectoriesDir = join(root, "trajectories");
    const agent = new YishuAgent({
      workspaceDir: join(root, "workspace"),
      skillsDir: join(packageRoot, "skills"),
      memoryPath: join(root, "memory.json"),
      trajectoriesDir,
      enableReview: false,
    });
    await agent.init();
    const r = await agent.run("计算 17*19+3");
    assert.equal(r.accepted, true);

    const trajPath = join(trajectoriesDir, `${r.trajectory.id}.json`);
    const signalPath = join(trajectoriesDir, `${r.trajectory.id}.signal.json`);
    const trajRaw = await readFile(trajPath, "utf8");
    const signalRaw = await readFile(signalPath, "utf8");
    assert.ok(trajRaw.includes(r.trajectory.id));

    const signal = JSON.parse(signalRaw) as {
      outcome: string;
      toolsUsed: string[];
      lessons: string[];
    };
    assert.equal(signal.outcome, "success");
    assert.ok(signal.toolsUsed.includes("code_exec"));
    assert.ok(Array.isArray(signal.lessons));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
