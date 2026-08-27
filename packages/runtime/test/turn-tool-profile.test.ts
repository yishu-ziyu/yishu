import assert from "node:assert/strict";
import test from "node:test";
import {
  LOOKUP_TOOL_NAMES,
  activeToolNamesForTurn,
  isLookupOnlyUtterance,
} from "../src/turn-tool-profile.js";

const registered = [
  "web_search",
  "browser",
  "computer_control",
  "delegate",
  "files",
  "capture_evidence",
  "finalize_research",
  "search_web",
  "research_plan",
  "save_current_page_actions_to_note",
];

test("wikipedia-style lookups hide desktop, files, and delegate", () => {
  assert.equal(
    isLookupOnlyUtterance("去维基百科查褪黑素，告诉我它什么时候可以人工合成的？"),
    true,
  );
  assert.equal(
    isLookupOnlyUtterance("打开维基百科火星条目，看完再告诉我它为什么是红色，并说出打开的网址。"),
    true,
  );
  const names = activeToolNamesForTurn({
    registeredNames: registered,
    utterance: "去维基百科查褪黑素，告诉我它什么时候可以人工合成的？",
    enablePageNote: true,
  });
  assert.deepEqual(names.sort(), [...LOOKUP_TOOL_NAMES].sort());
  assert.equal(names.includes("computer_control"), false);
  assert.equal(names.includes("delegate"), false);
  assert.equal(names.includes("files"), false);
  assert.equal(names.includes("research_plan"), false);
});

test("click, folder, and deictic screen turns keep the full tool surface", () => {
  assert.equal(isLookupOnlyUtterance("点击测试窗口里的主按钮。"), false);
  assert.equal(isLookupOnlyUtterance("读刚才加的文件夹里的 note 文件"), false);
  assert.equal(isLookupOnlyUtterance("这个按钮为什么是灰色的？"), false);
  assert.equal(isLookupOnlyUtterance("查一下屏幕上这个数字对不对"), false);
  const click = activeToolNamesForTurn({
    registeredNames: registered,
    utterance: "点击测试窗口里的主按钮。",
    enablePageNote: false,
  });
  assert.ok(click.includes("computer_control"));
  assert.ok(click.includes("delegate"));
  assert.ok(click.includes("files"));
  assert.equal(click.includes("save_current_page_actions_to_note"), false);
});
