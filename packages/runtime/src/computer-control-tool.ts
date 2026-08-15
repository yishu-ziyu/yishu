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
    x: Type.Number({ minimum: 0, description: "Horizontal coordinate in screenshot pixels." }),
    y: Type.Number({ minimum: 0, description: "Vertical coordinate in screenshot pixels." }),
    screen: Type.Optional(Type.Integer({ minimum: 1, description: "One-based screen number from Context Frame." })),
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
      "Coordinates use the screenshot pixel dimensions from the current Context Frame.",
      "Use only when the user directly asks to click, press, or input exact text.",
      "For set_text, provide only the requested text. The runtime owns the target app identity.",
      "Native commands, target process IDs, and target bundle IDs are not accepted.",
    ].join(" "),
    promptSnippet: "Perform an explicitly requested click or focused text input through the product-owned accessibility bridge.",
    promptGuidelines: [
      "Call computer_control instead of printing XML, HTML, JSON, coordinates, or tool syntax.",
      "Call set_text only for explicit user-requested text input; never infer or invent text to enter.",
      "For 'input ... then click ...', execute each step sequentially and rely on each returned read-back.",
      "After a verified direct click, reply with only a brief natural confirmation such as 点好了。",
      "When any result is unverified, say that the requested effect was delivered but not confirmed.",
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
      const text = result.verified
        ? `${actionLabel} succeeded and read-back was verified. ${result.evidence ?? result.message}`
        : `${actionLabel} was delivered but the outcome is unverified. Do not claim completion. ${result.evidence ?? result.message}`;
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  };
}
