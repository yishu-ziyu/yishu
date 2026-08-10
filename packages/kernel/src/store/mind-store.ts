import { randomUUID } from "node:crypto"
import {
  LEARNED_HEADING,
  MIND_LEARN_MIN_EVIDENCE,
  applyMindUpdate,
  isOutcomeEvidenceStatus,
  mindText,
  normalizePatternKey,
  summarizePatternEvidence,
  writeMindSection,
} from "../mind/document.js"
import { assertPersistableMemoryText } from "./ledger-safety.js"
import type {
  MindLearnFromPatternInput,
  MindLearnResult,
  MindSectionWriteInput,
  SuggestionOutcomeInput,
  SuggestionRecord,
  SuggestionRecordInput,
  SuggestionRecordStatus,
  YishuMindState,
} from "./types.js"

export function emptyMindState(): YishuMindState {
  return { markdown: "", updatedAt: null }
}

export function cloneMindState(mind: YishuMindState): YishuMindState {
  const copy: YishuMindState = {
    markdown: mind.markdown,
    updatedAt: mind.updatedAt,
  }
  if (mind.lastLearnedAt !== undefined) copy.lastLearnedAt = mind.lastLearnedAt
  return copy
}

export function cloneSuggestion(record: SuggestionRecord): SuggestionRecord {
  const copy: SuggestionRecord = {
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    patternKey: record.patternKey,
    summary: record.summary,
    status: record.status,
  }
  if (record.conversationId !== undefined) copy.conversationId = record.conversationId
  if (record.turnId !== undefined) copy.turnId = record.turnId
  if (record.taskId !== undefined) copy.taskId = record.taskId
  if (record.note !== undefined) copy.note = record.note
  if (record.outcomeAt !== undefined) copy.outcomeAt = record.outcomeAt
  return copy
}

export function parseMindState(raw: unknown): YishuMindState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyMindState()
  }
  const row = raw as Record<string, unknown>
  const markdown = typeof row.markdown === "string" ? row.markdown : ""
  const updatedAt =
    row.updatedAt === null || typeof row.updatedAt === "string" ? (row.updatedAt as string | null) : null
  const mind: YishuMindState = { markdown, updatedAt }
  if (typeof row.lastLearnedAt === "string") mind.lastLearnedAt = row.lastLearnedAt
  if (markdown.trim().length > 0) {
    assertPersistableMemoryText(markdown, "mind markdown")
  }
  return mind
}

const ALLOWED_STATUSES: readonly SuggestionRecordStatus[] = [
  "proposed",
  "adopted",
  "ignored",
  "succeeded",
  "failed",
  "unknown",
]

export function parseSuggestions(raw: unknown): SuggestionRecord[] {
  if (!Array.isArray(raw)) return []
  return raw.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("yishu-store: invalid suggestion record")
    }
    const row = value as Record<string, unknown>
    if (
      typeof row.id !== "string"
      || typeof row.createdAt !== "string"
      || typeof row.updatedAt !== "string"
      || typeof row.patternKey !== "string"
      || typeof row.summary !== "string"
      || typeof row.status !== "string"
      || !ALLOWED_STATUSES.includes(row.status as SuggestionRecordStatus)
    ) {
      throw new Error("yishu-store: invalid suggestion record")
    }
    assertPersistableMemoryText(row.patternKey, "suggestion pattern")
    assertPersistableMemoryText(row.summary, "suggestion summary")
    const record: SuggestionRecord = {
      id: row.id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      patternKey: row.patternKey,
      summary: row.summary,
      status: row.status as SuggestionRecordStatus,
    }
    if (typeof row.conversationId === "string") record.conversationId = row.conversationId
    if (typeof row.turnId === "string") record.turnId = row.turnId
    if (typeof row.taskId === "string") record.taskId = row.taskId
    if (typeof row.note === "string") {
      assertPersistableMemoryText(row.note, "suggestion note")
      record.note = row.note
    }
    if (typeof row.outcomeAt === "string") record.outcomeAt = row.outcomeAt
    return record
  })
}

function nowIso(stamp?: string): string {
  return stamp ?? new Date().toISOString()
}

export function buildSuggestionRecord(input: SuggestionRecordInput): SuggestionRecord {
  const patternKey = normalizePatternKey(input.patternKey)
  const summary = input.summary.trim()
  if (summary.length === 0) {
    throw new Error("suggestion_summary_empty")
  }
  assertPersistableMemoryText(patternKey, "suggestion pattern")
  assertPersistableMemoryText(summary, "suggestion summary")
  if (input.note !== undefined) {
    assertPersistableMemoryText(input.note, "suggestion note")
  }
  const createdAt = nowIso(input.createdAt)
  const status = input.status ?? "proposed"
  if (!ALLOWED_STATUSES.includes(status)) {
    throw new Error("suggestion_status_invalid")
  }
  const record: SuggestionRecord = {
    id: input.id ?? randomUUID(),
    createdAt,
    updatedAt: nowIso(input.updatedAt ?? createdAt),
    patternKey,
    summary,
    status,
  }
  if (input.conversationId !== undefined) record.conversationId = input.conversationId
  if (input.turnId !== undefined) record.turnId = input.turnId
  if (input.taskId !== undefined) record.taskId = input.taskId
  if (input.note !== undefined) record.note = input.note
  if (input.outcomeAt !== undefined) record.outcomeAt = input.outcomeAt
  if (isOutcomeEvidenceStatus(status) && record.outcomeAt === undefined) {
    record.outcomeAt = record.updatedAt
  }
  return record
}

export function applySuggestionOutcome(
  existing: SuggestionRecord,
  input: SuggestionOutcomeInput,
): SuggestionRecord {
  if (input.suggestionId !== existing.id) {
    throw new Error("suggestion_id_mismatch")
  }
  if (input.status === undefined) {
    throw new Error("suggestion_status_invalid")
  }
  const nextStatus = input.status
  if (input.note !== undefined) {
    assertPersistableMemoryText(input.note, "suggestion note")
  }
  const stamp = nowIso(input.outcomeAt)
  const next = cloneSuggestion(existing)
  next.status = nextStatus
  next.updatedAt = stamp
  if (
    isOutcomeEvidenceStatus(nextStatus)
    || nextStatus === "adopted"
    || nextStatus === "ignored"
    || nextStatus === "unknown"
  ) {
    next.outcomeAt = stamp
  }
  if (input.note !== undefined) next.note = input.note
  if (input.taskId !== undefined) next.taskId = input.taskId
  return next
}

export function readMindState(mind: YishuMindState): YishuMindState {
  return cloneMindState(mind)
}

export function writeMindSectionState(
  mind: YishuMindState,
  input: MindSectionWriteInput,
  stamp?: string,
): YishuMindState {
  const heading = input.heading.trim()
  if (heading.length === 0) {
    throw new Error("mind_heading_empty")
  }
  assertPersistableMemoryText(heading, "mind heading")
  if (input.body.trim().length > 0) {
    assertPersistableMemoryText(input.body, "mind section body")
  }
  const markdown = writeMindSection(mind.markdown, heading, input.body)
  assertPersistableMemoryText(markdown, "mind markdown")
  const next: YishuMindState = {
    markdown,
    updatedAt: nowIso(stamp),
  }
  if (mind.lastLearnedAt !== undefined) next.lastLearnedAt = mind.lastLearnedAt
  return next
}

export function restoreSeedMindState(stamp?: string): YishuMindState {
  return {
    markdown: "",
    updatedAt: nowIso(stamp),
  }
}

function defaultLesson(
  patternKey: string,
  dominant: "succeeded" | "failed" | "mixed" | "none",
  succeeded: number,
  failed: number,
): string {
  if (dominant === "succeeded") {
    return `- Pattern \`${patternKey}\` worked ${succeeded} times. Prefer this move when the same situation returns.`
  }
  if (dominant === "failed") {
    return `- Pattern \`${patternKey}\` failed ${failed} times. Do not repeat it without a new reason.`
  }
  if (dominant === "mixed") {
    return `- Pattern \`${patternKey}\` is mixed (${succeeded} succeeded / ${failed} failed). Narrow when it applies before repeating.`
  }
  return `- Pattern \`${patternKey}\` still lacks repeated outcomes.`
}

export function learnMindFromPattern(
  mind: YishuMindState,
  suggestions: readonly SuggestionRecord[],
  input: MindLearnFromPatternInput,
  stamp?: string,
): MindLearnResult {
  const patternKey = normalizePatternKey(input.patternKey)
  const minEvidence = input.minEvidence ?? MIND_LEARN_MIN_EVIDENCE
  const related = suggestions.filter((s) => s.patternKey === patternKey)
  const summary = summarizePatternEvidence(
    related.map((s) => s.status),
    minEvidence,
  )
  const mindSnapshot = cloneMindState(mind)

  if (!summary.canLearn && !input.force) {
    return {
      wrote: false,
      reason: `need_${minEvidence}_outcomes`,
      patternKey,
      evidenceCount: summary.totalOutcomes,
      mind: mindSnapshot,
    }
  }

  const lesson =
    input.lesson?.trim()
    || defaultLesson(patternKey, summary.dominant, summary.succeeded, summary.failed)
  assertPersistableMemoryText(lesson, "mind lesson")

  // Fork from seed on first write so later seed releases do not silently overwrite.
  const baseMarkdown = mindText(mind.markdown)
  const markdown = applyMindUpdate(baseMarkdown, {
    changed: true,
    sections: [
      {
        heading: LEARNED_HEADING,
        mode: "append",
        content: lesson,
      },
    ],
  })
  assertPersistableMemoryText(markdown, "mind markdown")
  const learnedAt = nowIso(stamp)
  const next: YishuMindState = {
    markdown,
    updatedAt: learnedAt,
    lastLearnedAt: learnedAt,
  }
  return {
    wrote: true,
    reason: input.force && !summary.canLearn ? "forced" : "pattern_threshold_met",
    patternKey,
    evidenceCount: summary.totalOutcomes,
    mind: next,
    lesson,
  }
}
