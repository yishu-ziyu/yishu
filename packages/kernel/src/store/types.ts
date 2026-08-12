import type { SessionScope } from "../session-scope.js"
import type { SuggestionOutcomeStatus } from "../mind/document.js"
import type { TaskExecutionContract } from "../task-contract.js"

export type { SuggestionOutcomeStatus } from "../mind/document.js"


/**
 * Evidence-based resource types for Yishu product-owned store.
 * Claims carry source, capture time, confidence, and scope - not bare strings.
 */

export interface MemoryClaim {
  id: string
  claim: string
  source: "conversation" | "observation" | "user_correction" | "skill_verify" | "system"
  capturedAt: string
  /** e.g. "global" | "project:yishu" */
  scope: string
  /** 0-1 */
  confidence: number
  lastConfirmedAt: string
  supersedes: string | null
  tags: string[]
  retiredAt?: string
}

export interface Learning {
  id: string
  /** User correction of agent behavior */
  rule: string
  source: "user_correction"
  capturedAt: string
  scope: string
  confidence: number
  examples?: string[]
}

export interface SkillStep {
  id: string
  description: string
  kind: "resolve" | "observe" | "act" | "verify" | "other"
}

export interface SkillCandidate {
  id: string
  name: string
  triggerPhrase?: string
  steps: SkillStep[]
  conditions: Record<string, string>
  verification: string[]
  sourceTrailFrom: string
  sourceTrailTo: string
  status: "candidate"
  createdAt: string
}

export interface VerifiedSkill {
  id: string
  name: string
  triggerPhrase?: string
  steps: SkillStep[]
  conditions: Record<string, string>
  verification: string[]
  status: "verified"
  verifiedAt: string
  candidateId: string
  confidence: number
}

export interface Mandate {
  id: string
  /** Action name or "*" for all */
  actionName: string
  scope: string
  grantedAt: string
  expiresAt?: string
  note?: string
}

export interface TaskTruth {
  id: string
  title: string
  status: "pending" | "running" | "blocked" | "done" | "failed" | "cancelled"
  createdAt: string
  updatedAt: string
  evidence: string[]
  /** Scope is copied from the originating turn so task queries cannot cross projects. */
  sessionScope: SessionScope
  parentId?: string
  /** Owning Main conversation for delegated execution and restart recovery. */
  mainConversationId?: string
  /** Immutable product-owned execution/success boundary; absent on legacy rows. */
  contract?: TaskExecutionContract
}

/** Delivery metadata for one delegated child result; never a task status. */
export type DelegatedResultKind =
  | "succeeded"
  | "completed"
  | "unverified"
  | "failed"
  | "cancelled"

export type DelegatedTaskSequenceStepStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"

/** A visible step derived from a real child RuntimeEvent (never from a timer). */
export interface DelegatedTaskSequenceStep {
  id: string
  label: string
  status: DelegatedTaskSequenceStepStatus
  occurredAt: string
  sourceEventId: string
}

/**
 * Durable payload-only Result Inbox row.
 *
 * `claim*` is a delivery reservation for one Main turn. `delivery*` records
 * that the claiming turn durably completed. Neither field duplicates
 * TaskTruth status.
 */
export interface DelegatedResultRecord {
  taskId: string
  parentId: string
  mainConversationId: string
  resultKind: DelegatedResultKind
  summary: string
  completedAt: string
  sequence: DelegatedTaskSequenceStep[]
  claimTurnId?: string
  claimedAt?: string
  deliveryTurnId?: string
  deliveredAt?: string
}

export type DelegatedResultInput = Pick<
  DelegatedResultRecord,
  | "taskId"
  | "parentId"
  | "mainConversationId"
  | "resultKind"
  | "summary"
  | "completedAt"
> & {
  sequence?: DelegatedTaskSequenceStep[]
}

export interface DelegatedResultListOptions {
  mainConversationId?: string
  taskId?: string
  /** Defaults to true so task-history projections can restore delivered rows. */
  includeDelivered?: boolean
  /** Only rows currently reserved by a Main turn. */
  claimedOnly?: boolean
}

/**
 * Product-owned durable conversation ledger.
 *
 * The ledger deliberately models only visible conversation material and
 * typed execution signals.  It is not a transcript dump or a model trace.
 */
export type ConversationStatus = "active" | "completed" | "archived"

export interface Conversation {
  id: string
  createdAt: string
  updatedAt: string
  status: ConversationStatus
  sessionScope: SessionScope
  title?: string
}

export type ConversationTurnStatus =
  | "open"
  | "completed"
  | "cancelled"
  | "failed"

export interface ConversationTurn {
  id: string
  conversationId: string
  sequence: number
  createdAt: string
  updatedAt: string
  status: ConversationTurnStatus
  /** Immutable snapshot of the owning conversation scope. */
  sessionScope: SessionScope
  /** Runtime trace shared by all events emitted during this turn. */
  traceId?: string
  /** User-visible input only; hidden prompts and reasoning never belong here. */
  userInput?: string
  /** User-visible assistant output only; hidden reasoning never belongs here. */
  assistantOutput?: string
}

/**
 * Open-ended namespaced event vocabulary.  The string intersection keeps the
 * type extensible for newer runtimes while preserving editor suggestions for
 * the common product/runtime events.
 */
export type ConversationEventType =
  | "turn.started"
  | "turn.user_input"
  | "turn.assistant_output"
  | "turn.completed"
  | "turn.cancelled"
  | "turn.failed"
  | "tool.started"
  | "tool.completed"
  | "action.requested"
  | "action.completed"
  | "task.updated"
  | "memory.candidate"
  | "runtime.error"
  | (string & {})

export type SafeEventScalar = string | number | boolean | null
/** Event metadata is intentionally flat: small scalars only. */
export type SafeEventPayload = { [key: string]: SafeEventScalar }

export interface ConversationEvent {
  id: string
  conversationId: string
  turnId?: string
  sequence: number
  type: ConversationEventType
  occurredAt: string
  /** Sanitized, bounded, non-secret event metadata. */
  payload: SafeEventPayload
}

/** Serializable snapshot of the whole store (tests + disk). */
export interface YishuStoreSnapshot {
  memories: MemoryClaim[]
  learnings: Learning[]
  skillCandidates: SkillCandidate[]
  verifiedSkills: VerifiedSkill[]
  mandates: Mandate[]
  tasks: TaskTruth[]
  delegatedResults: DelegatedResultRecord[]
  conversations: Conversation[]
  turns: ConversationTurn[]
  events: ConversationEvent[]
  /** Empty markdown means still tracking the shipped seed. */
  mind: YishuMindState
  suggestions: SuggestionRecord[]
}


export type MemoryInput = Omit<MemoryClaim, "id">
export type LearningInput = Omit<Learning, "id" | "source"> & {
  source?: "user_correction"
}
export type SkillCandidateInput = Omit<SkillCandidate, "id" | "status" | "createdAt"> & {
  createdAt?: string
}
export type MandateInput = Omit<Mandate, "id" | "grantedAt"> & {
  grantedAt?: string
}
export type TaskInput = Omit<TaskTruth, "createdAt" | "updatedAt" | "sessionScope"> & {
  createdAt?: string
  updatedAt?: string
  sessionScope?: SessionScope
}

/** Optional cancellation contract for durable memory mutations. */
export interface StoreMutationOptions {
  signal?: AbortSignal
}

export type ConversationInput = Partial<
  Omit<Conversation, "id" | "createdAt" | "updatedAt" | "sessionScope">
> & {
  id?: string
  createdAt?: string
  updatedAt?: string
  sessionScope?: SessionScope
}

/** Options for listing durable conversations (history UI). */
export interface ConversationListOptions {
  /** When set, only conversations in this exact session scope. */
  sessionScope?: SessionScope
  /**
   * Max rows returned. Default 30, hard-capped at 50 so a personal history
   * panel cannot dump the whole ledger.
   */
  limit?: number
  /**
   * When true, include recoverable archived rows. The product history UI
   * never sets this — deleted conversations stay out of list/open paths.
   */
  includeArchived?: boolean
}

/**
 * Compact, user-visible history row. Never carries hidden reasoning,
 * screenshots, raw events, or secret material.
 */
export interface ConversationListItem {
  id: string
  createdAt: string
  updatedAt: string
  status: ConversationStatus
  sessionScope: SessionScope
  /** Short label for the list (from stored title or first user input). */
  title: string
  /** Bounded summary of the latest visible turn content. */
  summary: string
}

export const DEFAULT_CONVERSATION_LIST_LIMIT = 30
export const MAX_CONVERSATION_LIST_LIMIT = 50
export const CONVERSATION_LIST_TITLE_MAX = 40
export const CONVERSATION_LIST_SUMMARY_MAX = 120

export type ConversationTurnInput = Partial<
  Omit<ConversationTurn, "id" | "sequence" | "createdAt" | "updatedAt" | "conversationId" | "sessionScope">
> & {
  id?: string
  conversationId: string
  createdAt?: string
  updatedAt?: string
  sessionScope?: SessionScope
}

export type ConversationEventInput = Omit<
  ConversationEvent,
  "id" | "sequence" | "occurredAt"
> & {
  id?: string
  occurredAt?: string
}

export interface MemorySearchOptions {
  scope?: string
  minConfidence?: number
}

/**
 * Options for the product "我的" memory list.
 * Scope is required (memory namespace string, e.g. "personal").
 */
export interface MemoryListOptions {
  /** Exact durable memory namespace; never private. */
  scope: string
  /**
   * Max rows. Default and hard cap 50 so the personal panel cannot dump
   * the whole claim table.
   */
  limit?: number
}

/**
 * Compact, user-visible memory row for the product UI.
 * Never carries full claim dumps beyond the summary cap, screenshots,
 * tool params, hidden reasoning, or credentials.
 */
export interface MemoryListItem {
  id: string
  /** Bounded summary of the claim text. */
  summary: string
  capturedAt: string
  lastConfirmedAt: string
  source: MemoryClaim["source"]
  scope: string
}

/** Result of a controlled personal forget by exact id. */
export interface ForgetMemoryResult {
  id: string
  /** Always true on success (including stable re-forget). */
  forgotten: true
  /** True when the id was already absent from product storage. */
  alreadyGone: boolean
}

export const DEFAULT_MEMORY_LIST_LIMIT = 50
export const MAX_MEMORY_LIST_LIMIT = 50
export const MEMORY_LIST_SUMMARY_MAX = 80

export interface TaskSearchOptions {
  sessionScope?: SessionScope
}

export interface PromoteSkillOptions {
  confidence?: number
  verifierNote?: string
  signal?: AbortSignal
}

/**
 * Product-owned Yishu Mind document.
 * Empty markdown tracks the shipped seed until the first write forks it.
 */
export interface YishuMindState {
  markdown: string
  updatedAt: string | null
  /** ISO time of the last automatic learned-section write, if any. */
  lastLearnedAt?: string
}

export type SuggestionRecordStatus = SuggestionOutcomeStatus

/**
 * A product suggestion that enters durable history so later outcomes can
 * judge whether the advice worked.
 */
export interface SuggestionRecord {
  id: string
  createdAt: string
  updatedAt: string
  /** Short stable key used to count repeated outcomes. */
  patternKey: string
  /** One-line summary shown in history and learning evidence. */
  summary: string
  status: SuggestionRecordStatus
  conversationId?: string
  turnId?: string
  taskId?: string
  /** Optional free note about adoption or outcome. */
  note?: string
  /** When an outcome status was recorded. */
  outcomeAt?: string
}

export type SuggestionRecordInput = {
  id?: string
  createdAt?: string
  updatedAt?: string
  patternKey: string
  summary: string
  status?: SuggestionRecordStatus
  conversationId?: string
  turnId?: string
  taskId?: string
  note?: string
  outcomeAt?: string
}

export type SuggestionOutcomeInput = {
  suggestionId: string
  status: Exclude<SuggestionRecordStatus, "proposed">
  note?: string
  outcomeAt?: string
  taskId?: string
}

export type MindSectionWriteInput = {
  heading: string
  body: string
}

export type MindLearnFromPatternInput = {
  patternKey: string
  /** Optional lesson body; store synthesizes a default when omitted. */
  lesson?: string
  /** Override the repeated-outcome bar (tests). Default 2. */
  minEvidence?: number
  /** Force write even below the bar; requires explicit approval path. */
  force?: boolean
}

export interface MindLearnResult {
  wrote: boolean
  reason: string
  patternKey: string
  evidenceCount: number
  mind: YishuMindState
  lesson?: string
}
