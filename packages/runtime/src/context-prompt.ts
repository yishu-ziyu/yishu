import { highRiskReminder, scanForInjection, wrapUntrustedContent } from "@yishu/agent-core";
import type { ContextFrame, TurnStartCommand } from "./protocol.js";

/** Controlled memory snippet injected into a single ordinary turn prompt. */
export type PromptMemorySnippet = {
  id: string;
  claim: string;
  source: string;
  capturedAt: string;
  scope: string;
};

/** Product-kernel-only attachment; never accepted from the client wire schema. */
export const RECALLED_MEMORIES_KEY = "__yishuRecalledMemories" as const;

export type TurnStartWithRecalledMemories = TurnStartCommand & {
  payload: TurnStartCommand["payload"] & {
    [RECALLED_MEMORIES_KEY]?: readonly PromptMemorySnippet[];
  };
};

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

function memoriesFromCommand(
  command: TurnStartCommand,
): readonly PromptMemorySnippet[] {
  const payload = (command as TurnStartWithRecalledMemories).payload;
  const raw = payload[RECALLED_MEMORIES_KEY];
  return Array.isArray(raw) ? raw : [];
}

function formatMemoryBlock(memories: readonly PromptMemorySnippet[]): string[] {
  if (memories.length === 0) return [];
  const lines: string[] = [
    "The user previously asked you to remember the following durable facts.",
    "Use only the rows that are clearly relevant to the current question.",
    "Do not invent extra memories. Do not mention secret material.",
    "When a row shapes the answer, prefer applying it over generic style.",
    "",
    "<durable_memories>",
  ];
  for (const [index, memory] of memories.entries()) {
    lines.push(
      `${index + 1}. id=${memory.id}; source=${memory.source}; savedAt=${memory.capturedAt}; scope=${memory.scope}`,
      `   claim: ${memory.claim}`,
    );
  }
  lines.push("</durable_memories>", "");
  return lines;
}

export function buildGroundedPrompt(command: TurnStartCommand): string {
  const groundedContext = contextWithoutImageBytes(command.payload.contextFrame);
  const memories = memoriesFromCommand(command);
  const contextJson = JSON.stringify(groundedContext, null, 2);
  // Screen-derived context is untrusted: scan it, and when risky wrap it as
  // data (never stripped) plus prepend a reminder. Low risk stays byte-identical.
  const scan = scanForInjection(contextJson);
  const contextLines =
    scan.risk === "low"
      ? ["<context_frame>", contextJson, "</context_frame>"]
      : [wrapUntrustedContent("context_frame", contextJson)];

  return [
    ...(scan.risk === "low" ? [] : [highRiskReminder(scan)]),
    "The user is speaking while sharing the following fresh computer context.",
    "Treat observations as evidence with confidence and timestamps, not as infallible facts.",
    "",
    ...formatMemoryBlock(memories),
    ...contextLines,
    "",
    "<user_utterance>",
    command.payload.utterance,
    "</user_utterance>",
  ].join("\n");
}

export function attachRecalledMemories(
  command: TurnStartCommand,
  memories: readonly PromptMemorySnippet[],
): TurnStartWithRecalledMemories {
  if (memories.length === 0) {
    return command as TurnStartWithRecalledMemories;
  }
  return {
    ...command,
    payload: {
      ...command.payload,
      [RECALLED_MEMORIES_KEY]: memories.map((m) => ({
        id: m.id,
        claim: m.claim,
        source: m.source,
        capturedAt: m.capturedAt,
        scope: m.scope,
      })),
    },
  };
}
