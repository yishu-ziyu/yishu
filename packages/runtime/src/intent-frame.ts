import type { TurnIntentFrame } from "@yishu/kernel";
import type { TurnStartCommand } from "./protocol.js";

const TURN_INTENT_FRAME = Symbol("yishu.turnIntentFrame");
type IntentCommand = TurnStartCommand & {
  [TURN_INTENT_FRAME]?: TurnIntentFrame;
};

/** Product-runtime-only attachment; never accepted from or emitted onto wire. */
export function attachTurnIntentFrame(
  command: TurnStartCommand,
  frame: TurnIntentFrame,
): TurnStartCommand {
  Object.defineProperty(command, TURN_INTENT_FRAME, {
    value: frame,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return command;
}

export function turnIntentFrameFromCommand(
  command: TurnStartCommand,
): TurnIntentFrame | undefined {
  return (command as IntentCommand)[TURN_INTENT_FRAME];
}

/**
 * The authoritative frame can veto effects. Commands without a frame are
 * direct Runtime/compatibility callers and retain their existing admission.
 */
export function intentAllowsComputerEffect(command: TurnStartCommand): boolean {
  const frame = turnIntentFrameFromCommand(command);
  return frame === undefined
    || (frame.effect === "external" && frame.speechAct === "command");
}
