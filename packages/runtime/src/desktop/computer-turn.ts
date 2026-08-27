import { randomUUID } from "node:crypto";
import { isDirectComputerActionUtterance } from "../assistant-output.js";
import type { ComputerActionResult } from "../computer-use-port.js";
import type { ComputerControlToolAction } from "../computer-control-tool.js";
import type { ContextFrame } from "../protocol.js";
import type { DesktopLoopState } from "./desktop-loop.js";
import type { DesktopObservation } from "./desktop-observation.js";
import { desktopStepBudget } from "./desktop-policy.js";

/**
 * Keep the user-facing completion gate on the legacy `verified` bit.  A
 * delivered or unverified receipt must never be promoted to “点好了” merely
 * because a platform accepted an input event.
 */
export function computerActionCompletionText(result: ComputerActionResult | undefined): string {
  if (result?.verified) return "点好了。";
  if (result?.succeeded || result?.status === "delivered" || result?.status === "unverified") {
    return "已经点击，但界面结果还没确认。";
  }
  return "这次没点成功。";
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
    || isSequencedDesktopUtterance(utterance);
}

export function desktopActionBudgetForTurn(input: {
  utterance: string;
  intentAllowsEffect: boolean;
}): number {
  if (!input.intentAllowsEffect) return 0;
  if (!isDesktopWorkUtterance(input.utterance)) return 0;
  return computerActionLimitForUtterance(input.utterance);
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
  const targetId = action.action === "left_click" ? action.targetId : undefined;
  const targets = previous?.targets
    ?? (targetId === undefined ? [] : [{ targetId }]);
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
