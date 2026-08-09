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
  | "finder_history_back";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
