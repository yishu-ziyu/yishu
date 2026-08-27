export const BROWSER_PAGE_READY_MESSAGE =
  "The opened page was already observed. Do not call browser again. Speak the answer now, and name the opened URL if the user asked for a source.";

const MIN_CONTENT_CHARS = 40;

export interface BrowserTurnBudget {
  opened: boolean;
  reads: number;
  contentful: boolean;
}

export function emptyBrowserTurnBudget(): BrowserTurnBudget {
  return { opened: false, reads: 0, contentful: false };
}

export function browserOpAllowed(budget: BrowserTurnBudget, op: string): boolean {
  if (op === "close") return true;
  if (!budget.opened) return true;
  if (budget.reads >= 2) return false;
  if (budget.reads >= 1 && budget.contentful) return false;
  return true;
}

export function noteBrowserOp(
  budget: BrowserTurnBudget,
  op: string,
  output: { succeeded?: boolean; extracted?: string },
): void {
  if (output.succeeded === false) return;
  if (op === "goto" || op === "open_tab") {
    budget.opened = true;
    budget.reads = 0;
    budget.contentful = false;
    return;
  }
  if (!budget.opened) return;
  if (op !== "observe" && op !== "extract") return;
  budget.reads += 1;
  const extracted = output.extracted?.trim() ?? "";
  if (extracted.length >= MIN_CONTENT_CHARS) budget.contentful = true;
}
