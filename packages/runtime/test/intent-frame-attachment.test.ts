import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveTurnIntentFrame } from "@yishu/kernel";
import {
  attachTurnIntentFrame,
  intentAllowsComputerEffect,
  turnIntentFrameFromCommand,
} from "../src/intent-frame.js";
import { makeTurnStartCommand } from "./fixtures.js";

test("IntentFrame crosses the internal runtime seam without entering the wire payload", () => {
  const command = makeTurnStartCommand();
  command.payload.utterance = "点击这个按钮，算了";
  const frame = deriveTurnIntentFrame(command.payload.utterance);

  attachTurnIntentFrame(command, frame);

  assert.equal(turnIntentFrameFromCommand(command), frame);
  assert.equal(intentAllowsComputerEffect(command), false);
  assert.doesNotMatch(JSON.stringify(command), /speechAct|product_state|steerable/);
});

test("IntentFrame permits exact action admission only for an external command", () => {
  const explicit = makeTurnStartCommand();
  explicit.payload.utterance = "点击这个按钮";
  attachTurnIntentFrame(explicit, deriveTurnIntentFrame(explicit.payload.utterance));
  assert.equal(intentAllowsComputerEffect(explicit), true);

  const legacy = makeTurnStartCommand();
  assert.equal(intentAllowsComputerEffect(legacy), true, "unwrapped protocol tests keep compatibility");
});
