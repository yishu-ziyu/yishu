import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ComputerAction } from "./protocol.js";
import type { ComputerActionResult } from "./computer-use-port.js";

const computerControlParameters = Type.Object({
  action: Type.Literal("left_click"),
  x: Type.Number({ minimum: 0, description: "Horizontal coordinate in screenshot pixels." }),
  y: Type.Number({ minimum: 0, description: "Vertical coordinate in screenshot pixels." }),
  screen: Type.Optional(Type.Integer({ minimum: 1, description: "One-based screen number from Context Frame." })),
  label: Type.Optional(Type.String({ maxLength: 120, description: "Short visible label of the target." })),
});

export function createComputerControlTool(
  perform: (action: ComputerAction, signal?: AbortSignal) => Promise<ComputerActionResult>,
): ToolDefinition<typeof computerControlParameters, ComputerActionResult> {
  return {
    name: "computer_control",
    label: "Computer control",
    description: [
      "Press a visible macOS control without moving the user's physical pointer.",
      "Coordinates use the screenshot pixel dimensions from the current Context Frame.",
      "Use only when the user directly asks to click or press a visible target.",
    ].join(" "),
    promptSnippet: "Press a visible macOS control through the product-owned accessibility bridge.",
    promptGuidelines: [
      "Call computer_control instead of printing XML, HTML, JSON, coordinates, or tool syntax.",
      "After a verified direct click, reply with only a brief natural confirmation such as 点好了。",
      "When the result is unverified, say that the click was delivered but the visible outcome is not confirmed.",
    ],
    parameters: computerControlParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const result = await perform(params, signal);
      if (!result.succeeded) throw new Error(result.message);

      const text = result.verified
        ? `Click succeeded and was visibly verified. ${result.evidence ?? result.message}`
        : `Click was delivered but the visible outcome is unverified. Do not claim completion. ${result.evidence ?? result.message}`;
      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  };
}
