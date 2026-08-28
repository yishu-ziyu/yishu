import assert from "node:assert/strict";
import { test } from "node:test";
import { CompletionsStreamParser } from "../src/model-loop/openai-completions.js";

test("MiniMax reasoning_content is not spoken", () => {
  const parser = new CompletionsStreamParser();
  const thinking = parser.push(JSON.stringify({
    choices: [{
      delta: { role: "assistant", content: "", reasoning_content: "用户问星期几。" },
    }],
  }));
  assert.equal(thinking, undefined);

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
