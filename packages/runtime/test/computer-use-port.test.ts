import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createComputerControlTool } from "../src/computer-control-tool.js";
import { StdioComputerUsePort } from "../src/computer-use-port.js";
import { PROTOCOL_VERSION, type RuntimeEvent } from "../src/protocol.js";

test("computer-use port round-trips a typed action and verification result", async () => {
  const events: RuntimeEvent[] = [];
  const port = new StdioComputerUsePort((event) => events.push(event), 1_000);
  const requestId = randomUUID();
  const traceId = randomUUID();
  const pendingResult = port.perform({
    action: "left_click",
    x: 185,
    y: 375,
    screen: 1,
    label: "调整 sub agent 为 Luna Max",
  }, { requestId, traceId });

  const requestEvent = events.at(0);
  assert.equal(requestEvent?.type, "computer.action.requested");
  const payload = requestEvent?.payload as { actionId?: string };
  assert.ok(payload.actionId);

  assert.equal(port.resolve({
    schemaVersion: PROTOCOL_VERSION,
    type: "computer.action.result",
    requestId,
    traceId,
    sentAt: new Date().toISOString(),
    payload: {
      actionId: payload.actionId,
      succeeded: true,
      verified: true,
      message: "AXPress succeeded.",
      evidence: "Target became selected.",
    },
  }), true);

  assert.deepEqual(await pendingResult, {
    succeeded: true,
    verified: true,
    message: "AXPress succeeded.",
    evidence: "Target became selected.",
  });
  port.dispose();
});

test("computer_control tool delegates to the product-owned port", async () => {
  const actions: unknown[] = [];
  const tool = createComputerControlTool(async (action) => {
    actions.push(action);
    return {
      succeeded: true,
      verified: true,
      message: "Pressed.",
      evidence: "Selected state changed.",
    };
  });

  const result = await tool.execute("tool-call", {
    action: "left_click",
    x: 185,
    y: 375,
    label: "目标任务",
  }, undefined, undefined, {} as never);

  assert.deepEqual(actions, [{
    action: "left_click",
    x: 185,
    y: 375,
    label: "目标任务",
  }]);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /visibly verified/i);
});
