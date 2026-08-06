import type { ContextFrame, TurnStartCommand } from "./protocol.js";

function contextWithoutImageBytes(contextFrame: ContextFrame): Record<string, unknown> {
  return {
    schemaVersion: contextFrame.schemaVersion,
    frameId: contextFrame.frameId,
    capturedAt: contextFrame.capturedAt,
    expiresAt: contextFrame.expiresAt,
    cursor: contextFrame.cursor,
    pointerTrail: contextFrame.pointerTrail,
    frontmostApplication: contextFrame.frontmostApplication,
    activeWindow: contextFrame.activeWindow,
    elementUnderCursor: contextFrame.elementUnderCursor,
    screenshots: contextFrame.screenshots.map(({ base64Data: _base64Data, ...metadata }) => metadata),
    warnings: contextFrame.warnings,
  };
}

export function buildGroundedPrompt(command: TurnStartCommand): string {
  const groundedContext = contextWithoutImageBytes(command.payload.contextFrame);

  return [
    "The user is speaking while sharing the following fresh computer context.",
    "Treat observations as evidence with confidence and timestamps, not as infallible facts.",
    "",
    "<context_frame>",
    JSON.stringify(groundedContext, null, 2),
    "</context_frame>",
    "",
    "<user_utterance>",
    command.payload.utterance,
    "</user_utterance>",
  ].join("\n");
}

