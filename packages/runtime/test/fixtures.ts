import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION, type TurnStartCommand } from "../src/protocol.js";

export function makeTurnStartCommand(): TurnStartCommand {
  const capturedAt = new Date().toISOString();
  return {
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.start",
    requestId: randomUUID(),
    traceId: randomUUID(),
    sentAt: capturedAt,
    payload: {
      utterance: "这个按钮为什么是灰色的？",
      capabilityProfile: "conversation",
      contextFrame: {
        schemaVersion: PROTOCOL_VERSION,
        frameId: randomUUID(),
        capturedAt,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        cursor: {
          value: { x: 640, y: 420, coordinateSpace: "global-top-left" },
          source: "CGEvent",
          capturedAt,
          confidence: 1,
        },
        pointerTrail: [],
        frontmostApplication: {
          value: { name: "Preview", bundleIdentifier: "com.apple.Preview", processIdentifier: 321 },
          source: "NSWorkspace",
          capturedAt,
          confidence: 1,
        },
        activeWindow: {
          value: {
            title: "Draft.pdf",
            ownerName: "Preview",
            processIdentifier: 321,
            bounds: { x: 20, y: 40, width: 900, height: 700 },
          },
          source: "CGWindowList",
          capturedAt,
          confidence: 0.9,
        },
        elementUnderCursor: {
          value: {
            role: "AXButton",
            subrole: null,
            title: "Markup",
            description: "Show Markup Toolbar",
            valuePreview: null,
          },
          source: "Accessibility",
          capturedAt,
          confidence: 0.95,
        },
        screenshots: [{
          label: "cursor display",
          mediaType: "image/jpeg",
          base64Data: "c2NyZWVu",
          displayWidthPoints: 1440,
          displayHeightPoints: 900,
          displayOriginXPoints: 0,
          displayOriginYPoints: 0,
          screenshotWidthPixels: 1280,
          screenshotHeightPixels: 800,
        }],
        warnings: [],
      },
    },
  };
}
