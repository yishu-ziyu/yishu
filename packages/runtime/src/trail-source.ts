import type { TrailSourceFrame } from "@yishu/kernel";
import type { ContextFrame } from "./protocol.js";

/**
 * Project a wire ContextFrame into the kernel trail-source shape. Shared by
 * the trail observer and the delegation handoff (capsule frame input).
 */
export function contextFrameToTrailSource(frame: ContextFrame): TrailSourceFrame {
  return {
    frameId: frame.frameId,
    capturedAt: frame.capturedAt,
    expiresAt: frame.expiresAt,
    frontmostApplication: frame.frontmostApplication,
    activeWindow: frame.activeWindow,
    elementUnderCursor: frame.elementUnderCursor,
    cursor: frame.cursor,
    screenshots: frame.screenshots.map((s) => ({
      label: s.label,
      base64Data: s.base64Data,
      mediaType: s.mediaType,
      displayWidthPoints: s.displayWidthPoints,
      displayHeightPoints: s.displayHeightPoints,
      ...(s.displayOriginXPoints === undefined
        ? {}
        : { displayOriginXPoints: s.displayOriginXPoints }),
      ...(s.displayOriginYPoints === undefined
        ? {}
        : { displayOriginYPoints: s.displayOriginYPoints }),
      screenshotWidthPixels: s.screenshotWidthPixels,
      screenshotHeightPixels: s.screenshotHeightPixels,
    })),
    warnings: frame.warnings,
  };
}
