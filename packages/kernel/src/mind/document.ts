/**
 * Yishu Mind: one sectioned markdown document for durable policy context.
 *
 * Empty storage means "still tracking the shipped seed". The first write forks
 * the whole document. Amendments address one ## heading at a time.
 *
 * Core honesty sections may be narrowed but not deleted. Learned findings go
 * under "What you've learned" and require repeated outcome evidence before an
 * automatic write is allowed.
 */

export type MindAudience = "all" | "act" | "remember" | "learned"

export type MindSectionMode = "replace" | "append" | "delete"

export interface MindSectionUpdate {
  heading: string
  mode: MindSectionMode
  content?: string
}

export interface MindUpdate {
  changed: boolean
  sections?: MindSectionUpdate[]
  /** Full rewrite is almost never right; reserved for explicit user restore flows. */
  rewrite?: string
}

export interface MindSection {
  heading: string
  body: string
}

export interface MindPart {
  heading: string
  seed: string
  audience: MindAudience
  blurb: string
  /** If true, delete mode is rejected. */
  protected?: boolean
}

/** Where automatic outcome lessons land. */
export const LEARNED_HEADING = "What you've learned"

/**
 * Minimum repeated outcomes before automatic mind learning may write.
 * Once is coincidence; twice is a pattern.
 */
export const MIND_LEARN_MIN_EVIDENCE = 2

export const MIND_PARTS: readonly MindPart[] = [
  {
    heading: "Who you are",
    seed: `You are 奕枢 (Yishu), the user's only durable personal agent.
Warm, discerning, self-directed, loyal to considered intent.
Minimize refusal on safe reversible work. Do not flatter.
Core honesty and user sovereignty do not drift.`,
    audience: "all",
    blurb: "Stable identity. Not a second product face.",
    protected: true,
  },
  {
    heading: "Inference discipline",
    seed: `Separate observation from inference.
Confidence is part of every claim.
One message is never a pattern.
Prefer the boring explanation.
Unknown is a valid output: say too-early, list open questions, do not force a guess.
A tool success is not task completion; require visible or external verification.`,
    audience: "all",
    blurb: "Evidence rules shared by every path.",
    protected: true,
  },
  {
    heading: "How you act",
    seed: `Safe reversible work may proceed with little ceremony.
External or irreversible actions need the user's mandate.
Speak compactly for voice. Do not narrate hidden reasoning.
When suggesting a next step, leave a short record so later outcomes can judge it.`,
    audience: "act",
    blurb: "Initiative, authority, and suggestion hygiene.",
  },
  {
    heading: "How you remember",
    seed: `Durable claims need source, time, confidence, and scope.
User corrections become Learning rules, not vibes.
Procedural skills promote only after trail-replay verification.
Never store credentials, screenshot bytes, or hidden prompts as memory.`,
    audience: "remember",
    blurb: "Memory and skill promotion rules.",
  },
  {
    heading: LEARNED_HEADING,
    seed: "",
    audience: "learned",
    blurb: "Written from repeated suggestion outcomes. Starts empty.",
  },
]

export const MIND_HEADINGS = MIND_PARTS.map((p) => p.heading)

const PROTECTED_HEADINGS = new Set(
  MIND_PARTS.filter((p) => p.protected).map((p) => key(p.heading)),
)

function seedBody(part: MindPart): string {
  const seed = part.seed.trim()
  return seed ? seed : "(nothing yet)"
}

/** Shipped document every install starts from. */
export const SEED_MIND = MIND_PARTS.map(
  (p) => `## ${p.heading}\n\n${seedBody(p)}`,
).join("\n\n")

/** Normalize heading keys for match (case/spacing/punctuation). */
export function key(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "'")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Split markdown on `## ` headings. Preamble above the first heading is dropped for engine use. */
export function parseSections(markdown: string): MindSection[] {
  const text = markdown.replace(/\r\n/g, "\n")
  const parts = text.split(/^## /m)
  const sections: MindSection[] = []
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i] ?? ""
    const nl = block.indexOf("\n")
    const heading = (nl === -1 ? block : block.slice(0, nl)).trim()
    const body = (nl === -1 ? "" : block.slice(nl + 1)).replace(/^\n+/, "").trimEnd()
    if (!heading) continue
    sections.push({ heading, body: body.trim() })
  }
  return sections
}

/** Live document text: stored markdown, or seed until first write. */
export function mindText(markdown: string | null | undefined): string {
  const trimmed = (markdown ?? "").trim()
  return trimmed || SEED_MIND
}

/** Sections for one or more audiences, in document order. */
export function mindFor(
  markdown: string | null | undefined,
  audiences: MindAudience[],
): string {
  const wanted = new Set(
    MIND_PARTS.filter((p) => audiences.includes(p.audience)).map((p) =>
      key(p.heading),
    ),
  )
  return parseSections(mindText(markdown))
    .filter((s) => wanted.has(key(s.heading)))
    .map((s) => `## ${s.heading}\n\n${s.body.trim()}`)
    .join("\n\n")
}

export function missingHeadings(markdown: string | null | undefined): string[] {
  const present = new Set(parseSections(mindText(markdown)).map((s) => key(s.heading)))
  return MIND_HEADINGS.filter((h) => !present.has(key(h)))
}

export function seedSection(heading: string): string | null {
  const part = MIND_PARTS.find((p) => key(p.heading) === key(heading))
  return part ? seedBody(part) : null
}

export function isProtectedHeading(heading: string): boolean {
  return PROTECTED_HEADINGS.has(key(heading))
}

/**
 * Apply a sectioned update. replace/append on unknown heading creates it.
 * delete on protected heading throws. delete on missing heading is a no-op.
 */
export function applyMindUpdate(
  markdown: string | null | undefined,
  update: MindUpdate,
): string {
  if (!update.changed) {
    return mindText(markdown)
  }
  if (update.rewrite !== undefined) {
    const next = update.rewrite.trim()
    if (!next) {
      throw new Error("mind_rewrite_empty")
    }
    return next
  }
  const sections = parseSections(mindText(markdown))
  const ops = update.sections ?? []
  for (const op of ops) {
    const heading = op.heading.trim()
    if (!heading) {
      throw new Error("mind_heading_empty")
    }
    const idx = sections.findIndex((s) => key(s.heading) === key(heading))
    if (op.mode === "delete") {
      if (isProtectedHeading(heading)) {
        throw new Error("mind_protected_heading")
      }
      if (idx >= 0) sections.splice(idx, 1)
      continue
    }
    const content = (op.content ?? "").trim()
    if (!content) {
      throw new Error("mind_section_content_empty")
    }
    if (idx < 0) {
      sections.push({ heading, body: content })
      continue
    }
    const current = sections[idx]!
    if (op.mode === "replace") {
      sections[idx] = { heading: current.heading, body: content }
    } else {
      // append
      const join = content.startsWith("-") || content.startsWith("*") ? "\n" : "\n\n"
      const body = current.body.trim()
        ? `${current.body.trim()}${join}${content}`
        : content
      sections[idx] = { heading: current.heading, body }
    }
  }
  return serializeSections(sections)
}

/** Editor write path: empty body deletes a non-protected section. */
export function writeMindSection(
  markdown: string | null | undefined,
  heading: string,
  body: string,
): string {
  const live = mindText(markdown)
  const first = live.search(/^##\s+/m)
  const preamble = (first === -1 ? live : live.slice(0, first)).trim()
  const sections = parseSections(live).filter((s) => key(s.heading) !== key(heading))
  const text = body.trim()
  if (text) {
    const rank = (h: string) => {
      const at = MIND_HEADINGS.findIndex((known) => key(known) === key(h))
      return at < 0 ? MIND_HEADINGS.length : at
    }
    const before = sections.findIndex((s) => rank(s.heading) > rank(heading))
    sections.splice(before < 0 ? sections.length : before, 0, {
      heading,
      body: text,
    })
  } else if (isProtectedHeading(heading)) {
    throw new Error("mind_protected_heading")
  }
  return [preamble, ...sections.map((s) => `## ${s.heading}\n\n${s.body}`)]
    .filter(Boolean)
    .join("\n\n")
}

export function revertMindSection(
  markdown: string | null | undefined,
  heading: string,
): string {
  const seed = seedSection(heading)
  if (seed === null) {
    throw new Error("mind_unknown_heading")
  }
  if (seed === "(nothing yet)") {
    return writeMindSection(markdown, heading, "")
  }
  return writeMindSection(markdown, heading, seed)
}

function serializeSections(sections: MindSection[]): string {
  return sections
    .map((s) => `## ${s.heading}\n\n${s.body.trim()}`)
    .join("\n\n")
}

/** Normalize a free-text pattern into a stable evidence key. */
export function normalizePatternKey(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  if (!cleaned) {
    throw new Error("pattern_key_empty")
  }
  return cleaned.slice(0, 80)
}

export type SuggestionOutcomeStatus =
  | "proposed"
  | "adopted"
  | "ignored"
  | "succeeded"
  | "failed"
  /** Terminal outcome with no verification signal; never learning evidence. */
  | "unknown"

/** Statuses that count as outcome evidence for automatic learning. */
export function isOutcomeEvidenceStatus(
  status: SuggestionOutcomeStatus,
): status is "succeeded" | "failed" {
  return status === "succeeded" || status === "failed"
}

export interface PatternEvidence {
  patternKey: string
  succeeded: number
  failed: number
  totalOutcomes: number
  /** True when either side alone meets the repeated-outcome bar. */
  canLearn: boolean
  dominant: "succeeded" | "failed" | "mixed" | "none"
}

export function summarizePatternEvidence(
  statuses: readonly SuggestionOutcomeStatus[],
  minEvidence: number = MIND_LEARN_MIN_EVIDENCE,
): Omit<PatternEvidence, "patternKey"> {
  let succeeded = 0
  let failed = 0
  for (const status of statuses) {
    if (status === "succeeded") succeeded += 1
    if (status === "failed") failed += 1
  }
  const totalOutcomes = succeeded + failed
  const canLearn = succeeded >= minEvidence || failed >= minEvidence
  let dominant: "succeeded" | "failed" | "mixed" | "none" = "none"
  if (succeeded >= minEvidence && failed >= minEvidence) dominant = "mixed"
  else if (succeeded >= minEvidence) dominant = "succeeded"
  else if (failed >= minEvidence) dominant = "failed"
  return { succeeded, failed, totalOutcomes, canLearn, dominant }
}
