/**
 * Controlled recall of durable MemoryClaim rows for ordinary product turns.
 *
 * Boundaries for this surface:
 * - only the existing YishuStore MemoryClaim table (no second memory product)
 * - hard scope filter (personal / project:…); private has no memory scope
 * - retired rows never surface (store search already excludes them)
 * - sensitive claims are skipped, never injected
 * - at most MEMORY_RECALL_MAX_ITEMS related rows, with per-claim and total caps
 * - retrieval failure is the caller's job to degrade (this helper throws)
 */

import type { MemoryClaim } from "../store/types.js";
import type { YishuStorePort } from "../store/yishu-store.js";

export const MEMORY_RECALL_MAX_ITEMS = 3;
export const MEMORY_RECALL_MAX_CLAIM_CHARS = 200;
export const MEMORY_RECALL_MAX_TOTAL_CHARS = 480;
export const MEMORY_RECALL_SUMMARY_CHARS = 80;

/** Minimal content tokens ignored when scoring relatedness (CJK + EN). */
const STOP_TOKENS = new Set([
  "的",
  "了",
  "吗",
  "呢",
  "啊",
  "吧",
  "呀",
  "么",
  "着",
  "过",
  "和",
  "与",
  "或",
  "及",
  "在",
  "是",
  "有",
  "我",
  "你",
  "他",
  "她",
  "它",
  "们",
  "这",
  "那",
  "就",
  "都",
  "也",
  "还",
  "很",
  "更",
  "最",
  "不",
  "没",
  "请",
  "帮",
  "给",
  "把",
  "被",
  "让",
  "用",
  "对",
  "从",
  "到",
  "为",
  "会",
  "能",
  "要",
  "想",
  "说",
  "问",
  "一下",
  "什么",
  "怎么",
  "怎样",
  "如何",
  "为何",
  "为什么",
  "哪个",
  "哪些",
  "多少",
  "可以",
  "可否",
  "是否",
  "如果",
  "因为",
  "所以",
  "但是",
  "然后",
  "已经",
  "还是",
  "或者",
  "一个",
  "一些",
  "这个",
  "那个",
  "我们",
  "你们",
  "他们",
  "希望",
  "觉得",
  "知道",
  "告诉",
  "关于",
  "时候",
  "今天",
  "明天",
  "昨天",
  "现在",
  "以后",
  "之前",
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "to",
  "of",
  "in",
  "on",
  "for",
  "and",
  "or",
  "but",
  "with",
  "at",
  "by",
  "from",
  "as",
  "it",
  "this",
  "that",
  "these",
  "those",
  "i",
  "you",
  "he",
  "she",
  "we",
  "they",
  "me",
  "my",
  "your",
  "our",
  "do",
  "does",
  "did",
  "can",
  "could",
  "would",
  "should",
  "will",
  "what",
  "which",
  "who",
  "whom",
  "how",
  "why",
  "when",
  "where",
  "please",
  "help",
  "tell",
  "about",
]);

export type RecalledMemory = {
  id: string;
  /** Truncated claim text safe for controlled prompt injection. */
  claim: string;
  /** Shorter display summary for the product UI. */
  summary: string;
  source: MemoryClaim["source"];
  capturedAt: string;
  scope: string;
  confidence: number;
};

export type RecallRelevantMemoriesOptions = {
  /** Required durable memory namespace, e.g. "personal" or "project:<uuid>". */
  scope: string;
  limit?: number;
  maxClaimChars?: number;
  maxTotalChars?: number;
  summaryChars?: number;
};

/**
 * Find a small set of related, non-retired, non-sensitive memories in one scope.
 * Callers must pass a real scope; private sessions should not call this.
 */
export async function recallRelevantMemories(
  store: YishuStorePort,
  query: string,
  options: RecallRelevantMemoriesOptions,
): Promise<RecalledMemory[]> {
  const scope = options.scope.trim();
  if (!scope) return [];

  const limit = clampInt(
    options.limit ?? MEMORY_RECALL_MAX_ITEMS,
    1,
    MEMORY_RECALL_MAX_ITEMS,
  );
  const maxClaimChars = clampInt(
    options.maxClaimChars ?? MEMORY_RECALL_MAX_CLAIM_CHARS,
    32,
    MEMORY_RECALL_MAX_CLAIM_CHARS,
  );
  const maxTotalChars = clampInt(
    options.maxTotalChars ?? MEMORY_RECALL_MAX_TOTAL_CHARS,
    maxClaimChars,
    MEMORY_RECALL_MAX_TOTAL_CHARS,
  );
  const summaryChars = clampInt(
    options.summaryChars ?? MEMORY_RECALL_SUMMARY_CHARS,
    16,
    MEMORY_RECALL_SUMMARY_CHARS,
  );

  const queryTokens = contentTokens(query);
  if (queryTokens.length === 0) return [];

  // Empty store query returns every non-retired row in scope; we score locally.
  // Personal memory volume stays small; this avoids brittle keyword-only misses.
  const candidates = await store.searchMemory("", {
    scope,
    minConfidence: 0,
  });

  const scored = candidates
    .filter((m) => m.scope === scope)
    .filter((m) => m.retiredAt === undefined)
    .filter((m) => isSafeMemoryText(m.claim))
    .map((m) => ({
      memory: m,
      score: relatednessScore(queryTokens, contentTokens(m.claim), query, m.claim),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.memory.confidence !== a.memory.confidence) {
        return b.memory.confidence - a.memory.confidence;
      }
      return b.memory.lastConfirmedAt.localeCompare(a.memory.lastConfirmedAt);
    });

  const selected: RecalledMemory[] = [];
  let totalChars = 0;
  for (const row of scored) {
    if (selected.length >= limit) break;
    const claim = truncateChars(row.memory.claim.trim(), maxClaimChars);
    if (!claim) continue;
    if (totalChars + claim.length > maxTotalChars && selected.length > 0) break;
    if (totalChars + claim.length > maxTotalChars) {
      const room = maxTotalChars - totalChars;
      if (room < 16) break;
      const clipped = truncateChars(claim, room);
      selected.push(toRecalled(row.memory, clipped, summaryChars));
      break;
    }
    selected.push(toRecalled(row.memory, claim, summaryChars));
    totalChars += claim.length;
  }
  return selected;
}

function toRecalled(
  memory: MemoryClaim,
  claim: string,
  summaryChars: number,
): RecalledMemory {
  return {
    id: memory.id,
    claim,
    summary: truncateChars(claim, summaryChars),
    source: memory.source,
    capturedAt: memory.capturedAt,
    scope: memory.scope,
    confidence: memory.confidence,
  };
}

/**
 * Content tokens for CJK + latin. CJK runs become overlapping bigrams;
 * single CJK chars only survive when they are not stop tokens.
 */
export function contentTokens(text: string): string[] {
  const lower = text.toLowerCase();
  const out = new Set<string>();

  for (const word of lower.match(/[a-z0-9_]{2,}/g) ?? []) {
    if (!STOP_TOKENS.has(word)) out.add(word);
  }

  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      if (!STOP_TOKENS.has(run)) out.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (!STOP_TOKENS.has(bigram)) out.add(bigram);
    }
  }

  return [...out];
}

function relatednessScore(
  queryTokens: string[],
  claimTokens: string[],
  query: string,
  claim: string,
): number {
  if (queryTokens.length === 0 || claimTokens.length === 0) return 0;
  const querySet = new Set(queryTokens);
  const claimSet = new Set(claimTokens);
  let hits = 0;
  for (const token of querySet) {
    if (claimSet.has(token) || claim.toLowerCase().includes(token)) hits += 1;
  }
  // Bidirectional: a distinctive claim bigram present in the user question.
  for (const token of claimSet) {
    if (querySet.has(token) || query.toLowerCase().includes(token)) hits += 0.5;
  }
  return hits;
}

function isSafeMemoryText(value: string): boolean {
  if (!value || value.trim().length === 0) return false;
  // Mirror durable write guards so legacy or corrupted rows never reach the model.
  if (/(api[_-]?key|password|secret|token|bearer)\s*[:=]/i.test(value)) {
    return false;
  }
  if (/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(value)) return false;
  if (/data:image\//i.test(value)) return false;
  if (/sk-[A-Za-z0-9]{16,}/.test(value)) return false;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return false;
  return true;
}

function truncateChars(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
