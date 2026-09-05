import { Type } from "typebox";
import type { ToolDefinition } from "./model-loop/types.js";
import type { ComputerAction } from "./protocol.js";
import type { ComputerActionResult } from "./computer-use-port.js";

export type ComputerControlToolAction =
  | Extract<ComputerAction, { action: "left_click" }>
  | { action: "set_text"; text: string }
  | { action: "drop_download_file"; fileName: string; targetId: string };

const computerControlParameters = Type.Union([
  Type.Object({
    action: Type.Literal("left_click"),
    targetId: Type.String({
      pattern: "^[1-9][0-9]?$",
      description: "Numbered AX target id from the current Context Frame numberedTargets list.",
    }),
    label: Type.Optional(Type.String({ maxLength: 120, description: "Short visible label of the target." })),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("set_text"),
    text: Type.String({
      minLength: 1,
      maxLength: 10_000,
      description: "Exact text explicitly requested by the user.",
    }),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("drop_download_file"),
    fileName: Type.String({
      minLength: 1,
      maxLength: 255,
      description: "Exact Downloads basename named by the user, including the extension. Never a path.",
    }),
    targetId: Type.String({
      pattern: "^[1-9][0-9]?$",
      description: "Numbered AX upload target id from the current Context Frame numberedTargets list.",
    }),
  }, { additionalProperties: false }),
]);

export function createComputerControlTool(
  perform: (action: ComputerControlToolAction, signal?: AbortSignal) => Promise<ComputerActionResult>,
): ToolDefinition<typeof computerControlParameters, ComputerActionResult> {
  return {
    name: "computer_control",
    label: "Computer control",
    description: [
      "Press a visible macOS control, set focused text, or drop one user-named Downloads file onto a numbered upload target.",
      "left_click uses targetId from Context Frame numberedTargets. Do not guess screenshot pixels.",
      "Use only when the user directly asks to click, press, input exact text, or drop a named Downloads file.",
      "For set_text, provide only the requested text. The runtime owns the target app identity.",
      "For drop_download_file, provide only the exact basename and targetId. Never a path, PID, bundle id, window id, or coordinates.",
      "Native commands, target process IDs, and target bundle IDs are not accepted.",
    ].join(" "),
    promptSnippet: "Perform an explicitly requested click, focused text input, or confirmed Downloads file drop through numbered accessibility targets.",
    promptGuidelines: [
      "Call computer_control instead of printing XML, HTML, JSON, coordinates, or tool syntax.",
      "For left_click, pass targetId from numberedTargets. Never pass screenshot coordinates.",
      "If numberedTargets is empty or warnings include ax-unreadable, say the window is not readable. Do not pixel-click.",
      "Call set_text only for explicit user-requested text input; never infer or invent text to enter.",
      "Call drop_download_file only for the user's named Downloads file: use the exact basename from a unique native downloadFiles candidate when speech differs. Do not submit, send, or press enter after dropping.",
      "For 'input ... then click ...', execute each step sequentially and rely on each returned read-back.",
      "After a verified click, phrase a brief natural confirmation in your own words. One to three words is enough.",
      "When any result is unverified, you must not claim success. Say the effect was delivered but not confirmed, in your own words.",
      "After every action, use the fresh observation in the tool result. Do not reuse turn-start numberedTargets.",
    ],
    parameters: computerControlParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const result = await perform(
        sanitizeComputerControlAction(params as { action: string } & Record<string, unknown>),
        signal,
      );
      if (result.code === "approval_required") {
        return {
          content: [{
            type: "text" as const,
            text: "Only the file and target were located. NOTHING HAS MOVED. Ask one short future-tense confirmation using the actual filename: the user can say 去 to perform the drop. Do not say it is dragged, dropped, uploaded or already in the box. Do not call a tool again or click submit while waiting.",
          }],
          details: result,
        };
      }
      const status = result.status
        ?? (result.verified ? "verified" : result.succeeded ? "delivered" : "failed");
      const terminalFailure = status === "blocked"
        || status === "stale"
        || status === "cancelled"
        || status === "failed";
      if (!result.succeeded || terminalFailure) {
        throw new Error(`${result.message}${result.code ? ` (${result.code})` : ""}`);
      }

      const actionLabel = params.action === "set_text"
        ? "Text input"
        : params.action === "drop_download_file"
          ? "File drop"
          : "Click";
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

function sanitizeComputerControlAction(
  params: { action: string } & Record<string, unknown>,
): ComputerControlToolAction {
  if (params.action === "drop_download_file") {
    return {
      action: "drop_download_file",
      fileName: String(params.fileName ?? ""),
      targetId: String(params.targetId ?? ""),
    };
  }
  if (params.action === "set_text") {
    return { action: "set_text", text: String(params.text ?? "") };
  }
  return params as ComputerControlToolAction;
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
