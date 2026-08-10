import { randomUUID } from "node:crypto";
import type { TrailSourceFrame } from "../src/context/sanitize.js";

export function makeFrame(
  partial: {
    capturedAt?: string;
    appName?: string;
    windowTitle?: string;
    axTitle?: string;
    axValue?: string;
    withScreenshot?: boolean;
    x?: number;
    y?: number;
  } = {},
): TrailSourceFrame {
  const capturedAt = partial.capturedAt ?? new Date().toISOString();
  const expiresAt = new Date(Date.parse(capturedAt) + 60_000).toISOString();
  const frame: TrailSourceFrame = {
    frameId: randomUUID(),
    capturedAt,
    expiresAt,
    frontmostApplication: {
      value: {
        name: partial.appName ?? "Chrome",
        bundleIdentifier: "com.google.Chrome",
        processIdentifier: 1001,
      },
      source: "ax",
      capturedAt,
      confidence: 0.95,
    },
    activeWindow: {
      value: {
        title: partial.windowTitle ?? "README · yishu",
        ownerName: partial.appName ?? "Chrome",
        processIdentifier: 1001,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
      },
      source: "ax",
      capturedAt,
      confidence: 0.9,
    },
    elementUnderCursor: {
      value: {
        role: "AXStaticText",
        subrole: null,
        title: partial.axTitle ?? "Agent-native",
        description: null,
        valuePreview: partial.axValue ?? "Agent-native design notes",
      },
      source: "ax",
      capturedAt,
      confidence: 0.85,
    },
    cursor: {
      value: {
        x: partial.x ?? 720,
        y: partial.y ?? 450,
        coordinateSpace: "global-top-left",
      },
      source: "pointer",
      capturedAt,
      confidence: 1,
    },
    warnings: [],
  };

  if (partial.withScreenshot) {
    frame.screenshots = [
      {
        label: "cursor-display",
        base64Data: "QUJDREVGR0g=", // never stored in trail
        mediaType: "image/jpeg",
        displayWidthPoints: 1440,
        displayHeightPoints: 900,
      },
    ];
  }

  return frame;
}
