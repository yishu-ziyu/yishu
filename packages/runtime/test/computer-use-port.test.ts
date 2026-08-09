import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createComputerControlTool } from "../src/computer-control-tool.js";
import {
  ComputerActionError,
  StdioComputerUsePort,
} from "../src/computer-use-port.js";
import {
  computerActionCompletionText,
  piSessionCacheKey,
  PiRuntimeAdapter,
  shouldRunCompatibilityComputerAction,
} from "../src/pi-runtime-adapter.js";
import { computerActionRequestedPayloadSchema } from "../src/protocol.js";
import { PROTOCOL_VERSION, type RuntimeEvent } from "../src/protocol.js";
import type { ComputerUsePort } from "../src/computer-use-port.js";
import { makeTurnStartCommand } from "./fixtures.js";

test("Pi session cache is isolated by durable conversation identity", () => {
  const preference = { provider: "yishu-local-grok" as const, model: "grok-4.5" as const };
  const first = piSessionCacheKey("conversation", preference, 0, randomUUID());
  const second = piSessionCacheKey("conversation", preference, 0, randomUUID());
  assert.notEqual(first, second);
  assert.equal(first.split(":")[1], preference.provider);
});

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
  const payload = computerActionRequestedPayloadSchema.parse(requestEvent?.payload);
  assert.ok(payload.actionId);
  assert.ok(payload.intentId);
  assert.ok(payload.attemptId);
  assert.equal(payload.effectClass, "write");

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
      status: "verified",
      code: "verified_accessibility",
      method: "ax_press",
      receiptId: "receipt-1",
      attemptId: payload.attemptId,
    },
  }), true);

  assert.deepEqual(await pendingResult, {
    succeeded: true,
    verified: true,
    message: "AXPress succeeded.",
    evidence: "Target became selected.",
    status: "verified",
    code: "verified_accessibility",
    method: "ax_press",
    receiptId: "receipt-1",
    attemptId: payload.attemptId,
  });
  port.dispose();
});

test("computer-use port rejects a stale attempt receipt without settling the action", async () => {
  const events: RuntimeEvent[] = [];
  const port = new StdioComputerUsePort((event) => events.push(event), 1_000);
  const requestId = randomUUID();
  const traceId = randomUUID();
  const pendingResult = port.perform({
    action: "left_click",
    x: 10,
    y: 20,
  }, { requestId, traceId });
  const payload = computerActionRequestedPayloadSchema.parse(events.at(0)?.payload);

  assert.equal(port.resolve({
    schemaVersion: PROTOCOL_VERSION,
    type: "computer.action.result",
    requestId,
    traceId: randomUUID(),
    sentAt: new Date().toISOString(),
    payload: {
      actionId: payload.actionId,
      succeeded: true,
      verified: true,
      message: "Wrong trace.",
      attemptId: payload.attemptId,
    },
  }), false);

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
      message: "Wrong attempt.",
      attemptId: randomUUID(),
    },
  }), false);

  assert.equal(port.resolve({
    schemaVersion: PROTOCOL_VERSION,
    type: "computer.action.result",
    requestId,
    traceId,
    sentAt: new Date().toISOString(),
    payload: {
      actionId: payload.actionId,
      succeeded: true,
      verified: false,
      status: "unverified",
      code: "ax_press_unverified",
      method: "ax_press",
      message: "AXPress was delivered, but the visible outcome was not confirmed.",
      attemptId: payload.attemptId,
    },
  }), true);

  const result = await pendingResult;
  assert.equal(result.verified, false);
  assert.equal(result.status, "unverified");
  assert.equal(result.code, "ax_press_unverified");
  port.dispose();
});

test("computer-use timeout preserves a failed receipt code for the adapter", async () => {
  const port = new StdioComputerUsePort(() => {}, 5);
  const pendingResult = port.perform({ action: "left_click", x: 1, y: 1 }, {
    requestId: randomUUID(),
    traceId: randomUUID(),
  });

  await assert.rejects(pendingResult, (error: unknown) => {
    assert.ok(error instanceof ComputerActionError);
    assert.equal(error.status, "failed");
    assert.equal(error.code, "timeout");
    return true;
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

test("computer_control tool keeps delivered and unverified outcomes out of completion language", async () => {
  const tool = createComputerControlTool(async () => ({
    succeeded: true,
    verified: false,
    status: "unverified" as const,
    code: "quartz_unverified" as const,
    method: "quartz" as const,
    message: "The click was delivered, but no visible change was confirmed.",
  }));

  const result = await tool.execute("tool-call", {
    action: "left_click",
    x: 185,
    y: 375,
  }, undefined, undefined, {} as never);

  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /delivered/i);
  assert.match(text, /unverified/i);
  assert.doesNotMatch(text, /visibly verified/i);
});

test("Pi adapter completion text promotes only verified receipts", () => {
  assert.equal(computerActionCompletionText({
    succeeded: true,
    verified: true,
    status: "verified",
    method: "ax_press",
    message: "Changed.",
  }), "点好了。");
  assert.equal(computerActionCompletionText({
    succeeded: true,
    verified: false,
    status: "delivered",
    method: "quartz",
    message: "Posted.",
  }), "已经点击，但界面结果还没确认。");
  assert.equal(computerActionCompletionText({
    succeeded: false,
    verified: false,
    status: "stale",
    code: "target_stale",
    method: "unknown",
    message: "Target changed.",
  }), "这次没点成功。");
});

async function assertDirectTurnSecondCallIsBlocked(firstResult: {
  succeeded: boolean;
  verified: boolean;
  status: "verified" | "unverified";
  method: "ax_press" | "quartz";
  message: string;
}): Promise<void> {
  const requests: unknown[] = [];
  const port: ComputerUsePort = {
    async perform(action, context) {
      requests.push({ action, context });
      return firstResult;
    },
    resolve: () => false,
    cancelRequest: () => {},
    dispose: () => {},
  };
  const adapter = new PiRuntimeAdapter(process.cwd(), port);
  const internals = adapter as any;
  const activeTurn: any = {
    requestId: randomUUID(),
    traceId: randomUUID(),
    intentId: randomUUID(),
    basisFrameId: randomUUID(),
    directComputerAction: true,
    emit: () => {},
    actionCount: 0,
  };
  const action = { action: "left_click" as const, x: 10, y: 20 };

  await internals.activeComputerTurn.run(activeTurn, async () => {
    assert.deepEqual(await internals.performComputerAction(action), firstResult);
    await assert.rejects(
      () => internals.performComputerAction(action),
      (error: unknown) => {
        assert.ok(error instanceof ComputerActionError);
        assert.equal(error.status, "blocked");
        assert.equal(error.code, "direct_action_already_attempted");
        assert.equal(error.receipt?.status, "blocked");
        assert.equal(error.receipt?.code, "direct_action_already_attempted");
        return true;
      },
    );
  });

  assert.equal(requests.length, 1, "the blocked second call must not reach the port");
  assert.equal(activeTurn.actionCount, 1, "only the dispatched action counts");
  assert.equal(activeTurn.lastResult.status, firstResult.status);
  assert.equal(activeTurn.lastResult.verified, firstResult.verified);
  assert.equal(
    computerActionCompletionText(activeTurn.lastResult),
    firstResult.verified ? "点好了。" : "已经点击，但界面结果还没确认。",
  );
  await adapter.dispose();
}

test("direct-click verified receipt blocks a second computer action before requested event", async () => {
  await assertDirectTurnSecondCallIsBlocked({
    succeeded: true,
    verified: true,
    status: "verified",
    method: "ax_press",
    message: "Accessibility state changed.",
  });
});

test("direct-click delivered or unverified receipt still blocks a second computer action", async () => {
  await assertDirectTurnSecondCallIsBlocked({
    succeeded: true,
    verified: false,
    status: "unverified",
    method: "quartz",
    message: "Input was delivered without visible confirmation.",
  });
});

test("complex turns keep multi-step computer actions available", async () => {
  const requests: unknown[] = [];
  const port: ComputerUsePort = {
    async perform(action, context) {
      requests.push({ action, context });
      return {
        succeeded: true,
        verified: false,
        status: "delivered",
        method: "ax_press",
        message: "Delivered.",
      };
    },
    resolve: () => false,
    cancelRequest: () => {},
    dispose: () => {},
  };
  const adapter = new PiRuntimeAdapter(process.cwd(), port);
  const internals = adapter as any;
  const activeTurn: any = {
    requestId: randomUUID(),
    traceId: randomUUID(),
    intentId: randomUUID(),
    basisFrameId: randomUUID(),
    directComputerAction: false,
    emit: () => {},
    actionCount: 0,
  };
  const action = { action: "left_click" as const, x: 10, y: 20 };

  await internals.activeComputerTurn.run(activeTurn, async () => {
    await internals.performComputerAction(action);
    await internals.performComputerAction({ ...action, x: 30 });
  });

  assert.equal(requests.length, 2);
  assert.equal(activeTurn.actionCount, 2);
  await adapter.dispose();
});

test("compatibility POINT fallback is only eligible before a direct action", () => {
  assert.equal(shouldRunCompatibilityComputerAction(true, 0, true), true);
  assert.equal(shouldRunCompatibilityComputerAction(true, 1, true), false);
  assert.equal(shouldRunCompatibilityComputerAction(false, 0, true), false);
  assert.equal(shouldRunCompatibilityComputerAction(true, 0, false), false);
});

test("duplicate request ids fail immediately without replacing the active turn", async () => {
  const adapter = new PiRuntimeAdapter(process.cwd(), {
    perform: async () => ({ succeeded: true, verified: true, message: "unused" }),
    resolve: () => false,
    cancelRequest: () => {},
    dispose: () => {},
  });
  const internals = adapter as any;
  const requestId = randomUUID();
  const activeProviderTurn = { requestId, provider: "xai" };
  internals.activeProviderTurns.set(requestId, activeProviderTurn);
  const command = makeTurnStartCommand();
  command.requestId = requestId;
  const events: RuntimeEvent[] = [];

  await adapter.startTurn(command, (event) => events.push(event));

  assert.equal(events.at(0)?.type, "turn.failed");
  assert.equal(events.at(0)?.payload.code, "duplicate_request");
  assert.equal(internals.activeProviderTurns.get(requestId), activeProviderTurn);

  internals.activeProviderTurns.delete(requestId);
  const activeSession = { sessionId: "existing", abort: async () => {} };
  internals.activeSessionByRequestId.set(requestId, activeSession);
  events.length = 0;
  await adapter.startTurn(command, (event) => events.push(event));
  assert.equal(events.at(0)?.type, "turn.failed");
  assert.equal(events.at(0)?.payload.code, "duplicate_request");
  assert.equal(internals.activeSessionByRequestId.get(requestId), activeSession);

  await adapter.dispose();
});

test("cancel during Pi initialization prevents session creation and later execution", async () => {
  const cancelled: string[] = [];
  const adapter = new PiRuntimeAdapter(process.cwd(), {
    perform: async () => ({ succeeded: true, verified: true, message: "unused" }),
    resolve: () => false,
    cancelRequest: (requestId) => cancelled.push(requestId),
    dispose: () => {},
  });
  const internals = adapter as any;
  let releaseModel!: () => void;
  let markModelStarted!: () => void;
  const modelStarted = new Promise<void>((resolve) => { markModelStarted = resolve; });
  const modelRelease = new Promise<void>((resolve) => { releaseModel = resolve; });
  let sessionCreated = false;
  internals.modelFor = async () => {
    markModelStarted();
    await modelRelease;
    return {};
  };
  internals.sessionFor = async () => {
    sessionCreated = true;
    throw new Error("sessionFor must not run after cancellation");
  };

  const command = makeTurnStartCommand();
  const events: RuntimeEvent[] = [];
  const start = adapter.startTurn(command, (event) => events.push(event));
  await modelStarted;
  await adapter.cancelTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.cancel",
    requestId: command.requestId,
    traceId: command.traceId,
    sentAt: new Date().toISOString(),
    payload: { reason: "user_cancelled" },
  }, (event) => events.push(event));
  releaseModel();
  await start;

  assert.equal(sessionCreated, false);
  assert.deepEqual(cancelled, [command.requestId]);
  assert.ok(events.some((event) => event.type === "turn.cancelled"));
  assert.ok(!events.some((event) => event.type === "turn.started"));
  await adapter.dispose();
});

test("Pi dispose waits for an initializing local turn to cross its cancellation gate", async () => {
  const adapter = new PiRuntimeAdapter(process.cwd(), {
    perform: async () => ({ succeeded: true, verified: true, message: "unused" }),
    resolve: () => false,
    cancelRequest: () => {},
    dispose: () => {},
  });
  const internals = adapter as any;
  let releaseModel!: () => void;
  let markModelStarted!: () => void;
  const modelStarted = new Promise<void>((resolve) => { markModelStarted = resolve; });
  const modelRelease = new Promise<void>((resolve) => { releaseModel = resolve; });
  let sessionCreated = false;
  internals.modelFor = async () => {
    markModelStarted();
    await modelRelease;
    return {};
  };
  internals.sessionFor = async () => {
    sessionCreated = true;
    throw new Error("sessionFor must not run after dispose");
  };

  const command = makeTurnStartCommand();
  const start = adapter.startTurn(command, () => undefined);
  await modelStarted;
  const disposing = adapter.dispose();
  releaseModel();
  await Promise.all([start, disposing]);

  assert.equal(sessionCreated, false);
});
