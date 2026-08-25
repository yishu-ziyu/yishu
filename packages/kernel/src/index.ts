/** @yishu/kernel - product layer above Pi AgentRuntime. */

export const KERNEL_VERSION = "0.0.1" as const;

export * from "./action/index.js";
export * from "./context/index.js";
export * from "./store/index.js";
export * from "./actions/index.js";
export * from "./mind/index.js";
export * from "./task-truth.js";
export * from "./task-contract.js";
export * from "./intent-frame.js";
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
export { createConversationLedger } from "./conversation/ledger.js";
export type {
  ConversationArchiveFailureReason,
  ConversationArchiveResult,
  ConversationLedger,
  ConversationOpenFailureReason,
  ConversationOpenResult,
  VisibleConversation,
  VisibleConversationTurn,
} from "./conversation/ledger.js";
export { createContextWatchLedger } from "./context-watch/ledger.js";
export type {
  ContextWatchAdvance,
  ContextWatchCancellation,
  ContextWatchLedger,
  ContextWatchObservationInput,
} from "./context-watch/ledger.js";
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
  createMemoryLedger,
  recallFromVisibleFacts,
  recallRelevantMemories,
  visibleFactId,
  VISIBLE_MEMORY_FILE_NAME,
  VISIBLE_MEMORY_HEADER,
  VisibleMemoryFile,
  claimFromVisibleLine,
  defaultVisibleMemoryPath,
  factsSemanticallyMatch,
  hydrateVisibleMemoryIfNew,
  isVisibleFactSuppressed,
  mergeVisibleMemoryEdit,
  normalizeVisibleFact,
  parseVisibleFacts,
  readLegacyFactClaims,
  semanticSuppressionKeys,
  visibleFactFingerprint,
} from "./memory/index.js";
export type {
  MemoryLedger,
  RecalledMemory,
  RecallRelevantMemoriesOptions,
  VisibleMemoryAuthoritySnapshot,
} from "./memory/index.js";
export {
  GREETING_SKIP_PHRASES,
  assertMemoryPathWithinRoot,
  isGreetingUtterance,
  memoryScopeSlug,
  runExtractionPass,
  DEFAULT_EVEROS_IDENTITY,
  EVEROS_APP_ID,
  EVEROS_ASSISTANT_SENDER_ID,
  EVEROS_MIN_SEARCH_SCORE,
  EVEROS_PROFILE_ID_PREFIX,
  EVEROS_USER_ID,
  assertValidEverOSIdentity,
  everosProjectId,
  isEverOSProfileMemory,
  mapEverOSProfiles,
  memoryScopeFromEverOSProject,
  EverOSHttpClient,
  everosMessagesForTurn,
  mapEverOSSearchHits,
} from "./memory/index.js";
export type {
  ExtractionRunStats,
  ExtractionSnapshot,
  MemoryExtractionInput,
  MemoryExtractionModel,
  MemoryExtractionOutput,
  EverOSHttpClientOptions,
  EverOSAddInput,
  EverOSFlushInput,
  EverOSIdentity,
  EverOSMemoryMessage,
  EverOSMemoryPort,
  EverOSProfileInput,
  EverOSSearchInput,
} from "./memory/index.js";
