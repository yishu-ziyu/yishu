import assert from "node:assert/strict";
import test from "node:test";
import { deriveTurnIntentFrame } from "@yishu/kernel";
import { resolveModelRouting } from "../src/model-routing.js";
import { LOCAL_GROK_PROVIDER, type ModelRouting } from "../src/protocol.js";

const profiles = {
  realtimeConversation: { provider: LOCAL_GROK_PROVIDER, model: "MiniMax-M3" },
  screenCollaboration: { provider: "xai", model: "grok-4.5" },
  deepTask: { provider: "openai-codex", model: "gpt-5.5" },
} as const satisfies Extract<ModelRouting, { profiles: unknown }>["profiles"];

function resolve(
  routing: ModelRouting | undefined,
  utterance: string,
  options: { currentPageNote?: boolean } = {},
) {
  return resolveModelRouting({
    routing,
    legacyPreference: undefined,
    intent: deriveTurnIntentFrame(utterance, {
      currentPageNote: options.currentPageNote,
    }),
    utterance,
    currentPageNote: options.currentPageNote ?? false,
  });
}

test("explicit routing modes select their configured profile without reinterpretation", () => {
  for (const mode of [
    "realtime_conversation",
    "screen_collaboration",
    "deep_task",
  ] as const) {
    const decision = resolve({ mode, profiles }, "点击这个按钮");
    assert.equal(decision?.routingMode, mode);
    assert.equal(decision?.resolvedRoute, mode);
  }

  assert.deepEqual(
    resolve({ mode: "realtime_conversation", profiles }, "点击这个按钮")?.preference,
    profiles.realtimeConversation,
  );
  assert.deepEqual(
    resolve({ mode: "deep_task", profiles }, "你好")?.preference,
    profiles.deepTask,
  );
});

test("auto routes external effects, screen references, and current-page notes to screen collaboration", () => {
  const cases = [
    { utterance: "点击这个按钮" },
    { utterance: "这个按钮为什么是灰色的？" },
    { utterance: "总结当前页面的重点" },
    { utterance: "把当前页面需要我做的事整理成备忘录", currentPageNote: true },
  ];

  for (const item of cases) {
    const decision = resolve(
      { mode: "auto", profiles },
      item.utterance,
      { currentPageNote: item.currentPageNote },
    );
    assert.equal(decision?.routingMode, "auto", item.utterance);
    assert.equal(decision?.resolvedRoute, "screen_collaboration", item.utterance);
    assert.deepEqual(decision?.preference, profiles.screenCollaboration, item.utterance);
  }
});

test("auto stays realtime for ordinary conversation and never infers deep_task in v1", () => {
  for (const utterance of ["你好", "帮我深入分析一下这个观点", "给我讲一个睡前故事"]) {
    const decision = resolve({ mode: "auto", profiles }, utterance);
    assert.equal(decision?.resolvedRoute, "realtime_conversation", utterance);
    assert.deepEqual(decision?.preference, profiles.realtimeConversation, utterance);
  }
});

test("fixed and legacy preferences preserve the exact user choice", () => {
  const fixed = resolve({
    mode: "fixed_model",
    preference: profiles.deepTask,
  }, "点击这个按钮");
  assert.deepEqual(fixed, {
    routingMode: "fixed_model",
    resolvedRoute: "fixed_model",
    preference: profiles.deepTask,
  });

  const legacy = resolveModelRouting({
    routing: undefined,
    legacyPreference: profiles.screenCollaboration,
    intent: deriveTurnIntentFrame("你好"),
    utterance: "你好",
    currentPageNote: false,
  });
  assert.deepEqual(legacy, {
    routingMode: "fixed_model",
    resolvedRoute: "fixed_model",
    preference: profiles.screenCollaboration,
  });
  assert.equal(resolve(undefined, "你好"), undefined);
});
