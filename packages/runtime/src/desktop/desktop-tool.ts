import { Type } from "typebox";
import type { ToolDefinition } from "../model-loop/types.js";
import type { DesktopAction } from "./desktop-action.js";
import { runDesktopStep, type DesktopLoopState } from "./desktop-loop.js";
import type { DesktopObservation } from "./desktop-observation.js";
import type { DesktopCommitResult } from "./desktop-loop.js";

const desktopParameters = Type.Union([
  Type.Object({ kind: Type.Literal("press"), targetId: Type.String({ pattern: "^[1-9][0-9]?$" }) }),
  Type.Object({
    kind: Type.Literal("set_text"),
    text: Type.String({ minLength: 1, maxLength: 10_000 }),
    mode: Type.Union([Type.Literal("replace"), Type.Literal("insert")]),
    targetId: Type.Optional(Type.String({ pattern: "^[1-9][0-9]?$" })),
  }),
  Type.Object({
    kind: Type.Literal("key_press"),
    key: Type.Union([
      Type.Literal("enter"),
      Type.Literal("escape"),
      Type.Literal("tab"),
      Type.Literal("space"),
      Type.Literal("backspace"),
    ]),
  }),
  Type.Object({
    kind: Type.Literal("scroll"),
    axis: Type.Union([Type.Literal("vertical"), Type.Literal("horizontal")]),
    direction: Type.Union([Type.Literal("forward"), Type.Literal("backward")]),
    amount: Type.Union([Type.Literal("small"), Type.Literal("page")]),
  }),
  Type.Object({ kind: Type.Literal("open_app"), bundleId: Type.String({ minLength: 1, maxLength: 255 }) }),
  Type.Object({ kind: Type.Literal("focus_window"), targetId: Type.String({ pattern: "^[1-9][0-9]?$" }) }),
  Type.Object({
    kind: Type.Literal("select_menu_item"),
    appBundleId: Type.String({ minLength: 1, maxLength: 255 }),
    path: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 6 }),
  }),
  Type.Object({ kind: Type.Literal("copy") }),
  Type.Object({ kind: Type.Literal("paste") }),
  Type.Object({ kind: Type.Literal("wait"), milliseconds: Type.Number({ minimum: 50, maximum: 8_000 }) }),
]);

export function createDesktopTool(input: {
  requestId: string;
  state: DesktopLoopState;
  observation: () => DesktopObservation | undefined;
  commit: (action: DesktopAction) => Promise<DesktopCommitResult>;
  now?: () => Date;
}): ToolDefinition {
  return {
    name: "desktop",
    label: "Desktop loop",
    description: "Observe-act-verify macOS actions. Every action must cite the current observation.",
    promptSnippet: "Use desktop after a fresh observation. Do not reuse stale target ids.",
    promptGuidelines: [
      "Call observe-equivalent context first.",
      "Do not retry an action that returned unknown after commit.",
      "Stop and ask the user after two consecutive verification failures.",
    ],
    parameters: desktopParameters,
    executionMode: "sequential",
    async execute(_id, params) {
      const observation = input.observation();
      if (observation !== undefined) input.state.lastObservation = observation;
      const receipt = await runDesktopStep({
        proposal: {
          action: params as DesktopAction,
          basisObservationId: observation?.observationId ?? "",
          requestId: input.requestId,
        },
        state: input.state,
        now: (input.now ?? (() => new Date()))(),
        commit: async (proposal) => input.commit(proposal.action),
      });
      if (receipt.status === "blocked" || receipt.status === "stale" || receipt.status === "failed") {
        throw new Error(`Desktop action ${receipt.status}${receipt.evidenceCode ? ` (${receipt.evidenceCode})` : ""}.`);
      }
      const text = receipt.verified
        ? "Desktop action succeeded and read-back was verified."
        : "Desktop action was delivered but the outcome is unverified. Do not claim completion.";
      return {
        content: [{ type: "text", text }],
        details: receipt,
      };
    },
  };
}
