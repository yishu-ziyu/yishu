import assert from "node:assert/strict";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { YishuAgent } from "../src/harness.js";

test("auto skill draft: write_file run produces skill draft or skill.json sidecar", async () => {
  const root = await mkdtemp(join(tmpdir(), "yishu-auto-skill-"));
  const skillsDir = join(root, "skills");
  const trajectoriesDir = join(root, "trajectories");
  try {
    const agent = new YishuAgent({
      workspaceDir: join(root, "workspace"),
      skillsDir,
      memoryPath: join(root, "memory.json"),
      trajectoriesDir,
      enableReview: false,
      enableAutoSkillDraft: true,
    });
    await agent.init();
    const r = await agent.run("写文件 auto-skill-note.md 内容 auto-ok");
    assert.ok(
      r.toolsUsed.includes("write_file"),
      `expected write_file, got ${r.toolsUsed.join(",")}`,
    );
    assert.equal(r.trajectory.status, "completed");

    const skillSidecar = join(trajectoriesDir, `${r.trajectory.id}.skill.json`);
    let sidecarOk = false;
    try {
      await access(skillSidecar);
      sidecarOk = true;
    } catch {
      sidecarOk = false;
    }

    // Auto drafts must NOT pollute live skillsDir; they go to data/skill-drafts.
    let liveGenerated = 0;
    try {
      const entries = await readdir(skillsDir);
      liveGenerated = entries.filter((e) => e.startsWith("generated-")).length;
    } catch {
      liveGenerated = 0;
    }
    assert.equal(liveGenerated, 0, "auto draft must not write into live skills/");

    assert.ok(sidecarOk, "expected .skill.json sidecar for auto draft");

    const meta = JSON.parse(await readFile(skillSidecar, "utf8")) as {
      path: string;
      name: string;
      auto: boolean;
      promoted?: boolean;
    };
    assert.equal(meta.auto, true);
    assert.equal(meta.promoted, false);
    assert.ok(meta.name.length > 0);
    assert.ok(meta.path.includes("SKILL.md"));
    assert.match(meta.path, /skill-drafts/);
    await access(meta.path);
    const raw = await readFile(meta.path, "utf8");
    assert.match(raw, /write_file|Procedure|generated-/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auto skill draft: disabled flag writes no skill sidecar", async () => {
  const root = await mkdtemp(join(tmpdir(), "yishu-auto-skill-off-"));
  const skillsDir = join(root, "skills");
  const trajectoriesDir = join(root, "trajectories");
  try {
    const agent = new YishuAgent({
      workspaceDir: join(root, "workspace"),
      skillsDir,
      memoryPath: join(root, "memory.json"),
      trajectoriesDir,
      enableReview: false,
      enableAutoSkillDraft: false,
    });
    await agent.init();
    const r = await agent.run("写文件 no-auto.md 内容 x");
    assert.ok(r.toolsUsed.includes("write_file"));

    let sidecarExists = true;
    try {
      await access(join(trajectoriesDir, `${r.trajectory.id}.skill.json`));
    } catch {
      sidecarExists = false;
    }
    assert.equal(sidecarExists, false);

    let entries: string[] = [];
    try {
      entries = await readdir(skillsDir);
    } catch {
      entries = [];
    }
    assert.equal(
      entries.filter((e) => e.startsWith("generated-")).length,
      0,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
