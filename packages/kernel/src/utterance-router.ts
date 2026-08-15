/**
 * Map short natural-language voice utterances to product actions.
 * Prefer high-precision patterns; fall through to Pi for conversation.
 */

export type ProductActionName =
  | "remember"
  | "forget"
  | "remember_how"
  | "share_context"
  | "record_learning"
  | "run_skill"
  | "watch_app_return"
  | "finder_history_back"
  | "create_note"
  | "schedule_time_reminder";

export interface ProductUtteranceRoute {
  action: ProductActionName;
  input: Record<string, unknown>;
  /** Confidence that this should short-circuit Pi. */
  confidence: number;
}

/**
 * Route a final ASR transcript to a product action, or null if Pi should handle it.
 */
export function routeProductUtterance(
  utterance: string,
  contextFrame?: unknown,
): ProductUtteranceRoute | null {
  const text = utterance.trim();
  if (text.length === 0) return null;
  const lower = text.toLowerCase();

  const timeReminder = parseRelativeTimeReminder(text);
  if (timeReminder) {
    return {
      action: "schedule_time_reminder",
      input: timeReminder,
      confidence: 0.99,
    };
  }

  const note = parseCreateNote(text);
  if (note) {
    return {
      action: "create_note",
      input: {
        content: note.content,
        title: note.title,
        targetBundleId: "com.apple.Notes",
      },
      confidence: 0.99,
    };
  }

  // This is deliberately narrow: only a direct back-button imperative while
  // Finder is the observed foreground app may bypass Pi. The product runtime
  // supplies the current frame; the macOS actuator will bind and revalidate
  // the exact window and AX control again immediately before AXPress.
  const finderTarget = finderFrontmostTarget(contextFrame);
  if (finderTarget && isDirectFinderBackUtterance(text)) {
    return {
      action: "finder_history_back",
      input: finderTarget,
      confidence: 0.99,
    };
  }

  // This is the only initiative phrase handled here: one explicit reminder
  // bound to leaving and then returning to the freshly observed application.
  // Questions, negations, vague reminders, and generic scheduling fall to Pi.
  const appReturnReminder = parseAppReturnReminder(text);
  const appReturnTarget = frontmostApplicationReference(contextFrame);
  if (appReturnReminder && appReturnTarget) {
    return {
      action: "watch_app_return",
      input: {
        reminder: appReturnReminder,
        targetBundleId: appReturnTarget.targetBundleId,
        sourceFrameId: appReturnTarget.sourceFrameId,
      },
      confidence: 0.99,
    };
  }

  // 1) Remember procedure / "记住我刚才怎么做的"
  if (
    /(记住|记下|保存).{0,12}(刚才|刚刚).{0,12}(怎么做|做法|流程|步骤)/.test(text) ||
    /(记住|记下).{0,8}(这个|刚才的)?(流程|步骤|做法)/.test(text) ||
    /remember\s+(how|what)\s+i\s+(just\s+)?did/i.test(text) ||
    /save\s+(this\s+)?(workflow|procedure|skill)/i.test(text)
  ) {
    const nameMatch = text.match(
      /叫(?:它|做)?[「"']?([A-Za-z0-9_\u4e00-\u9fff\- ]{2,40})[」"']?/,
    );
    const input: Record<string, unknown> = {
      minutes: 5,
      autoVerify: true,
      triggerPhrase: text.slice(0, 120),
    };
    if (nameMatch?.[1]) input.name = nameMatch[1].trim();
    return { action: "remember_how", input, confidence: 0.95 };
  }

  // 2) Hand off current context / "这个交给 Codex"
  if (
    /(交给|给|发给).{0,8}(codex|claude|cursor|cua)/i.test(text) ||
    /hand\s*(this|it)?\s*off/i.test(lower) ||
    /share\s+(this\s+)?context/i.test(lower) ||
    /把(现在|当前|这些?).{0,12}(交给|给)/.test(text)
  ) {
    // Prefer run_skill when user says a short skill-like command after learning.
    if (
      /^(这个|把这个)?\s*(交给|给)\s*(codex|claude)/i.test(text.trim()) ||
      /run\s+skill/i.test(lower)
    ) {
      return {
        action: "run_skill",
        input: {
          phrase: text.slice(0, 200),
          fallbackShareContext: true,
          userIntent: text,
        },
        confidence: 0.9,
      };
    }
    return {
      action: "share_context",
      input: {
        userIntent: text,
        recentMinutes: 5,
      },
      confidence: 0.9,
    };
  }

  // 3) Record learning / corrections
  if (
    /(以后|下次).{0,20}(不要|别|禁止)/.test(text) ||
    /不要再/.test(text) ||
    /记住规则/.test(text) ||
    /from\s+now\s+on/i.test(lower) ||
    /don'?t\s+ever/i.test(lower)
  ) {
    return {
      action: "record_learning",
      input: {
        rule: text,
        scope: "global",
        confidence: 0.95,
      },
      confidence: 0.85,
    };
  }

  // 4) Forget memory
  if (
    /^(忘掉|忘记|删掉记忆)/.test(text) ||
    /^forget\b/i.test(text)
  ) {
    // Needs id - cannot forget without id from voice alone.
    return null;
  }

  // 5) Remember a fact (must not steal remember_how)
  if (
    /^(记住|记下|记一下)[：:\s]/.test(text) ||
    /^remember\s+(that|this)\b/i.test(text) ||
    /请记住/.test(text)
  ) {
    const claim = text
      .replace(/^(记住|记下|记一下|请记住)[：:\s]*/u, "")
      .replace(/^remember\s+(that|this)\s*/i, "")
      .trim();
    if (claim.length < 2) return null;
    return {
      action: "remember",
      input: {
        claim,
        scope: "global",
        source: "conversation",
        confidence: 0.9,
      },
      confidence: 0.88,
    };
  }

  return null;
}

/** Spoken Chinese/English summary after a product action receipt. */
export function formatProductActionSpeech(
  action: ProductActionName,
  status: string,
  output: unknown,
): string {
  if (action === "schedule_time_reminder") {
    const result = output as {
      succeeded?: boolean;
      verified?: boolean;
      code?: string;
      clockLabel?: string;
    } | null;
    const when = validClockLabel(result?.clockLabel);
    if (result?.verified) {
      return when ? `已经设好提醒，大约 ${when}。` : "已经设好提醒。";
    }
    if (result?.code === "notification_permission_pending") {
      return "还没有设置，请允许后再说一次。";
    }
    if (result?.code === "notification_permission_denied") {
      return "系统提醒权限没有允许，所以这次没有设置。";
    }
    if (result?.succeeded) {
      return "提醒可能已经设好，但我没能确认；我不会重复设置。";
    }
    return "这次没有设置提醒。";
  }
  if (action === "create_note") {
    const result = output as { succeeded?: boolean; verified?: boolean } | null;
    if (result?.verified) return "已新建并确认一条备忘录。";
    if (result?.succeeded) {
      return "备忘录可能已经新建，但我没能读回来确认；我不会重复创建。";
    }
    return "这次没有新建备忘录。";
  }
  if (action === "finder_history_back") {
    const result = output as { succeeded?: boolean; verified?: boolean } | null;
    if (result?.verified) return "已经回到刚才的位置。";
    if (result?.succeeded) {
      return "已经按下返回，但没有确认到原窗口的结果；我不会重复点击。";
    }
    return "这次没有按下返回。";
  }
  if (status === "needs_approval") {
    return "这件事需要你明确批准，我先不动。";
  }
  if (status === "denied") {
    return "好的，我按你的拒绝停住了。";
  }
  if (status === "cancelled") {
    return "好的，我已经停下，没有继续执行。";
  }
  if (status === "cancelled_after_commit") {
    return "好的，我已经停下；刚才已经落地的结果保留，不再继续。";
  }
  if (status === "failed") {
    const msg =
      output && typeof output === "object" && "message" in output
        ? String((output as { message?: string }).message ?? "")
        : "";
    return msg
      ? `这次没做成：${msg}`
      : "这次产品动作没有完成。";
  }

  switch (action) {
    case "watch_app_return": {
      const result = output as {
        accepted?: boolean;
        watch?: { reminder?: string };
      } | null;
      return result?.accepted
        ? `好。你离开这个应用后，下次切回来我会提醒你：${result.watch?.reminder ?? "这件事"}`
        : "这次没有设好提醒。";
    }
    case "remember": {
      const claim =
        output && typeof output === "object" && "claim" in output
          ? String((output as { claim: string }).claim)
          : "这件事";
      return `好，我记住了：${claim}`;
    }
    case "remember_how": {
      const result = output as {
        skill?: { name?: string; steps?: unknown[] } | null;
        candidate?: { name?: string; steps?: unknown[] };
        entryCount?: number;
        verifyReport?: { verified?: boolean; confidence?: number };
      };
      const name = result.skill?.name ?? result.candidate?.name ?? "这个流程";
      const steps =
        result.skill?.steps?.length ?? result.candidate?.steps?.length ?? 0;
      if (result.skill) {
        return `已经把「${name}」验证成 Skill 了，共 ${steps} 步。下次你可以直接说触发语。`;
      }
      return `我从最近 ${result.entryCount ?? "几"} 条轨迹记下了「${name}」候选（${steps} 步）。trail 复验还不够稳，先放在候选里。`;
    }
    case "share_context": {
      const capsule =
        output && typeof output === "object" && "capsule" in output
          ? (output as { capsule: { capsuleId?: string; provenance?: { trailEntryCount?: number } } })
              .capsule
          : null;
      const n = capsule?.provenance?.trailEntryCount ?? 0;
      return `Context Capsule 已打好（含最近 ${n} 条轨迹），可以直接交给 Codex 或其它 Agent。`;
    }
    case "record_learning": {
      return "好，这条规则我会当作 Learning 记住，以后相关行为会收敛。";
    }
    case "run_skill": {
      const result = output as {
        mode?: string;
        skillName?: string;
        steps?: unknown[];
        capsuleReady?: boolean;
      };
      if (result.mode === "skill") {
        const n = result.steps?.length ?? 0;
        return result.capsuleReady
          ? `按 Skill「${result.skillName}」执行：${n} 步，Context Capsule 也准备好了。`
          : `找到 Skill「${result.skillName}」，共 ${n} 步，条件已对照当前上下文。`;
      }
      return "我还没有可用的验证 Skill，已先把当前上下文打成 Capsule。";
    }
    case "forget":
      return "好，那条记忆已经退休了。";
    default:
      return "好，处理好了。";
  }
}

export type RelativeTimeReminderClass =
  | { kind: "schedule"; delaySeconds: number; body: string }
  | { kind: "question" }
  | { kind: "incomplete" };

/** Spoken clarification when a reminder-shaped line must not reach Pi. */
export const RELATIVE_TIME_REMINDER_CLARIFY_SPEECH =
  "要设提醒的话，直接说时间，比如二十分钟后提醒我喝水。";

/**
 * One classifier for routing, barge-in, and delegate refusal.
 * Commands parse; questions/incomplete stay product-owned and never fall to Pi.
 */
export function classifyRelativeTimeReminder(text: string): RelativeTimeReminderClass | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const rest = stripReminderLeadIn(trimmed);
  if (!hasRelativeTimeReminderShape(trimmed) && !hasRelativeTimeReminderShape(rest)) {
    return null;
  }
  if (isRelativeTimeReminderQuestion(trimmed, rest)) return { kind: "question" };
  const parsed = parseRelativeTimeReminder(trimmed);
  return parsed ? { kind: "schedule", ...parsed } : { kind: "incomplete" };
}

/** True for spoken reminders, questions, and rewritten titles like “20分钟后提醒用户…”. */
export function looksLikeRelativeTimeReminder(text: string): boolean {
  return classifyRelativeTimeReminder(text) !== null;
}

function parseRelativeTimeReminder(
  text: string,
): { delaySeconds: number; body: string } | null {
  const rest = stripReminderLeadIn(text);
  if (isRelativeTimeReminderQuestion(text, rest)) return null;

  const parsed = parseTimeThenRemind(rest)
    ?? parseRemindThenTime(rest)
    ?? parseSetReminder(rest)
    ?? parseEnglishReminder(rest);
  if (!parsed) return null;
  const body = normalizeReminderBody(parsed.body);
  if (!isUsableReminderBody(body)) return null;
  return { delaySeconds: parsed.delaySeconds, body };
}

function parseTimeThenRemind(
  text: string,
): { delaySeconds: number; body: string } | null {
  const delay = matchSpokenDelayPrefix(text.replace(/^(?:再过|再)\s*/u, ""));
  if (!delay) return null;
  const after = delay.rest.replace(/^[，,]\s*/u, "");
  const verb = after.match(
    /^(?:请你?|帮我|麻烦|给我)?\s*(?:提醒(?:我一下|一下我|我|用户|你)|叫我(?:一声)?|喊我|帮我提醒)\s*/u,
  );
  if (!verb) return null;
  return { delaySeconds: delay.delaySeconds, body: after.slice(verb[0].length) };
}

function parseRemindThenTime(
  text: string,
): { delaySeconds: number; body: string } | null {
  const verb = text.match(
    /^(?:提醒(?:我一下|一下我|我|用户|你)|叫我(?:一声)?|喊我)\s*/u,
  );
  if (!verb) return null;
  const delay = matchSpokenDelayPrefix(text.slice(verb[0].length));
  if (!delay) return null;
  return { delaySeconds: delay.delaySeconds, body: delay.rest };
}

function parseSetReminder(
  text: string,
): { delaySeconds: number; body: string } | null {
  const setTimeBody = text.match(
    /^设(?:一个|个)?(?:在|过|再过)?\s*/u,
  );
  if (setTimeBody) {
    const afterSet = text.slice(setTimeBody[0].length);
    const delay = matchSpokenDelayPrefix(afterSet);
    if (delay) {
      const remainder = delay.rest.replace(/^的?提醒[，,：:\s]*/u, "");
      const remindVerb = remainder.match(
        /^(?:提醒(?:我一下|一下我|我|用户|你)|叫我(?:一声)?|喊我)\s*/u,
      );
      if (remindVerb) {
        return { delaySeconds: delay.delaySeconds, body: remainder.slice(remindVerb[0].length) };
      }
      const beforeReminder = remainder.match(/^(.*?)的提醒[。！!\s]*$/u);
      if (beforeReminder) {
        return { delaySeconds: delay.delaySeconds, body: beforeReminder[1] ?? "" };
      }
      return { delaySeconds: delay.delaySeconds, body: remainder };
    }
  }
  const setThenTime = text.match(/^设(?:一个|个)?提醒[，,：:\s]*/u);
  if (!setThenTime) return null;
  const delay = matchSpokenDelayPrefix(text.slice(setThenTime[0].length));
  if (!delay) return null;
  return { delaySeconds: delay.delaySeconds, body: delay.rest };
}

function parseEnglishReminder(
  text: string,
): { delaySeconds: number; body: string } | null {
  const remindFirst = text.match(
    /^remind\s+me\s+(?:to\s+)?/i,
  );
  if (remindFirst) {
    const delay = matchSpokenDelayPrefix(text.slice(remindFirst[0].length));
    if (!delay) return null;
    return {
      delaySeconds: delay.delaySeconds,
      body: delay.rest.replace(/^(?:to|that)\s+/i, ""),
    };
  }
  const delay = matchSpokenDelayPrefix(text);
  if (!delay) return null;
  const remind = delay.rest.match(/^remind\s+me\s+(?:to\s+)?/i);
  if (!remind) return null;
  return {
    delaySeconds: delay.delaySeconds,
    body: delay.rest.slice(remind[0].length).replace(/^(?:to|that)\s+/i, ""),
  };
}

function matchSpokenDelayPrefix(
  text: string,
): { delaySeconds: number; rest: string } | null {
  const trimmed = text.replace(/^(?:在|过|in)\s*/iu, "");
  const half = trimmed.match(/^半(?:个)?小时\s*(?:后|以后|之后)?\s*/u);
  if (half) return finishDelay(1_800, trimmed, half[0]);
  const oneHour = trimmed.match(/^(?:一|1)个?小时\s*(?:后|以后|之后)?\s*/u);
  if (oneHour) return finishDelay(3_600, trimmed, oneHour[0]);
  const twoHours = trimmed.match(/^(?:两|二|2)个?小时\s*(?:后|以后|之后)?\s*/u);
  if (twoHours) return finishDelay(7_200, trimmed, twoHours[0]);
  const numbered = trimmed.match(/^(\d{1,4})\s*(分钟|分|小时|时)\s*(?:后|以后|之后)?\s*/u);
  if (numbered) {
    const amount = Number(numbered[1]);
    const unit = numbered[2];
    if (unit === undefined) return null;
    const isMinutes = unit === "分钟" || unit === "分";
    if (!Number.isInteger(amount)
      || (isMinutes && (amount < 1 || amount > 1_440))
      || (!isMinutes && (amount < 1 || amount > 24))) {
      return null;
    }
    return finishDelay(amount * (isMinutes ? 60 : 3_600), trimmed, numbered[0]);
  }
  const english = trimmed.match(
    /^(\d{1,4})\s*(minutes?|mins?|hours?|hrs?)\s*(?:from now|later)?\s*/i,
  );
  if (!english) return null;
  const amount = Number(english[1]);
  const unit = english[2]?.toLowerCase();
  if (unit === undefined) return null;
  const isMinutes = unit.startsWith("min");
  if (!Number.isInteger(amount)
    || (isMinutes && (amount < 1 || amount > 1_440))
    || (!isMinutes && (amount < 1 || amount > 24))) {
    return null;
  }
  return finishDelay(amount * (isMinutes ? 60 : 3_600), trimmed, english[0]);
}

function finishDelay(
  delaySeconds: number,
  source: string,
  consumed: string,
): { delaySeconds: number; rest: string } | null {
  if (delaySeconds < 60 || delaySeconds > 86_400) return null;
  return { delaySeconds, rest: source.slice(consumed.length) };
}

function isRelativeTimeReminderQuestion(original: string, stripped: string): boolean {
  if (
    /(?:[？?]|好吗|行吗|可以吗|能吗|好不好|行不行|要不要|是不是)\s*[。！!]?\s*$/u.test(original)
    || /(?:吗|么|嘛|呢)\s*[。！!]?\s*$/u.test(original)
  ) {
    return true;
  }
  return /^(?:能不能|可不可以|是否|要不要|是不是|可以不可以|can you|could you|would you|will you)\b/iu
    .test(stripped);
}

function hasRelativeTimeReminderShape(text: string): boolean {
  return /(?:\d{1,4}\s*(?:分钟|分|小时|时)|半(?:个)?小时|(?:一|两|二|\d)个?小时|\d{1,4}\s*(?:minutes?|mins?|hours?|hrs?))/iu
      .test(text)
    && /(?:提醒(?:我|用户|你)?|叫我|喊我|remind\s+me)/iu.test(text);
}

function normalizeReminderBody(raw: string): string {
  return raw
    .replace(/[（(]\s*约\s*\d{2}:\d{2}\s*[）)]\s*$/u, "")
    .replace(/[。！!？?\s]+$/u, "")
    .replace(/(?:啊|呀|哦|哈|吧|谢谢)+$/u, "")
    .replace(/^(?:to|that)\s+/i, "")
    .trim();
}

function isUsableReminderBody(body: string): boolean {
  return body.length > 0
    && body.length <= 500
    && !/^(?:不要|别|不用|无需)/u.test(body)
    && !/^(?:一下|这件事|这个|那个|到时候|别忘了|提醒)$/u.test(body);
}

function stripReminderLeadIn(text: string): string {
  return text
    .replace(/^(?:奕枢[，,\s]*)+/u, "")
    .replace(/^(?:嗯|啊|那个|然后)[，,\s]*/u, "")
    .replace(/^(?:请你?|帮我|麻烦|给我)[，,\s]*/u, "")
    .replace(/^(?:请\s*)?/u, "")
    .trim();
}

function validClockLabel(value: unknown): string | null {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value) ? value : null;
}

function parseCreateNote(text: string): { content: string; title: string } | null {
  const quoted = extractPairedQuote(text);
  const directContent = quoted
    ? quoted.content
    : extractDirectSpokenNoteContent(text);
  if (directContent === null) return null;
  const shell = quoted
    ? `${text.slice(0, quoted.start)}Q${text.slice(quoted.end)}`.trim()
    : text.replace(directContent, "Q").trim();
  // Authorization comes only from the command around the quote. Words such
  // as “不要” or “删除” inside the requested note are content, not control.
  if (
    /[？?]\s*$/u.test(shell)
    || /(?:不要|别|不用|无需|别再|不要再)/u.test(shell)
    || /\b(?:do\s+not|don't|dont)\b/iu.test(shell)
    || /(?:编辑|修改|删除|追加|补充|覆盖|替换)/u.test(shell)
    || /\b(?:edit|update|delete|append|replace)\b/iu.test(shell)
  ) {
    return null;
  }
  const direct = [
    /^(?:奕枢[，,\s]*)?(?:(?:请|帮我|麻烦)\s*)?把\s*Q\s*写进(?:我的)?备忘录[。！!\s]*$/u,
    /^(?:奕枢[，,\s]*)?(?:(?:请|帮我|麻烦)\s*)?在(?:我的)?备忘录(?:里|中)?\s*记下\s*Q[。！!\s]*$/u,
    /^(?:奕枢[，,\s]*)?(?:(?:请|帮我|麻烦)\s*)?(?:新建|创建)(?:一条|一个)?备忘录[：:\s]*Q[。！!\s]*$/u,
  ].some((pattern) => pattern.test(shell));
  if (!direct) return null;

  const content = directContent.trim();
  if (content.length === 0 || content.length > 5_000) return null;
  if (/^(?:刚才(?:的)?(?:那|这)?一?段|上一段|前一段|那一?段|这一?段|这个|那个|它|其)$/u.test(content)) {
    return null;
  }
  const firstLine = content.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim();
  if (!firstLine) return null;
  const title = Array.from(firstLine).slice(0, 60).join("");
  return { content, title };
}

function extractDirectSpokenNoteContent(text: string): string | null {
  const patterns = [
    /^(?:奕枢[，,\s]*)?(?:(?:请|帮我|麻烦)\s*)?把\s*(.{1,5000}?)\s*写进(?:我的)?备忘录[。！!\s]*$/u,
    /^(?:奕枢[，,\s]*)?(?:(?:请|帮我|麻烦)\s*)?在(?:我的)?备忘录(?:里|中)?\s*记下\s*(.{1,5000}?)[。！!\s]*$/u,
    /^(?:奕枢[，,\s]*)?(?:(?:请|帮我|麻烦)\s*)?(?:新建|创建)(?:一条|一个)?备忘录[：:\s]+(.{1,5000}?)[。！!\s]*$/u,
  ];
  for (const pattern of patterns) {
    const content = text.match(pattern)?.[1]?.trim();
    if (content) return content;
  }
  return null;
}

function extractPairedQuote(
  text: string,
): { content: string; start: number; end: number } | null {
  const pairs = [["「", "」"], ["“", "”"], ["『", "』"], ['"', '"']] as const;
  for (const [open, close] of pairs) {
    const start = text.indexOf(open);
    if (start < 0) continue;
    const closeAt = text.indexOf(close, start + open.length);
    if (closeAt < 0) continue;
    if (text.indexOf(open, closeAt + close.length) >= 0) return null;
    return {
      content: text.slice(start + open.length, closeAt),
      start,
      end: closeAt + close.length,
    };
  }
  return null;
}

function parseAppReturnReminder(text: string): string | null {
  if (/[？?]\s*$/u.test(text) || /(?:吗|么|嘛)\s*[。！!.]?\s*$/u.test(text)) {
    return null;
  }
  const match = text.match(
    /^(?:请\s*)?(?:我\s*)?下次(?:再)?切回(?:到)?(?:这个|当前)应用(?:程序)?时[，,\s]*(?:请\s*)?提醒我[：:\s]*(.{1,200}?)[。！!]?$/u,
  );
  const reminder = match?.[1]?.trim();
  if (!reminder || reminder.length < 2) return null;
  if (/^(?:一下|这件事|这个|到时候|别忘了)$/u.test(reminder)) return null;
  return reminder;
}

function isDirectFinderBackUtterance(text: string): boolean {
  return /^(?:(?:请|帮我|麻烦)\s*)?(?:点击|点一下|点|按下|按|click|press)\s*(?:左上角(?:的)?\s*)?(?:返回|后退|back)(?:按钮|键)?[。！？!?]?$/iu.test(
    text,
  );
}

function finderFrontmostTarget(
  contextFrame: unknown,
): { targetBundleId: "com.apple.finder"; targetPid: number } | null {
  if (!isRecord(contextFrame)) return null;
  const frontmost = isRecord(contextFrame.frontmostApplication)
    ? contextFrame.frontmostApplication
    : null;
  const application = frontmost && isRecord(frontmost.value)
    ? frontmost.value
    : null;
  if (
    !application
    || application.bundleIdentifier !== "com.apple.finder"
    || !Number.isInteger(application.processIdentifier)
    || (application.processIdentifier as number) <= 0
  ) {
    return null;
  }
  return {
    targetBundleId: "com.apple.finder",
    targetPid: application.processIdentifier as number,
  };
}

function frontmostApplicationReference(
  contextFrame: unknown,
): { targetBundleId: string; sourceFrameId: string } | null {
  if (!isRecord(contextFrame) || typeof contextFrame.frameId !== "string") return null;
  const frontmost = isRecord(contextFrame.frontmostApplication)
    ? contextFrame.frontmostApplication
    : null;
  const application = frontmost && isRecord(frontmost.value)
    ? frontmost.value
    : null;
  if (
    !application
    || typeof application.bundleIdentifier !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/u.test(application.bundleIdentifier)
  ) {
    return null;
  }
  return {
    targetBundleId: application.bundleIdentifier,
    sourceFrameId: contextFrame.frameId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
