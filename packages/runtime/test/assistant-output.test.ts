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

test("every incremental split keeps point, XML tool, function, and fence syntax fail-closed", () => {
  const fixtures = [
    {
      raw: "第一句。[POINT:none]",
      visible: "第一句。",
    },
    {
      raw: "已处理。<function=computer_control><parameter name=\"action\">left_click</parameter></function>",
      visible: "已处理。",
    },
    {
      raw: "结论。<tool_call><parameter name=\"secret\">hidden</parameter></tool_call>",
      visible: "结论。",
    },
    {
      raw: "完成。```tool\n{\"name\":\"computer_control\"}\n```",
      visible: "完成。",
    },
    {
      raw: "前缀安全。[PO",
      visible: "前缀安全。",
    },
    {
      raw: "前缀安全。<function=computer_control",
      visible: "前缀安全。",
    },
    {
      raw: "前缀安全。</function>",
      visible: "前缀安全。",
    },
  ];

  for (const fixture of fixtures) {
    const projector = new AssistantOutputStreamProjector();
    const deltas = [...fixture.raw].map((character) => projector.push(character));
    for (const delta of deltas) {
      assert.doesNotMatch(
        delta,
        /\[po(?:int)?|<\/?(?:tool|function|computer|parameter)|```|`$/i,
      );
    }
    const completed = projector.complete();
    assert.equal(deltas.join("") + completed.visibleDelta, completed.visibleText);
    assert.equal(completed.visibleText, fixture.visible);
  }
});

test("direct click utterances are identified for buffer-until-result presentation", () => {
  assert.equal(isDirectComputerActionUtterance("帮我点一下旁边那个任务"), true);
  assert.equal(isDirectComputerActionUtterance("去点那个"), true);
  assert.equal(isDirectComputerActionUtterance("去点击左上角的新对话"), true);
  assert.equal(isDirectComputerActionUtterance("帮我点一下那个"), true);
  assert.equal(isDirectComputerActionUtterance("点击新对话"), true);
  assert.equal(isDirectComputerActionUtterance("click the New conversation button"), true);
  assert.equal(isDirectComputerActionUtterance("click New Thread"), true);
  assert.equal(isDirectComputerActionUtterance("解释一下这个按钮为什么灰了"), false);
});

test("multi-step click utterances stay on the normal multi-action path", () => {
  assert.equal(isDirectComputerActionUtterance("先点击 A，再点击 B"), false);
  assert.equal(isDirectComputerActionUtterance("点击 A，然后按回车"), false);
  assert.equal(isDirectComputerActionUtterance("点击 A 接着选择 B"), false);
  assert.equal(isDirectComputerActionUtterance("click A and then click B"), false);
  assert.equal(isDirectComputerActionUtterance("click A then confirm the dialog"), false);
  assert.equal(isDirectComputerActionUtterance("click A and press Enter"), false);
  assert.equal(isDirectComputerActionUtterance("点击新对话并输入 hello"), false);
  assert.equal(isDirectComputerActionUtterance("click New Thread and type hello"), false);
});

test("explanation and question utterances never enable direct-click max-once", () => {
  assert.equal(isDirectComputerActionUtterance("解释为什么点击这个按钮"), false);
  assert.equal(isDirectComputerActionUtterance("为什么点击这个按钮"), false);
  assert.equal(isDirectComputerActionUtterance("这是什么意思，click New Thread?"), false);
  assert.equal(isDirectComputerActionUtterance("how do I click New Thread?"), false);
  assert.equal(isDirectComputerActionUtterance("why click this button?"), false);
  assert.equal(isDirectComputerActionUtterance("不要点击这个按钮"), false);
  assert.equal(isDirectComputerActionUtterance("他说点击这个按钮"), false);
  assert.equal(isDirectComputerActionUtterance("如果点击这个按钮会怎样"), false);
  assert.equal(isDirectComputerActionUtterance("这个按钮可以点击吗？"), false);
  assert.equal(isDirectComputerActionUtterance("我刚才点击了按钮"), false);
  assert.equal(isDirectComputerActionUtterance("我想知道点击后会发生什么"), false);
  assert.equal(isDirectComputerActionUtterance("点击这个按钮吗"), false);
  assert.equal(isDirectComputerActionUtterance("点击这个按钮对吗"), false);
  assert.equal(isDirectComputerActionUtterance("点击这个按钮好不好"), false);
  assert.equal(isDirectComputerActionUtterance("点击这个按钮会不会有风险"), false);
  assert.equal(isDirectComputerActionUtterance("点击这个按钮是什么效果"), false);
  assert.equal(isDirectComputerActionUtterance("点击 新对话"), true);
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
