import assert from "node:assert/strict";
import test from "node:test";
import {
  planVisualPrompt,
  promptRouteForCommand,
  restrictCommandScreenshots,
  selectPromptScreenshots,
  utteranceNeedsVisualContext,
} from "../src/prompt-images.js";
import { makeTurnStartCommand } from "./fixtures.js";

const cursor = { label: "cursor display" };
const extra = { label: "display 2" };

test("plain chat attaches no screenshots even in fixed_model", () => {
  assert.equal(utteranceNeedsVisualContext({ utterance: "在吗" }), false);
  assert.equal(utteranceNeedsVisualContext({ utterance: "今天星期几" }), false);
  assert.deepEqual(
    selectPromptScreenshots([cursor, extra], planVisualPrompt({
      utterance: "在吗",
      route: "fixed_model",
    })),
    [],
  );
});

test("screen-dependent chat keeps only the cursor display under fixed_model", () => {
  assert.equal(utteranceNeedsVisualContext({ utterance: "这个按钮在哪" }), true);
  assert.deepEqual(
    selectPromptScreenshots([cursor, extra], planVisualPrompt({
      utterance: "这个按钮在哪",
      route: "fixed_model",
    })),
    [cursor],
  );
});

test("screen_collaboration keeps every display", () => {
  assert.deepEqual(
    selectPromptScreenshots([cursor, extra], planVisualPrompt({
      utterance: "这个按钮在哪",
      route: "screen_collaboration",
    })),
    [cursor, extra],
  );
});

test("external effect attaches visual context", () => {
  assert.equal(
    utteranceNeedsVisualContext({ utterance: "在吗", effect: "external" }),
    true,
  );
});

test("restrict drops numbered targets for a text-only utterance", () => {
  const command = makeTurnStartCommand();
  command.payload.utterance = "在吗";
  command.payload.modelRouting = {
    mode: "fixed_model",
    preference: { provider: "yishu-local-grok", model: "MiniMax-M3" },
  };
  command.payload.contextFrame.numberedTargets = [
    { id: "1", role: "AXButton", title: "Back", description: null, enabled: true },
  ];
  const restricted = restrictCommandScreenshots(command, "fixed_model");
  assert.equal(restricted.payload.contextFrame.screenshots.length, 0);
  assert.equal(restricted.payload.contextFrame.numberedTargets, undefined);
});

test("plain chat utterance resolves to the realtime route", () => {
  const command = makeTurnStartCommand();
  command.payload.utterance = "在吗";
  assert.equal(promptRouteForCommand(command), "realtime_conversation");
});

test("a screen question resolves to screen collaboration", () => {
  const command = makeTurnStartCommand();
  command.payload.utterance = "这个按钮在哪";
  assert.equal(promptRouteForCommand(command), "screen_collaboration");
});
