import assert from "node:assert/strict";
import test from "node:test";
import {
  AssistantOutputStreamProjector,
  isDirectComputerActionUtterance,
  projectAssistantOutput,
} from "../src/assistant-output.js";

const capturedClickLeak = [
  "看到了，侧边栏里『调整 sub agent 为 Luna Max』旁边在转圈，我点过去。",
  "```html",
  "<computer_control>",
  '<parameter name="action">left_click</parameter>',
  '<parameter name="x">185</parameter>',
  '<parameter name="y">375</parameter>',
  "</computer_control>",
  "```",
].join("\n");

test("assistant output replay never exposes computer-control protocol", () => {
  const projection = projectAssistantOutput(capturedClickLeak);

  assert.doesNotMatch(projection.visibleText, /computer_control|parameter|```|html/i);
});

test("assistant output replay turns the captured pseudo-tool block into an action", () => {
  const projection = projectAssistantOutput(capturedClickLeak);

  assert.deepEqual(projection.computerActions, [{
    action: "left_click",
    x: 185,
    y: 375,
  }]);
});

test("assistant output replay remains safe when protocol markers split across deltas", () => {
  const projector = new AssistantOutputStreamProjector();
  const visibleChunks = [
    "我点过去。`",
    "``html\n<computer_",
    "control><parameter name=\"action\">left_click</parameter>",
    "<parameter name=\"x\">185</parameter><parameter name=\"y\">375</parameter>",
    "</computer_control>\n```",
  ].map((chunk) => projector.push(chunk));
  const completed = projector.complete();
  const visibleText = visibleChunks.join("") + completed.visibleDelta;

  assert.equal(visibleText, "我点过去。");
  assert.doesNotMatch(visibleText, /computer|parameter|```|html/i);
  assert.equal(completed.computerActions.length, 1);
});

test("direct click utterances are identified for buffer-until-result presentation", () => {
  assert.equal(isDirectComputerActionUtterance("帮我点一下旁边那个任务"), true);
  assert.equal(isDirectComputerActionUtterance("去点那个"), true);
  assert.equal(isDirectComputerActionUtterance("解释一下这个按钮为什么灰了"), false);
});

test("direct click replay turns a legacy POINT response into an action instead of asking the user to click", () => {
  const projector = new AssistantOutputStreamProjector();
  projector.push("我已经指向左上角的新对话了，你自己点一下吧。[POINT:52,78:新对话]", true);

  const completed = projector.complete();

  assert.deepEqual(completed.computerActions, [{
    action: "left_click",
    x: 52,
    y: 78,
    label: "新对话",
  }]);
  const presentedText = completed.computerActions.length > 0 ? "点好了。" : completed.visibleText;
  assert.doesNotMatch(presentedText, /POINT|指向|自己点/);
});
