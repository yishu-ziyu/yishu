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
const fencedBlockPattern = /```[^\n]*\n?[\s\S]*?```/g;
const pointDirectivePattern = /\[POINT:\s*(?:none|(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?::([^\]:\s][^\]:]*?))?(?::screen(\d+))?)\]\s*$/gi;

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
  const withoutComputerControl = withoutFences.replace(computerControlBlockPattern, "");
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

  const computerControlToken = "<computer_control";
  const lastAngleBracket = lowercased.lastIndexOf("<");
  if (lastAngleBracket >= 0) {
    const suffix = lowercased.slice(lastAngleBracket);
    if (computerControlToken.startsWith(suffix)) candidates.push(lastAngleBracket);
  }

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

  return {
    visibleText: cleanVisibleText(rawText),
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
  return /(?:点一下|点击|点开|点选|按一下|按下|选中|(?:帮我|替我|给我|请|去)点(?:这个|那个)?)|\b(?:click|press|tap)\b/i.test(normalized);
}
