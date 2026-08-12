import { promises as fs } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type {
  Conversation,
  ConversationEvent,
  ConversationEventInput,
  ConversationInput,
  ConversationListItem,
  ConversationListOptions,
  ConversationTurn,
  ConversationTurnInput,
  DelegatedResultInput,
  DelegatedResultListOptions,
  DelegatedResultRecord,
  DelegatedTaskSequenceStep,
  ForgetMemoryResult,
  Learning,
  LearningInput,
  Mandate,
  MandateInput,
  MemoryClaim,
  MemoryInput,
  MemoryListItem,
  MemoryListOptions,
  MemorySearchOptions,
  MindLearnFromPatternInput,
  MindLearnResult,
  MindSectionWriteInput,
  PromoteSkillOptions,
  SkillCandidate,
  SkillCandidateInput,
  StoreMutationOptions,
  SuggestionOutcomeInput,
  SuggestionRecord,
  SuggestionRecordInput,
  TaskInput,
  TaskSearchOptions,
  TaskTruth,
  VerifiedSkill,
  YishuMindState,
  YishuStoreSnapshot,
} from "./types.js"
import {
  CONVERSATION_LIST_SUMMARY_MAX,
  CONVERSATION_LIST_TITLE_MAX,
  DEFAULT_CONVERSATION_LIST_LIMIT,
  DEFAULT_MEMORY_LIST_LIMIT,
  MAX_CONVERSATION_LIST_LIMIT,
  MAX_MEMORY_LIST_LIMIT,
  MEMORY_LIST_SUMMARY_MAX,
} from "./types.js"
import {
  createTaskExecutionContract,
  type TaskExecutionContract,
} from "../task-contract.js"
import type { SessionScope } from "../session-scope.js"
import {
  assertDurableSessionScope,
  cloneSessionScope,
  normalizeSessionScope,
  sessionScopesEqual,
} from "../session-scope.js"
import {
  assertPersistableEventType,
  assertPersistableLearningFields,
  assertPersistableMemoryFields,
  assertPersistableSkillFields,
  cloneEventPayload,
  sanitizeEventPayload,
  sanitizeVisibleText,
  sameEventPayload,
  SENSITIVE_CONTENT_REJECTED,
} from "./ledger-safety.js"
import {
  applySuggestionOutcome,
  buildSuggestionRecord,
  cloneMindState,
  cloneSuggestion,
  emptyMindState,
  learnMindFromPattern,
  parseMindState,
  parseSuggestions,
  readMindState,
  restoreSeedMindState,
  writeMindSectionState,
} from "./mind-store.js"


function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Conversation ids are UUIDs on the product wire. Swift encodes them in
 * uppercase while some seed/tool writers use lowercase; treat them equal.
 */
function conversationIdsEqual(left: string, right: string): boolean {
  return left === right || left.toLowerCase() === right.toLowerCase()
}

function clampConversationListLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_CONVERSATION_LIST_LIMIT
  }
  return Math.max(1, Math.min(MAX_CONVERSATION_LIST_LIMIT, Math.floor(limit)))
}

function clampMemoryListLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_MEMORY_LIST_LIMIT
  }
  return Math.max(1, Math.min(MAX_MEMORY_LIST_LIMIT, Math.floor(limit)))
}

/**
 * Mirror durable write / recall guards so the product list never surfaces
 * credential-like or payload-like claim text.
 */
function isSafeMemoryListText(value: string): boolean {
  if (!value || value.trim().length === 0) return false
  if (/(api[_-]?key|password|secret|token|bearer)\s*[:=]/i.test(value)) {
    return false
  }
  if (/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(value)) return false
  if (/data:image\//i.test(value)) return false
  if (/sk-[A-Za-z0-9]{16,}/.test(value)) return false
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return false
  return true
}

function buildMemoryListItem(memory: MemoryClaim): MemoryListItem | null {
  if (memory.retiredAt !== undefined) return null
  if (!isSafeMemoryListText(memory.claim)) return null
  const summary = clipListText(memory.claim, MEMORY_LIST_SUMMARY_MAX)
  if (!summary) return null
  return {
    id: memory.id,
    summary,
    capturedAt: memory.capturedAt,
    lastConfirmedAt: memory.lastConfirmedAt,
    source: memory.source,
    scope: memory.scope,
  }
}

function memoryIdsEqual(left: string, right: string): boolean {
  return left === right || left.toLowerCase() === right.toLowerCase()
}

/** Compact list labels: collapse whitespace and hard-cap visible length. */
function clipListText(value: string, max: number): string {
  const cleaned = value.replace(/\s+/gu, " ").trim()
  if (cleaned.length === 0) return ""
  if (cleaned.length <= max) return cleaned
  if (max <= 1) return "…"
  return `${cleaned.slice(0, max - 1).trimEnd()}…`
}

function buildConversationListItem(
  conversation: Conversation,
  turns: ConversationTurn[],
): ConversationListItem {
  const ordered = [...turns].sort((a, b) => a.sequence - b.sequence)
  const latest = ordered.length > 0 ? ordered[ordered.length - 1] : undefined
  const firstUser = ordered.find((turn) => {
    const text = turn.userInput?.trim()
    return text !== undefined && text.length > 0
  })

  let titleSource = ""
  if (conversation.title !== undefined && conversation.title.trim().length > 0) {
    titleSource = sanitizeVisibleText(conversation.title, "conversation title")
  } else if (firstUser?.userInput) {
    titleSource = sanitizeVisibleText(firstUser.userInput, "conversation user input")
  }
  const title = clipListText(titleSource, CONVERSATION_LIST_TITLE_MAX) || "未命名对话"

  let summarySource = ""
  if (latest?.assistantOutput && latest.assistantOutput.trim().length > 0) {
    summarySource = sanitizeVisibleText(latest.assistantOutput, "conversation assistant output")
  } else if (latest?.userInput && latest.userInput.trim().length > 0) {
    summarySource = sanitizeVisibleText(latest.userInput, "conversation user input")
  }
  const summary = clipListText(summarySource, CONVERSATION_LIST_SUMMARY_MAX)

  return {
    id: conversation.id,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    status: conversation.status,
    sessionScope: cloneSessionScope(conversation.sessionScope),
    title,
    summary,
  }
}

export const STORE_OPERATION_CANCELLED = "store_operation_cancelled" as const

/** Stable, detail-free cancellation error for durable store mutations. */
export class StoreOperationCancelledError extends Error {
  readonly code = STORE_OPERATION_CANCELLED

  constructor() {
    super(STORE_OPERATION_CANCELLED)
    this.name = "StoreOperationCancelledError"
  }
}

export function assertStoreOperationNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new StoreOperationCancelledError()
}

function emptySnapshot(): YishuStoreSnapshot {
  return {
    memories: [],
    learnings: [],
    skillCandidates: [],
    verifiedSkills: [],
    mandates: [],
    tasks: [],
    delegatedResults: [],
    conversations: [],
    turns: [],
    events: [],
    mind: emptyMindState(),
    suggestions: [],
  }
}

function cloneSnapshot(data: YishuStoreSnapshot): YishuStoreSnapshot {
  return {
    memories: data.memories.map((m) => ({ ...m, tags: [...m.tags] })),
    learnings: data.learnings.map((l) => {
      const copy: Learning = {
        id: l.id,
        rule: l.rule,
        source: l.source,
        capturedAt: l.capturedAt,
        scope: l.scope,
        confidence: l.confidence,
      }
      if (l.examples !== undefined) {
        copy.examples = [...l.examples]
      }
      return copy
    }),
    skillCandidates: data.skillCandidates.map((s) => ({
      ...s,
      steps: s.steps.map((st) => ({ ...st })),
      conditions: { ...s.conditions },
      verification: [...s.verification],
    })),
    verifiedSkills: data.verifiedSkills.map((s) => ({
      ...s,
      steps: s.steps.map((st) => ({ ...st })),
      conditions: { ...s.conditions },
      verification: [...s.verification],
    })),
    mandates: data.mandates.map((m) => {
      const copy: Mandate = {
        id: m.id,
        actionName: m.actionName,
        scope: m.scope,
        grantedAt: m.grantedAt,
      }
      if (m.expiresAt !== undefined) copy.expiresAt = m.expiresAt
      if (m.note !== undefined) copy.note = m.note
      return copy
    }),
    tasks: data.tasks.map((t) => {
      const copy: TaskTruth = {
        id: t.id,
        title: t.title,
        status: t.status,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        evidence: [...t.evidence],
        sessionScope: cloneSessionScope(t.sessionScope),
      }
      if (t.parentId !== undefined) copy.parentId = t.parentId
      if (t.mainConversationId !== undefined) copy.mainConversationId = t.mainConversationId
      if (t.contract !== undefined) copy.contract = { ...t.contract }
      return copy
    }),
    delegatedResults: data.delegatedResults.map(cloneDelegatedResult),
    conversations: data.conversations.map((conversation) => ({
      ...conversation,
      sessionScope: cloneSessionScope(conversation.sessionScope),
    })),
    turns: data.turns.map((turn) => ({
      ...turn,
      sessionScope: cloneSessionScope(turn.sessionScope),
    })),
    events: data.events.map((event) => ({
      ...event,
      payload: cloneEventPayload(event.payload),
    })),
    mind: cloneMindState(data.mind ?? emptyMindState()),
    suggestions: (data.suggestions ?? []).map((s) => cloneSuggestion(s)),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseSnapshot(raw: unknown): YishuStoreSnapshot {
  if (!isRecord(raw)) return emptySnapshot()
  return {
    memories: parseMemories(raw.memories),
    learnings: parseLearnings(raw.learnings),
    skillCandidates: parseSkillCandidates(raw.skillCandidates),
    verifiedSkills: parseVerifiedSkills(raw.verifiedSkills),
    mandates: Array.isArray(raw.mandates) ? (raw.mandates as Mandate[]) : [],
    tasks: parseTasks(raw.tasks),
    delegatedResults: parseDelegatedResults(raw.delegatedResults),
    conversations: parseConversations(raw.conversations),
    turns: parseConversationTurns(raw.turns),
    events: parseConversationEvents(raw.events),
    mind: parseMindState(raw.mind),
    suggestions: parseSuggestions(raw.suggestions),
  }
}

function parseTasks(raw: unknown): TaskTruth[] {
  if (!Array.isArray(raw)) return []
  return raw.map((value) => {
    if (
      !isRecord(value)
      || typeof value.id !== "string"
      || typeof value.title !== "string"
      || typeof value.status !== "string"
      || typeof value.createdAt !== "string"
      || typeof value.updatedAt !== "string"
      || !Array.isArray(value.evidence)
      || value.evidence.some((item) => typeof item !== "string")
    ) {
      throw new Error("yishu-store: invalid task record")
    }
    const allowedStatuses = ["pending", "running", "blocked", "done", "failed", "cancelled"]
    if (!allowedStatuses.includes(value.status)) {
      throw new Error("yishu-store: invalid task status")
    }
    const task: TaskTruth = {
      id: value.id,
      title: value.title,
      status: value.status as TaskTruth["status"],
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      evidence: [...value.evidence] as string[],
      sessionScope: normalizeSessionScope(value.sessionScope),
    }
    assertDurableSessionScope(task.sessionScope)
    if (value.parentId !== undefined) {
      if (typeof value.parentId !== "string") throw new Error("yishu-store: invalid task parent id")
      task.parentId = value.parentId
    }
    if (value.mainConversationId !== undefined) {
      if (typeof value.mainConversationId !== "string" || value.mainConversationId.trim().length === 0) {
        throw new Error("yishu-store: invalid task main conversation id")
      }
      task.mainConversationId = value.mainConversationId
    }
    if (value.contract !== undefined) task.contract = normalizeTaskContract(value.contract, value.title)
    return task
  })
}

function normalizeTaskContract(raw: unknown, taskTitle: string): TaskExecutionContract {
  if (!isRecord(raw)) throw new Error("yishu-store: invalid task contract")
  if (
    typeof raw.objective !== "string"
    || (raw.successMode !== "read_only_delivery" && raw.successMode !== "external_effect")
    || !["automatic", "reversible", "standing_mandate", "explicit_approval"].includes(String(raw.authority))
    || !["low", "medium", "high", "critical"].includes(String(raw.risk))
    || typeof raw.maxAttempts !== "number"
  ) {
    throw new Error("yishu-store: invalid task contract")
  }
  try {
    return createTaskExecutionContract({
      // A durable objective is the bounded, sanitized TaskTruth title rather
      // than an unbounded copy of the original utterance.
      objective: sanitizeVisibleText(taskTitle, "task contract objective"),
      successMode: raw.successMode,
      authority: raw.authority as TaskExecutionContract["authority"],
      risk: raw.risk as TaskExecutionContract["risk"],
      maxAttempts: raw.maxAttempts,
    })
  } catch {
    throw new Error("yishu-store: invalid task contract")
  }
}

function sameTaskContract(
  left: TaskExecutionContract,
  right: TaskExecutionContract,
): boolean {
  return left.objective === right.objective
    && left.successMode === right.successMode
    && left.authority === right.authority
    && left.risk === right.risk
    && left.maxAttempts === right.maxAttempts
}

const DELEGATED_RESULT_KINDS = new Set([
  "succeeded",
  "completed",
  "unverified",
  "failed",
  "cancelled",
] as const)
const DELEGATED_STEP_STATUSES = new Set([
  "pending",
  "running",
  "passed",
  "failed",
] as const)
const MAX_DELEGATED_RESULT_SUMMARY = 500
const MAX_DELEGATED_SEQUENCE_STEPS = 64

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

function delegatedIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 160) {
    throw new Error(`yishu-store: invalid delegated result ${field}`)
  }
  return value
}

function normalizeDelegatedSequence(raw: unknown): DelegatedTaskSequenceStep[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_DELEGATED_SEQUENCE_STEPS) {
    throw new Error("yishu-store: invalid delegated result sequence")
  }
  return raw.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("yishu-store: invalid delegated result step")
    const id = delegatedIdentifier(candidate.id, "step id")
    const sourceEventId = delegatedIdentifier(candidate.sourceEventId, "source event id")
    if (
      typeof candidate.label !== "string"
      || candidate.label.trim().length === 0
      || candidate.label.length > 120
      || typeof candidate.status !== "string"
      || !DELEGATED_STEP_STATUSES.has(candidate.status as never)
      || !validIsoTimestamp(candidate.occurredAt)
    ) {
      throw new Error("yishu-store: invalid delegated result step")
    }
    return {
      id,
      label: sanitizeVisibleText(candidate.label, "delegated task step label"),
      status: candidate.status as DelegatedTaskSequenceStep["status"],
      occurredAt: candidate.occurredAt,
      sourceEventId,
    }
  })
}

function normalizeDelegatedResult(
  input: DelegatedResultInput | DelegatedResultRecord,
): DelegatedResultRecord {
  const taskId = delegatedIdentifier(input.taskId, "task id")
  const parentId = delegatedIdentifier(input.parentId, "parent id")
  const mainConversationId = delegatedIdentifier(input.mainConversationId, "conversation id")
  if (!DELEGATED_RESULT_KINDS.has(input.resultKind as never)) {
    throw new Error("yishu-store: invalid delegated result kind")
  }
  if (
    typeof input.summary !== "string"
    || input.summary.trim().length === 0
    || input.summary.length > MAX_DELEGATED_RESULT_SUMMARY
    || !validIsoTimestamp(input.completedAt)
  ) {
    throw new Error("yishu-store: invalid delegated result payload")
  }
  const record: DelegatedResultRecord = {
    taskId,
    parentId,
    mainConversationId,
    resultKind: input.resultKind,
    summary: sanitizeVisibleText(input.summary, "delegated result summary"),
    completedAt: input.completedAt,
    sequence: normalizeDelegatedSequence(input.sequence),
  }
  if ("claimTurnId" in input && input.claimTurnId !== undefined) {
    record.claimTurnId = delegatedIdentifier(input.claimTurnId, "claim turn id")
    if (!validIsoTimestamp(input.claimedAt)) {
      throw new Error("yishu-store: invalid delegated result claimed time")
    }
    record.claimedAt = input.claimedAt
  } else if ("claimedAt" in input && input.claimedAt !== undefined) {
    throw new Error("yishu-store: delegated result claim is incomplete")
  }
  if ("deliveryTurnId" in input && input.deliveryTurnId !== undefined) {
    record.deliveryTurnId = delegatedIdentifier(input.deliveryTurnId, "delivery turn id")
    if (!validIsoTimestamp(input.deliveredAt)) {
      throw new Error("yishu-store: invalid delegated result delivered time")
    }
    record.deliveredAt = input.deliveredAt
  } else if ("deliveredAt" in input && input.deliveredAt !== undefined) {
    throw new Error("yishu-store: delegated result delivery is incomplete")
  }
  return record
}

function cloneDelegatedResult(result: DelegatedResultRecord): DelegatedResultRecord {
  return {
    ...result,
    sequence: result.sequence.map((step) => ({ ...step })),
  }
}

function sameDelegatedResultPayload(
  left: DelegatedResultRecord,
  right: DelegatedResultRecord,
): boolean {
  return left.taskId === right.taskId
    && left.parentId === right.parentId
    && left.mainConversationId === right.mainConversationId
    && left.resultKind === right.resultKind
    && left.summary === right.summary
    && left.completedAt === right.completedAt
    && JSON.stringify(left.sequence) === JSON.stringify(right.sequence)
}

function parseDelegatedResults(raw: unknown): DelegatedResultRecord[] {
  if (!Array.isArray(raw)) return []
  return raw.map((value) => {
    if (!isRecord(value)) throw new Error("yishu-store: invalid delegated result record")
    return normalizeDelegatedResult(value as unknown as DelegatedResultRecord)
  })
}

function skillRecordError(): Error {
  return new Error(SENSITIVE_CONTENT_REJECTED)
}

function assertSkillKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = new Set(allowed)
  if (Object.keys(value).some((key) => !keys.has(key))) throw skillRecordError()
}

function parseSkillSteps(value: unknown): SkillCandidate["steps"] {
  if (!Array.isArray(value)) throw skillRecordError()
  return value.map((step) => {
    if (!isRecord(step)) throw skillRecordError()
    assertSkillKeys(step, ["id", "description", "kind"])
    if (
      typeof step.id !== "string" ||
      typeof step.description !== "string" ||
      typeof step.kind !== "string"
    ) {
      throw skillRecordError()
    }
    return {
      id: step.id,
      description: step.description,
      kind: step.kind as SkillCandidate["steps"][number]["kind"],
    }
  })
}

function parseSkillConditions(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw skillRecordError()
  const conditions: Record<string, string> = {}
  for (const [key, condition] of Object.entries(value)) {
    if (typeof condition !== "string") throw skillRecordError()
    conditions[key] = condition
  }
  return conditions
}

function parseSkillVerification(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw skillRecordError()
  }
  return [...value]
}

function parseSkillCandidates(raw: unknown): SkillCandidate[] {
  if (!Array.isArray(raw)) return []
  return raw.map((value) => {
    if (!isRecord(value)) throw skillRecordError()
    assertSkillKeys(value, [
      "id",
      "name",
      "triggerPhrase",
      "steps",
      "conditions",
      "verification",
      "sourceTrailFrom",
      "sourceTrailTo",
      "status",
      "createdAt",
    ])
    if (
      typeof value.id !== "string" ||
      typeof value.name !== "string" ||
      (value.triggerPhrase !== undefined && typeof value.triggerPhrase !== "string") ||
      typeof value.sourceTrailFrom !== "string" ||
      typeof value.sourceTrailTo !== "string" ||
      value.status !== "candidate" ||
      typeof value.createdAt !== "string"
    ) {
      throw skillRecordError()
    }
    const candidate: SkillCandidate = {
      id: value.id,
      name: value.name,
      steps: parseSkillSteps(value.steps),
      conditions: parseSkillConditions(value.conditions),
      verification: parseSkillVerification(value.verification),
      sourceTrailFrom: value.sourceTrailFrom,
      sourceTrailTo: value.sourceTrailTo,
      status: "candidate",
      createdAt: value.createdAt,
    }
    if (value.triggerPhrase !== undefined) candidate.triggerPhrase = value.triggerPhrase
    assertPersistableSkillFields(candidate)
    return candidate
  })
}

function parseVerifiedSkills(raw: unknown): VerifiedSkill[] {
  if (!Array.isArray(raw)) return []
  return raw.map((value) => {
    if (!isRecord(value)) throw skillRecordError()
    assertSkillKeys(value, [
      "id",
      "name",
      "triggerPhrase",
      "steps",
      "conditions",
      "verification",
      "status",
      "verifiedAt",
      "candidateId",
      "confidence",
    ])
    if (
      typeof value.id !== "string" ||
      typeof value.name !== "string" ||
      (value.triggerPhrase !== undefined && typeof value.triggerPhrase !== "string") ||
      value.status !== "verified" ||
      typeof value.verifiedAt !== "string" ||
      typeof value.candidateId !== "string" ||
      typeof value.confidence !== "number" ||
      !Number.isFinite(value.confidence)
    ) {
      throw skillRecordError()
    }
    const skill: VerifiedSkill = {
      id: value.id,
      name: value.name,
      steps: parseSkillSteps(value.steps),
      conditions: parseSkillConditions(value.conditions),
      verification: parseSkillVerification(value.verification),
      status: "verified",
      verifiedAt: value.verifiedAt,
      candidateId: value.candidateId,
      confidence: value.confidence,
    }
    if (value.triggerPhrase !== undefined) skill.triggerPhrase = value.triggerPhrase
    assertPersistableSkillFields(skill)
    return skill
  })
}

function parseMemories(raw: unknown): MemoryClaim[] {
  if (!Array.isArray(raw)) return []
  return raw.map((value) => {
    if (!isRecord(value)) {
      throw new Error("yishu-store: invalid memory record")
    }
    const memoryFields = {
      claim: value.claim,
      scope: value.scope,
      tags: value.tags,
    }
    assertPersistableMemoryFields(memoryFields)
    if (
      typeof value.id !== "string" ||
      typeof value.source !== "string" ||
      typeof value.capturedAt !== "string" ||
      typeof value.lastConfirmedAt !== "string" ||
      (value.supersedes !== null && value.supersedes !== undefined && typeof value.supersedes !== "string") ||
      (value.retiredAt !== undefined && typeof value.retiredAt !== "string")
    ) {
      throw new Error("yishu-store: invalid memory record")
    }
    const memory: MemoryClaim = {
      id: value.id,
      claim: memoryFields.claim,
      source: value.source as MemoryClaim["source"],
      capturedAt: value.capturedAt,
      scope: memoryFields.scope,
      confidence: Number(value.confidence),
      lastConfirmedAt: value.lastConfirmedAt,
      supersedes: value.supersedes === undefined ? null : value.supersedes as string | null,
      tags: [...memoryFields.tags],
    }
    if (value.retiredAt !== undefined) memory.retiredAt = value.retiredAt
    return memory
  })
}

function parseLearnings(raw: unknown): Learning[] {
  if (!Array.isArray(raw)) return []
  return raw.map((value) => {
    if (!isRecord(value)) {
      throw new Error("yishu-store: invalid learning record")
    }
    const learningFields = {
      rule: value.rule,
      scope: value.scope,
      examples: value.examples,
    }
    assertPersistableLearningFields(learningFields)
    if (
      typeof value.id !== "string" ||
      typeof value.source !== "string" ||
      typeof value.capturedAt !== "string"
    ) {
      throw new Error("yishu-store: invalid learning record")
    }
    const learning: Learning = {
      id: value.id,
      rule: learningFields.rule,
      source: value.source as Learning["source"],
      capturedAt: value.capturedAt,
      scope: learningFields.scope,
      confidence: Number(value.confidence),
    }
    if (learningFields.examples !== undefined) learning.examples = [...learningFields.examples]
    return learning
  })
}

function parseConversations(raw: unknown): Conversation[] {
  if (!Array.isArray(raw)) return []
  return raw.map((value) => {
    if (!isRecord(value) || typeof value.id !== "string") {
      throw new Error("yishu-store: invalid conversation record")
    }
    const status = value.status
    if (status !== "active" && status !== "completed" && status !== "archived") {
      throw new Error("yishu-store: invalid conversation status")
    }
    if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
      throw new Error("yishu-store: conversation timestamps are required")
    }
    const conversation: Conversation = {
      id: value.id,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      status,
      sessionScope: normalizeSessionScope(value.sessionScope),
    }
    assertDurableSessionScope(conversation.sessionScope)
    if (value.title !== undefined) {
      if (typeof value.title !== "string") throw new Error("yishu-store: invalid conversation title")
      conversation.title = sanitizeVisibleText(value.title, "conversation title")
    }
    return conversation
  })
}

function parseConversationTurns(raw: unknown): ConversationTurn[] {
  if (!Array.isArray(raw)) return []
  return raw.map((value) => {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.conversationId !== "string") {
      throw new Error("yishu-store: invalid conversation turn record")
    }
    const status = value.status
    if (status !== "open" && status !== "completed" && status !== "cancelled" && status !== "failed") {
      throw new Error("yishu-store: invalid conversation turn status")
    }
    if (typeof value.sequence !== "number" || !Number.isInteger(value.sequence) || value.sequence < 0) {
      throw new Error("yishu-store: invalid conversation turn sequence")
    }
    if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
      throw new Error("yishu-store: conversation turn timestamps are required")
    }
    const turn: ConversationTurn = {
      id: value.id,
      conversationId: value.conversationId,
      sequence: value.sequence,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      status,
      sessionScope: normalizeSessionScope(value.sessionScope),
    }
    assertDurableSessionScope(turn.sessionScope)
    if (value.traceId !== undefined) {
      if (typeof value.traceId !== "string") throw new Error("yishu-store: invalid conversation turn trace id")
      turn.traceId = value.traceId
    }
    if (value.userInput !== undefined) {
      if (typeof value.userInput !== "string") throw new Error("yishu-store: invalid user input")
      turn.userInput = sanitizeVisibleText(value.userInput, "conversation user input")
    }
    if (value.assistantOutput !== undefined) {
      if (typeof value.assistantOutput !== "string") throw new Error("yishu-store: invalid assistant output")
      turn.assistantOutput = sanitizeVisibleText(value.assistantOutput, "conversation assistant output")
    }
    return turn
  })
}

function parseConversationEvents(raw: unknown): ConversationEvent[] {
  if (!Array.isArray(raw)) return []
  return raw.map((value) => {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.conversationId !== "string") {
      throw new Error("yishu-store: invalid conversation event record")
    }
    if (typeof value.sequence !== "number" || !Number.isInteger(value.sequence) || value.sequence < 0) {
      throw new Error("yishu-store: invalid conversation event sequence")
    }
    if (typeof value.type !== "string" || value.type.length === 0) {
      throw new Error("yishu-store: conversation event type is required")
    }
    assertPersistableEventType(value.type)
    if (typeof value.occurredAt !== "string") {
      throw new Error("yishu-store: conversation event timestamp is required")
    }
    const event: ConversationEvent = {
      id: value.id,
      conversationId: value.conversationId,
      sequence: value.sequence,
      type: value.type,
      occurredAt: value.occurredAt,
      payload: sanitizeEventPayload(value.payload),
    }
    if (value.turnId !== undefined) {
      if (typeof value.turnId !== "string") throw new Error("yishu-store: invalid conversation event turn id")
      event.turnId = value.turnId
    }
    return event
  })
}

function tokensOf(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，、]+/)
    .filter(Boolean)
}

function memoryMatches(claim: MemoryClaim, tokens: string[]): boolean {
  if (tokens.length === 0) return true
  const hay = `${claim.claim} ${claim.scope} ${claim.tags.join(" ")} ${claim.source}`.toLowerCase()
  return tokens.some((t) => hay.includes(t))
}

/**
 * Shared port so file-backed and pure in-memory stores share one surface.
 */
export interface YishuStorePort {
  load(): Promise<void>
  save(): Promise<void>
  addMemory(input: MemoryInput, options?: StoreMutationOptions): Promise<MemoryClaim>
  searchMemory(query: string, options?: MemorySearchOptions): Promise<MemoryClaim[]>
  retireMemory(id: string, options?: StoreMutationOptions): Promise<boolean>
  /**
   * Compact product UI list for one exact memory namespace.
   * Retired / sensitive / empty claims are omitted. Newest captured first.
   */
  listMemories(options: MemoryListOptions): Promise<MemoryListItem[]>
  /**
   * User-confirmed forget by exact id + expected scope.
   * Hard-removes the claim body from product storage (no soft-retire body left).
   * Scope mismatch returns null. Missing id is a stable success (alreadyGone).
   */
  forgetMemory(
    id: string,
    options: { expectedScope: string },
  ): Promise<ForgetMemoryResult | null>
  addLearning(input: LearningInput, options?: StoreMutationOptions): Promise<Learning>
  listLearnings(): Promise<Learning[]>
  addSkillCandidate(
    input: SkillCandidateInput,
    options?: StoreMutationOptions,
  ): Promise<SkillCandidate>
  listSkillCandidates(): Promise<SkillCandidate[]>
  promoteSkill(
    candidateId: string,
    opts?: PromoteSkillOptions,
  ): Promise<VerifiedSkill | null>
  listVerifiedSkills(): Promise<VerifiedSkill[]>
  getSkillByName(
    name: string,
  ): Promise<VerifiedSkill | SkillCandidate | null>
  grantMandate(input: MandateInput): Promise<Mandate>
  listMandates(): Promise<Mandate[]>
  hasMandate(actionName: string, now?: string | Date): Promise<boolean>
  revokeMandate(id: string): Promise<boolean>
  upsertTask(input: TaskInput): Promise<TaskTruth>
  listTasks(options?: TaskSearchOptions): Promise<TaskTruth[]>
  putDelegatedResult(input: DelegatedResultInput): Promise<DelegatedResultRecord>
  /** Atomically persist the canonical TaskTruth transition and its result payload. */
  upsertTaskWithDelegatedResult(
    task: TaskInput,
    result: DelegatedResultInput,
  ): Promise<{ task: TaskTruth; result: DelegatedResultRecord }>
  listDelegatedResults(options?: DelegatedResultListOptions): Promise<DelegatedResultRecord[]>
  /** Atomically reserve every pending result in one conversation for one Main turn. */
  claimDelegatedResults(
    mainConversationId: string,
    claimTurnId: string,
    claimedAt?: string,
  ): Promise<DelegatedResultRecord[]>
  /** Mark rows reserved by this completed Main turn as delivered. */
  ackDelegatedResults(claimTurnId: string, deliveredAt?: string): Promise<number>
  /** Return rows reserved by a failed/cancelled Main turn to the pending inbox. */
  releaseDelegatedResults(claimTurnId: string): Promise<number>
  upsertConversation(input: ConversationInput): Promise<Conversation>
  upsertConversationTurn(input: ConversationTurnInput): Promise<ConversationTurn>
  appendConversationEvent(input: ConversationEventInput): Promise<ConversationEvent>
  getConversation(id: string): Promise<Conversation | null>
  getConversationTurn(id: string): Promise<ConversationTurn | null>
  listConversationTurns(conversationId: string): Promise<ConversationTurn[]>
  listConversationEvents(conversationId: string): Promise<ConversationEvent[]>
  /**
   * Read-only history rows for the product UI.
   * Private scope never persists and always returns [].
   * Archived (user-deleted, recoverable) rows are excluded unless
   * `includeArchived` is set for recovery tooling.
   */
  listConversations(options?: ConversationListOptions): Promise<ConversationListItem[]>
  /**
   * Soft-delete a durable conversation by marking it archived.
   * Body and turns remain on disk for recoverability; list/open hide it.
   * Idempotent: already-archived returns the existing row.
   */
  archiveConversation(
    id: string,
    options?: { expectedScope?: SessionScope },
  ): Promise<Conversation | null>
  getMind(): Promise<YishuMindState>
  writeMindSection(
    input: MindSectionWriteInput,
    options?: StoreMutationOptions,
  ): Promise<YishuMindState>
  restoreSeedMind(options?: StoreMutationOptions): Promise<YishuMindState>
  addSuggestion(
    input: SuggestionRecordInput,
    options?: StoreMutationOptions,
  ): Promise<SuggestionRecord>
  recordSuggestionOutcome(
    input: SuggestionOutcomeInput,
    options?: StoreMutationOptions,
  ): Promise<SuggestionRecord>
  listSuggestions(): Promise<SuggestionRecord[]>
  getSuggestion(id: string): Promise<SuggestionRecord | null>
  learnMindFromPattern(
    input: MindLearnFromPatternInput,
    options?: StoreMutationOptions,
  ): Promise<MindLearnResult>
  getSnapshot(): YishuStoreSnapshot
}

/**
 * Core mutation logic shared by disk and memory backends.
 */
class YishuStoreCore {
  protected data: YishuStoreSnapshot = emptySnapshot()
  protected loaded = false

  getSnapshot(): YishuStoreSnapshot {
    return cloneSnapshot(this.data)
  }

  protected ensureData(): void {
    if (!this.loaded) {
      this.data = emptySnapshot()
      this.loaded = true
    }
  }

  addMemorySync(input: MemoryInput, signal?: AbortSignal): MemoryClaim {
    assertStoreOperationNotAborted(signal)
    assertPersistableMemoryFields(input)
    assertStoreOperationNotAborted(signal)
    this.ensureData()
    const claim: MemoryClaim = {
      id: randomUUID(),
      claim: input.claim,
      source: input.source,
      capturedAt: input.capturedAt,
      scope: input.scope,
      confidence: input.confidence,
      lastConfirmedAt: input.lastConfirmedAt,
      supersedes: input.supersedes,
      tags: [...input.tags],
    }
    if (input.retiredAt !== undefined) {
      claim.retiredAt = input.retiredAt
    }
    assertStoreOperationNotAborted(signal)
    this.data.memories.push(claim)
    return claim
  }

  searchMemorySync(query: string, options?: MemorySearchOptions): MemoryClaim[] {
    this.ensureData()
    const tokens = tokensOf(query)
    const minConfidence = options?.minConfidence
    const scope = options?.scope

    return this.data.memories
      .filter((m) => m.retiredAt === undefined)
      .filter((m) => (scope === undefined ? true : m.scope === scope))
      .filter((m) =>
        minConfidence === undefined ? true : m.confidence >= minConfidence,
      )
      .filter((m) => memoryMatches(m, tokens))
      .sort((a, b) => {
        const conf = b.confidence - a.confidence
        if (conf !== 0) return conf
        return b.lastConfirmedAt.localeCompare(a.lastConfirmedAt)
      })
      .map((m) => {
        const copy: MemoryClaim = {
          id: m.id,
          claim: m.claim,
          source: m.source,
          capturedAt: m.capturedAt,
          scope: m.scope,
          confidence: m.confidence,
          lastConfirmedAt: m.lastConfirmedAt,
          supersedes: m.supersedes,
          tags: [...m.tags],
        }
        if (m.retiredAt !== undefined) copy.retiredAt = m.retiredAt
        return copy
      })
  }

  retireMemorySync(id: string, signal?: AbortSignal): boolean {
    assertStoreOperationNotAborted(signal)
    this.ensureData()
    const target = this.data.memories.find((m) => m.id === id)
    if (!target) return false
    if (target.retiredAt === undefined) {
      assertStoreOperationNotAborted(signal)
      target.retiredAt = nowIso()
    }
    return true
  }

  listMemoriesSync(options: MemoryListOptions): MemoryListItem[] {
    this.ensureData()
    const scope = options.scope.trim()
    if (!scope) return []
    const limit = clampMemoryListLimit(options.limit)
    return this.data.memories
      .filter((m) => m.scope === scope)
      .filter((m) => m.retiredAt === undefined)
      .sort((a, b) => {
        const byCaptured = b.capturedAt.localeCompare(a.capturedAt)
        if (byCaptured !== 0) return byCaptured
        return b.id.localeCompare(a.id)
      })
      .map((m) => buildMemoryListItem(m))
      .filter((item): item is MemoryListItem => item !== null)
      .slice(0, limit)
  }

  /**
   * Hard-delete one memory claim after exact scope match.
   * Returns null on scope mismatch (caller fails closed).
   * Missing id → stable alreadyGone success (repeat forget is fine).
   */
  forgetMemorySync(
    id: string,
    options: { expectedScope: string },
  ): ForgetMemoryResult | null {
    this.ensureData()
    const expectedScope = options.expectedScope.trim()
    if (!expectedScope) return null
    const index = this.data.memories.findIndex((m) => memoryIdsEqual(m.id, id))
    if (index < 0) {
      return { id, forgotten: true, alreadyGone: true }
    }
    const target = this.data.memories[index]!
    if (target.scope !== expectedScope) {
      return null
    }
    this.data.memories.splice(index, 1)
    return { id: target.id, forgotten: true, alreadyGone: false }
  }

  addLearningSync(input: LearningInput, signal?: AbortSignal): Learning {
    assertStoreOperationNotAborted(signal)
    assertPersistableLearningFields(input)
    assertStoreOperationNotAborted(signal)
    this.ensureData()
    const learning: Learning = {
      id: randomUUID(),
      rule: input.rule,
      source: "user_correction",
      capturedAt: input.capturedAt ?? nowIso(),
      scope: input.scope,
      confidence: input.confidence,
    }
    if (input.examples !== undefined) {
      learning.examples = [...input.examples]
    }
    assertStoreOperationNotAborted(signal)
    this.data.learnings.push(learning)
    return learning
  }

  listLearningsSync(): Learning[] {
    this.ensureData()
    return this.data.learnings.map((l) => {
      const copy: Learning = {
        id: l.id,
        rule: l.rule,
        source: l.source,
        capturedAt: l.capturedAt,
        scope: l.scope,
        confidence: l.confidence,
      }
      if (l.examples !== undefined) copy.examples = [...l.examples]
      return copy
    })
  }

  addSkillCandidateSync(
    input: SkillCandidateInput,
    signal?: AbortSignal,
  ): SkillCandidate {
    assertStoreOperationNotAborted(signal)
    this.ensureData()
    const candidate: SkillCandidate = {
      id: randomUUID(),
      name: input.name,
      steps: input.steps.map((s) => ({ ...s })),
      conditions: { ...input.conditions },
      verification: [...input.verification],
      sourceTrailFrom: input.sourceTrailFrom,
      sourceTrailTo: input.sourceTrailTo,
      status: "candidate",
      createdAt: input.createdAt ?? nowIso(),
    }
    if (input.triggerPhrase !== undefined) {
      candidate.triggerPhrase = input.triggerPhrase
    }
    assertPersistableSkillFields(candidate)
    assertStoreOperationNotAborted(signal)
    this.data.skillCandidates.push(candidate)
    return candidate
  }

  listSkillCandidatesSync(): SkillCandidate[] {
    this.ensureData()
    return this.data.skillCandidates.map((s) => {
      const copy: SkillCandidate = {
        id: s.id,
        name: s.name,
        steps: s.steps.map((st) => ({ ...st })),
        conditions: { ...s.conditions },
        verification: [...s.verification],
        sourceTrailFrom: s.sourceTrailFrom,
        sourceTrailTo: s.sourceTrailTo,
        status: s.status,
        createdAt: s.createdAt,
      }
      if (s.triggerPhrase !== undefined) copy.triggerPhrase = s.triggerPhrase
      return copy
    })
  }

  promoteSkillSync(
    candidateId: string,
    opts?: PromoteSkillOptions,
  ): VerifiedSkill | null {
    assertStoreOperationNotAborted(opts?.signal)
    this.ensureData()
    const idx = this.data.skillCandidates.findIndex((c) => c.id === candidateId)
    if (idx < 0) return null
    const candidate = this.data.skillCandidates[idx]
    if (!candidate) return null
    assertPersistableSkillFields(candidate)

    const verified: VerifiedSkill = {
      id: randomUUID(),
      name: candidate.name,
      steps: candidate.steps.map((st) => ({ ...st })),
      conditions: { ...candidate.conditions },
      verification:
        opts?.verifierNote !== undefined
          ? [...candidate.verification, opts.verifierNote]
          : [...candidate.verification],
      status: "verified",
      verifiedAt: nowIso(),
      candidateId: candidate.id,
      confidence: opts?.confidence ?? 0.8,
    }
    if (candidate.triggerPhrase !== undefined) {
      verified.triggerPhrase = candidate.triggerPhrase
    }

    assertPersistableSkillFields(verified)

    assertStoreOperationNotAborted(opts?.signal)
    this.data.skillCandidates.splice(idx, 1)
    this.data.verifiedSkills.push(verified)
    return verified
  }

  listVerifiedSkillsSync(): VerifiedSkill[] {
    this.ensureData()
    return this.data.verifiedSkills.map((s) => {
      const copy: VerifiedSkill = {
        id: s.id,
        name: s.name,
        steps: s.steps.map((st) => ({ ...st })),
        conditions: { ...s.conditions },
        verification: [...s.verification],
        status: s.status,
        verifiedAt: s.verifiedAt,
        candidateId: s.candidateId,
        confidence: s.confidence,
      }
      if (s.triggerPhrase !== undefined) copy.triggerPhrase = s.triggerPhrase
      return copy
    })
  }

  getSkillByNameSync(name: string): VerifiedSkill | SkillCandidate | null {
    this.ensureData()
    const verified = this.data.verifiedSkills.find((s) => s.name === name)
    if (verified) {
      const copy: VerifiedSkill = {
        id: verified.id,
        name: verified.name,
        steps: verified.steps.map((st) => ({ ...st })),
        conditions: { ...verified.conditions },
        verification: [...verified.verification],
        status: verified.status,
        verifiedAt: verified.verifiedAt,
        candidateId: verified.candidateId,
        confidence: verified.confidence,
      }
      if (verified.triggerPhrase !== undefined) {
        copy.triggerPhrase = verified.triggerPhrase
      }
      return copy
    }
    const candidate = this.data.skillCandidates.find((s) => s.name === name)
    if (candidate) {
      const copy: SkillCandidate = {
        id: candidate.id,
        name: candidate.name,
        steps: candidate.steps.map((st) => ({ ...st })),
        conditions: { ...candidate.conditions },
        verification: [...candidate.verification],
        sourceTrailFrom: candidate.sourceTrailFrom,
        sourceTrailTo: candidate.sourceTrailTo,
        status: candidate.status,
        createdAt: candidate.createdAt,
      }
      if (candidate.triggerPhrase !== undefined) {
        copy.triggerPhrase = candidate.triggerPhrase
      }
      return copy
    }
    return null
  }

  grantMandateSync(input: MandateInput): Mandate {
    this.ensureData()
    const mandate: Mandate = {
      id: randomUUID(),
      actionName: input.actionName,
      scope: input.scope,
      grantedAt: input.grantedAt ?? nowIso(),
    }
    if (input.expiresAt !== undefined) mandate.expiresAt = input.expiresAt
    if (input.note !== undefined) mandate.note = input.note
    this.data.mandates.push(mandate)
    return mandate
  }

  listMandatesSync(): Mandate[] {
    this.ensureData()
    return this.data.mandates.map((m) => {
      const copy: Mandate = {
        id: m.id,
        actionName: m.actionName,
        scope: m.scope,
        grantedAt: m.grantedAt,
      }
      if (m.expiresAt !== undefined) copy.expiresAt = m.expiresAt
      if (m.note !== undefined) copy.note = m.note
      return copy
    })
  }

  hasMandateSync(actionName: string, now?: string | Date): boolean {
    this.ensureData()
    const instant =
      now === undefined
        ? Date.now()
        : typeof now === "string"
          ? Date.parse(now)
          : now.getTime()

    return this.data.mandates.some((m) => {
      if (m.actionName !== actionName && m.actionName !== "*") return false
      if (m.expiresAt === undefined) return true
      const exp = Date.parse(m.expiresAt)
      if (Number.isNaN(exp)) return true
      return exp > instant
    })
  }

  revokeMandateSync(id: string): boolean {
    this.ensureData()
    const before = this.data.mandates.length
    this.data.mandates = this.data.mandates.filter((m) => m.id !== id)
    return this.data.mandates.length < before
  }

  upsertTaskSync(input: TaskInput): TaskTruth {
    this.ensureData()
    const existing = this.data.tasks.find((t) => t.id === input.id)
    const stamp = nowIso()
    const sessionScope = input.sessionScope === undefined && existing
      ? cloneSessionScope(existing.sessionScope)
      : normalizeSessionScope(input.sessionScope)
    assertDurableSessionScope(sessionScope)
    const contract = input.contract === undefined
      ? existing?.contract
      : normalizeTaskContract(input.contract, input.title)
    if (existing) {
      if (!sessionScopesEqual(existing.sessionScope, sessionScope)) {
        throw new Error(`task_scope_conflict:${input.id}`)
      }
      if (existing.contract !== undefined && contract !== undefined
        && !sameTaskContract(existing.contract, contract)) {
        throw new Error(`task_contract_conflict:${input.id}`)
      }
      existing.title = input.title
      existing.status = input.status
      existing.evidence = [...input.evidence]
      existing.updatedAt = input.updatedAt ?? stamp
      if (input.parentId !== undefined) {
        existing.parentId = input.parentId
      } else {
        delete existing.parentId
      }
      if (input.mainConversationId !== undefined) {
        if (existing.mainConversationId !== undefined
          && !conversationIdsEqual(existing.mainConversationId, input.mainConversationId)) {
          throw new Error(`task_conversation_conflict:${input.id}`)
        }
        existing.mainConversationId = input.mainConversationId
      }
      if (contract !== undefined) existing.contract = { ...contract }
      return {
        ...existing,
        evidence: [...existing.evidence],
        sessionScope: cloneSessionScope(existing.sessionScope),
        ...(existing.contract !== undefined ? { contract: { ...existing.contract } } : {}),
      }
    }

    const task: TaskTruth = {
      id: input.id,
      title: input.title,
      status: input.status,
      createdAt: input.createdAt ?? stamp,
      updatedAt: input.updatedAt ?? stamp,
      evidence: [...input.evidence],
      sessionScope,
    }
    if (input.parentId !== undefined) {
      task.parentId = input.parentId
    }
    if (input.mainConversationId !== undefined) task.mainConversationId = input.mainConversationId
    if (contract !== undefined) task.contract = { ...contract }
    this.data.tasks.push(task)
    return {
      ...task,
      evidence: [...task.evidence],
      sessionScope: cloneSessionScope(task.sessionScope),
      ...(task.contract !== undefined ? { contract: { ...task.contract } } : {}),
    }
  }

  listTasksSync(options?: TaskSearchOptions): TaskTruth[] {
    this.ensureData()
    const requestedScope = options?.sessionScope === undefined
      ? undefined
      : normalizeSessionScope(options.sessionScope)
    return this.data.tasks
      .filter((task) => requestedScope === undefined || sessionScopesEqual(task.sessionScope, requestedScope))
      .map((t) => {
      const copy: TaskTruth = {
        id: t.id,
        title: t.title,
        status: t.status,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        evidence: [...t.evidence],
        sessionScope: cloneSessionScope(t.sessionScope),
      }
      if (t.parentId !== undefined) copy.parentId = t.parentId
      if (t.mainConversationId !== undefined) copy.mainConversationId = t.mainConversationId
      if (t.contract !== undefined) copy.contract = { ...t.contract }
      return copy
    })
  }

  putDelegatedResultSync(input: DelegatedResultInput): DelegatedResultRecord {
    this.ensureData()
    const normalized = normalizeDelegatedResult(input)
    const existing = this.data.delegatedResults.find((result) => result.taskId === normalized.taskId)
    if (existing) {
      if (!sameDelegatedResultPayload(existing, normalized)) {
        throw new Error(`delegated_result_conflict:${normalized.taskId}`)
      }
      return cloneDelegatedResult(existing)
    }
    this.data.delegatedResults.push(normalized)
    return cloneDelegatedResult(normalized)
  }

  upsertTaskWithDelegatedResultSync(
    taskInput: TaskInput,
    resultInput: DelegatedResultInput,
  ): { task: TaskTruth; result: DelegatedResultRecord } {
    this.ensureData()
    if (taskInput.id !== resultInput.taskId) {
      throw new Error("delegated result must match its TaskTruth id")
    }
    const before = cloneSnapshot(this.data)
    try {
      const task = this.upsertTaskSync(taskInput)
      const result = this.putDelegatedResultSync(resultInput)
      return { task, result }
    } catch (error) {
      this.data = before
      throw error
    }
  }

  listDelegatedResultsSync(options?: DelegatedResultListOptions): DelegatedResultRecord[] {
    this.ensureData()
    const includeDelivered = options?.includeDelivered ?? true
    return this.data.delegatedResults
      .filter((result) =>
        (options?.mainConversationId === undefined
          || conversationIdsEqual(result.mainConversationId, options.mainConversationId))
        && (options?.taskId === undefined || result.taskId === options.taskId)
        && (includeDelivered || result.deliveryTurnId === undefined)
        && (options?.claimedOnly !== true || result.claimTurnId !== undefined)
      )
      .sort((left, right) => left.completedAt.localeCompare(right.completedAt))
      .map(cloneDelegatedResult)
  }

  claimDelegatedResultsSync(
    mainConversationId: string,
    claimTurnId: string,
    claimedAt = nowIso(),
  ): DelegatedResultRecord[] {
    this.ensureData()
    const conversationId = delegatedIdentifier(mainConversationId, "conversation id")
    const turnId = delegatedIdentifier(claimTurnId, "claim turn id")
    if (!validIsoTimestamp(claimedAt)) {
      throw new Error("yishu-store: invalid delegated result claimed time")
    }
    for (const result of this.data.delegatedResults) {
      if (
        conversationIdsEqual(result.mainConversationId, conversationId)
        && result.deliveryTurnId === undefined
        && (result.claimTurnId === undefined || result.claimTurnId === turnId)
      ) {
        result.claimTurnId = turnId
        result.claimedAt ??= claimedAt
      }
    }
    return this.data.delegatedResults
      .filter((result) =>
        conversationIdsEqual(result.mainConversationId, conversationId)
        && result.deliveryTurnId === undefined
        && result.claimTurnId === turnId
      )
      .sort((left, right) => left.completedAt.localeCompare(right.completedAt))
      .map(cloneDelegatedResult)
  }

  ackDelegatedResultsSync(claimTurnId: string, deliveredAt = nowIso()): number {
    this.ensureData()
    const turnId = delegatedIdentifier(claimTurnId, "claim turn id")
    if (!validIsoTimestamp(deliveredAt)) {
      throw new Error("yishu-store: invalid delegated result delivered time")
    }
    let changed = 0
    for (const result of this.data.delegatedResults) {
      if (result.claimTurnId !== turnId || result.deliveryTurnId !== undefined) continue
      result.deliveryTurnId = turnId
      result.deliveredAt = deliveredAt
      changed += 1
    }
    return changed
  }

  releaseDelegatedResultsSync(claimTurnId: string): number {
    this.ensureData()
    const turnId = delegatedIdentifier(claimTurnId, "claim turn id")
    let changed = 0
    for (const result of this.data.delegatedResults) {
      if (result.claimTurnId !== turnId || result.deliveryTurnId !== undefined) continue
      delete result.claimTurnId
      delete result.claimedAt
      changed += 1
    }
    return changed
  }

  upsertConversationSync(input: ConversationInput): Conversation {
    this.ensureData()
    const id = input.id ?? randomUUID()
    const existing = this.data.conversations.find((conversation) => conversation.id === id)
    const stamp = input.updatedAt ?? nowIso()
    const sessionScope = input.sessionScope === undefined && existing
      ? cloneSessionScope(existing.sessionScope)
      : normalizeSessionScope(input.sessionScope)
    assertDurableSessionScope(sessionScope)
    if (existing) {
      if (!sessionScopesEqual(existing.sessionScope, sessionScope)) {
        throw new Error(`conversation_scope_conflict:${id}`)
      }
      if (input.status !== undefined) existing.status = input.status
      if (input.title !== undefined) {
        existing.title = sanitizeVisibleText(input.title, "conversation title")
      }
      existing.updatedAt = stamp
      return { ...existing, sessionScope: cloneSessionScope(existing.sessionScope) }
    }

    const conversation: Conversation = {
      id,
      createdAt: input.createdAt ?? stamp,
      updatedAt: stamp,
      status: input.status ?? "active",
      sessionScope,
    }
    if (input.title !== undefined) {
      conversation.title = sanitizeVisibleText(input.title, "conversation title")
    }
    this.data.conversations.push(conversation)
    return { ...conversation, sessionScope: cloneSessionScope(conversation.sessionScope) }
  }

  upsertConversationTurnSync(input: ConversationTurnInput): ConversationTurn {
    this.ensureData()
    const conversation = this.data.conversations.find(
      (candidate) => candidate.id === input.conversationId,
    )
    if (!conversation) {
      throw new Error(`conversation ${input.conversationId} does not exist`)
    }
    const sessionScope = input.sessionScope === undefined
      ? cloneSessionScope(conversation.sessionScope)
      : normalizeSessionScope(input.sessionScope)
    assertDurableSessionScope(sessionScope)
    if (!sessionScopesEqual(conversation.sessionScope, sessionScope)) {
      throw new Error(`conversation_turn_scope_conflict:${input.conversationId}`)
    }

    const id = input.id ?? randomUUID()
    const existing = this.data.turns.find((turn) => turn.id === id)
    const stamp = input.updatedAt ?? nowIso()
    if (existing) {
      if (existing.conversationId !== input.conversationId) {
        throw new Error(`conversation turn ${id} belongs to another conversation`)
      }
      if (!sessionScopesEqual(existing.sessionScope, sessionScope)) {
        throw new Error(`conversation_turn_scope_conflict:${id}`)
      }
      const incomingUserInput = input.userInput === undefined
        ? undefined
        : sanitizeVisibleText(input.userInput, "conversation user input")
      const incomingAssistantOutput = input.assistantOutput === undefined
        ? undefined
        : sanitizeVisibleText(input.assistantOutput, "conversation assistant output")
      const isTerminal = existing.status !== "open"
      if (input.status !== undefined && input.status !== existing.status) {
        if (isTerminal || input.status === "open") {
          throw new Error(`turn_terminal_conflict:${id}`)
        }
      }
      if (input.traceId !== undefined && existing.traceId !== undefined && existing.traceId !== input.traceId) {
        throw new Error(`turn_trace_conflict:${id}`)
      }
      if (incomingUserInput !== undefined && existing.userInput !== undefined && existing.userInput !== incomingUserInput) {
        throw new Error(`turn_input_conflict:${id}`)
      }
      if (incomingAssistantOutput !== undefined && existing.assistantOutput !== undefined && existing.assistantOutput !== incomingAssistantOutput) {
        throw new Error(`turn_output_conflict:${id}`)
      }
      if (isTerminal) return cloneTurn(existing)
      if (input.status !== undefined) existing.status = input.status
      if (input.traceId !== undefined) existing.traceId = input.traceId
      if (incomingUserInput !== undefined) existing.userInput = incomingUserInput
      if (incomingAssistantOutput !== undefined) existing.assistantOutput = incomingAssistantOutput
      existing.updatedAt = stamp
      conversation.updatedAt = stamp
      return cloneTurn(existing)
    }

    const sequence = this.data.turns
      .filter((turn) => turn.conversationId === input.conversationId)
      .reduce((max, turn) => Math.max(max, turn.sequence), -1) + 1
    const turn: ConversationTurn = {
      id,
      conversationId: input.conversationId,
      sequence,
      createdAt: input.createdAt ?? stamp,
      updatedAt: stamp,
      status: input.status ?? "open",
      sessionScope,
    }
    if (input.traceId !== undefined) turn.traceId = input.traceId
    if (input.userInput !== undefined) {
      turn.userInput = sanitizeVisibleText(input.userInput, "conversation user input")
    }
    if (input.assistantOutput !== undefined) {
      turn.assistantOutput = sanitizeVisibleText(
        input.assistantOutput,
        "conversation assistant output",
      )
    }
    this.data.turns.push(turn)
    conversation.updatedAt = stamp
    return cloneTurn(turn)
  }

  appendConversationEventSync(input: ConversationEventInput): ConversationEvent {
    this.ensureData()
    const conversation = this.data.conversations.find(
      (candidate) => candidate.id === input.conversationId,
    )
    if (!conversation) {
      throw new Error(`conversation ${input.conversationId} does not exist`)
    }
    const existingById = input.id === undefined
      ? undefined
      : this.data.events.find((event) => event.id === input.id)
    if (input.turnId !== undefined) {
      const turn = this.data.turns.find((candidate) => candidate.id === input.turnId)
      if (!turn || turn.conversationId !== input.conversationId) {
        throw new Error(`conversation event turn ${input.turnId} does not belong to conversation`)
      }
      if (turn.status !== "open" && existingById === undefined) {
        throw new Error(`late_event_rejected:${input.turnId}`)
      }
    }

    assertPersistableEventType(input.type)
    const payload = sanitizeEventPayload(input.payload)
    if (input.id !== undefined) {
      const existing = this.data.events.find((event) => event.id === input.id)
      if (existing) {
        const sameTurn = (existing.turnId ?? null) === (input.turnId ?? null)
        const sameTime = input.occurredAt === undefined || existing.occurredAt === input.occurredAt
        if (
          existing.conversationId !== input.conversationId ||
          !sameTurn ||
          existing.type !== input.type ||
          !sameTime ||
          !sameEventPayload(existing.payload, payload)
        ) {
          throw new Error(`event_id_conflict:${input.id}`)
        }
        return cloneEvent(existing)
      }
    }

    const sequence = this.data.events
      .filter((event) => event.conversationId === input.conversationId)
      .reduce((max, event) => Math.max(max, event.sequence), -1) + 1
    const occurredAt = input.occurredAt ?? nowIso()
    const event: ConversationEvent = {
      id: input.id ?? randomUUID(),
      conversationId: input.conversationId,
      sequence,
      type: input.type,
      occurredAt,
      payload,
    }
    if (input.turnId !== undefined) event.turnId = input.turnId
    this.data.events.push(event)
    conversation.updatedAt = occurredAt
    return cloneEvent(event)
  }

  getConversationSync(id: string): Conversation | null {
    this.ensureData()
    const conversation = this.data.conversations.find((candidate) =>
      conversationIdsEqual(candidate.id, id),
    )
    return conversation
      ? { ...conversation, sessionScope: cloneSessionScope(conversation.sessionScope) }
      : null
  }

  getConversationTurnSync(id: string): ConversationTurn | null {
    this.ensureData()
    const turn = this.data.turns.find((candidate) => conversationIdsEqual(candidate.id, id))
    return turn ? cloneTurn(turn) : null
  }

  listConversationTurnsSync(conversationId: string): ConversationTurn[] {
    this.ensureData()
    return this.data.turns
      .filter((turn) => conversationIdsEqual(turn.conversationId, conversationId))
      .sort((a, b) => a.sequence - b.sequence)
      .map(cloneTurn)
  }

  listConversationEventsSync(conversationId: string): ConversationEvent[] {
    this.ensureData()
    return this.data.events
      .filter((event) => conversationIdsEqual(event.conversationId, conversationId))
      .sort((a, b) => a.sequence - b.sequence)
      .map(cloneEvent)
  }

  listConversationsSync(options?: ConversationListOptions): ConversationListItem[] {
    this.ensureData()
    const limit = clampConversationListLimit(options?.limit)
    // Private is never durable; a private filter is an empty history.
    if (options?.sessionScope?.kind === "private") {
      return []
    }
    const requestedScope = options?.sessionScope === undefined
      ? undefined
      : normalizeSessionScope(options.sessionScope)
    const includeArchived = options?.includeArchived === true

    const matched = this.data.conversations
      .filter((conversation) => {
        if (conversation.sessionScope.kind === "private") return false
        if (!includeArchived && conversation.status === "archived") return false
        if (requestedScope === undefined) return true
        return sessionScopesEqual(conversation.sessionScope, requestedScope)
      })
      .sort((left, right) => {
        const leftTime = Date.parse(left.updatedAt)
        const rightTime = Date.parse(right.updatedAt)
        if (rightTime !== leftTime) return rightTime - leftTime
        return right.id.localeCompare(left.id)
      })
      .slice(0, limit)

    return matched.map((conversation) => {
      const turns = this.data.turns.filter((turn) =>
        conversationIdsEqual(turn.conversationId, conversation.id),
      )
      return buildConversationListItem(conversation, turns)
    })
  }

  /**
   * Soft-delete: set status=archived. Does not remove turns/events.
   * Returns null when missing or when expectedScope does not match.
   */
  archiveConversationSync(
    id: string,
    options?: { expectedScope?: SessionScope },
  ): Conversation | null {
    this.ensureData()
    const existing = this.data.conversations.find((candidate) =>
      conversationIdsEqual(candidate.id, id),
    )
    if (!existing) return null
    if (existing.sessionScope.kind === "private") return null
    if (options?.expectedScope !== undefined) {
      const expected = normalizeSessionScope(options.expectedScope)
      if (!sessionScopesEqual(existing.sessionScope, expected)) return null
    }
    if (existing.status === "archived") {
      return {
        ...existing,
        sessionScope: cloneSessionScope(existing.sessionScope),
      }
    }
    existing.status = "archived"
    existing.updatedAt = nowIso()
    return {
      ...existing,
      sessionScope: cloneSessionScope(existing.sessionScope),
    }
  }

  getMindSync(): YishuMindState {
    this.ensureData()
    return readMindState(this.data.mind ?? emptyMindState())
  }

  writeMindSectionSync(
    input: MindSectionWriteInput,
    signal?: AbortSignal,
  ): YishuMindState {
    assertStoreOperationNotAborted(signal)
    this.ensureData()
    const next = writeMindSectionState(this.data.mind ?? emptyMindState(), input)
    assertStoreOperationNotAborted(signal)
    this.data.mind = next
    return cloneMindState(next)
  }

  restoreSeedMindSync(signal?: AbortSignal): YishuMindState {
    assertStoreOperationNotAborted(signal)
    this.ensureData()
    const next = restoreSeedMindState()
    assertStoreOperationNotAborted(signal)
    this.data.mind = next
    return cloneMindState(next)
  }

  addSuggestionSync(
    input: SuggestionRecordInput,
    signal?: AbortSignal,
  ): SuggestionRecord {
    assertStoreOperationNotAborted(signal)
    this.ensureData()
    const record = buildSuggestionRecord(input)
    assertStoreOperationNotAborted(signal)
    this.data.suggestions.push(record)
    return cloneSuggestion(record)
  }

  recordSuggestionOutcomeSync(
    input: SuggestionOutcomeInput,
    signal?: AbortSignal,
  ): SuggestionRecord {
    assertStoreOperationNotAborted(signal)
    this.ensureData()
    const index = this.data.suggestions.findIndex((s) => s.id === input.suggestionId)
    if (index < 0) {
      throw new Error("suggestion_not_found")
    }
    const next = applySuggestionOutcome(this.data.suggestions[index]!, input)
    assertStoreOperationNotAborted(signal)
    this.data.suggestions[index] = next
    return cloneSuggestion(next)
  }

  listSuggestionsSync(): SuggestionRecord[] {
    this.ensureData()
    return this.data.suggestions.map((s) => cloneSuggestion(s))
  }

  getSuggestionSync(id: string): SuggestionRecord | null {
    this.ensureData()
    const hit = this.data.suggestions.find((s) => s.id === id)
    return hit ? cloneSuggestion(hit) : null
  }

  learnMindFromPatternSync(
    input: MindLearnFromPatternInput,
    signal?: AbortSignal,
  ): MindLearnResult {
    assertStoreOperationNotAborted(signal)
    this.ensureData()
    const result = learnMindFromPattern(
      this.data.mind ?? emptyMindState(),
      this.data.suggestions,
      input,
    )
    assertStoreOperationNotAborted(signal)
    if (result.wrote) {
      this.data.mind = result.mind
    }
    return {
      ...result,
      mind: cloneMindState(result.mind),
    }
  }
}

function cloneTurn(turn: ConversationTurn): ConversationTurn {
  return { ...turn, sessionScope: cloneSessionScope(turn.sessionScope) }
}

function cloneEvent(event: ConversationEvent): ConversationEvent {
  return {
    ...event,
    payload: cloneEventPayload(event.payload),
  }
}

/**
 * File-backed JSON store at `storeDir/yishu-store.json`.
 * Product-owned evidence: memory claims, learnings, skills, mandates, task truth.
 */
export class YishuStore extends YishuStoreCore implements YishuStorePort {
  private readonly storePath: string
  private operationTail: Promise<void> = Promise.resolve()

  constructor(storeDir: string) {
    super()
    this.storePath = path.join(storeDir, "yishu-store.json")
  }

  get path(): string {
    return this.storePath
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async loadUnsafe(): Promise<void> {
    try {
      const raw = await fs.readFile(this.storePath, "utf8")
      this.data = parseSnapshot(JSON.parse(raw) as unknown)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        this.data = emptySnapshot()
      } else {
        throw err
      }
    }
    this.loaded = true
  }

  private async writeSnapshotUnsafe(
    snapshot: YishuStoreSnapshot,
    signal?: AbortSignal,
  ): Promise<void> {
    assertStoreOperationNotAborted(signal)
    const storeDir = path.dirname(this.storePath)
    const temporaryPath = path.join(
      storeDir,
      `.${path.basename(this.storePath)}.${process.pid}.${randomUUID()}.tmp`,
    )
    await fs.mkdir(storeDir, { recursive: true })
    try {
      await fs.writeFile(
        temporaryPath,
        JSON.stringify(snapshot, null, 2),
        { encoding: "utf8", signal },
      )
      assertStoreOperationNotAborted(signal)
      await fs.rename(temporaryPath, this.storePath)
      assertStoreOperationNotAborted(signal)
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => undefined)
      throw error
    }
  }

  private async saveUnsafe(signal?: AbortSignal): Promise<void> {
    this.ensureData()
    await this.writeSnapshotUnsafe(this.data, signal)
  }

  private async ensureLoadedUnsafe(signal?: AbortSignal): Promise<void> {
    assertStoreOperationNotAborted(signal)
    if (!this.loaded) await this.loadUnsafe()
    assertStoreOperationNotAborted(signal)
  }

  async load(): Promise<void> {
    await this.enqueue(() => this.loadUnsafe())
  }

  async save(): Promise<void> {
    await this.enqueue(() => this.saveUnsafe())
  }

  async addMemory(
    input: MemoryInput,
    options?: StoreMutationOptions,
  ): Promise<MemoryClaim> {
    return this.enqueue(async () => {
      const signal = options?.signal
      await this.ensureLoadedUnsafe(signal)
      const before = cloneSnapshot(this.data)
      try {
        const claim = this.addMemorySync(input, signal)
        await this.saveUnsafe(signal)
        assertStoreOperationNotAborted(signal)
        return claim
      } catch (error) {
        if (signal?.aborted || error instanceof StoreOperationCancelledError) {
          this.data = before
          await this.writeSnapshotUnsafe(before).catch(() => undefined)
          throw new StoreOperationCancelledError()
        }
        throw error
      }
    })
  }

  async searchMemory(
    query: string,
    options?: MemorySearchOptions,
  ): Promise<MemoryClaim[]> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      return this.searchMemorySync(query, options)
    })
  }

  async retireMemory(
    id: string,
    options?: StoreMutationOptions,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const signal = options?.signal
      await this.ensureLoadedUnsafe(signal)
      const before = cloneSnapshot(this.data)
      try {
        const ok = this.retireMemorySync(id, signal)
        if (ok) {
          await this.saveUnsafe(signal)
          assertStoreOperationNotAborted(signal)
        }
        return ok
      } catch (error) {
        if (signal?.aborted || error instanceof StoreOperationCancelledError) {
          this.data = before
          await this.writeSnapshotUnsafe(before).catch(() => undefined)
          throw new StoreOperationCancelledError()
        }
        throw error
      }
    })
  }

  async listMemories(options: MemoryListOptions): Promise<MemoryListItem[]> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      return this.listMemoriesSync(options)
    })
  }

  async forgetMemory(
    id: string,
    options: { expectedScope: string },
  ): Promise<ForgetMemoryResult | null> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      const before = cloneSnapshot(this.data)
      try {
        const result = this.forgetMemorySync(id, options)
        if (result !== null && !result.alreadyGone) {
          await this.saveUnsafe()
        }
        return result
      } catch (error) {
        this.data = before
        await this.writeSnapshotUnsafe(before).catch(() => undefined)
        throw error
      }
    })
  }

  async addLearning(
    input: LearningInput,
    options?: StoreMutationOptions,
  ): Promise<Learning> {
    return this.enqueue(async () => {
      const signal = options?.signal
      await this.ensureLoadedUnsafe(signal)
      const before = cloneSnapshot(this.data)
      try {
        const learning = this.addLearningSync(input, signal)
        await this.saveUnsafe(signal)
        assertStoreOperationNotAborted(signal)
        return learning
      } catch (error) {
        if (signal?.aborted || error instanceof StoreOperationCancelledError) {
          this.data = before
          await this.writeSnapshotUnsafe(before).catch(() => undefined)
          throw new StoreOperationCancelledError()
        }
        throw error
      }
    })
  }

  async listLearnings(): Promise<Learning[]> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      return this.listLearningsSync()
    })
  }

  async addSkillCandidate(
    input: SkillCandidateInput,
    options?: StoreMutationOptions,
  ): Promise<SkillCandidate> {
    return this.enqueue(async () => {
      const signal = options?.signal
      await this.ensureLoadedUnsafe(signal)
      const before = cloneSnapshot(this.data)
      try {
        const candidate = this.addSkillCandidateSync(input, signal)
        await this.saveUnsafe(signal)
        assertStoreOperationNotAborted(signal)
        return candidate
      } catch (error) {
        if (signal?.aborted || error instanceof StoreOperationCancelledError) {
          this.data = before
          await this.writeSnapshotUnsafe(before).catch(() => undefined)
          throw new StoreOperationCancelledError()
        }
        throw error
      }
    })
  }

  async listSkillCandidates(): Promise<SkillCandidate[]> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      return this.listSkillCandidatesSync()
    })
  }

  async promoteSkill(
    candidateId: string,
    opts?: PromoteSkillOptions,
  ): Promise<VerifiedSkill | null> {
    return this.enqueue(async () => {
      const signal = opts?.signal
      await this.ensureLoadedUnsafe(signal)
      const before = cloneSnapshot(this.data)
      try {
        const verified = this.promoteSkillSync(candidateId, opts)
        if (verified) {
          await this.saveUnsafe(signal)
          assertStoreOperationNotAborted(signal)
        }
        return verified
      } catch (error) {
        if (signal?.aborted || error instanceof StoreOperationCancelledError) {
          this.data = before
          await this.writeSnapshotUnsafe(before).catch(() => undefined)
          throw new StoreOperationCancelledError()
        }
        throw error
      }
    })
  }

  async listVerifiedSkills(): Promise<VerifiedSkill[]> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      return this.listVerifiedSkillsSync()
    })
  }

  async getSkillByName(
    name: string,
  ): Promise<VerifiedSkill | SkillCandidate | null> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      return this.getSkillByNameSync(name)
    })
  }

  async grantMandate(input: MandateInput): Promise<Mandate> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      const mandate = this.grantMandateSync(input)
      await this.saveUnsafe()
      return mandate
    })
  }

  async listMandates(): Promise<Mandate[]> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      return this.listMandatesSync()
    })
  }

  async hasMandate(actionName: string, now?: string | Date): Promise<boolean> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      return this.hasMandateSync(actionName, now)
    })
  }

  async revokeMandate(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      const ok = this.revokeMandateSync(id)
      if (ok) await this.saveUnsafe()
      return ok
    })
  }

  async upsertTask(input: TaskInput): Promise<TaskTruth> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      const task = this.upsertTaskSync(input)
      await this.saveUnsafe()
      return task
    })
  }

  async listTasks(options?: TaskSearchOptions): Promise<TaskTruth[]> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      return this.listTasksSync(options)
    })
  }

  async putDelegatedResult(input: DelegatedResultInput): Promise<DelegatedResultRecord> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      const result = this.putDelegatedResultSync(input)
      await this.saveUnsafe()
      return result
    })
  }

  async upsertTaskWithDelegatedResult(
    task: TaskInput,
    result: DelegatedResultInput,
  ): Promise<{ task: TaskTruth; result: DelegatedResultRecord }> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      const before = cloneSnapshot(this.data)
      try {
        const stored = this.upsertTaskWithDelegatedResultSync(task, result)
        await this.saveUnsafe()
        return stored
      } catch (error) {
        this.data = before
        await this.writeSnapshotUnsafe(before).catch(() => undefined)
        throw error
      }
    })
  }

  async listDelegatedResults(
    options?: DelegatedResultListOptions,
  ): Promise<DelegatedResultRecord[]> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      return this.listDelegatedResultsSync(options)
    })
  }

  async claimDelegatedResults(
    mainConversationId: string,
    claimTurnId: string,
    claimedAt?: string,
  ): Promise<DelegatedResultRecord[]> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      const before = cloneSnapshot(this.data)
      try {
        const results = this.claimDelegatedResultsSync(mainConversationId, claimTurnId, claimedAt)
        if (results.length > 0) await this.saveUnsafe()
        return results
      } catch (error) {
        this.data = before
        throw error
      }
    })
  }

  async ackDelegatedResults(claimTurnId: string, deliveredAt?: string): Promise<number> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      const before = cloneSnapshot(this.data)
      try {
        const changed = this.ackDelegatedResultsSync(claimTurnId, deliveredAt)
        if (changed > 0) await this.saveUnsafe()
        return changed
      } catch (error) {
        this.data = before
        throw error
      }
    })
  }

  async releaseDelegatedResults(claimTurnId: string): Promise<number> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      const before = cloneSnapshot(this.data)
      try {
        const changed = this.releaseDelegatedResultsSync(claimTurnId)
        if (changed > 0) await this.saveUnsafe()
        return changed
      } catch (error) {
        this.data = before
        throw error
      }
    })
  }

  async upsertConversation(input: ConversationInput): Promise<Conversation> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      const conversation = this.upsertConversationSync(input)
      await this.saveUnsafe()
      return conversation
    })
  }

  async upsertConversationTurn(input: ConversationTurnInput): Promise<ConversationTurn> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      const turn = this.upsertConversationTurnSync(input)
      await this.saveUnsafe()
      return turn
    })
  }

  async appendConversationEvent(input: ConversationEventInput): Promise<ConversationEvent> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      const event = this.appendConversationEventSync(input)
      await this.saveUnsafe()
      return event
    })
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      return this.getConversationSync(id)
    })
  }

  async getConversationTurn(id: string): Promise<ConversationTurn | null> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      return this.getConversationTurnSync(id)
    })
  }

  async listConversationTurns(conversationId: string): Promise<ConversationTurn[]> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      return this.listConversationTurnsSync(conversationId)
    })
  }

  async listConversationEvents(conversationId: string): Promise<ConversationEvent[]> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      return this.listConversationEventsSync(conversationId)
    })
  }

  async listConversations(options?: ConversationListOptions): Promise<ConversationListItem[]> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      return this.listConversationsSync(options)
    })
  }

  async archiveConversation(
    id: string,
    options?: { expectedScope?: SessionScope },
  ): Promise<Conversation | null> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      const archived = this.archiveConversationSync(id, options)
      if (archived) await this.saveUnsafe()
      return archived
    })
  }

  async getMind(): Promise<YishuMindState> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      return this.getMindSync()
    })
  }

  async writeMindSection(
    input: MindSectionWriteInput,
    options?: StoreMutationOptions,
  ): Promise<YishuMindState> {
    return this.enqueue(async () => {
      const signal = options?.signal
      await this.ensureLoadedUnsafe(signal)
      const before = cloneSnapshot(this.data)
      try {
        const mind = this.writeMindSectionSync(input, signal)
        await this.saveUnsafe(signal)
        assertStoreOperationNotAborted(signal)
        return mind
      } catch (error) {
        if (signal?.aborted || error instanceof StoreOperationCancelledError) {
          this.data = before
          await this.writeSnapshotUnsafe(before).catch(() => undefined)
          throw new StoreOperationCancelledError()
        }
        throw error
      }
    })
  }

  async restoreSeedMind(options?: StoreMutationOptions): Promise<YishuMindState> {
    return this.enqueue(async () => {
      const signal = options?.signal
      await this.ensureLoadedUnsafe(signal)
      const before = cloneSnapshot(this.data)
      try {
        const mind = this.restoreSeedMindSync(signal)
        await this.saveUnsafe(signal)
        assertStoreOperationNotAborted(signal)
        return mind
      } catch (error) {
        if (signal?.aborted || error instanceof StoreOperationCancelledError) {
          this.data = before
          await this.writeSnapshotUnsafe(before).catch(() => undefined)
          throw new StoreOperationCancelledError()
        }
        throw error
      }
    })
  }

  async addSuggestion(
    input: SuggestionRecordInput,
    options?: StoreMutationOptions,
  ): Promise<SuggestionRecord> {
    return this.enqueue(async () => {
      const signal = options?.signal
      await this.ensureLoadedUnsafe(signal)
      const before = cloneSnapshot(this.data)
      try {
        const record = this.addSuggestionSync(input, signal)
        await this.saveUnsafe(signal)
        assertStoreOperationNotAborted(signal)
        return record
      } catch (error) {
        if (signal?.aborted || error instanceof StoreOperationCancelledError) {
          this.data = before
          await this.writeSnapshotUnsafe(before).catch(() => undefined)
          throw new StoreOperationCancelledError()
        }
        throw error
      }
    })
  }

  async recordSuggestionOutcome(
    input: SuggestionOutcomeInput,
    options?: StoreMutationOptions,
  ): Promise<SuggestionRecord> {
    return this.enqueue(async () => {
      const signal = options?.signal
      await this.ensureLoadedUnsafe(signal)
      const before = cloneSnapshot(this.data)
      try {
        const record = this.recordSuggestionOutcomeSync(input, signal)
        await this.saveUnsafe(signal)
        assertStoreOperationNotAborted(signal)
        return record
      } catch (error) {
        if (signal?.aborted || error instanceof StoreOperationCancelledError) {
          this.data = before
          await this.writeSnapshotUnsafe(before).catch(() => undefined)
          throw new StoreOperationCancelledError()
        }
        throw error
      }
    })
  }

  async listSuggestions(): Promise<SuggestionRecord[]> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      return this.listSuggestionsSync()
    })
  }

  async getSuggestion(id: string): Promise<SuggestionRecord | null> {
    return this.enqueue(async () => {
      await this.ensureLoadedUnsafe()
      return this.getSuggestionSync(id)
    })
  }

  async learnMindFromPattern(
    input: MindLearnFromPatternInput,
    options?: StoreMutationOptions,
  ): Promise<MindLearnResult> {
    return this.enqueue(async () => {
      const signal = options?.signal
      await this.ensureLoadedUnsafe(signal)
      const before = cloneSnapshot(this.data)
      try {
        const result = this.learnMindFromPatternSync(input, signal)
        if (result.wrote) {
          await this.saveUnsafe(signal)
          assertStoreOperationNotAborted(signal)
        }
        return result
      } catch (error) {
        if (signal?.aborted || error instanceof StoreOperationCancelledError) {
          this.data = before
          await this.writeSnapshotUnsafe(before).catch(() => undefined)
          throw new StoreOperationCancelledError()
        }
        throw error
      }
    })
  }
}

/**
 * Pure in-memory store for tests - no disk I/O.
 */
export class InMemoryYishuStore extends YishuStoreCore implements YishuStorePort {
  /**
   * Test-only inject that skips write-time persistable checks so the list
   * surface can prove it still hides credential-shaped legacy rows.
   * Production code must never call this.
   */
  injectUncheckedMemoryForTests(memory: MemoryClaim): void {
    this.ensureData()
    this.data.memories.push({
      ...memory,
      tags: [...memory.tags],
    })
  }
  constructor() {
    super()
    this.data = emptySnapshot()
    this.loaded = true
  }

  async load(): Promise<void> {
    // already resident
  }

  async save(): Promise<void> {
    // no-op: memory is source of truth
  }

  async addMemory(
    input: MemoryInput,
    options?: StoreMutationOptions,
  ): Promise<MemoryClaim> {
    return this.addMemorySync(input, options?.signal)
  }

  async searchMemory(
    query: string,
    options?: MemorySearchOptions,
  ): Promise<MemoryClaim[]> {
    return this.searchMemorySync(query, options)
  }

  async retireMemory(
    id: string,
    options?: StoreMutationOptions,
  ): Promise<boolean> {
    return this.retireMemorySync(id, options?.signal)
  }

  async listMemories(options: MemoryListOptions): Promise<MemoryListItem[]> {
    return this.listMemoriesSync(options)
  }

  async forgetMemory(
    id: string,
    options: { expectedScope: string },
  ): Promise<ForgetMemoryResult | null> {
    return this.forgetMemorySync(id, options)
  }

  async addLearning(
    input: LearningInput,
    options?: StoreMutationOptions,
  ): Promise<Learning> {
    return this.addLearningSync(input, options?.signal)
  }

  async listLearnings(): Promise<Learning[]> {
    return this.listLearningsSync()
  }

  async addSkillCandidate(
    input: SkillCandidateInput,
    options?: StoreMutationOptions,
  ): Promise<SkillCandidate> {
    return this.addSkillCandidateSync(input, options?.signal)
  }

  async listSkillCandidates(): Promise<SkillCandidate[]> {
    return this.listSkillCandidatesSync()
  }

  async promoteSkill(
    candidateId: string,
    opts?: PromoteSkillOptions,
  ): Promise<VerifiedSkill | null> {
    return this.promoteSkillSync(candidateId, opts)
  }

  async listVerifiedSkills(): Promise<VerifiedSkill[]> {
    return this.listVerifiedSkillsSync()
  }

  async getSkillByName(
    name: string,
  ): Promise<VerifiedSkill | SkillCandidate | null> {
    return this.getSkillByNameSync(name)
  }

  async grantMandate(input: MandateInput): Promise<Mandate> {
    return this.grantMandateSync(input)
  }

  async listMandates(): Promise<Mandate[]> {
    return this.listMandatesSync()
  }

  async hasMandate(actionName: string, now?: string | Date): Promise<boolean> {
    return this.hasMandateSync(actionName, now)
  }

  async revokeMandate(id: string): Promise<boolean> {
    return this.revokeMandateSync(id)
  }

  async upsertTask(input: TaskInput): Promise<TaskTruth> {
    return this.upsertTaskSync(input)
  }

  async listTasks(options?: TaskSearchOptions): Promise<TaskTruth[]> {
    return this.listTasksSync(options)
  }

  async putDelegatedResult(input: DelegatedResultInput): Promise<DelegatedResultRecord> {
    return this.putDelegatedResultSync(input)
  }

  async upsertTaskWithDelegatedResult(
    task: TaskInput,
    result: DelegatedResultInput,
  ): Promise<{ task: TaskTruth; result: DelegatedResultRecord }> {
    return this.upsertTaskWithDelegatedResultSync(task, result)
  }

  async listDelegatedResults(
    options?: DelegatedResultListOptions,
  ): Promise<DelegatedResultRecord[]> {
    return this.listDelegatedResultsSync(options)
  }

  async claimDelegatedResults(
    mainConversationId: string,
    claimTurnId: string,
    claimedAt?: string,
  ): Promise<DelegatedResultRecord[]> {
    return this.claimDelegatedResultsSync(mainConversationId, claimTurnId, claimedAt)
  }

  async ackDelegatedResults(claimTurnId: string, deliveredAt?: string): Promise<number> {
    return this.ackDelegatedResultsSync(claimTurnId, deliveredAt)
  }

  async releaseDelegatedResults(claimTurnId: string): Promise<number> {
    return this.releaseDelegatedResultsSync(claimTurnId)
  }

  async upsertConversation(input: ConversationInput): Promise<Conversation> {
    return this.upsertConversationSync(input)
  }

  async upsertConversationTurn(input: ConversationTurnInput): Promise<ConversationTurn> {
    return this.upsertConversationTurnSync(input)
  }

  async appendConversationEvent(input: ConversationEventInput): Promise<ConversationEvent> {
    return this.appendConversationEventSync(input)
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return this.getConversationSync(id)
  }

  async getConversationTurn(id: string): Promise<ConversationTurn | null> {
    return this.getConversationTurnSync(id)
  }

  async listConversationTurns(conversationId: string): Promise<ConversationTurn[]> {
    return this.listConversationTurnsSync(conversationId)
  }

  async listConversationEvents(conversationId: string): Promise<ConversationEvent[]> {
    return this.listConversationEventsSync(conversationId)
  }

  async listConversations(options?: ConversationListOptions): Promise<ConversationListItem[]> {
    return this.listConversationsSync(options)
  }

  async archiveConversation(
    id: string,
    options?: { expectedScope?: SessionScope },
  ): Promise<Conversation | null> {
    return this.archiveConversationSync(id, options)
  }

  async getMind(): Promise<YishuMindState> {
    return this.getMindSync()
  }

  async writeMindSection(
    input: MindSectionWriteInput,
    options?: StoreMutationOptions,
  ): Promise<YishuMindState> {
    return this.writeMindSectionSync(input, options?.signal)
  }

  async restoreSeedMind(options?: StoreMutationOptions): Promise<YishuMindState> {
    return this.restoreSeedMindSync(options?.signal)
  }

  async addSuggestion(
    input: SuggestionRecordInput,
    options?: StoreMutationOptions,
  ): Promise<SuggestionRecord> {
    return this.addSuggestionSync(input, options?.signal)
  }

  async recordSuggestionOutcome(
    input: SuggestionOutcomeInput,
    options?: StoreMutationOptions,
  ): Promise<SuggestionRecord> {
    return this.recordSuggestionOutcomeSync(input, options?.signal)
  }

  async listSuggestions(): Promise<SuggestionRecord[]> {
    return this.listSuggestionsSync()
  }

  async getSuggestion(id: string): Promise<SuggestionRecord | null> {
    return this.getSuggestionSync(id)
  }

  async learnMindFromPattern(
    input: MindLearnFromPatternInput,
    options?: StoreMutationOptions,
  ): Promise<MindLearnResult> {
    return this.learnMindFromPatternSync(input, options?.signal)
  }
}

/** Factory for tests that must not touch disk. */
export function createInMemoryStore(): InMemoryYishuStore {
  return new InMemoryYishuStore()
}
