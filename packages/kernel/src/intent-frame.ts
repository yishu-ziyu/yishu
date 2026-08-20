import type { ActionRisk, AuthorityLevel } from "./action/types.js";
import {
  classifyRelativeTimeReminder,
  routeProductUtterance,
  type ProductActionName,
  type ProductUtteranceRoute,
} from "./utterance-router.js";
import {
  createTaskExecutionContract,
  type TaskExecutionContract,
  type TaskSuccessMode,
} from "./task-contract.js";

export const INTENT_FRAME_VERSION = 1 as const;

export type IntentSpeechAct =
  | "command"
  | "question"
  | "negation"
  | "reported_speech"
  | "statement";

export type IntentEffect = "none" | "product_state" | "external";
export type IntentSource = "deterministic" | "model";

export type IntentRoute =
  | { readonly kind: "model" }
  | { readonly kind: "product_action"; readonly value: ProductUtteranceRoute }
  | { readonly kind: "clarify"; readonly topic: "relative_time_reminder" };

/**
 * One immutable product interpretation for a turn.
 *
 * Parsers may evolve from deterministic rules to a model-backed candidate,
 * while Runtime, task truth, and UI keep consuming this stable contract.
 */
export interface TurnIntentFrame {
  readonly schemaVersion: typeof INTENT_FRAME_VERSION;
  readonly objective: string;
  readonly speechAct: IntentSpeechAct;
  readonly effect: IntentEffect;
  readonly route: IntentRoute;
  readonly successMode: TaskSuccessMode;
  readonly authority: AuthorityLevel;
  readonly risk: ActionRisk;
  readonly steerable: boolean;
  readonly source: IntentSource;
}

/** Parser/model output before product policy assigns authority and success. */
export interface TurnIntentCandidate {
  readonly objective: string;
  readonly speechAct: IntentSpeechAct;
  readonly effect: IntentEffect;
  readonly route: IntentRoute;
  readonly source: IntentSource;
}

export interface IntentResolutionPolicy {
  readonly authority?: AuthorityLevel;
  readonly risk?: ActionRisk;
}

export interface ProductActionIntentPolicy {
  readonly effect: Exclude<IntentEffect, "none">;
  readonly authority: AuthorityLevel;
  readonly risk: ActionRisk;
}

export interface DeriveTurnIntentOptions {
  readonly contextFrame?: unknown;
  /** Narrow composed capability whose parser currently lives in Runtime. */
  readonly currentPageNote?: boolean;
  /** Sanitized display objective; raw utterance remains available to parsers. */
  readonly objective?: string;
}

const PRODUCT_ACTION_INTENT_POLICY = {
  remember: { effect: "product_state", authority: "reversible", risk: "low" },
  forget: { effect: "product_state", authority: "reversible", risk: "medium" },
  remember_how: { effect: "product_state", authority: "reversible", risk: "low" },
  share_context: { effect: "product_state", authority: "automatic", risk: "low" },
  record_learning: { effect: "product_state", authority: "reversible", risk: "low" },
  run_skill: { effect: "product_state", authority: "reversible", risk: "low" },
  watch_app_return: { effect: "product_state", authority: "reversible", risk: "low" },
  finder_history_back: { effect: "external", authority: "reversible", risk: "low" },
  create_note: { effect: "external", authority: "explicit_approval", risk: "medium" },
  schedule_time_reminder: { effect: "external", authority: "explicit_approval", risk: "medium" },
} as const satisfies Record<ProductActionName, ProductActionIntentPolicy>;

const LEADING_NEGATION = /^(?:(?:请|麻烦|帮我|请帮我)\s*)?(?:不要|别(?:再)?|无需|不(?:用|必)|禁止|do\s+not\b|don['’]?t\b|dont\b|never\b)/iu;
const REPORTED_SPEECH = /^(?:他说|她说|它说|有人说|页面上写着|the\s+text\s+says\b|they\s+said\b|he\s+said\b|she\s+said\b)/iu;
const HISTORICAL_STATEMENT = /^(?:我刚才|我刚刚|刚才我|刚刚我|我之前|我已经|已经)/u;
const QUESTION = /[?？]/u;
const QUESTION_LANGUAGE = /(?:为什么|怎么|如何|是什么|什么意思|是否|能否|可否|能不能|可不可以|要不要|该不该|会不会|会怎样|会发生什么|(?:吗|呢|么)\s*$|^(?:why|what|how|can|could|would|should|do|does|did|is|are)\b)/iu;
const HYPOTHETICAL = /^(?:如果|假如|要是|假设|if\b)/iu;

// Safety vocabulary only: it marks an explicit command as effectful. It never
// selects a tool or grants parameters; typed product/tool policies do that.
const CHINESE_EXTERNAL_VERBS = [
  "点击", "点开", "点选", "点一下", "点这个", "点那个", "按一下", "按下",
  "选中", "选择", "打开", "关闭", "输入", "填写", "填入", "键入", "写进", "写入",
  "发送", "删除", "移动", "重命名", "创建", "保存", "执行", "复制", "粘贴", "剪切", "拷贝",
  "拖动", "滚动",
] as const;
const ENGLISH_EXTERNAL_VERBS = [
  "click", "press", "tap", "open", "close", "type(?:\\s+in)?", "enter",
  "fill(?:\\s+in)?", "set\\s+(?:the\\s+)?text", "select", "send", "delete",
  "move", "rename", "create", "save", "execute", "copy", "paste", "cut", "drag", "scroll",
] as const;
const CHINESE_EXTERNAL_PATTERN = CHINESE_EXTERNAL_VERBS.join("|");
const ENGLISH_EXTERNAL_PATTERN = ENGLISH_EXTERNAL_VERBS.join("|");
const DIRECT_EXTERNAL_COMMAND = new RegExp(
  `^(?:(?:请|麻烦|帮我|请帮我|给我|去)\\s*)?(?:先\\s*)?`
  + `(?:在(?:这里|当前(?:输入框|文本框|位置))\\s*)?`
  + `(?:${CHINESE_EXTERNAL_PATTERN})(?:\\s*\\S|$)`
  + `|^(?:please\\s+)?(?:${ENGLISH_EXTERNAL_PATTERN})\\b`,
  "iu",
);
const OBJECT_EXTERNAL_COMMAND = new RegExp(
  `^(?:请|麻烦|帮我|请帮我)?\\s*把\\S[\\s\\S]{0,180}?`
  + `(?:${CHINESE_EXTERNAL_PATTERN})`,
  "u",
);
const TRAILING_CANCELLATION = /(?:[,，]\s*)?(?:还是\s*)?(?:算了|不用了|不要了|取消(?:吧)?|never\s+mind)[。.!！\s]*$/iu;
const TRAILING_NEGATED_EXTERNAL_COMMAND = new RegExp(
  `(?:[,，]\\s*)?(?:还是\\s*)?(?:不要|别)(?:再)?(?:${CHINESE_EXTERNAL_PATTERN})[了吧]?[。.!！\\s]*$`,
  "u",
);

export function deriveTurnIntentFrame(
  utterance: string,
  options: DeriveTurnIntentOptions = {},
): TurnIntentFrame {
  const objective = normalizeObjective(options.objective ?? utterance);
  const speechAct = classifySpeechAct(utterance);
  const reminder = classifyRelativeTimeReminder(utterance);
  if (reminder?.kind === "question" || reminder?.kind === "incomplete") {
    return resolveTurnIntentCandidate({
      objective,
      speechAct,
      effect: "none",
      route: { kind: "clarify", topic: "relative_time_reminder" },
      source: "deterministic",
    });
  }

  const productRoute = reminder?.kind === "schedule"
    ? {
        action: "schedule_time_reminder" as const,
        input: { delaySeconds: reminder.delaySeconds, body: reminder.body },
        confidence: 0.99,
      }
    : routeProductUtterance(utterance, options.contextFrame);

  if (productRoute !== null) {
    const policy = productActionIntentPolicy(productRoute.action);
    return resolveTurnIntentCandidate(
      {
        objective,
        speechAct,
        effect: policy.effect,
        route: { kind: "product_action", value: productRoute },
        source: "deterministic",
      },
      policy,
    );
  }

  const external = options.currentPageNote === true
    || (speechAct === "command" && isExplicitExternalCommand(utterance));
  return resolveTurnIntentCandidate(
    {
      objective,
      speechAct,
      effect: external ? "external" : "none",
      route: { kind: "model" },
      source: "deterministic",
    },
    options.currentPageNote === true
      ? { authority: "explicit_approval", risk: "medium" }
      : {},
  );
}

export function productActionIntentPolicy(
  action: ProductActionName,
): ProductActionIntentPolicy {
  return { ...PRODUCT_ACTION_INTENT_POLICY[action] };
}

/**
 * Stable policy seam shared by deterministic and future model-backed parsers.
 * Candidate sources describe meaning; only this resolver assigns authority.
 */
export function resolveTurnIntentCandidate(
  candidate: TurnIntentCandidate,
  policy: IntentResolutionPolicy = {},
): TurnIntentFrame {
  const effectful = candidate.effect !== "none";
  return freezeFrame({
    objective: normalizeObjective(candidate.objective),
    speechAct: candidate.speechAct,
    effect: candidate.effect,
    route: candidate.route,
    successMode: effectful ? "external_effect" : "read_only_delivery",
    authority: policy.authority
      ?? (effectful ? "reversible" : "automatic"),
    risk: policy.risk ?? (candidate.effect === "external" ? "medium" : "low"),
    steerable: candidate.route.kind === "model" && !effectful,
    source: candidate.source,
  });
}

export function taskExecutionContractForIntent(
  frame: TurnIntentFrame,
): TaskExecutionContract {
  return createTaskExecutionContract({
    objective: frame.objective,
    successMode: frame.successMode,
    authority: frame.authority,
    risk: frame.risk,
    maxAttempts: 1,
  });
}

function classifySpeechAct(utterance: string): IntentSpeechAct {
  const text = utterance.trim();
  if (TRAILING_CANCELLATION.test(text) || TRAILING_NEGATED_EXTERNAL_COMMAND.test(text)) {
    return "negation";
  }
  if (LEADING_NEGATION.test(text)) return "negation";
  if (REPORTED_SPEECH.test(text)) return "reported_speech";
  if (QUESTION.test(text) || QUESTION_LANGUAGE.test(text) || HYPOTHETICAL.test(text)) {
    return "question";
  }
  if (HISTORICAL_STATEMENT.test(text)) return "statement";
  if (isExplicitExternalCommand(text)) return "command";
  return "statement";
}

function isExplicitExternalCommand(utterance: string): boolean {
  const text = utterance.trim();
  return DIRECT_EXTERNAL_COMMAND.test(text) || OBJECT_EXTERNAL_COMMAND.test(text);
}

function normalizeObjective(value: string): string {
  const objective = value.replace(/\s+/gu, " ").trim().slice(0, 160);
  return objective || "完成本轮任务";
}

function freezeFrame(
  input: Omit<TurnIntentFrame, "schemaVersion">,
): TurnIntentFrame {
  const route = input.route.kind === "product_action"
    ? Object.freeze({
        kind: input.route.kind,
        value: Object.freeze({
          ...input.route.value,
          input: Object.freeze({ ...input.route.value.input }),
        }),
      })
    : Object.freeze({ ...input.route });
  return Object.freeze({
    schemaVersion: INTENT_FRAME_VERSION,
    ...input,
    route,
  });
}
