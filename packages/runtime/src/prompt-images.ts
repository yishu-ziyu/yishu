import { turnIntentFrameFromCommand } from "./intent-frame.js";
import { isScreenDependentUtterance } from "./model-routing.js";
import type { ResolvedModelRoute } from "./model-routing.js";
import type { TurnStartCommand } from "./protocol.js";

/** Extra deictic / screen words not already covered by observational pointing. */
const SCREEN_REFERENCE = /屏幕|窗口|这个|那个|点/;

export function isCursorDisplayScreenshot(screenshot: { label: string }): boolean {
  return /cursor/i.test(screenshot.label);
}

export interface VisualPromptPlan {
  readonly attachVisual: boolean;
  readonly keepAllDisplays: boolean;
}

/** Images follow the utterance, not fixed_model / auto routing. */
export function utteranceNeedsVisualContext(input: {
  utterance: string;
  effect?: string;
}): boolean {
  if (input.effect === "external") return true;
  const text = input.utterance.trim();
  return isScreenDependentUtterance(text) || SCREEN_REFERENCE.test(text);
}

export function planVisualPrompt(input: {
  utterance: string;
  effect?: string;
  route?: ResolvedModelRoute;
}): VisualPromptPlan {
  return {
    attachVisual: utteranceNeedsVisualContext(input),
    keepAllDisplays: input.route === "screen_collaboration",
  };
}

export function planVisualPromptForCommand(
  command: TurnStartCommand,
  route?: ResolvedModelRoute,
): VisualPromptPlan {
  const mode = command.payload.modelRouting?.mode;
  const effect = turnIntentFrameFromCommand(command)?.effect;
  const inferredRoute = route ?? (mode === "screen_collaboration" ? "screen_collaboration" : undefined);
  return planVisualPrompt({
    utterance: command.payload.utterance,
    ...(effect === undefined ? {} : { effect }),
    ...(inferredRoute === undefined ? {} : { route: inferredRoute }),
  });
}

/** Plain chat sends no JPEGs; collaboration keeps every display; else cursor only. */
export function selectPromptScreenshots<T extends { label: string }>(
  screenshots: readonly T[],
  plan: VisualPromptPlan,
): readonly T[] {
  if (!plan.attachVisual) return [];
  if (plan.keepAllDisplays) return screenshots;
  const cursor = screenshots.filter(isCursorDisplayScreenshot);
  return cursor.length > 0 ? cursor : screenshots.slice(0, 1);
}

export function promptRouteForCommand(command: TurnStartCommand): ResolvedModelRoute {
  const routing = command.payload.modelRouting;
  const screen = isScreenDependentUtterance(command.payload.utterance);
  if (routing === undefined || routing.mode === "fixed_model" || routing.mode === "auto") {
    return screen ? "screen_collaboration" : "realtime_conversation";
  }
  return routing.mode;
}

export function restrictCommandScreenshots(
  command: TurnStartCommand,
  route?: ResolvedModelRoute,
): TurnStartCommand {
  const plan = planVisualPromptForCommand(command, route);
  const selected = selectPromptScreenshots(command.payload.contextFrame.screenshots, plan);
  const dropTargets = !plan.attachVisual
    && (command.payload.contextFrame.numberedTargets?.length ?? 0) > 0;
  const screenshotsChanged = selected.length !== command.payload.contextFrame.screenshots.length;
  if (!screenshotsChanged && !dropTargets) return command;
  return {
    ...command,
    payload: {
      ...command.payload,
      contextFrame: {
        ...command.payload.contextFrame,
        screenshots: [...selected],
        ...(plan.attachVisual
          ? {}
          : { numberedTargets: undefined }),
      },
    },
  };
}

export function promptImageByteLength(base64Data: string): number {
  return Buffer.byteLength(base64Data, "utf8");
}
