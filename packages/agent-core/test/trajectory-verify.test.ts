import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  draftSkillFromTrajectory,
  writeSkillDraft,
} from "../src/evolution/skill-draft.js";
import { YishuAgent } from "../src/harness.js";
import { verifyTrajectory } from "../src/trajectory/verifier.js";
import type { Trajectory } from "../src/types.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function traj(
  partial: Partial<Trajectory> & Pick<Trajectory, "status" | "task">,
): Trajectory {
  return {
    id: partial.id ?? "traj-verify-1",
    task: partial.task,
    startedAt: partial.startedAt ?? "2026-01-01T00:00:00.000Z",
    endedAt: partial.endedAt ?? "2026-01-01T00:00:01.000Z",
    steps: partial.steps ?? [],
    status: partial.status,
    ...(partial.result !== undefined ? { result: partial.result } : {}),
  };
}

test("verifyTrajectory: empty steps → issue", () => {
  const r = verifyTrajectory(
    traj({ status: "running", task: "anything", steps: [] }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /empty steps/i.test(i)));
  assert.ok(r.score < 1);
});

test("verifyTrajectory: completed without final step → issue", () => {
  const r = verifyTrajectory(
    traj({
      status: "completed",
      task: "hello",
      steps: [
        {
          kind: "think",
          at: "t",
          data: { text: "thinking" },
        },
      ],
    }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /no final step/i.test(i)));
});

test("verifyTrajectory: math task without code_exec → issue", () => {
  const r = verifyTrajectory(
    traj({
      status: "completed",
      task: "计算 1+1",
      steps: [
        {
          kind: "final",
          at: "t",
          data: { text: "2" },
        },
      ],
      result: "2",
    }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /code_exec/i.test(i)));
});

test("verifyTrajectory: write task without write_file → issue", () => {
  const r = verifyTrajectory(
    traj({
      status: "completed",
      task: "写文件 notes.txt 内容 hello",
      steps: [
        {
          kind: "final",
          at: "t",
          data: { text: "done" },
        },
      ],
    }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /write_file/i.test(i)));
});

test("verifyTrajectory: tool fail + final claims success → issue", () => {
  const r = verifyTrajectory(
    traj({
      status: "completed",
      task: "写文件 x.txt",
      steps: [
        {
          kind: "tool_call",
          at: "t1",
          data: { name: "write_file", arguments: {} },
        },
        {
          kind: "tool_result",
          at: "t2",
          data: { name: "write_file", ok: false, content: "denied" },
        },
        {
          kind: "final",
          at: "t3",
          data: { text: "已成功写入文件" },
        },
      ],
    }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /ok=false|claims success/i.test(i)));
});

test("verifyTrajectory: clean math trajectory scores 1", () => {
  const r = verifyTrajectory(
    traj({
      status: "completed",
      task: "计算 17*19+3",
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
      result: "326",
    }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
  assert.equal(r.score, 1);
});

test("draftSkillFromTrajectory summarizes tool sequence", () => {
  const draft = draftSkillFromTrajectory(
    traj({
      id: "abcd1234-xxxx",
      status: "completed",
      task: "计算 2+2",
      steps: [
        {
          kind: "tool_call",
          at: "t1",
          data: { name: "code_exec", arguments: {} },
        },
        {
          kind: "tool_result",
          at: "t2",
          data: { name: "code_exec", ok: true, content: "4" },
        },
        {
          kind: "tool_call",
          at: "t3",
          data: { name: "code_exec", arguments: {} },
        },
        {
          kind: "final",
          at: "t4",
          data: { text: "4" },
        },
      ],
    }),
  );
  assert.match(draft.name, /^generated-/);
  assert.ok(draft.description.length > 0);
  assert.match(draft.body, /code_exec/);
  assert.match(draft.body, /Procedure/i);
  assert.match(draft.body, /1\./);
});

test("writeSkillDraft writes SKILL.md only when accepted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yishu-skill-draft-"));
  try {
    const draft = draftSkillFromTrajectory(
      traj({
        id: "skill-1",
        status: "completed",
        task: "search docs",
        steps: [
          {
            kind: "tool_call",
            at: "t",
            data: { name: "web_search", arguments: { query: "docs" } },
          },
          {
            kind: "final",
            at: "t2",
            data: { text: "ok" },
          },
        ],
      }),
    );

    const skipped = await writeSkillDraft(dir, draft, { accepted: false });
    assert.equal(skipped, null);

    const written = await writeSkillDraft(dir, draft, { accepted: true });
    assert.ok(written);
    assert.match(written!, /SKILL\.md$/);
    const raw = await readFile(written!, "utf8");
    assert.match(raw, /^---/);
    assert.match(raw, /name:/);
    assert.match(raw, /web_search/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("YishuAgent.run writes ${id}.verify.json next to trajectory", async () => {
  const root = await mkdtemp(join(tmpdir(), "yishu-agent-verify-"));
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

    const verifyPath = join(trajectoriesDir, `${r.trajectory.id}.verify.json`);
    const raw = await readFile(verifyPath, "utf8");
    const verification = JSON.parse(raw) as {
      ok: boolean;
      issues: string[];
      score: number;
    };
    assert.equal(typeof verification.ok, "boolean");
    assert.ok(Array.isArray(verification.issues));
    assert.equal(typeof verification.score, "number");
    assert.equal(verification.ok, true);
    assert.equal(verification.score, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
