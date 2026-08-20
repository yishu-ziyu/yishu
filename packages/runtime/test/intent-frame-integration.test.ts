import assert from "node:assert/strict";
import { test } from "node:test";
import { createYishuKernel } from "@yishu/kernel";
import { ProductKernelRuntime } from "../src/product-kernel-runtime.js";
import { intentAllowsComputerEffect } from "../src/intent-frame.js";
import {
  PROTOCOL_VERSION,
  runtimeEvent,
  type RuntimeEvent,
  type TurnInterruptCommand,
  type TurnStartCommand,
  type TurnSteerCommand,
} from "../src/protocol.js";
import type { AgentRuntime, RuntimeEventSink } from "../src/runtime-port.js";
import { makeTurnStartCommand } from "./fixtures.js";

class ReadOnlyToolRuntime implements AgentRuntime {
  lastIntentAllowsEffect?: boolean;

  async startTurn(command: TurnStartCommand, emit: Parameters<AgentRuntime["startTurn"]>[1]): Promise<void> {
    this.lastIntentAllowsEffect = intentAllowsComputerEffect(command);
    emit(runtimeEvent("turn.started", command.requestId, command.traceId, {}));
    emit(runtimeEvent("tool.started", command.requestId, command.traceId, {
      toolName: "web_search",
    }));
    emit(runtimeEvent("tool.completed", command.requestId, command.traceId, {
      toolName: "web_search",
      isError: false,
    }));
    emit(runtimeEvent("response.completed", command.requestId, command.traceId, {
      text: "这是文件无法打开的原因。",
      verified: true,
    }));
  }

  async steerTurn(): Promise<void> {}
  async cancelTurn(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class SteerableRuntime implements AgentRuntime {
  private command?: TurnStartCommand;
  private turnEmit?: RuntimeEventSink;
  private finish?: () => void;
  private markReady?: () => void;
  readonly ready = new Promise<void>((resolve) => { this.markReady = resolve; });
  private readonly done = new Promise<void>((resolve) => { this.finish = resolve; });

  async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
    this.command = command;
    this.turnEmit = emit;
    emit(runtimeEvent("turn.started", command.requestId, command.traceId, {}));
    this.markReady?.();
    await this.done;
  }

  async interruptTurn(command: TurnInterruptCommand, emit: RuntimeEventSink): Promise<void> {
    emit(runtimeEvent("turn.interrupt.accepted", command.requestId, command.traceId, {
      interruptedGeneration: command.payload.expectedGeneration,
      nextGeneration: command.payload.expectedGeneration + 1,
    }));
  }

  async steerTurn(command: TurnSteerCommand): Promise<void> {
    if (this.command !== undefined) {
      this.turnEmit?.(runtimeEvent(
        "response.completed",
        this.command.requestId,
        this.command.traceId,
        { text: "换一种解释。", verified: false, generation: command.payload.nextGeneration },
      ));
    }
    this.finish?.();
  }

  async cancelTurn(): Promise<void> { this.finish?.(); }
  async dispose(): Promise<void> { this.finish?.(); }
}

function command(utterance: string): TurnStartCommand {
  const value = makeTurnStartCommand();
  value.payload.utterance = utterance;
  return value;
}

test("one IntentFrame keeps an action-word question read-only through TaskTruth", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const inner = new ReadOnlyToolRuntime();
  const runtime = new ProductKernelRuntime(inner, kernel);

  await runtime.startTurn(command("为什么要打开这个文件？"), () => undefined);

  const [task] = await kernel.store.listTasks();
  assert.equal(task?.status, "done");
  assert.equal(task?.contract?.successMode, "read_only_delivery");
  assert.equal(inner.lastIntentAllowsEffect, false);
  await runtime.dispose();
});

test("one IntentFrame keeps an explicit command effectful without trusted read-back", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const inner = new ReadOnlyToolRuntime();
  const runtime = new ProductKernelRuntime(inner, kernel);

  await runtime.startTurn(command("打开这个文件"), () => undefined);

  const [task] = await kernel.store.listTasks();
  assert.equal(task?.status, "blocked");
  assert.equal(task?.contract?.successMode, "external_effect");
  assert.equal(inner.lastIntentAllowsEffect, true);
  await runtime.dispose();
});

test("a final self-correction cancels the earlier effect before TaskTruth", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const inner = new ReadOnlyToolRuntime();
  const runtime = new ProductKernelRuntime(inner, kernel);

  await runtime.startTurn(command("打开这个文件，算了"), () => undefined);

  const [task] = await kernel.store.listTasks();
  assert.equal(task?.status, "done");
  assert.equal(task?.contract?.successMode, "read_only_delivery");
  assert.equal(inner.lastIntentAllowsEffect, false);
  await runtime.dispose();
});

test("the same IntentFrame admits conversational barge-in for an action-word question", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const inner = new SteerableRuntime();
  const runtime = new ProductKernelRuntime(inner, kernel);
  const initial = command("为什么要打开这个文件？");
  const start = runtime.startTurn(initial, () => undefined);
  await inner.ready;

  const interruptEvents: RuntimeEvent[] = [];
  await runtime.interruptTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.interrupt",
    requestId: initial.requestId,
    traceId: initial.traceId,
    sentAt: new Date().toISOString(),
    payload: { expectedGeneration: 1, reason: "user_barge_in" },
  }, (event) => interruptEvents.push(event));
  await runtime.steerTurn({
    schemaVersion: PROTOCOL_VERSION,
    type: "turn.steer",
    requestId: initial.requestId,
    traceId: initial.traceId,
    sentAt: new Date().toISOString(),
    payload: {
      message: "换一种解释",
      nextGeneration: 2,
      interactionClass: "conversation",
    },
  }, () => undefined);
  await start;

  assert.equal(interruptEvents[0]?.type, "turn.interrupt.accepted");
  await runtime.dispose();
});
