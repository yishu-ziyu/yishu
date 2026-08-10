/**
 * Context trail + capsule surface for the Yishu product kernel.
 *
 * Evidence in, sanitized trail out. No screenshot bytes leave this module.
 */

export {
  toTrailEntry,
  truncatePreview,
  sanitizeWarnings,
  sanitizeWarningText,
  cursorRegionFromFrame,
  expireScreenshotMetadata,
  type Observed,
  type TrailSourceFrame,
  type TrailSourceApplication,
  type TrailSourceWindow,
  type TrailSourceElement,
  type TrailSourceCursor,
  type TrailSourceScreenshot,
  type TrailSourceBounds,
  type ContextTrailEntry,
  type CursorRegion,
  type CursorHorizontal,
  type CursorVertical,
  type ToTrailEntryOptions,
} from "./sanitize.js";

export {
  ContextTrail,
  type ContextTrailOptions,
  type ContextTrailQuery,
} from "./trail.js";

export {
  CONTEXT_CAPSULE_SCHEMA_VERSION,
  buildContextCapsule,
  serializeContextCapsule,
  parseContextCapsule,
  type ContextCapsule,
  type CapsuleApp,
  type CapsuleWindow,
  type CapsuleAxElement,
  type CapsuleProvenance,
  type BuildContextCapsuleInput,
} from "./capsule.js";
