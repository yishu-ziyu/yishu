import { randomUUID } from "node:crypto"
import type { SkillCandidate, SkillStep } from "./types.js"
import { assertPersistableSafeText } from "./ledger-safety.js"

/** Minimal trail entry used to invent a skill candidate. */
export interface TrailEntry {
  capturedAt: string
  appName?: string
  windowTitle?: string
  axPreview?: string
  url?: string
  note?: string
  [key: string]: unknown
}

export interface ExtractProcedureOptions {
  name?: string
  triggerPhrase?: string
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64)
  return slug.length > 0 ? slug : "procedure_from_trail"
}

function safeTrailText(value: unknown, fieldName: string): string {
  if (value === undefined || value === null) return ""
  assertPersistableSafeText(value, fieldName)
  return value.trim()
}

function assertSafeCandidate(candidate: SkillCandidate): void {
  assertPersistableSafeText(candidate.name, "skill name")
  if (candidate.triggerPhrase !== undefined) {
    assertPersistableSafeText(candidate.triggerPhrase, "skill trigger phrase")
  }
  for (const [index, step] of candidate.steps.entries()) {
    assertPersistableSafeText(step.description, `skill step ${index}`)
  }
  for (const [key, value] of Object.entries(candidate.conditions)) {
    assertPersistableSafeText(value, `skill condition ${key}`)
  }
  for (const [index, value] of candidate.verification.entries()) {
    assertPersistableSafeText(value, `skill verification ${index}`)
  }
  assertPersistableSafeText(candidate.sourceTrailFrom, "skill trail start")
  assertPersistableSafeText(candidate.sourceTrailTo, "skill trail end")
}

function segmentKey(entry: TrailEntry): string {
  const app = (entry.appName ?? "").trim()
  if (app.length > 0) return app
  const title = (entry.windowTitle ?? "").trim()
  if (title.length > 0) return `window:${title}`
  return "unknown"
}

function displayKey(key: string): string {
  return key.startsWith("window:") ? key.slice("window:".length) : key
}

function stepDescription(entries: TrailEntry[], appKey: string): string {
  const titles = entries
    .map((e) => (e.windowTitle ?? "").trim())
    .filter((t) => t.length > 0)
  const uniqueTitles = [...new Set(titles)].slice(0, 3)
  const appLabel = displayKey(appKey)

  if (uniqueTitles.length === 0) {
    return `Work in ${appLabel}`
  }
  if (uniqueTitles.length === 1) {
    return `In ${appLabel}: ${uniqueTitles[0]}`
  }
  return `In ${appLabel}: ${uniqueTitles.join(" → ")}`
}

/**
 * Heuristic extraction: consecutive same-app segments become steps.
 * - first app open: resolve
 * - app switches: act
 * - continued same-app observation (multi-entry single app): observe
 */
export function extractProcedureFromTrail(
  entries: TrailEntry[],
  options?: ExtractProcedureOptions,
): SkillCandidate {
  if (options?.name !== undefined) {
    assertPersistableSafeText(options.name, "skill name")
  }
  if (options?.triggerPhrase !== undefined) {
    assertPersistableSafeText(options.triggerPhrase, "skill trigger phrase")
  }
  // Validate every source text before deriving titles, domains, or step
  // descriptions. Direct callers can bypass ContextTrail, so extraction is a
  // second fail-closed boundary before the candidate reaches a Store.
  for (const [index, entry] of entries.entries()) {
    safeTrailText(entry.capturedAt, `trail ${index} captured at`)
    safeTrailText(entry.appName, `trail ${index} app name`)
    safeTrailText(entry.windowTitle, `trail ${index} window title`)
    safeTrailText(entry.axPreview, `trail ${index} AX preview`)
    safeTrailText(entry.url, `trail ${index} URL`)
    safeTrailText(entry.note, `trail ${index} note`)
  }
  const ordered = [...entries].sort((a, b) =>
    a.capturedAt.localeCompare(b.capturedAt),
  )

  // Group consecutive same-app segments
  const segments: Array<{ key: string; entries: TrailEntry[] }> = []
  for (const entry of ordered) {
    const key = segmentKey(entry)
    const last = segments[segments.length - 1]
    if (last && last.key === key) {
      last.entries.push(entry)
    } else {
      segments.push({ key, entries: [entry] })
    }
  }

  const steps: SkillStep[] = []

  if (segments.length === 0) {
    steps.push({
      id: randomUUID(),
      description: "Empty trail - no observable steps",
      kind: "other",
    })
  } else if (segments.length === 1) {
    // Single app: resolve open, then observe if trail has depth
    const only = segments[0]!
    steps.push({
      id: randomUUID(),
      description: stepDescription(only.entries, only.key),
      kind: "resolve",
    })
    if (only.entries.length > 1) {
      steps.push({
        id: randomUUID(),
        description: `Observe activity in ${displayKey(only.key)}`,
        kind: "observe",
      })
    }
  } else {
    // Multi-app: first resolve, subsequent switches act
    for (let index = 0; index < segments.length; index++) {
      const seg = segments[index]!
      const kind: SkillStep["kind"] = index === 0 ? "resolve" : "act"
      steps.push({
        id: randomUUID(),
        description: stepDescription(seg.entries, seg.key),
        kind,
      })
    }
  }

  // Conditions from most common app / domain-like window titles
  const appCounts = new Map<string, number>()
  const titleCounts = new Map<string, number>()
  for (const entry of ordered) {
    const app = (entry.appName ?? "").trim()
    if (app) appCounts.set(app, (appCounts.get(app) ?? 0) + 1)
    const title = (entry.windowTitle ?? "").trim()
    if (title) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1)
    const url = typeof entry.url === "string" ? entry.url.trim() : ""
    if (url) {
      try {
        const host = new URL(url).hostname
        if (host) titleCounts.set(host, (titleCounts.get(host) ?? 0) + 1)
      } catch {
        // ignore invalid urls
      }
    }
  }

  const topApp = [...appCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const topTitle = [...titleCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]

  const conditions: Record<string, string> = {}
  if (topApp) conditions.app = topApp
  if (topTitle) conditions.windowOrDomain = topTitle

  const name =
    options?.name ??
    (options?.triggerPhrase
      ? slugify(options.triggerPhrase)
      : "procedure_from_trail")

  const from = ordered[0]?.capturedAt ?? new Date().toISOString()
  const to = ordered[ordered.length - 1]?.capturedAt ?? from

  const candidate: SkillCandidate = {
    id: randomUUID(),
    name,
    steps,
    conditions,
    verification: ["trail_covers_steps", "user_confirmed"],
    sourceTrailFrom: from,
    sourceTrailTo: to,
    status: "candidate",
    createdAt: new Date().toISOString(),
  }

  if (options?.triggerPhrase !== undefined) {
    candidate.triggerPhrase = options.triggerPhrase
  }

  assertSafeCandidate(candidate)
  return candidate
}
