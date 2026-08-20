import type { AuthorityLevel } from "../../src/action/types.js";
import type { IntentEffect, IntentSpeechAct } from "../../src/intent-frame.js";
import type { ProductActionName } from "../../src/utterance-router.js";

export interface IntentCorpusCase {
  readonly name: string;
  readonly utterance: string;
  readonly options?: { readonly currentPageNote?: boolean };
  readonly expected: {
    readonly speechAct?: IntentSpeechAct;
    readonly effect: IntentEffect;
    readonly route: "model" | "product_action" | "clarify";
    readonly action?: ProductActionName;
    readonly steerable: boolean;
    readonly authority?: AuthorityLevel;
  };
}

export const INTENT_CORPUS: readonly IntentCorpusCase[] = [
  {
    name: "question with open verb",
    utterance: "为什么要打开这个文件？",
    expected: { speechAct: "question", effect: "none", route: "model", steerable: true },
  },
  {
    name: "question without punctuation",
    utterance: "能不能打开这个文件",
    expected: { speechAct: "question", effect: "none", route: "model", steerable: true },
  },
  {
    name: "English polite question",
    utterance: "can you open this file",
    expected: { speechAct: "question", effect: "none", route: "model", steerable: true },
  },
  {
    name: "hypothetical delete",
    utterance: "如果删除这份草稿会发生什么？",
    expected: { speechAct: "question", effect: "none", route: "model", steerable: true },
  },
  {
    name: "leading negation",
    utterance: "不要打开这个文件",
    expected: { speechAct: "negation", effect: "none", route: "model", steerable: true },
  },
  {
    name: "English leading negation",
    utterance: "do not delete this note",
    expected: { speechAct: "negation", effect: "none", route: "model", steerable: true },
  },
  {
    name: "reported Chinese command",
    utterance: "他说「打开设置」是什么意思？",
    expected: { speechAct: "reported_speech", effect: "none", route: "model", steerable: true },
  },
  {
    name: "reported page text",
    utterance: "页面上写着点击继续",
    expected: { speechAct: "reported_speech", effect: "none", route: "model", steerable: true },
  },
  {
    name: "reported English command",
    utterance: "she said click the blue button",
    expected: { speechAct: "reported_speech", effect: "none", route: "model", steerable: true },
  },
  {
    name: "past observation",
    utterance: "我刚才打开了这个文件",
    expected: { speechAct: "statement", effect: "none", route: "model", steerable: true },
  },
  {
    name: "completed observation",
    utterance: "我已经保存了这份文档",
    expected: { speechAct: "statement", effect: "none", route: "model", steerable: true },
  },
  {
    name: "self-cancelled Chinese command",
    utterance: "打开这个文件，算了",
    expected: { speechAct: "negation", effect: "none", route: "model", steerable: true },
  },
  {
    name: "self-corrected Chinese command",
    utterance: "打开这个文件，还是别打开了",
    expected: { speechAct: "negation", effect: "none", route: "model", steerable: true },
  },
  {
    name: "self-cancelled English command",
    utterance: "open this file, never mind",
    expected: { speechAct: "negation", effect: "none", route: "model", steerable: true },
  },
  {
    name: "ordinary inspection",
    utterance: "帮我看看这份文档在说什么",
    expected: { effect: "none", route: "model", steerable: true },
  },
  {
    name: "direct open",
    utterance: "打开这个文件",
    expected: { speechAct: "command", effect: "external", route: "model", steerable: false },
  },
  {
    name: "direct click",
    utterance: "请点击右上角的保存",
    expected: { speechAct: "command", effect: "external", route: "model", steerable: false },
  },
  {
    name: "direct deictic click",
    utterance: "点这个",
    expected: { speechAct: "command", effect: "external", route: "model", steerable: false },
  },
  {
    name: "direct text input",
    utterance: "在当前输入框输入「hello world」",
    expected: { speechAct: "command", effect: "external", route: "model", steerable: false },
  },
  {
    name: "direct select",
    utterance: "选择第二个选项",
    expected: { speechAct: "command", effect: "external", route: "model", steerable: false },
  },
  {
    name: "object-first copy",
    utterance: "把上一段复制到这里",
    expected: { speechAct: "command", effect: "external", route: "model", steerable: false },
  },
  {
    name: "English command",
    utterance: "please open this file",
    expected: { speechAct: "command", effect: "external", route: "model", steerable: false },
  },
  {
    name: "English exact text command",
    utterance: "set the text to hello",
    expected: { speechAct: "command", effect: "external", route: "model", steerable: false },
  },
  {
    name: "remember fact",
    utterance: "记住：我喜欢简短回答",
    expected: {
      effect: "product_state",
      route: "product_action",
      action: "remember",
      steerable: false,
      authority: "reversible",
    },
  },
  {
    name: "remember procedure",
    utterance: "记住我刚才是怎么做的",
    expected: {
      effect: "product_state",
      route: "product_action",
      action: "remember_how",
      steerable: false,
      authority: "reversible",
    },
  },
  {
    name: "share context",
    utterance: "share this context",
    expected: {
      effect: "product_state",
      route: "product_action",
      action: "share_context",
      steerable: false,
      authority: "automatic",
    },
  },
  {
    name: "handoff to Codex",
    utterance: "这个交给 Codex",
    expected: {
      effect: "product_state",
      route: "product_action",
      action: "run_skill",
      steerable: false,
      authority: "reversible",
    },
  },
  {
    name: "record correction",
    utterance: "以后不要在没有证据时宣布完成",
    expected: {
      effect: "product_state",
      route: "product_action",
      action: "record_learning",
      steerable: false,
      authority: "reversible",
    },
  },
  {
    name: "create note",
    utterance: "把「周五演示」写进备忘录",
    expected: {
      speechAct: "command",
      effect: "external",
      route: "product_action",
      action: "create_note",
      steerable: false,
      authority: "explicit_approval",
    },
  },
  {
    name: "quoted negative content is still a note command",
    utterance: "把「不要忘记删除旧草稿」写进备忘录",
    expected: {
      speechAct: "command",
      effect: "external",
      route: "product_action",
      action: "create_note",
      steerable: false,
      authority: "explicit_approval",
    },
  },
  {
    name: "relative reminder",
    utterance: "20分钟后提醒我喝水",
    expected: {
      effect: "external",
      route: "product_action",
      action: "schedule_time_reminder",
      steerable: false,
      authority: "explicit_approval",
    },
  },
  {
    name: "relative reminder question",
    utterance: "20分钟后提醒我喝水吗？",
    expected: { effect: "none", route: "clarify", steerable: false },
  },
  {
    name: "relative reminder incomplete",
    utterance: "20分钟后提醒我",
    expected: { effect: "none", route: "clarify", steerable: false },
  },
  {
    name: "current-page composed note",
    utterance: "把当前页面需要我做的三件事整理成一条备忘录",
    options: { currentPageNote: true },
    expected: {
      effect: "external",
      route: "model",
      steerable: false,
      authority: "explicit_approval",
    },
  },
];
