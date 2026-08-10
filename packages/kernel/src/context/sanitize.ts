/**
 * Context trail sanitization.
 *
 * Strips screenshot bytes and secret-looking material from a ContextFrame-like
 * source into a compact, queryable trail entry.
 *
 * Local types mirror runtime ContextFrame fields without importing @yishu/runtime
 * (avoids circular package deps).
 */

import { sanitizePortableText } from "../store/ledger-safety.js";

export interface Observed<T> {
  value: T;
  source: string;
  capturedAt: string;
  confidence: number;
}

export interface TrailSourceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TrailSourceApplication {
  name: string;
  bundleIdentifier: string | null;
  processIdentifier: number;
}

export interface TrailSourceWindow {
  title: string | null;
  ownerName: string;
  processIdentifier: number;
  bounds: TrailSourceBounds | null;
}

export interface TrailSourceElement {
  role: string | null;
  subrole: string | null;
  title: string | null;
  description: string | null;
  valuePreview: string | null;
}

export interface TrailSourceCursor {
  x: number;
  y: number;
  coordinateSpace: string;
}

export interface TrailSourceScreenshot {
  label: string;
  base64Data: string;
  mediaType?: string;
  displayWidthPoints?: number;
  displayHeightPoints?: number;
  screenshotWidthPixels?: number;
  screenshotHeightPixels?: number;
}

/** Minimal ContextFrame-compatible shape used as trail input. */
export interface TrailSourceFrame {
  frameId: string;
  capturedAt: string;
  expiresAt: string;
  frontmostApplication: Observed<TrailSourceApplication> | null;
  activeWindow: Observed<TrailSourceWindow> | null;
  elementUnderCursor: Observed<TrailSourceElement> | null;
  screenshots?: TrailSourceScreenshot[];
  warnings?: string[];
  cursor?: Observed<TrailSourceCursor>;
}

export type CursorHorizontal = "left" | "center" | "right" | "unknown";
export type CursorVertical = "top" | "middle" | "bottom" | "unknown";

/** Combined region label, e.g. "center-middle", or "unknown" when no coords. */
export type CursorRegion =
  | `${Exclude<CursorHorizontal, "unknown">}-${Exclude<CursorVertical, "unknown">}`
  | "unknown";

export interface ContextTrailEntry {
  frameId: string;
  capturedAt: string;
  appName: string | null;
  bundleId: string | null;
  windowTitle: string | null;
  windowOwner: string | null;
  axRole: string | null;
  axTitle: string | null;
  /** Truncated to 200 chars; never raw screenshot bytes. */
  axValuePreview: string | null;
  cursorRegion: CursorRegion;
  warnings: string[];
  hasScreenshot: boolean;
  /** ISO expiry for screenshot metadata flag only; image bytes are never stored. */
  screenshotExpiresAt?: string;
}

const VALUE_PREVIEW_MAX = 200;
const DEFAULT_SCREENSHOT_TTL_MS = 30_000;

export function truncatePreview(value: string | null | undefined, max = VALUE_PREVIEW_MAX): string | null {
  if (value == null) return null;
  if (value.length <= max) return value;
  return value.slice(0, max);
}

export function sanitizeWarningText(text: string): string {
  try {
    return sanitizePortableText(text, "context warning");
  } catch {
    // Warnings are diagnostic context, not durable truth. If malformed or
    // oversized input reaches this boundary, keep only a safe marker.
    return "[omitted]";
  }
}

export function sanitizeWarnings(warnings: string[] | undefined): string[] {
  if (!warnings || warnings.length === 0) return [];
  return warnings.map(sanitizeWarningText);
}

function displaySizeFromFrame(frame: TrailSourceFrame): { width: number; height: number } | null {
  const shots = frame.screenshots;
  if (shots) {
    for (const shot of shots) {
      const w = shot.displayWidthPoints;
      const h = shot.displayHeightPoints;
      if (typeof w === "number" && typeof h === "number" && w > 0 && h > 0) {
        return { width: w, height: h };
      }
    }
  }
  const bounds = frame.activeWindow?.value.bounds;
  if (bounds && bounds.width > 0 && bounds.height > 0) {
    // Window-local size is a weak prior for global cursor; only use when nothing else exists.
    return { width: bounds.width, height: bounds.height };
  }
  return null;
}

function bucketHorizontal(ratio: number): Exclude<CursorHorizontal, "unknown"> {
  if (ratio < 1 / 3) return "left";
  if (ratio < 2 / 3) return "center";
  return "right";
}

function bucketVertical(ratio: number): Exclude<CursorVertical, "unknown"> {
  if (ratio < 1 / 3) return "top";
  if (ratio < 2 / 3) return "middle";
  return "bottom";
}

/**
 * Map cursor coords into a coarse screen region.
 * Uses display points from screenshots when available; otherwise "unknown".
 */
export function cursorRegionFromFrame(frame: TrailSourceFrame): CursorRegion {
  const cursor = frame.cursor?.value;
  if (!cursor) return "unknown";

  const size = displaySizeFromFrame(frame);
  if (!size) return "unknown";

  let y = cursor.y;
  // appkit-bottom-left: origin at bottom-left; normalize to top-left ratio space
  if (cursor.coordinateSpace === "appkit-bottom-left") {
    y = size.height - cursor.y;
  }

  const xRatio = clamp01(cursor.x / size.width);
  const yRatio = clamp01(y / size.height);
  return `${bucketHorizontal(xRatio)}-${bucketVertical(yRatio)}`;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function sanitizePortableField(
  value: string | null | undefined,
  fieldName: string,
): string | null {
  if (value == null) return null;
  try {
    return sanitizePortableText(value, fieldName);
  } catch {
    return "[omitted]";
  }
}

export interface ToTrailEntryOptions {
  /** Override "now" for screenshot TTL computation. */
  now?: Date;
  /** Screenshot metadata TTL in ms. Default 30s. */
  screenshotTtlMs?: number;
}

/**
 * Convert a source frame into a trail entry.
 * STRIPS all screenshot base64Data. Stores only metadata + hasScreenshot flag.
 */
export function toTrailEntry(
  frame: TrailSourceFrame,
  nowOrOptions?: Date | ToTrailEntryOptions,
): ContextTrailEntry {
  const options: ToTrailEntryOptions =
    nowOrOptions instanceof Date ? { now: nowOrOptions } : (nowOrOptions ?? {});
  const now = options.now ?? new Date();
  const screenshotTtlMs = options.screenshotTtlMs ?? DEFAULT_SCREENSHOT_TTL_MS;

  const app = frame.frontmostApplication?.value;
  const win = frame.activeWindow?.value;
  const el = frame.elementUnderCursor?.value;
  const hasScreenshot = Array.isArray(frame.screenshots) && frame.screenshots.length > 0;

  const entry: ContextTrailEntry = {
    frameId: frame.frameId,
    capturedAt: frame.capturedAt,
    appName: sanitizePortableField(app?.name, "trail app name"),
    bundleId: sanitizePortableField(app?.bundleIdentifier, "trail bundle id"),
    windowTitle: sanitizePortableField(win?.title, "trail window title"),
    windowOwner: sanitizePortableField(win?.ownerName, "trail window owner"),
    axRole: sanitizePortableField(el?.role, "trail AX role"),
    axTitle: sanitizePortableField(el?.title, "trail AX title"),
    axValuePreview: truncatePreview(
      sanitizePortableField(el?.valuePreview, "trail AX value preview"),
    ),
    cursorRegion: cursorRegionFromFrame(frame),
    warnings: sanitizeWarnings(frame.warnings),
    hasScreenshot,
  };

  if (hasScreenshot) {
    entry.screenshotExpiresAt = new Date(now.getTime() + screenshotTtlMs).toISOString();
  }

  return entry;
}

/**
 * Expire screenshot metadata on an entry after its TTL.
 * Mutates and returns the entry. Bytes were never stored.
 */
export function expireScreenshotMetadata(
  entry: ContextTrailEntry,
  now: Date = new Date(),
): ContextTrailEntry {
  if (!entry.hasScreenshot) return entry;
  if (!entry.screenshotExpiresAt) {
    entry.hasScreenshot = false;
    delete entry.screenshotExpiresAt;
    return entry;
  }
  if (Date.parse(entry.screenshotExpiresAt) <= now.getTime()) {
    entry.hasScreenshot = false;
    delete entry.screenshotExpiresAt;
  }
  return entry;
}
