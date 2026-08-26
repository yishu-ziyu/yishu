export const DESKTOP_ACTION_KINDS = [
  "press",
  "set_text",
  "key_press",
  "scroll",
  "open_app",
  "focus_window",
  "select_menu_item",
  "copy",
  "paste",
  "wait",
] as const;

export type DesktopActionKind = (typeof DESKTOP_ACTION_KINDS)[number];

export type DesktopAction =
  | { kind: "press"; targetId: string }
  | { kind: "set_text"; targetId?: string; text: string; mode: "replace" | "insert" }
  | { kind: "key_press"; key: "enter" | "escape" | "tab" | "space" | "backspace"; modifiers?: string[] }
  | { kind: "scroll"; axis: "vertical" | "horizontal"; direction: "forward" | "backward"; amount: "small" | "page" }
  | { kind: "open_app"; bundleId: string }
  | { kind: "focus_window"; targetId: string }
  | { kind: "select_menu_item"; appBundleId: string; path: string[] }
  | { kind: "copy" }
  | { kind: "paste" }
  | { kind: "wait"; milliseconds: number };

export const DESKTOP_RECEIPT_STATUSES = [
  "verified",
  "delivered",
  "blocked",
  "stale",
  "cancelled",
  "unknown",
  "failed",
] as const;

export type DesktopReceiptStatus = (typeof DESKTOP_RECEIPT_STATUSES)[number];

export interface DesktopActionReceipt {
  receiptId: string;
  requestId: string;
  attemptId: string;
  actionDigest: string;
  basisObservationId: string;
  status: DesktopReceiptStatus;
  committed: boolean;
  verified: boolean;
  verifier?: string;
  evidenceCode?: string;
  nextObservationId?: string;
}

export interface DesktopActionProposal {
  action: DesktopAction;
  basisObservationId: string;
  requestId: string;
  approvalToken?: string;
}

export function digestDesktopAction(action: DesktopAction): string {
  return JSON.stringify(action);
}

export function isEffectfulDesktopAction(action: DesktopAction): boolean {
  return action.kind !== "wait";
}

export function desktopActionFromLegacy(action: {
  action: "left_click" | "set_text";
  targetId?: string;
  text?: string;
}): DesktopAction {
  if (action.action === "left_click") {
    if (action.targetId === undefined) {
      throw new Error("left_click compatibility mapping requires targetId.");
    }
    return { kind: "press", targetId: action.targetId };
  }
  if (action.text === undefined) {
    throw new Error("set_text compatibility mapping requires text.");
  }
  return {
    kind: "set_text",
    text: action.text,
    mode: "replace",
    ...(action.targetId === undefined ? {} : { targetId: action.targetId }),
  };
}
