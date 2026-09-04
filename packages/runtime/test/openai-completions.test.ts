import assert from "node:assert/strict";
import { test } from "node:test";
import { CompletionsStreamParser, buildCompletionsBody, minimaxCompletionsExtras } from "../src/model-loop/openai-completions.js";
import type { ResolvedModel } from "../src/model-loop/types.js";

test("MiniMax-M3 chat extras disable thinking", () => {
  assert.deepEqual(minimaxCompletionsExtras("MiniMax-M3"), {
    reasoning_split: true,
    thinking: { type: "disabled" },
  });
  assert.deepEqual(minimaxCompletionsExtras("MiniMax-M2.5"), { reasoning_split: true });
  assert.deepEqual(minimaxCompletionsExtras("grok-4.20-0309-non-reasoning"), {});
});

test("MiniMax-M3 completions body sends thinking.disabled", () => {
  const model: ResolvedModel = {
    providerId: "yishu-local-grok",
    id: "MiniMax-M3",
    name: "MiniMax-M3",
    api: "openai-completions",
    baseUrl: "https://api.minimaxi.com/v1",
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
  const body = buildCompletionsBody(model, "sys", [{ role: "user", text: "在吗" }], []);
  assert.equal(body.thinking?.type, "disabled");
  assert.equal(body.reasoning_split, true);
  const m25 = buildCompletionsBody({ ...model, id: "MiniMax-M2.5", name: "MiniMax-M2.5" }, "sys", [], []);
  assert.equal(m25.thinking, undefined);
  assert.equal(m25.reasoning_split, true);
});

test("MiniMax reasoning_content is not spoken", () => {
  const parser = new CompletionsStreamParser();
  const thinking = parser.push(JSON.stringify({
    choices: [{
      delta: { role: "assistant", content: "", reasoning_content: "用户问星期几。" },
    }],
  }));
  assert.equal(thinking, undefined);
  assert.equal(parser.takeReasoningDelta(), "用户问星期几。");
  assert.equal(parser.takeReasoningDelta(), "");

  const spoken = parser.push(JSON.stringify({
    choices: [{ delta: { content: "今天是星期五。" } }],
  }));
  assert.deepEqual(spoken, { type: "text_delta", delta: "今天是星期五。" });
});

test("MiniMax content on the finish chunk is not dropped", () => {
  const parser = new CompletionsStreamParser();
  parser.push(JSON.stringify({
    choices: [{ delta: { role: "assistant", reasoning_content: "hidden" } }],
  }));
  const done = parser.push(JSON.stringify({
    choices: [{
      finish_reason: "stop",
      delta: { content: "今天是星期五。" },
    }],
  }));
  assert.equal(done?.type, "message_done");
  if (done?.type !== "message_done") return;
  assert.equal(done.trailingText, "今天是星期五。");
  assert.equal(done.finishReason, "stop");
});

test("null finish_reason is a heartbeat, not the end of the turn", () => {
  const parser = new CompletionsStreamParser();
  const heartbeat = parser.push(JSON.stringify({
    choices: [{ finish_reason: null, delta: { role: "assistant", content: "" } }],
  }));
  assert.equal(heartbeat, undefined);
  const spoken = parser.push(JSON.stringify({
    choices: [{ delta: { content: "星期五。" } }],
  }));
  assert.deepEqual(spoken, { type: "text_delta", delta: "星期五。" });
});
