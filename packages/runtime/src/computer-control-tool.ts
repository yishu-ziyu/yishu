import { Type } from "typebox";
import type { ToolDefinition } from "./model-loop/types.js";
import type { ComputerAction } from "./protocol.js";
import type { ComputerActionResult } from "./computer-use-port.js";

export type ComputerControlToolAction =
  | Extract<ComputerAction, { action: "left_click" }>
  | { action: "set_text"; text: string };

const computerControlParameters = Type.Union([
  Type.Object({
    action: Type.Literal("left_click"),
    targetId: Type.String({
      pattern: "^[1-9][0-9]?$",
      description: "Numbered AX target id from the current Context Frame numberedTargets list.",
    }),
    label: Type.Optional(Type.String({ maxLength: 120, description: "Short visible label of the target." })),
  }),
  Type.Object({
    action: Type.Literal("set_text"),
    text: Type.String({
      minLength: 1,
      maxLength: 10_000,
      description: "Exact text explicitly requested by the user.",
    }),
  }),
]);

export function createComputerControlTool(
  perform: (action: ComputerControlToolAction, signal?: AbortSignal) => Promise<ComputerActionResult>,
): ToolDefinition<typeof computerControlParameters, ComputerActionResult> {
  return {
    name: "computer_control",
    label: "Computer control",
    description: [
      "Press a visible macOS control or set the freshly focused editable text element.",
      "left_click uses targetId from Context Frame numberedTargets. Do not guess screenshot pixels.",
      "Use only when the user directly asks to click, press, or input exact text.",
      "For set_text, provide only the requested text. The runtime owns the target app identity.",
      "Native commands, target process IDs, and target bundle IDs are not accepted.",
    ].join(" "),
    promptSnippet: "Perform an explicitly requested click or focused text input through numbered accessibility targets.",
    promptGuidelines: [
      "Call computer_control instead of printing XML, HTML, JSON, coordinates, or tool syntax.",
      "For left_click, pass targetId from numberedTargets. Never pass screenshot coordinates.",
      "If numberedTargets is empty or warnings include ax-unreadable, say the window is not readable. Do not pixel-click.",
      "Call set_text only for explicit user-requested text input; never infer or invent text to enter.",
      "For 'input ... then click ...', execute each step sequentially and rely on each returned read-back.",
      "After a verified click, phrase a brief natural confirmation in your own words. One to three words is enough.",
      "When any result is unverified, you must not claim success. Say the effect was delivered but not confirmed, in your own words.",
      "After every action, use the fresh observation in the tool result. Do not reuse turn-start numberedTargets.",
    ],
    parameters: computerControlParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const result = await perform(params, signal);
      const status = result.status
        ?? (result.verified ? "verified" : result.succeeded ? "delivered" : "failed");
      const terminalFailure = status === "blocked"
        || status === "stale"
        || status === "cancelled"
        || status === "failed";
      if (!result.succeeded || terminalFailure) {
        throw new Error(`${result.message}${result.code ? ` (${result.code})` : ""}`);
      }

      const actionLabel = params.action === "set_text" ? "Text input" : "Click";
      const observation = formatFreshObservation(result);
      const text = result.verified
        ? `${actionLabel} succeeded and read-back was verified. ${result.evidence ?? result.message}${observation}`
        : `${actionLabel} was delivered but the outcome is unverified. Do not claim completion. ${result.evidence ?? result.message}${observation}`;
      return {
        content: [{ type: "text", text }],
        details: result,
        ...(result.screenshots && result.screenshots.length > 0
          ? {
              images: result.screenshots.map((screenshot) => ({
                type: "image" as const,
                data: screenshot.base64Data,
                mimeType: screenshot.mediaType,
                label: `${screenshot.label} (image dimensions: ${screenshot.screenshotWidthPixels}x${screenshot.screenshotHeightPixels} pixels)`,
              })),
            }
          : {}),
      };
    },
  };
}

function formatFreshObservation(result: ComputerActionResult): string {
  const parts: string[] = [];
  if (result.observationId) parts.push(`observation ${result.observationId}`);
  if (result.previousReadback) parts.push(`readback ${result.previousReadback}`);
  if (result.numberedTargets && result.numberedTargets.length > 0) {
    parts.push(`numberedTargets ${result.numberedTargets.map((target) => target.targetId).join(",")}`);
  }
  if (result.screenshots && result.screenshots.length > 0) {
    parts.push("fresh screenshot attached");
  }
  if (parts.length === 0) return "";
  return ` Fresh observation (do not reuse the turn-start screenshot): ${parts.join("; ")}.`;
}
