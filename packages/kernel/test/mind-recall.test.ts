import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LEARNED_HEADING,
  SEED_MIND,
  applyMindUpdate,
} from "../src/mind/index.js";
import { selectRelevantMindLessons } from "../src/mind/recall.js";

function mindWithLessons(lessons: string[]): string {
  let markdown = SEED_MIND;
  for (const lesson of lessons) {
    markdown = applyMindUpdate(markdown, {
      changed: true,
      sections: [{ heading: LEARNED_HEADING, mode: "append", content: lesson }],
    });
  }
  return markdown;
}

const DEPLOY_LESSON =
  "Pattern `deploy-script` worked 2 times. Prefer this move when the same situation returns.";
const BACKUP_LESSON =
  "Pattern `backup-folder` failed 2 times. Do not repeat it without a new reason.";
const MIXED_LESSON =
  "Pattern `deploy-script` is mixed (2 succeeded / 2 failed). Narrow when it applies before repeating.";

describe("selectRelevantMindLessons", () => {
  it("returns only learned-section bullets, never seed or protected sections", () => {
    const markdown = mindWithLessons([
      "- Prefer short voice replies for this user.",
      "* Keep Saturday plans concrete.",
    ]);
    assert.deepEqual(selectRelevantMindLessons(markdown, "short voice replies"), [
      "Prefer short voice replies for this user.",
    ]);
    // These tokens live only in protected seed sections, never in lessons.
    assert.deepEqual(
      selectRelevantMindLessons(mindWithLessons(["- Prefer short voice replies."]), "flatter honesty sovereignty inference"),
      [],
    );
  });

  it("never returns bullets from non-learned sections", () => {
    const markdown = "## Who you are\n\n- deploy things quickly\n\n## How you act\n\n- deploy safely";
    assert.deepEqual(selectRelevantMindLessons(markdown, "deploy"), []);
  });

  it("ranks by distinct shared tokens and excludes zero-score lessons", () => {
    const markdown = mindWithLessons([
      `- ${DEPLOY_LESSON}`,
      `- ${BACKUP_LESSON}`,
      `- ${MIXED_LESSON}`,
    ]);
    const selected = selectRelevantMindLessons(markdown, "Is the deploy script situation safe?");
    assert.deepEqual(selected, [DEPLOY_LESSON, MIXED_LESSON]);
  });

  it("keeps document order on score ties", () => {
    const markdown = mindWithLessons([
      `- ${MIXED_LESSON}`,
      `- ${DEPLOY_LESSON}`,
    ]);
    const selected = selectRelevantMindLessons(markdown, "deploy script");
    assert.deepEqual(selected, [MIXED_LESSON, DEPLOY_LESSON]);
  });

  it("bounds the list at maxLessons", () => {
    const markdown = mindWithLessons([
      "- Pattern `deploy-a` worked 2 times. Prefer this move when the same situation returns.",
      "- Pattern `deploy-b` worked 3 times. Prefer this move when the same situation returns.",
      "- Pattern `deploy-c` worked 4 times. Prefer this move when the same situation returns.",
      "- Pattern `deploy-d` worked 5 times. Prefer this move when the same situation returns.",
    ]);
    const query = "deploy prefer move situation";
    assert.equal(selectRelevantMindLessons(markdown, query).length, 3);
    assert.equal(selectRelevantMindLessons(markdown, query, { maxLessons: 2 }).length, 2);
  });

  it("truncates the list at maxChars without cutting a lesson", () => {
    const pad = "pad ".repeat(20).trim();
    const first = `Pattern deploy ${pad}`;
    const second = `Pattern deploy ${pad} again`;
    const markdown = mindWithLessons([`- ${first}`, `- ${second}`]);
    const maxChars = first.length + 10;
    const selected = selectRelevantMindLessons(markdown, "deploy pad", { maxChars });
    assert.deepEqual(selected, [first]);
  });

  it("returns a single over-long lesson whole", () => {
    const long = `Pattern deploy ${"pad ".repeat(200)}end`;
    const markdown = mindWithLessons([`- ${long}`]);
    const selected = selectRelevantMindLessons(markdown, "deploy pad");
    assert.deepEqual(selected, [long]);
    assert.ok(long.length > 600);
  });

  it("returns nothing for empty mind, missing learned section, or blank query", () => {
    assert.deepEqual(selectRelevantMindLessons("", "deploy"), []);
    assert.deepEqual(selectRelevantMindLessons("   ", "deploy"), []);
    const markdown = mindWithLessons([`- ${DEPLOY_LESSON}`]);
    assert.deepEqual(selectRelevantMindLessons(markdown, ""), []);
    assert.deepEqual(selectRelevantMindLessons(markdown, "   "), []);
    // Every query token below the 2-char floor.
    assert.deepEqual(selectRelevantMindLessons(markdown, "a b c"), []);
  });

  it("is deterministic for the same input", () => {
    const markdown = mindWithLessons([
      `- ${DEPLOY_LESSON}`,
      `- ${BACKUP_LESSON}`,
      `- ${MIXED_LESSON}`,
    ]);
    const query = "deploy script situation";
    assert.deepEqual(
      selectRelevantMindLessons(markdown, query),
      selectRelevantMindLessons(markdown, query),
    );
  });
});
