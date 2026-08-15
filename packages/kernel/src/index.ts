/** @yishu/kernel - product layer above Pi AgentRuntime. */

export const KERNEL_VERSION = "0.0.1" as const;

export * from "./action/index.js";
export * from "./context/index.js";
export * from "./store/index.js";
export * from "./actions/index.js";
export * from "./mind/index.js";
export * from "./task-truth.js";
export * from "./task-contract.js";
export * from "./session-scope.js";
export {
  createYishuKernel,
  createDefaultProductKernel,
} from "./kernel.js";
export type {
  CreateYishuKernelOptions,
  YishuKernel,
  YishuMemoryLayer,
  YishuStoreBackend,
} from "./kernel.js";
export {
  routeProductUtterance,
  formatProductActionSpeech,
  looksLikeRelativeTimeReminder,
  classifyRelativeTimeReminder,
  RELATIVE_TIME_REMINDER_CLARIFY_SPEECH,
} from "./utterance-router.js";
export type {
  ProductActionName,
  ProductUtteranceRoute,
  RelativeTimeReminderClass,
} from "./utterance-router.js";
export {
  MEMORY_RECALL_MAX_ITEMS,
  MEMORY_RECALL_MAX_CLAIM_CHARS,
  MEMORY_RECALL_MAX_TOTAL_CHARS,
  MEMORY_RECALL_SUMMARY_CHARS,
  contentTokens,
  recallRelevantMemories,
} from "./memory/index.js";
export type {
  RecalledMemory,
  RecallRelevantMemoriesOptions,
} from "./memory/index.js";
export {
  GREETING_SKIP_PHRASES,
  assertMemoryPathWithinRoot,
  isGreetingUtterance,
  memoryScopeSlug,
  runExtractionPass,
} from "./memory/index.js";
export type {
  ExtractionRunStats,
  ExtractionSnapshot,
  MemoryExtractionInput,
  MemoryExtractionModel,
  MemoryExtractionOutput,
} from "./memory/index.js";
