export {
  LEARNED_HEADING,
  MIND_HEADINGS,
  MIND_LEARN_MIN_EVIDENCE,
  MIND_PARTS,
  SEED_MIND,
  applyMindUpdate,
  isOutcomeEvidenceStatus,
  isProtectedHeading,
  key,
  mindFor,
  mindText,
  missingHeadings,
  normalizePatternKey,
  parseSections,
  revertMindSection,
  seedSection,
  summarizePatternEvidence,
  writeMindSection,
} from "./document.js"
export type {
  MindAudience,
  MindPart,
  MindSection,
  MindSectionMode,
  MindSectionUpdate,
  MindUpdate,
  PatternEvidence,
  SuggestionOutcomeStatus,
} from "./document.js"
export {
  MIND_RECALL_MAX_CHARS,
  MIND_RECALL_MAX_LESSONS,
  selectRelevantMindLessons,
} from "./recall.js"
export type { SelectRelevantMindLessonsOptions } from "./recall.js"
