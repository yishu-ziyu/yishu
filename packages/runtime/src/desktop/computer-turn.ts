import { randomUUID } from "node:crypto";
import { isDirectComputerActionUtterance } from "../assistant-output.js";
import type { ComputerActionResult } from "../computer-use-port.js";
import type { ComputerControlToolAction } from "../computer-control-tool.js";
import type { ContextFrame } from "../protocol.js";
import type { DesktopLoopState } from "./desktop-loop.js";
import type { DesktopObservation } from "./desktop-observation.js";
import { desktopStepBudget } from "./desktop-policy.js";
import {
  fileDropTargetFingerprint,
  isExactFileDropConfirmation,
  isFileDropRequestUtterance,
  isLikelyFileDropTarget,
  isSupportedBrowserBundleId,
  isValidDownloadFileName,
  type FileDropTargetBinding,
} from "./file-drop-approval.js";

/**
 * Tool-result status for the model. Never spoken to the user. A delivered or
 * unverified receipt must never be described as a confirmed success.
 */
export function computerActionCompletionText(result: ComputerActionResult | undefined): string {
  if (result?.verified) {
    return "Status: verified. The requested click was confirmed by accessibility read-back. Phrase any confirmation in your own words. Do not mention receipts or tool names.";
  }
  if (result?.succeeded || result?.status === "delivered" || result?.status === "unverified") {
    return "Status: unverified. The click was delivered but the visible outcome was not confirmed. You must not claim success.";
  }
  return "Status: failed. The click did not succeed. You must not claim success.";
}

/** Compatibility POINT replay is a single fallback, never a second dispatch. */
export function shouldRunCompatibilityComputerAction(
  directComputerAction: boolean,
  actionCount: number,
  hasCompatibilityAction: boolean,
): boolean {
  return directComputerAction && actionCount === 0 && hasCompatibilityAction;
}

const deniedTextInputPattern = /^(?:(?:请|麻烦|帮我|请帮我)\s*)?(?:不要|别(?:再)?|无需|不(?:要|用|必)|禁止|别把|do\s+not|don't|dont|never)\s*(?:输入|填写|填入|键入|写入|type|fill|set)/iu;
const textInputQuestionPattern = /(?:为什么|怎么|如何|是什么|什么意思|what\b|why\b|how\b|\?\s*$|？\s*$)/iu;
const quotedTextPattern = /["“「『']([^"”」』']+)["”」』']/u;
const desktopDenialPrefix = /^(?:(?:请|麻烦|帮我|请帮我)\s*)?(?:不要|别(?:再)?|无需|不(?:要|用|必)|禁止|do\s+not|don't|dont|never)/iu;
const reportedSpeechPrefix = /^(?:他说|她说|它说|有人说|the\s+text\s+says|they\s+said|he\s+said|she\s+said)/iu;
const explanationOrQuestionPattern = /(?:解释|为什么|是什么意思|怎么|如何|\b(?:why|what|how)\b)/i;
const questionLikePattern = /(?:如果|假如|是否|能否|可否|是不是|要不要|该不该|好不好|对吗|会不会|是什么|可以.*吗|会怎样|会发生什么|我刚才|我之前|我想知道|(?:吗|呢|么)\s*$)/u;
const sequenceConnectorPattern = /然后|再|接着|之后|随后|and\s+then|\band\b|then|next|\/|,|，/i;

/**
 * Extract the one exact string the user authorized. This deliberately accepts
 * only imperative utterances; negation, questions, reported speech and an
 * empty/ambiguous tail fail closed before Pi receives write authority.
 */
export function authorizedTextForUtterance(utterance: string): string | undefined {
  const normalized = utterance.trim();
  if (normalized.length === 0
    || deniedTextInputPattern.test(normalized)) return undefined;

  const chinese = normalized.match(
    /^(?:(?:请|麻烦|帮我|请帮我)\s*)?(?:在(?:这里|当前(?:输入框|文本框|位置))\s*)?(?:输入|填写|填入|键入|写入)\s*[:：]?\s*(.+)$/u,
  );
  const english = normalized.match(
    /^(?:please\s+)?(?:type(?:\s+in)?|fill(?:\s+in)?|set\s+(?:the\s+)?text)\s*[:：]?\s+(.+)$/iu,
  );
  const tail = (chinese?.[1] ?? english?.[1])?.trim();
  if (!tail) return undefined;

  const quotedMatch = tail.match(quotedTextPattern);
  const quoted = quotedMatch?.[1]?.trim();
  if (quoted && quotedMatch?.index !== undefined) {
    const suffix = tail.slice(quotedMatch.index + quotedMatch[0].length).trim();
    const authorizedFollowup = /^(?:，|,)?\s*(?:然后|再|接着|之后|随后|and\s+then|then|after(?:wards)?)\s*(?:(?:点击|点(?:击)?|按下|按)[\p{Script=Han}A-Za-z0-9]|(?:click|press)\b)/iu;
    // A question or reported-speech suffix outside the quotes is not write
    // authority. Only an empty suffix or one explicit follow-up click is
    // accepted; punctuation inside the quoted text remains literal input.
    if (suffix.length > 0
      && (textInputQuestionPattern.test(suffix) || !authorizedFollowup.test(suffix))) return undefined;
    return quoted.length <= 10_000 ? quoted : undefined;
  }
  if (textInputQuestionPattern.test(normalized)) return undefined;
  const beforeNextAction = tail.split(
    /(?:，|,)?\s*(?:然后|再|接着|之后|随后|and\s+then|then|after(?:wards)?)\s*(?=(?:点击|点(?:击)?|按下|按|click|press))/iu,
    1,
  )[0]?.trim();
  const text = beforeNextAction;
  if (!text || text.length > 10_000) return undefined;
  return text.replace(/[。.]$/u, "").trim() || undefined;
}

/** set_text is admitted only when the utterance itself authorizes text input. */
export function isExplicitTextInputUtterance(utterance: string): boolean {
  return authorizedTextForUtterance(utterance) !== undefined;
}

/** Step budget for this utterance. Regex no longer caps a turn at one or two actions. */
export function computerActionLimitForUtterance(utterance: string): number {
  return desktopStepBudget({
    authorizedCombo: isExplicitTextInputUtterance(utterance),
  });
}

function isDeniedDesktopUtterance(utterance: string): boolean {
  const normalized = utterance.trim().toLowerCase();
  if (normalized.length === 0) return true;
  if (desktopDenialPrefix.test(normalized) || reportedSpeechPrefix.test(normalized)) return true;
  if (explanationOrQuestionPattern.test(normalized) || /[?？]/u.test(normalized)) return true;
  return questionLikePattern.test(normalized);
}

function desktopVerbCount(utterance: string): number {
  const pattern = /看(?:一下|看)?|观察|点(?:击|开|选|一下)?|按下|输入|填写|提交|发送|\blook\b|\bobserve\b|\bclick\b|\bpress\b|\btype\b|\bsubmit\b/gi;
  return [...utterance.toLowerCase().matchAll(pattern)].length;
}

function isSequencedDesktopUtterance(utterance: string): boolean {
  if (isDeniedDesktopUtterance(utterance)) return false;
  if (desktopVerbCount(utterance) < 2) return false;
  return sequenceConnectorPattern.test(utterance);
}

/** Look / click / type / submit sequences are desktop work, not budget 0. */
export function isDesktopWorkUtterance(utterance: string): boolean {
  return isDirectComputerActionUtterance(utterance)
    || isExplicitTextInputUtterance(utterance)
    || isSequencedDesktopUtterance(utterance)
    || authorizedDownloadFileNameForUtterance(utterance) !== undefined;
}

const quotedFileNamePattern = /["“「『']([^"”」』']+)["”」』']/u;
const downloadsMarkerPattern = /(?:下载(?:文件夹|目录|里|中的)?|downloads?)/iu;
const fileNameTailCutPattern = /(?:拖(?:到|进|入|放)|放到|到这里|到这个|上传框|上传区)/u;

/** One exact Downloads basename from an imperative drop/upload utterance. */
export function authorizedDownloadFileNameForUtterance(utterance: string): string | undefined {
  if (!isFileDropRequestUtterance(utterance)) return undefined;
  const quoted = utterance.match(quotedFileNamePattern)?.[1]?.trim();
  if (quoted !== undefined) {
    return isValidDownloadFileName(quoted) ? quoted : undefined;
  }
  const marker = downloadsMarkerPattern.exec(utterance);
  if (marker === null || marker.index === undefined) return undefined;
  const afterMarker = utterance.slice(marker.index + marker[0].length);
  const stripped = afterMarker.replace(/^(?:\s*)(?:文件夹|目录|里|中)?(?:的)?\s*/u, "");
  const cut = stripped.split(fileNameTailCutPattern)[0]?.trim() ?? "";
  if (cut.length === 0 || /\s/u.test(cut) || /[\\/]/.test(cut) || cut.includes("..")) return undefined;
  return isValidDownloadFileName(cut) ? cut : undefined;
}

/** Native candidates resolve speech; the model never chooses a path or grants access. */
export function groundedDownloadFileName(utterance: string, frame: ContextFrame, now: Date): string | undefined {
  if (!isFileDropRequestUtterance(utterance)) return undefined;
  const observation = frame.downloadFiles;
  // Backward compatibility for v1 clients predating native discovery.
  if (observation === undefined) return authorizedDownloadFileNameForUtterance(utterance);
  const age = now.getTime() - Date.parse(observation.capturedAt);
  if (observation.status !== "available" || observation.truncated
    || !Number.isFinite(age) || age < 0 || age > 60_000
    || observation.candidates.length !== 1) return undefined;
  const name = observation.candidates[0]!;
  return isValidDownloadFileName(name) ? name : undefined;
}

export function fileDropBindingFromContext(input: {
  conversationId: string;
  fileName: string;
  targetId: string;
  frame: ContextFrame;
}): FileDropTargetBinding | undefined {
  if (!isValidDownloadFileName(input.fileName)) return undefined;
  const app = input.frame.frontmostApplication?.value;
  const window = input.frame.activeWindow?.value;
  if (!app?.bundleIdentifier || !(app.processIdentifier > 0)) return undefined;
  if (!isSupportedBrowserBundleId(app.bundleIdentifier)) return undefined;
  if (window?.windowNumber === undefined || window.windowNumber <= 0) return undefined;
  if (window.processIdentifier !== app.processIdentifier) return undefined;
  const target = (input.frame.numberedTargets ?? []).find((item) => item.id === input.targetId);
  if (target === undefined || target.enabled === false) return undefined;
  if (!isLikelyFileDropTarget({
    role: target.role,
    title: target.title,
    description: target.description,
  })) return undefined;
  const targetFrame = target.frame;
  if (targetFrame === undefined || targetFrame === null
    || ![targetFrame.x, targetFrame.y, targetFrame.width, targetFrame.height].every(Number.isFinite)
    || targetFrame.width <= 0 || targetFrame.height <= 0) return undefined;
  const targetFingerprint = fileDropTargetFingerprint({
    role: target.role,
    title: target.title,
    description: target.description,
    frame: targetFrame,
  });
  if (targetFingerprint.replaceAll("\u001e", "").length === 0) return undefined;
  return {
    conversationId: input.conversationId,
    fileName: input.fileName,
    targetId: input.targetId,
    targetBundleId: app.bundleIdentifier,
    targetPid: app.processIdentifier,
    targetWindowNumber: window.windowNumber,
    targetFingerprint,
  };
}

export function desktopActionBudgetForTurn(input: {
  utterance: string;
  intentAllowsEffect: boolean;
  fileDropPending?: boolean;
  groundedFileName?: string | undefined;
}): number {
  if (isExactFileDropConfirmation(input.utterance)) {
    return input.fileDropPending === true ? 1 : 0;
  }
  if (!input.intentAllowsEffect) return 0;
  if (input.groundedFileName !== undefined) return 1;
  if (authorizedDownloadFileNameForUtterance(input.utterance) !== undefined) return 1;
  if (!isDesktopWorkUtterance(input.utterance)) return 0;
  return computerActionLimitForUtterance(input.utterance);
}

export function shouldBufferComputerModelText(input: {
  intentAllowsEffect: boolean;
  actionBudget: number;
}): boolean {
  return input.intentAllowsEffect && input.actionBudget > 0;
}

const CONTEXT_FRAME_CLOCK_SKEW_MS = 5_000;

export class ContextFrameFreshnessError extends Error {
  constructor(
    readonly code: "context_frame_invalid" | "context_frame_expired" | "context_frame_from_future",
    message: string,
  ) {
    super(message);
    this.name = "ContextFrameFreshnessError";
  }
}

export function assertContextFrameFresh(contextFrame: ContextFrame, now = new Date()): void {
  const nowMs = now.getTime();
  const capturedAtMs = Date.parse(contextFrame.capturedAt);
  const expiresAtMs = Date.parse(contextFrame.expiresAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(capturedAtMs) || !Number.isFinite(expiresAtMs)) {
    throw new ContextFrameFreshnessError(
      "context_frame_invalid",
      "ContextFrame time boundaries are invalid.",
    );
  }
  if (expiresAtMs <= nowMs) {
    throw new ContextFrameFreshnessError(
      "context_frame_expired",
      "ContextFrame expired before the model prompt was admitted.",
    );
  }
  // The product's context-watch contract tolerates only a bounded clock
  // skew. A materially future frame cannot be trusted as current evidence.
  if (capturedAtMs > nowMs + CONTEXT_FRAME_CLOCK_SKEW_MS) {
    throw new ContextFrameFreshnessError(
      "context_frame_from_future",
      "ContextFrame capturedAt is too far in the future.",
    );
  }
  if (expiresAtMs <= capturedAtMs) {
    throw new ContextFrameFreshnessError(
      "context_frame_invalid",
      "ContextFrame time boundaries are invalid.",
    );
  }
}

export function observationFromContextFrame(frame: ContextFrame): DesktopObservation {
  return {
    observationId: frame.frameId,
    capturedAt: frame.capturedAt,
    expiresAt: frame.expiresAt,
    ...(frame.frontmostApplication?.value.bundleIdentifier
      ? { frontmostBundleId: frame.frontmostApplication.value.bundleIdentifier }
      : {}),
    ...(frame.frontmostApplication?.value.processIdentifier
      ? { frontmostPid: frame.frontmostApplication.value.processIdentifier }
      : {}),
    targets: (frame.numberedTargets ?? []).map((target) => ({
      targetId: target.id,
      ...(target.role ? { role: target.role } : {}),
      ...(target.enabled === undefined || target.enabled === null ? {} : { enabled: target.enabled }),
    })),
    warnings: frame.warnings,
  };
}

export interface ComputerActionTerminalProjection {
  readonly hasComputerAction: boolean;
  readonly visibleDelta: string;
  readonly receiptProjectionText?: string;
}

/** A receipt-free past-tense completion must not escape the buffered action turn. */
export function claimsComputerActionCompleted(text: string): boolean {
  return /点好了|做好了|已经完成|已完成|完成了|verified complete|successfully completed|(?:拖|放|传)(?:到|进|过|上|好)[^。！？\n]{0,30}了|(?:拖|放|传)了|(?:上传|附加|拖放)成功/u.test(text);
}

export function projectComputerActionTerminal(input: {
  directComputerAction: boolean;
  actionCount: number;
  allActionsVerified: boolean;
  bufferComputerModelText: boolean;
  computerActionAttempted: boolean;
  lastResult?: ComputerActionResult;
  modelVisibleDelta: string;
}): ComputerActionTerminalProjection {
  const hasComputerAction = input.actionCount > 0;
  const claimsSuccess = claimsComputerActionCompleted(input.modelVisibleDelta);
  const suppressUnverifiedClaim = (hasComputerAction || input.computerActionAttempted)
    && (input.allActionsVerified !== true || input.lastResult?.code === "approval_required")
    && claimsSuccess;
  const visibleDelta = suppressUnverifiedClaim ? "" : input.modelVisibleDelta;
  return {
    hasComputerAction,
    visibleDelta,
  };
}

export function digestComputerControlAction(action: ComputerControlToolAction): string {
  return JSON.stringify(action);
}

export function unknownCommitBlocksRetry(
  state: Pick<DesktopLoopState, "unknownDigests">,
  digest: string,
): boolean {
  return state.unknownDigests.has(digest);
}

export function rememberUnknownCommit(
  state: Pick<DesktopLoopState, "unknownDigests">,
  digest: string,
  result: ComputerActionResult,
): void {
  if (result.succeeded && result.verified !== true) {
    state.unknownDigests.add(digest);
  }
}

export function nextDesktopObservation(
  previous: DesktopObservation | undefined,
  result: ComputerActionResult,
  action: ComputerControlToolAction,
  now = new Date(),
): DesktopObservation {
  const targetId = action.action === "left_click" || action.action === "drop_download_file"
    ? action.targetId
    : undefined;
  const recaptured = result.numberedTargets ?? [];
  const targets = recaptured.length > 0
    ? recaptured
    : previous?.targets ?? (targetId === undefined ? [] : [{ targetId }]);
  const readback = result.evidence ?? result.message;
  return {
    observationId: randomUUID(),
    capturedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    ...(previous?.frontmostBundleId === undefined ? {} : { frontmostBundleId: previous.frontmostBundleId }),
    ...(previous?.frontmostPid === undefined ? {} : { frontmostPid: previous.frontmostPid }),
    targets,
    warnings: previous?.warnings ?? [],
    previousReadback: readback,
  };
}

export function withFreshObservation(
  result: ComputerActionResult,
  observation: DesktopObservation,
): ComputerActionResult {
  const readback = observation.previousReadback ?? result.evidence;
  return {
    ...result,
    ...(readback === undefined ? {} : { evidence: readback, previousReadback: readback }),
    observationId: observation.observationId,
    numberedTargets: observation.targets,
  };
}
