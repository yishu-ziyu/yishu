/**
 * ContextCapsule: a short-lived, sanitized context pack for a single turn
 * or handoff. No raw screenshots, no credentials.
 */

import { randomUUID } from "node:crypto";

import type { ContextTrail } from "./trail.js";
import type { ContextTrailEntry, CursorRegion, TrailSourceFrame } from "./sanitize.js";
import { sanitizeWarningText, truncatePreview } from "./sanitize.js";
import {
  assertPersistableSafeText,
  SENSITIVE_CONTENT_REJECTED,
  sanitizePortableText,
} from "../store/ledger-safety.js";
import {
  cloneSessionScope,
  normalizeSessionScope,
  sessionScopesEqual,
  type SessionScope,
} from "../session-scope.js";

export const CONTEXT_CAPSULE_SCHEMA_VERSION = 1 as const;

export interface CapsuleApp {
  name: string;
  bundleIdentifier: string | null;
}

export interface CapsuleWindow {
  title: string | null;
  ownerName: string;
}

export interface CapsuleAxElement {
  role: string | null;
  title: string | null;
  valuePreview: string | null;
}

export interface CapsuleProvenance {
  source: "yishu";
  frameId?: string;
  trailEntryCount: number;
}

export interface ContextCapsule {
  schemaVersion: typeof CONTEXT_CAPSULE_SCHEMA_VERSION;
  capsuleId: string;
  createdAt: string;
  expiresAt: string;
  sessionScope: SessionScope;
  userIntent?: string;
  frontmostApp?: CapsuleApp;
  window?: CapsuleWindow;
  selectedText?: string;
  axElement?: CapsuleAxElement;
  projectHint?: string;
  recentTrail: ContextTrailEntry[];
  provenance: CapsuleProvenance;
}

export interface BuildContextCapsuleInput {
  frame?: TrailSourceFrame;
  trail: ContextTrail;
  /** Exact product scope whose trail may enter this capsule. */
  sessionScope: SessionScope;
  userIntent?: string;
  projectHint?: string;
  /** How many minutes of trail to include. Default 5. */
  recentMinutes?: number;
  /** Capsule TTL in ms. Default 15 minutes. */
  ttlMs?: number;
  now?: Date;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_RECENT_MINUTES = 5;

function safeCapsuleText(
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

function safeCapsuleTrailEntry(entry: ContextTrailEntry): ContextTrailEntry {
  return {
    ...entry,
    appName: safeCapsuleText(entry.appName, "capsule trail app name"),
    bundleId: safeCapsuleText(entry.bundleId, "capsule trail bundle id"),
    windowTitle: safeCapsuleText(entry.windowTitle, "capsule trail window title"),
    windowOwner: safeCapsuleText(entry.windowOwner, "capsule trail window owner"),
    axRole: safeCapsuleText(entry.axRole, "capsule trail AX role"),
    axTitle: safeCapsuleText(entry.axTitle, "capsule trail AX title"),
    axValuePreview: safeCapsuleText(entry.axValuePreview, "capsule trail AX value preview"),
    warnings: entry.warnings.map((warning) => sanitizeWarningText(warning)),
  };
}

/**
 * Build a ContextCapsule from an optional live frame + the rolling trail.
 * Screenshot bytes are never included.
 */
export function buildContextCapsule(input: BuildContextCapsuleInput): ContextCapsule {
  if (input.sessionScope.kind === "private") {
    throw new Error("ContextCapsule: private scope is not shareable");
  }
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const recentMinutes = input.recentMinutes ?? DEFAULT_RECENT_MINUTES;
  const recentTrail = input.trail
    .recentMinutes(recentMinutes, input.sessionScope, now)
    .map(safeCapsuleTrailEntry);
  const frame = input.frame;

  const capsule: ContextCapsule = {
    schemaVersion: CONTEXT_CAPSULE_SCHEMA_VERSION,
    capsuleId: randomUUID(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    sessionScope: cloneSessionScope(input.sessionScope),
    recentTrail,
    provenance: {
      source: "yishu",
      trailEntryCount: recentTrail.length,
    },
  };

  if (input.userIntent != null && input.userIntent.length > 0) {
    capsule.userIntent = safeCapsuleText(input.userIntent, "capsule user intent") ?? "[omitted]";
  }
  if (input.projectHint != null && input.projectHint.length > 0) {
    capsule.projectHint = safeCapsuleText(input.projectHint, "capsule project hint") ?? "[omitted]";
  }
  if (frame?.frameId) {
    const frameId = safeCapsuleText(frame.frameId, "capsule frame id");
    if (frameId != null) capsule.provenance.frameId = frameId;
  }

  const app = frame?.frontmostApplication?.value;
  if (app) {
    capsule.frontmostApp = {
      name: safeCapsuleText(app.name, "capsule app name") ?? "[omitted]",
      bundleIdentifier: safeCapsuleText(app.bundleIdentifier, "capsule bundle id"),
    };
  }

  const win = frame?.activeWindow?.value;
  if (win) {
    capsule.window = {
      title: safeCapsuleText(win.title, "capsule window title"),
      ownerName: safeCapsuleText(win.ownerName, "capsule window owner") ?? "[omitted]",
    };
  }

  const el = frame?.elementUnderCursor?.value;
  if (el) {
    const valuePreview = truncatePreview(
      safeCapsuleText(el.valuePreview, "capsule AX value preview"),
    );
    capsule.axElement = {
      role: safeCapsuleText(el.role, "capsule AX role"),
      title: safeCapsuleText(el.title, "capsule AX title"),
      valuePreview,
    };
    if (valuePreview != null && valuePreview.length > 0) {
      capsule.selectedText = valuePreview;
    }
  }

  return capsule;
}

export function serializeContextCapsule(capsule: ContextCapsule): string {
  const json = JSON.stringify(capsule, null, 2);
  // Treat serialization as another boundary: typed callers can still pass a
  // hand-built object that bypassed buildContextCapsule.
  const parsed = parseContextCapsule(json);
  // Return the validated projection rather than the caller's object so
  // unknown fields cannot smuggle private payloads across the handoff.
  return JSON.stringify(parsed, null, 2);
}

/**
 * Parse + basic structural validation.
 * Rejects capsules that still carry screenshot bytes or credential fields.
 */
export function parseContextCapsule(json: string): ContextCapsule {
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch {
    throw new Error("ContextCapsule: invalid JSON");
  }

  if (!isRecord(raw)) {
    throw new Error("ContextCapsule: root must be an object");
  }

  if (raw.schemaVersion !== CONTEXT_CAPSULE_SCHEMA_VERSION) {
    throw new Error("ContextCapsule: unsupported schemaVersion");
  }
  if (typeof raw.capsuleId !== "string" || raw.capsuleId.length === 0) {
    throw new Error("ContextCapsule: capsuleId required");
  }
  assertPersistableSafeText(raw.capsuleId, "capsule id");
  if (typeof raw.createdAt !== "string" || Number.isNaN(Date.parse(raw.createdAt))) {
    throw new Error("ContextCapsule: createdAt must be ISO datetime");
  }
  if (typeof raw.expiresAt !== "string" || Number.isNaN(Date.parse(raw.expiresAt))) {
    throw new Error("ContextCapsule: expiresAt must be ISO datetime");
  }
  if (raw.sessionScope === undefined) {
    throw new Error("ContextCapsule: sessionScope required");
  }
  const sessionScope = normalizeSessionScope(raw.sessionScope);
  if (sessionScope.kind === "private") {
    throw new Error("ContextCapsule: private scope is not shareable");
  }
  if (!Array.isArray(raw.recentTrail)) {
    throw new Error("ContextCapsule: recentTrail must be an array");
  }
  if (!isRecord(raw.provenance) || raw.provenance.source !== "yishu") {
    throw new Error('ContextCapsule: provenance.source must be "yishu"');
  }
  if (typeof raw.provenance.trailEntryCount !== "number") {
    throw new Error("ContextCapsule: provenance.trailEntryCount required");
  }

  // Hard reject any accidental image / credential payload. Key names are
  // never included in the error so a caller cannot learn a secret fragment.
  const bannedKeys = [
    "base64Data",
    "password",
    "apiKey",
    "accessToken",
    "credential",
    "screenshot",
    "systemPrompt",
    "chainOfThought",
  ];
  const blob = JSON.stringify(raw);
  for (const key of bannedKeys) {
    if (blob.includes(`"${key}"`)) {
      throw new Error(SENSITIVE_CONTENT_REJECTED);
    }
  }

  const provenance: CapsuleProvenance = {
    source: "yishu",
    trailEntryCount: raw.provenance.trailEntryCount,
  };
  if (typeof raw.provenance.frameId === "string") {
    assertPersistableSafeText(raw.provenance.frameId, "capsule frame id");
    provenance.frameId = raw.provenance.frameId;
  }

  const capsule: ContextCapsule = {
    schemaVersion: CONTEXT_CAPSULE_SCHEMA_VERSION,
    capsuleId: raw.capsuleId,
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
    sessionScope,
    recentTrail: parseTrailEntries(raw.recentTrail, sessionScope),
    provenance,
  };

  if (typeof raw.userIntent === "string") {
    assertPersistableSafeText(raw.userIntent, "capsule user intent");
    capsule.userIntent = raw.userIntent;
  }
  if (typeof raw.projectHint === "string") {
    assertPersistableSafeText(raw.projectHint, "capsule project hint");
    capsule.projectHint = raw.projectHint;
  }
  if (typeof raw.selectedText === "string") {
    assertPersistableSafeText(raw.selectedText, "capsule selected text");
    capsule.selectedText = raw.selectedText;
  }

  if (isRecord(raw.frontmostApp) && typeof raw.frontmostApp.name === "string") {
    assertPersistableSafeText(raw.frontmostApp.name, "capsule app name");
    if (raw.frontmostApp.bundleIdentifier !== null && raw.frontmostApp.bundleIdentifier !== undefined) {
      assertPersistableSafeText(raw.frontmostApp.bundleIdentifier, "capsule bundle id");
    }
    capsule.frontmostApp = {
      name: raw.frontmostApp.name,
      bundleIdentifier:
        raw.frontmostApp.bundleIdentifier === null || typeof raw.frontmostApp.bundleIdentifier === "string"
          ? (raw.frontmostApp.bundleIdentifier as string | null)
          : null,
    };
  }

  if (isRecord(raw.window) && typeof raw.window.ownerName === "string") {
    assertPersistableSafeText(raw.window.ownerName, "capsule window owner");
    if (typeof raw.window.title === "string") {
      assertPersistableSafeText(raw.window.title, "capsule window title");
    }
    capsule.window = {
      title: typeof raw.window.title === "string" || raw.window.title === null
        ? (raw.window.title as string | null)
        : null,
      ownerName: raw.window.ownerName,
    };
  }

  if (isRecord(raw.axElement)) {
    for (const [key, value] of Object.entries(raw.axElement)) {
      if (value !== null && value !== undefined) {
        assertPersistableSafeText(value, `capsule AX ${key}`);
      }
    }
    capsule.axElement = {
      role: stringOrNull(raw.axElement.role),
      title: stringOrNull(raw.axElement.title),
      valuePreview: stringOrNull(raw.axElement.valuePreview),
    };
  }

  return capsule;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTrailEntries(raw: unknown, capsuleScope: SessionScope): ContextTrailEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error(SENSITIVE_CONTENT_REJECTED);
  }
  return raw.map((value, index) => {
    if (!isRecord(value)) {
      throw new Error(SENSITIVE_CONTENT_REJECTED);
    }
    const text = (key: string, fallback: string | null): string | null => {
      const candidate = value[key];
      if (candidate === undefined || candidate === null) return fallback;
      assertPersistableSafeText(candidate, `capsule trail ${index} ${key}`);
      return candidate;
    };
    const warningsValue = value.warnings;
    if (warningsValue !== undefined && !Array.isArray(warningsValue)) {
      throw new Error(SENSITIVE_CONTENT_REJECTED);
    }
    const warnings = (warningsValue ?? []).map((warning, warningIndex) => {
      assertPersistableSafeText(warning, `capsule trail ${index} warning ${warningIndex}`);
      return warning;
    });
    const cursorRegionValue = value.cursorRegion;
    const cursorRegion: CursorRegion =
      cursorRegionValue === "left-top" ||
      cursorRegionValue === "center-top" ||
      cursorRegionValue === "right-top" ||
      cursorRegionValue === "left-middle" ||
      cursorRegionValue === "center-middle" ||
      cursorRegionValue === "right-middle" ||
      cursorRegionValue === "left-bottom" ||
      cursorRegionValue === "center-bottom" ||
      cursorRegionValue === "right-bottom"
        ? cursorRegionValue
        : "unknown";
    const screenshotExpiresAt = text("screenshotExpiresAt", null);
    if (value.sessionScope === undefined) {
      throw new Error(SENSITIVE_CONTENT_REJECTED);
    }
    const sessionScope = normalizeSessionScope(value.sessionScope);
    if (sessionScope.kind === "private" || !sessionScopesEqual(sessionScope, capsuleScope)) {
      throw new Error(SENSITIVE_CONTENT_REJECTED);
    }
    const entry: ContextTrailEntry = {
      sessionScope,
      frameId: text("frameId", "unknown") ?? "unknown",
      capturedAt: text("capturedAt", "") ?? "",
      appName: text("appName", null),
      bundleId: text("bundleId", null),
      windowTitle: text("windowTitle", null),
      windowOwner: text("windowOwner", null),
      axRole: text("axRole", null),
      axTitle: text("axTitle", null),
      axValuePreview: text("axValuePreview", null),
      cursorRegion,
      warnings,
      hasScreenshot: value.hasScreenshot === true,
    };
    if (screenshotExpiresAt !== undefined && screenshotExpiresAt !== null) {
      entry.screenshotExpiresAt = screenshotExpiresAt;
    }
    return entry;
  });
}

function stringOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string") return value;
  return null;
}
