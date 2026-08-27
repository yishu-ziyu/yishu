import { isDirectComputerActionUtterance } from "./assistant-output.js";
import { isDesktopWorkUtterance } from "./desktop/computer-turn.js";
import { isCurrentPageActionsNoteUtterance } from "./delegation.js";

/** Tools a public-fact lookup may see. Desktop, files, and delegate stay off. */
export const LOOKUP_TOOL_NAMES = [
  "web_search",
  "search_web",
  "browser",
  "capture_evidence",
  "finalize_research",
] as const;

const LOOKUP_HINT =
  /维基|wikipedia|查(?:一?下)?|搜索|搜一下|公开(?:网页|事实)|打开的网址|源页|(?:百科).{0,12}条目/iu;
const SCREEN_HINT = /屏幕上|窗口里|按钮|菜单栏|光标|点一下|点击|按下|打字|输入到/u;
const FILES_HINT = /文件夹|工作区|workspace|granted folder|\.txt|\.md|读.*文件|改.*文件/iu;
const DELEGATE_HINT = /后台|委托|delegate|盯着|过一会儿(?:再|告诉)|帮我持续/iu;

export function isLookupOnlyUtterance(utterance: string): boolean {
  const text = utterance.trim();
  if (text.length === 0) return false;
  if (isDesktopWorkUtterance(text) || isDirectComputerActionUtterance(text)) return false;
  if (isCurrentPageActionsNoteUtterance(text)) return false;
  if (SCREEN_HINT.test(text) || FILES_HINT.test(text) || DELEGATE_HINT.test(text)) return false;
  return LOOKUP_HINT.test(text);
}

export function activeToolNamesForTurn(input: {
  registeredNames: readonly string[];
  utterance: string;
  enablePageNote: boolean;
}): string[] {
  const withoutPageNote = input.registeredNames.filter(
    (name) => name !== "save_current_page_actions_to_note",
  );
  if (isLookupOnlyUtterance(input.utterance)) {
    const allowed = new Set<string>(LOOKUP_TOOL_NAMES);
    return withoutPageNote.filter((name) => allowed.has(name));
  }
  if (input.enablePageNote) {
    return [...withoutPageNote, "save_current_page_actions_to_note"];
  }
  return withoutPageNote;
}
