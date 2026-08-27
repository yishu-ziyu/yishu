import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createComputerControlTool } from "../src/computer-control-tool.js";
import {
  ComputerActionError,
  StdioComputerUsePort,
} from "../src/computer-use-port.js";
import {
  authorizedTextForUtterance,
  computerActionLimitForUtterance,
  computerActionCompletionText,
  isExplicitTextInputUtterance,
  piSessionCacheKey,
  YishuLoopRuntimeAdapter,
  shouldRunCompatibilityComputerAction,
} from "../src/loop-adapter.js";
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

test("computer-use port accepts uppercase UUID receipts from Swift JSONEncoder", async () => {
  const events: RuntimeEvent[] = [];
  const port = new StdioComputerUsePort((event) => events.push(event), 1_000);
  const requestId = randomUUID();
  const traceId = randomUUID();
  const pendingResult = port.perform({
    action: "left_click",
    targetId: "1",
  }, { requestId, traceId });
  const payload = computerActionRequestedPayloadSchema.parse(events.at(0)?.payload);

  assert.equal(port.resolve({
    schemaVersion: PROTOCOL_VERSION,
    type: "computer.action.result",
    requestId: requestId.toUpperCase(),
    traceId: traceId.toUpperCase(),
    sentAt: new Date().toISOString(),
    payload: {
      actionId: payload.actionId.toUpperCase(),
      succeeded: true,
      verified: true,
      message: "The requested control changed visible state.",
      evidence: "method=accessibility;code=verified_accessibility_change;testbed-effect=effect-1",
      status: "verified",
      code: "verified_accessibility",
      method: "ax_press",
      receiptId: "receipt-1",
      attemptId: payload.attemptId?.toUpperCase(),
    },
  }), true);

  const result = await pendingResult;
  assert.equal(result.succeeded, true);
  assert.equal(result.verified, true);
  port.dispose();
});

test("computer-use port forwards recaptured screenshot and numbered targets", async () => {
  const events: RuntimeEvent[] = [];
  const port = new StdioComputerUsePort((event) => events.push(event), 1_000);
  const requestId = randomUUID();
  const traceId = randomUUID();
  const pendingResult = port.perform({
    action: "left_click",
    targetId: "1",
  }, { requestId, traceId });
  const actionId = computerActionRequestedPayloadSchema.parse(events.at(0)?.payload).actionId;
  const observationId = randomUUID();
  assert.equal(port.resolve({
    schemaVersion: PROTOCOL_VERSION,
    type: "computer.action.result",
    requestId,
    traceId,
    sentAt: new Date().toISOString(),
    payload: {
      actionId,
      succeeded: true,
      verified: true,
      message: "clicked",
      observationId,
      numberedTargets: [{ id: "2", role: "AXButton", title: "Primary", description: null }],
      screenshots: [{
        label: "after",
        mediaType: "image/jpeg",
        base64Data: "abc123",
        displayWidthPoints: 100,
        displayHeightPoints: 80,
        screenshotWidthPixels: 200,
        screenshotHeightPixels: 160,
      }],
    },
  }), true);
  const result = await pendingResult;
  assert.equal(result.observationId, observationId);
  assert.deepEqual(result.numberedTargets, [{ targetId: "2", role: "AXButton" }]);
  assert.equal(result.screenshots?.[0]?.base64Data, "abc123");
  port.dispose();
});

test("computer-use port omits blank click labels so icon buttons stay wire-valid", async () => {
  const events: RuntimeEvent[] = [];
  const port = new StdioComputerUsePort((event) => events.push(event), 1_000);
  const requestId = randomUUID();
  const traceId = randomUUID();
  const pendingResult = port.perform({
    action: "left_click",
    x: 40,
    y: 20,
    label: "   ",
  }, { requestId, traceId });

  const requestEvent = events.at(0);
  assert.equal(requestEvent?.type, "computer.action.requested");
  const payload = computerActionRequestedPayloadSchema.parse(requestEvent?.payload);
  assert.equal(payload.action, "left_click");
  assert.equal("label" in payload, false);

  assert.equal(port.resolve({
    schemaVersion: PROTOCOL_VERSION,
    type: "computer.action.result",
    requestId,
    traceId,
    sentAt: new Date().toISOString(),
    payload: {
      actionId: payload.actionId,
      succeeded: false,
      verified: false,
      message: "nack",
      status: "failed",
      code: "runtime_error",
      method: "unknown",
      attemptId: payload.attemptId,
    },
  }), true);
  await pendingResult;
  port.dispose();
});

test("computer-use port carries runtime-owned set_text target and AX read-back receipt", async () => {
  const events: RuntimeEvent[] = [];
  const port = new StdioComputerUsePort((event) => events.push(event), 1_000);
  const requestId = randomUUID();
  const traceId = randomUUID();
  const pendingResult = port.perform({
    action: "set_text",
    text: "hello",
    targetBundleId: "com.apple.TextEdit",
    targetPid: 321,
  }, {
    requestId,
    traceId,
    basisFrameId: randomUUID(),
  });

  const payload = computerActionRequestedPayloadSchema.parse(events[0]?.payload);
  assert.equal(payload.action, "set_text");
  if (payload.action !== "set_text") assert.fail("expected set_text");
  assert.equal(payload.text, "hello");
  assert.equal(payload.targetBundleId, "com.apple.TextEdit");
  assert.equal(payload.targetPid, 321);

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
      message: "AX read-back matched.",
      evidence: "length=5;role=AXTextField;same=true",
      status: "verified",
      code: "verified_accessibility",
      method: "ax_set_value",
      attemptId: payload.attemptId,
    },
  }), true);
  assert.equal((await pendingResult).verified, true);
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
  const events: RuntimeEvent[] = [];
  const port = new StdioComputerUsePort((event) => events.push(event), 5);
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

  const afterTimeout = port.perform({ action: "left_click", x: 2, y: 2 }, {
    requestId: randomUUID(),
    traceId: randomUUID(),
  });
  assert.equal(events.length, 2, "a new action acquires immediately after timeout");
  port.dispose();
  await assert.rejects(afterTimeout, /disposed/);
});

test("one shared port blocks concurrent Pi and Kernel desktop actions without queueing", async () => {
  const events: RuntimeEvent[] = [];
  const port = new StdioComputerUsePort((event) => events.push(event), 1_000);
  const piRequestId = randomUUID();
  const piTraceId = randomUUID();

  const piAction = port.perform({ action: "left_click", x: 10, y: 20 }, {
    requestId: piRequestId,
    traceId: piTraceId,
  });
  const busyResult = await port.perform({
    action: "finder_history_back",
    x: 0,
    y: 0,
    targetBundleId: "com.apple.finder",
    targetPid: 4242,
  }, {
    requestId: randomUUID(),
    traceId: randomUUID(),
  });

  assert.deepEqual(busyResult, {
    succeeded: false,
    verified: false,
    status: "blocked",
    code: "runtime_error",
    method: "unknown",
    attemptId: busyResult.attemptId,
    message: "Desktop is busy with another computer action.",
  });
  assert.ok(busyResult.attemptId);
  assert.equal(events.length, 1, "busy action must not emit or enter a queue");

  const requested = computerActionRequestedPayloadSchema.parse(events[0]?.payload);
  assert.equal(port.resolve({
    schemaVersion: PROTOCOL_VERSION,
    type: "computer.action.result",
    requestId: piRequestId,
    traceId: piTraceId,
    sentAt: new Date().toISOString(),
    payload: {
      actionId: requested.actionId,
      succeeded: true,
      verified: true,
      message: "Clicked.",
      attemptId: requested.attemptId,
    },
  }), true);
  await piAction;
  assert.equal(events.length, 1, "the blocked action must not run after the lease is released");
  const afterResolve = port.perform({ action: "left_click", x: 30, y: 40 }, {
    requestId: randomUUID(),
    traceId: randomUUID(),
  });
  assert.equal(events.length, 2, "a new action acquires immediately after resolve");
  port.dispose();
  await assert.rejects(afterResolve, /disposed/);
});

test("the default desktop lease is shared by every Stdio port in the process", async () => {
  const firstEvents: RuntimeEvent[] = [];
  const secondEvents: RuntimeEvent[] = [];
  const firstPort = new StdioComputerUsePort((event) => firstEvents.push(event), 1_000);
  const secondPort = new StdioComputerUsePort((event) => secondEvents.push(event), 1_000);
  const firstRequestId = randomUUID();
  const first = firstPort.perform({ action: "left_click", x: 1, y: 1 }, {
    requestId: firstRequestId,
    traceId: randomUUID(),
  });

  const busy = await secondPort.perform({ action: "left_click", x: 2, y: 2 }, {
    requestId: randomUUID(),
    traceId: randomUUID(),
  });
  assert.equal(busy.status, "blocked");
  assert.equal(secondEvents.length, 0);

  firstPort.cancelRequest(firstRequestId);
  await assert.rejects(first, (error: unknown) => {
    assert.ok(error instanceof ComputerActionError);
    assert.equal(error.status, "cancelled");
    return true;
  });
  const afterRelease = secondPort.perform({ action: "left_click", x: 3, y: 3 }, {
    requestId: randomUUID(),
    traceId: randomUUID(),
  });
  assert.equal(secondEvents.length, 1);
  secondPort.dispose();
  await assert.rejects(afterRelease, /disposed/);
  firstPort.dispose();
});

test("computer-use cancellation releases the desktop lease", async () => {
  const events: RuntimeEvent[] = [];
  const port = new StdioComputerUsePort((event) => events.push(event), 1_000);
  const controller = new AbortController();
  const first = port.perform({ action: "left_click", x: 1, y: 1 }, {
    requestId: randomUUID(),
    traceId: randomUUID(),
  }, controller.signal);

  controller.abort();
  await assert.rejects(first, (error: unknown) => {
    assert.ok(error instanceof ComputerActionError);
    assert.equal(error.status, "cancelled");
    return true;
  });

  const second = port.perform({ action: "left_click", x: 2, y: 2 }, {
    requestId: randomUUID(),
    traceId: randomUUID(),
  });
  assert.equal(events.length, 2, "a new action acquires immediately after cancellation");
  port.dispose();
  await assert.rejects(second, /disposed/);
});

test("computer-use emit exceptions release the desktop lease", async () => {
  const events: RuntimeEvent[] = [];
  let throwOnce = true;
  const port = new StdioComputerUsePort((event) => {
    if (throwOnce) {
      throwOnce = false;
      throw new Error("emit failed");
    }
    events.push(event);
  }, 1_000);

  await assert.rejects(port.perform({ action: "left_click", x: 1, y: 1 }, {
    requestId: randomUUID(),
    traceId: randomUUID(),
  }), /emit failed/);

  const second = port.perform({ action: "left_click", x: 2, y: 2 }, {
    requestId: randomUUID(),
    traceId: randomUUID(),
  });
  assert.equal(events.length, 1, "a new action acquires immediately after the exception");
  port.dispose();
  await assert.rejects(second, /disposed/);
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

  assert.equal(tool.executionMode, "sequential");

  const result = await tool.execute("tool-call", {
    action: "left_click",
    targetId: "3",
    label: "目标任务",
  }, undefined, undefined, {} as never);

  assert.deepEqual(actions, [{
    action: "left_click",
    targetId: "3",
    label: "目标任务",
  }]);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /read-back was verified/i);
});

test("computer_control exposes set_text without model-owned target identity", async () => {
  const actions: unknown[] = [];
  const tool = createComputerControlTool(async (action) => {
    actions.push(action);
    return {
      succeeded: true,
      verified: true,
      status: "verified",
      code: "verified_accessibility",
      method: "ax_set_value",
      message: "Read-back matched.",
      evidence: "length=5;role=AXTextField;same=true",
    };
  });

  const result = await tool.execute("tool-call", {
    action: "set_text",
    text: "hello",
  }, undefined, undefined, {} as never);

  assert.deepEqual(actions, [{ action: "set_text", text: "hello" }]);
  const returned = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(returned, /read-back was verified/i);
  assert.doesNotMatch(returned, /targetPid|targetBundleId/);
});

test("runtime injects the observed frontmost target into set_text and overrides spoofed fields", async () => {
  const requests: unknown[] = [];
  const port: ComputerUsePort = {
    async perform(action, context) {
      requests.push({ action, context });
      return {
        succeeded: true,
        verified: true,
        status: "verified",
        code: "verified_accessibility",
        method: "ax_set_value",
        message: "Read-back matched.",
      };
    },
    resolve: () => false,
    cancelRequest: () => {},
    dispose: () => {},
  };
  const adapter = new YishuLoopRuntimeAdapter(process.cwd(), port);
  const internals = adapter as any;
  const activeTurn: any = {
    requestId: randomUUID(),
    traceId: randomUUID(),
    intentId: randomUUID(),
    basisFrameId: randomUUID(),
    directComputerAction: false,
    authorizedText: "hello",
    allowedActionSequence: ["set_text"],
    frontmostTarget: { targetBundleId: "com.apple.TextEdit", targetPid: 321 },
    emit: () => {},
    actionCount: 0,
    allActionsVerified: true,
  };

  await internals.activeComputerTurn.run(activeTurn, async () => {
    await internals.performComputerAction({
      action: "set_text",
      text: "hello",
      targetBundleId: "evil.bundle",
      targetPid: 999,
    });
  });

  const dispatched = requests[0] as { action: Record<string, unknown> };
  assert.deepEqual(dispatched.action, {
    action: "set_text",
    text: "hello",
    targetBundleId: "com.apple.TextEdit",
    targetPid: 321,
  });
  assert.equal(activeTurn.actionCount, 1);
  await adapter.dispose();
});

test("text input binds exact user authority and the requested action sequence", async () => {
  assert.equal(isExplicitTextInputUtterance("输入 hello，然后点发送"), true);
  assert.equal(isExplicitTextInputUtterance("how do I type hello?"), false);
  assert.equal(isExplicitTextInputUtterance("不要输入任何内容"), false);
  assert.equal(isExplicitTextInputUtterance("他说输入密码是什么意思"), false);
  assert.equal(authorizedTextForUtterance("输入 hello，然后点发送"), "hello");
  assert.equal(authorizedTextForUtterance("输入「hello world」然后点击发送"), "hello world");
  assert.equal(authorizedTextForUtterance("输入「不用谢？」"), "不用谢？");
  assert.equal(authorizedTextForUtterance("输入「hello」这句话是什么意思？"), undefined);
  assert.equal(authorizedTextForUtterance("输入「hello」然后点击发送是什么意思？"), undefined);
  assert.equal(computerActionLimitForUtterance("点击发送"), 8);
  assert.equal(computerActionLimitForUtterance("输入 hello，然后点发送"), 12);
  assert.equal(computerActionLimitForUtterance("输入 hello"), 12);
  assert.equal(computerActionLimitForUtterance("解释这个界面"), 8);

  const requests: unknown[] = [];
  const port: ComputerUsePort = {
    async perform(action) {
      requests.push(action);
      return {
        succeeded: true,
        verified: true,
        status: "verified",
        code: "verified_accessibility",
        method: action.action === "set_text" ? "ax_set_value" : "ax_press",
        message: "Verified.",
      };
    },
    resolve: () => false,
    cancelRequest: () => {},
    dispose: () => {},
  };
  const adapter = new YishuLoopRuntimeAdapter(process.cwd(), port);
  const internals = adapter as any;
  const activeTurn: any = {
    requestId: randomUUID(),
    traceId: randomUUID(),
    intentId: randomUUID(),
    basisFrameId: randomUUID(),
    directComputerAction: false,
    authorizedText: "hello",
    allowedActionSequence: ["set_text", "left_click"],
    frontmostTarget: { targetBundleId: "com.apple.TextEdit", targetPid: 321 },
    emit: () => {},
    actionCount: 0,
    allActionsVerified: true,
  };

  await internals.activeComputerTurn.run(activeTurn, async () => {
    await internals.performComputerAction({ action: "set_text", text: "hello" });
    await internals.performComputerAction({ action: "left_click", x: 10, y: 20 });
    await assert.rejects(
      () => internals.performComputerAction({ action: "left_click", x: 30, y: 40 }),
      (error: unknown) => {
        assert.ok(error instanceof ComputerActionError);
        assert.equal(error.code, "action_limit_reached");
        return true;
      },
    );
  });
  assert.equal(requests.length, 2);
  assert.equal(activeTurn.actionCount, 2);

  const noAuthority = {
    ...activeTurn,
    actionCount: 0,
    authorizedText: undefined,
    allowedActionSequence: ["left_click"],
  };
  await internals.activeComputerTurn.run(noAuthority, async () => {
    await assert.rejects(
      () => internals.performComputerAction({ action: "set_text", text: "blocked" }),
      /expected left_click|authorized text/i,
    );
  });
  assert.equal(requests.length, 2, "blocked text must not reach the Swift port");
  assert.equal(noAuthority.actionCount, 0, "admission failures are not product actions");
  await adapter.dispose();
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
    targetId: "3",
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
  const adapter = new YishuLoopRuntimeAdapter(process.cwd(), port);
  const internals = adapter as any;
  const activeTurn: any = {
    requestId: randomUUID(),
    traceId: randomUUID(),
    intentId: randomUUID(),
    basisFrameId: randomUUID(),
    directComputerAction: true,
    allowedActionSequence: ["left_click"],
    emit: () => {},
    actionCount: 0,
  };
  const action = { action: "left_click" as const, x: 10, y: 20 };

  await internals.activeComputerTurn.run(activeTurn, async () => {
    const returned = await internals.performComputerAction(action);
    assert.equal(returned.succeeded, firstResult.succeeded);
    assert.equal(returned.verified, firstResult.verified);
    assert.equal(returned.status, firstResult.status);
    assert.equal(returned.method, firstResult.method);
    assert.equal(returned.message, firstResult.message);
    assert.ok(returned.observationId, "the next model step must see a fresh observation id");
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

test("an admitted input-then-click sequence cannot dispatch a third action", async () => {
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
  const adapter = new YishuLoopRuntimeAdapter(process.cwd(), port);
  const internals = adapter as any;
  const activeTurn: any = {
    requestId: randomUUID(),
    traceId: randomUUID(),
    intentId: randomUUID(),
    basisFrameId: randomUUID(),
    directComputerAction: false,
    authorizedText: "hello",
    allowedActionSequence: ["set_text", "left_click"],
    frontmostTarget: { targetBundleId: "com.apple.TextEdit", targetPid: 321 },
    emit: () => {},
    actionCount: 0,
  };
  await internals.activeComputerTurn.run(activeTurn, async () => {
    await internals.performComputerAction({ action: "set_text", text: "hello" });
    await internals.performComputerAction({ action: "left_click", x: 30, y: 20 });
    await assert.rejects(
      () => internals.performComputerAction({ action: "left_click", x: 40, y: 20 }),
      /authorized desktop action limit/i,
    );
  });

  assert.equal(requests.length, 2);
  assert.equal(activeTurn.actionCount, 2);
  await adapter.dispose();
});

test("unknown computer commits are not retried and the next step gets a fresh observation", async () => {
  const requests: unknown[] = [];
  const port: ComputerUsePort = {
    async perform(action) {
      requests.push(action);
      return {
        succeeded: true,
        verified: false,
        status: "unverified",
        code: "ax_press_failed",
        method: "ax_press",
        message: "AXPress delivery is uncertain; the action was not repeated.",
        evidence: "method=ax_press;code=ax_press_failed;testbed-effect=idle",
      };
    },
    resolve: () => false,
    cancelRequest: () => {},
    dispose: () => {},
  };
  const adapter = new YishuLoopRuntimeAdapter(process.cwd(), port);
  const internals = adapter as any;
  const action = { action: "left_click" as const, targetId: "1" };
  const activeTurn: any = {
    requestId: randomUUID(),
    traceId: randomUUID(),
    intentId: randomUUID(),
    basisFrameId: randomUUID(),
    directComputerAction: false,
    actionBudget: 8,
    emit: () => {},
    actionCount: 0,
    allActionsVerified: true,
  };
  await internals.activeComputerTurn.run(activeTurn, async () => {
    const first = await internals.performComputerAction(action);
    assert.equal(first.verified, false);
    assert.ok(first.observationId);
    assert.match(first.evidence ?? "", /testbed-effect=idle/);
    await assert.rejects(
      () => internals.performComputerAction(action),
      /will not be retried/i,
    );
  });
  assert.equal(requests.length, 1, "unknown commits must not be dispatched again");
  assert.equal(activeTurn.actionCount, 1);
  await adapter.dispose();
});

test("a verified click replaces the turn-start observation before the next step", async () => {
  const port: ComputerUsePort = {
    async perform() {
      return {
        succeeded: true,
        verified: true,
        status: "verified",
        code: "verified_accessibility",
        method: "ax_press",
        message: "The requested control changed visible state.",
        evidence: "method=accessibility;code=verified_accessibility_change;testbed-effect=effect-1",
      };
    },
    resolve: () => false,
    cancelRequest: () => {},
    dispose: () => {},
  };
  const adapter = new YishuLoopRuntimeAdapter(process.cwd(), port);
  const internals = adapter as any;
  const frameId = randomUUID();
  const activeTurn: any = {
    requestId: randomUUID(),
    traceId: randomUUID(),
    intentId: randomUUID(),
    basisFrameId: frameId,
    directComputerAction: false,
    actionBudget: 8,
    emit: () => {},
    actionCount: 0,
    allActionsVerified: true,
  };
  await internals.activeComputerTurn.run(activeTurn, async () => {
    const first = await internals.performComputerAction({ action: "left_click", targetId: "1" });
    assert.notEqual(first.observationId, frameId);
    assert.equal(activeTurn.desktop.lastObservation.observationId, first.observationId);
    assert.match(first.previousReadback ?? "", /effect-1/);
    const second = await internals.performComputerAction({ action: "left_click", targetId: "1" });
    assert.notEqual(second.observationId, first.observationId);
  });
  await adapter.dispose();
});

test("compatibility POINT fallback is only eligible before a direct action", () => {
  assert.equal(shouldRunCompatibilityComputerAction(true, 0, true), true);
  assert.equal(shouldRunCompatibilityComputerAction(true, 1, true), false);
  assert.equal(shouldRunCompatibilityComputerAction(false, 0, true), false);
  assert.equal(shouldRunCompatibilityComputerAction(true, 0, false), false);
});

test("duplicate request ids fail immediately without replacing the active turn", async () => {
  const adapter = new YishuLoopRuntimeAdapter(process.cwd(), {
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
  const adapter = new YishuLoopRuntimeAdapter(process.cwd(), {
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
  const adapter = new YishuLoopRuntimeAdapter(process.cwd(), {
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
