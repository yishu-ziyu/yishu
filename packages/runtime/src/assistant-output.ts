export interface LegacyComputerAction {
  action: "left_click";
  x: number;
  y: number;
  screen?: number;
  label?: string;
}

export interface AssistantOutputProjection {
  visibleText: string;
  computerActions: LegacyComputerAction[];
}

const computerControlBlockPattern = /<computer_control\b[^>]*>([\s\S]*?)<\/computer_control\s*>/gi;
const functionComputerControlBlockPattern = /<\s*function\s*=\s*["']?computer[ _-]?control["']?[^>]*>[\s\S]*?<\/\s*function\s*>/gi;
const functionBlockPattern = /<\s*function(?:\s*=|\b)[^>]*>[\s\S]*?<\/\s*function\s*>/gi;
const toolWrapperBlockPattern = /<\s*(?:computer[ _-]?action|tool[ _-]?call|function[ _-]?call|tool)\b[^>]*>[\s\S]*?<\/\s*(?:computer[ _-]?action|tool[ _-]?call|function[ _-]?call|tool)\s*>/gi;
const selfClosingToolTagPattern = /<\s*(?:computer[ _-]?action|tool[ _-]?call|function[ _-]?call|tool)\b[^>]*\/\s*>/gi;
const namedParameterBlockPattern = /<\s*parameter\b(?=[^>]*\bname\s*=)[^>]*>[\s\S]*?<\/\s*parameter\s*>/gi;
const orphanToolTagPattern = /<\/?\s*(?:computer[ _-]?control|computer[ _-]?action|tool[ _-]?call|function[ _-]?call|tool|function)(?:\s*=|\b)[^>]*>/gi;
const bracketToolDirectivePattern = /\[\s*(?:tool[ _-]?call|computer[ _-]?control|function[ _-]?call)\b[^\]]*\][\s\S]*$/gi;
const fencedBlockPattern = /```[^\n]*\n?[\s\S]*?```/g;
const pointDirectivePattern = /\[POINT:\s*(?:none|(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?::([^\]:\s][^\]:]*?))?(?::screen(\d+))?)\]\s*$/gi;
const directActionTriggerPattern = /(?:点击|点开|点选|点一下|点(?:这个|那个)|按一下|按下|选中|\b(?:click|press|tap)\b)/gi;
const directActionTriggerSearchPattern = new RegExp(directActionTriggerPattern.source, "i");
const sequenceConnectorPattern = /(?:然后|再|接着|之后|随后|并且|并|且|and then|after that|\band\b|then|next)/i;
const followUpActionPattern = /(?:打开|选择|输入|填写|确认|提交|发送|拖动|滚动|关闭|删除|按(?:回车|enter)|\b(?:select|open|type|enter|submit|send|confirm|drag|scroll|close|delete)\b)/i;
const explanationOrQuestionPattern = /(?:解释|为什么|是什么意思|怎么|如何|\b(?:why|what|how)\b)/i;

function parameterValue(block: string, name: string): string | undefined {
  const pattern = new RegExp(
    `<parameter\\s+name\\s*=\\s*["']${name}["']\\s*>([\\s\\S]*?)<\\/parameter\\s*>`,
    "i",
  );
  return pattern.exec(block)?.[1]?.trim();
}

function parseComputerAction(block: string): LegacyComputerAction | undefined {
  const rawAction = parameterValue(block, "action")?.toLowerCase();
  if (rawAction !== "left_click" && rawAction !== "click") return undefined;

  const x = Number(parameterValue(block, "x"));
  const y = Number(parameterValue(block, "y"));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;

  const rawScreen = parameterValue(block, "screen");
  const screen = rawScreen === undefined ? undefined : Number(rawScreen);
  if (screen !== undefined && (!Number.isInteger(screen) || screen < 1)) return undefined;

  return {
    action: "left_click",
    x,
    y,
    ...(screen === undefined ? {} : { screen }),
  };
}

function parsePointAction(match: RegExpMatchArray): LegacyComputerAction | undefined {
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;

  const screen = match[4] === undefined ? undefined : Number(match[4]);
  if (screen !== undefined && (!Number.isInteger(screen) || screen < 1)) return undefined;

  const label = match[3]?.trim();
  return {
    action: "left_click",
    x,
    y,
    ...(screen === undefined ? {} : { screen }),
    ...(label === undefined || label.length === 0 ? {} : { label }),
  };
}

function cleanVisibleText(rawText: string): string {
  const withoutFences = rawText.replace(fencedBlockPattern, "");
  const withoutComputerControl = withoutFences
    .replace(functionComputerControlBlockPattern, "")
    .replace(functionBlockPattern, "")
    .replace(toolWrapperBlockPattern, "")
    .replace(selfClosingToolTagPattern, "")
    .replace(namedParameterBlockPattern, "")
    .replace(computerControlBlockPattern, "")
    .replace(bracketToolDirectivePattern, "")
    .replace(orphanToolTagPattern, "");
  const withoutPointDirective = withoutComputerControl.replace(pointDirectivePattern, "");
  return withoutPointDirective
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function incompleteHiddenBlockStart(rawText: string): number | undefined {
  const lowercased = rawText.toLowerCase();
  const candidates: number[] = [];
  const openComputerControl = lowercased.lastIndexOf("<computer_control");
  const closeComputerControl = lowercased.lastIndexOf("</computer_control");
  if (openComputerControl > closeComputerControl) candidates.push(openComputerControl);

  const fenceCount = rawText.match(/```/g)?.length ?? 0;
  if (fenceCount % 2 === 1) candidates.push(rawText.lastIndexOf("```"));

  // Never publish a partial XML-looking token. Once the closing `>` arrives,
  // ordinary markup can flow; known tool wrappers remain buffered below until
  // their matching close tag arrives and the projector can remove them.
  const lastAngleBracket = lowercased.lastIndexOf("<");
  if (lastAngleBracket > lowercased.lastIndexOf(">")) {
    candidates.push(lastAngleBracket);
  }

  const lastSquareBracket = lowercased.lastIndexOf("[");
  if (lastSquareBracket > lowercased.lastIndexOf("]")) {
    candidates.push(lastSquareBracket);
  }

  const pointStart = lowercased.lastIndexOf("[point:");
  if (pointStart >= 0) candidates.push(pointStart);
  for (const marker of ["[tool_call", "[tool-call", "[computer_control", "[function_call"]) {
    const markerStart = lowercased.lastIndexOf(marker);
    if (markerStart >= 0) candidates.push(markerStart);
  }

  const openToolBlock = (
    openingPattern: RegExp,
    closingPattern: RegExp,
  ): void => {
    const openings = [...lowercased.matchAll(openingPattern)];
    const closings = [...lowercased.matchAll(closingPattern)];
    const opening = openings.at(-1);
    const closing = closings.at(-1);
    const selfClosing = opening?.[0] !== undefined && /\/\s*>$/u.test(opening[0]);
    if (!selfClosing && opening?.index !== undefined && opening.index > (closing?.index ?? -1)) {
      candidates.push(opening.index);
    }
  };
  openToolBlock(/<\s*computer_control\b/g, /<\/\s*computer_control\s*>/g);
  openToolBlock(
    /<\s*function\s*=\s*["']?computer[ _-]?control["']?[^>]*>/g,
    /<\/\s*function\s*>/g,
  );
  openToolBlock(
    /<\s*function(?:\s*=|\b)[^>]*>/g,
    /<\/\s*function\s*>/g,
  );
  for (const tag of ["computer[ _-]?action", "tool[ _-]?call", "function[ _-]?call", "tool"]) {
    openToolBlock(
      new RegExp(`<\\s*${tag}\\b[^>]*>`, "g"),
      new RegExp(`<\\/\\s*${tag}\\s*>`, "g"),
    );
  }
  openToolBlock(
    /<\s*parameter\b(?=[^>]*\bname\s*=)[^>]*>/g,
    /<\/\s*parameter\s*>/g,
  );

  let trailingBackticks = 0;
  for (let index = rawText.length - 1; index >= 0 && rawText[index] === "`"; index -= 1) {
    trailingBackticks += 1;
  }
  if (trailingBackticks > 0 && trailingBackticks < 3) {
    candidates.push(rawText.length - trailingBackticks);
  }

  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

export function projectAssistantOutput(rawText: string): AssistantOutputProjection {
  const computerActions: LegacyComputerAction[] = [];
  for (const match of rawText.matchAll(computerControlBlockPattern)) {
    const action = parseComputerAction(match[0]);
    if (action) computerActions.push(action);
  }
  for (const match of rawText.matchAll(pointDirectivePattern)) {
    const action = parsePointAction(match);
    if (action) computerActions.push(action);
  }

  const hiddenSuffixStart = incompleteHiddenBlockStart(rawText);
  const presentationRawText = hiddenSuffixStart === undefined
    ? rawText
    : rawText.slice(0, hiddenSuffixStart);
  return {
    visibleText: cleanVisibleText(presentationRawText),
    computerActions,
  };
}

/**
 * Projects streaming model text into a monotonic, presentation-safe stream.
 * Direct action turns can buffer everything until execution has a result.
 */
export class AssistantOutputStreamProjector {
  private rawText = "";
  private emittedText = "";

  push(delta: string, bufferUntilComplete = false): string {
    this.rawText += delta;
    if (bufferUntilComplete) return "";

    const hiddenBlockStart = incompleteHiddenBlockStart(this.rawText);
    const stableRawText = hiddenBlockStart === undefined
      ? this.rawText
      : this.rawText.slice(0, hiddenBlockStart);
    const stableVisibleText = projectAssistantOutput(stableRawText).visibleText;
    return this.takeNewVisibleSuffix(stableVisibleText);
  }

  complete(): AssistantOutputProjection & { visibleDelta: string; rawText: string } {
    const projection = projectAssistantOutput(this.rawText);
    return {
      ...projection,
      visibleDelta: this.takeNewVisibleSuffix(projection.visibleText),
      rawText: this.rawText,
    };
  }

  private takeNewVisibleSuffix(nextVisibleText: string): string {
    if (!nextVisibleText.startsWith(this.emittedText)) {
      return "";
    }
    const delta = nextVisibleText.slice(this.emittedText.length);
    this.emittedText = nextVisibleText;
    return delta;
  }
}

export function isDirectComputerActionUtterance(utterance: string): boolean {
  const normalized = utterance.trim().toLowerCase();
  if (/^(?:(?:请|麻烦|帮我|请帮我)\s*)?(?:不要|别(?:再)?|无需|不(?:要|用|必)|禁止|do\s+not|don't|dont|never)/iu.test(normalized)) {
    return false;
  }
  if (/^(?:他说|她说|它说|有人说|the\s+text\s+says|they\s+said|he\s+said|she\s+said)/iu.test(normalized)) {
    return false;
  }
  if (explanationOrQuestionPattern.test(normalized)
    || /[?？]/u.test(normalized)
    || /(?:如果|假如|是否|能否|可否|是不是|要不要|该不该|好不好|对吗|会不会|是什么|可以.*吗|会怎样|会发生什么|我刚才|我之前|我想知道|(?:吗|呢|么)\s*$)/u.test(normalized)) {
    return false;
  }

  // Tool authority is narrower than merely mentioning an action. Require an
  // anchored imperative form; presentation buffering may be conservative, but
  // only this explicit user command can authorize a physical click.
  const imperative = /^(?:(?:请|麻烦|帮我|请帮我|去|给我)\s*)?(?:先\s*)?(?:点击|点开|点选|点一下|点(?:这个|那个)|按一下|按下|选中|点那个)(?:\s*\S|$)|^(?:please\s+)?(?:click|press|tap)\b/iu;
  if (!imperative.test(normalized)) return false;

  const actionTriggerCount = [...normalized.matchAll(directActionTriggerPattern)].length;
  if (actionTriggerCount !== 1) return false;

  // A single click may be followed by an explanation or other non-action
  // response. Once the utterance clearly sequences a second computer action,
  // leave it on the normal multi-step path instead of enabling max-once.
  const sequenceParts = normalized.split(sequenceConnectorPattern);
  if (sequenceParts.length > 1) {
    const firstPart = sequenceParts.at(0) ?? "";
    const firstPartHasAction = directActionTriggerSearchPattern.test(firstPart)
      || followUpActionPattern.test(firstPart);
    const laterPartHasAction = sequenceParts.slice(1).some((part) => (
      directActionTriggerSearchPattern.test(part) || followUpActionPattern.test(part)
    ));
    if (firstPartHasAction && laterPartHasAction) return false;
  }

  return true;
}
