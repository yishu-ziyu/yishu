/**
 * Bounded recall of learned Mind lessons for ordinary product turns.
 *
 * Closes the experience → mind → decision loop with the smallest possible
 * read side: only bullet lines under "What you've learned" are eligible;
 * seed and protected sections never surface. Relevance is deterministic
 * token overlap with the user utterance — no embeddings, no new store.
 */

import { LEARNED_HEADING, key, mindText, parseSections } from "./document.js"

export const MIND_RECALL_MAX_LESSONS = 3
export const MIND_RECALL_MAX_CHARS = 600

export interface SelectRelevantMindLessonsOptions {
  maxLessons?: number
  maxChars?: number
}

/**
 * Pick the most relevant learned lessons for one utterance, in document
 * order on ties. Lessons are whole bullet lines (marker stripped); the
 * returned list is truncated at the bounds, never a lesson itself — when the
 * first lesson alone exceeds maxChars it is still returned whole.
 */
export function selectRelevantMindLessons(
  markdown: string,
  query: string,
  opts: SelectRelevantMindLessonsOptions = {},
): string[] {
  const queryTokens = recallTokens(query)
  if (queryTokens.size === 0) return []

  const lessons = learnedLessonLines(markdown)
  if (lessons.length === 0) return []

  const maxLessons = normalizeBound(opts.maxLessons, MIND_RECALL_MAX_LESSONS)
  const maxChars = normalizeBound(opts.maxChars, MIND_RECALL_MAX_CHARS)

  const scored = lessons
    .map((lesson, index) => ({
      lesson,
      index,
      score: overlapScore(queryTokens, recallTokens(lesson)),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)

  const selected: string[] = []
  let totalChars = 0
  for (const row of scored) {
    if (selected.length >= maxLessons) break
    if (selected.length > 0 && totalChars + row.lesson.length > maxChars) break
    selected.push(row.lesson)
    totalChars += row.lesson.length
  }
  return selected
}

/** Bullet lines of the learned section only; empty when absent or seed-only. */
function learnedLessonLines(markdown: string): string[] {
  const section = parseSections(mindText(markdown)).find(
    (s) => key(s.heading) === key(LEARNED_HEADING),
  )
  if (!section) return []
  return section.body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") || line.startsWith("* "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0)
}

/** Distinct lowercase alphanumeric tokens (CJK runs count), min length 2. */
function recallTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const match of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (match.length >= 2) tokens.add(match)
  }
  return tokens
}

function overlapScore(queryTokens: Set<string>, lessonTokens: Set<string>): number {
  let score = 0
  for (const token of queryTokens) {
    if (lessonTokens.has(token)) score += 1
  }
  return score
}

function normalizeBound(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.trunc(value))
}
