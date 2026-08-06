import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills, matchSkills } from "../src/context/skills.js";

const skillsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../skills",
);

describe("skills", () => {
  it("loads skill markdown with frontmatter", async () => {
    const skills = await loadSkills(skillsDir);
    assert.ok(skills.length >= 3);
    const names = skills.map((s) => s.name).sort();
    assert.ok(names.includes("research"));
    assert.ok(names.includes("coding"));
    assert.ok(names.includes("memory"));
    for (const s of skills) {
      assert.ok(s.description.length > 0);
      assert.ok(s.body.length > 0);
    }
  });

  it("matches progressive disclosure bodies", async () => {
    const skills = await loadSkills(skillsDir);
    const m = matchSkills("记住我的偏好", skills);
    assert.ok(m.catalog.length >= 3);
    assert.ok(m.matched.some((s) => s.name === "memory"));
  });
});
