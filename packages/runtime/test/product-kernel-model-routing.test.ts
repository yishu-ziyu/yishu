import assert from "node:assert/strict";
import test from "node:test";
import { createYishuKernel } from "@yishu/kernel";
import { ProductKernelRuntime } from "../src/product-kernel-runtime.js";
import {
  LOCAL_GROK_PROVIDER,
  runtimeEvent,
  type RuntimeEvent,
  type TurnStartCommand,
} from "../src/protocol.js";
import type { AgentRuntime, RuntimeEventSink } from "../src/runtime-port.js";
import { makeTurnStartCommand } from "./fixtures.js";

class RoutingCaptureRuntime implements AgentRuntime {
  command: TurnStartCommand | undefined;
  readonly commands: TurnStartCommand[] = [];
  readonly releasedConversationIds: string[] = [];

  async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
    this.command = command;
    this.commands.push(command);
    emit(runtimeEvent("turn.started", command.requestId, command.traceId, {
      runtime: "capture",
      routingMode: "deep_task",
      resolvedRoute: "deep_task",
      provider: "untrusted-provider",
      model: "untrusted-model",
      profiles: { secret: true },
      apiKey: "must-not-escape",
    }));
    emit(runtimeEvent("response.completed", command.requestId, command.traceId, {
      text: "完成。",
      verified: true,
    }));
  }

  releaseConversationSession(conversationId: string): void {
    this.releasedConversationIds.push(conversationId);
  }

  async cancelTurn(): Promise<void> {}
  async dispose(): Promise<void> {}
}

test("product runtime passes the resolved concrete model to the inner loop and emits bounded routing metadata", async () => {
  const inner = new RoutingCaptureRuntime();
  const runtime = new ProductKernelRuntime(
    inner,
    createYishuKernel({ storeBackend: "memory" }),
  );
  const command = makeTurnStartCommand();
  command.payload.utterance = "点击这个按钮";
  command.payload.modelPreference = { provider: LOCAL_GROK_PROVIDER, model: "grok-4.6" };
  command.payload.modelRouting = {
    mode: "auto",
    profiles: {
      realtimeConversation: { provider: LOCAL_GROK_PROVIDER, model: "MiniMax-M3" },
      screenCollaboration: { provider: "xai", model: "grok-4.5" },
      deepTask: { provider: "openai-codex", model: "gpt-5.5" },
    },
  };
  const events: RuntimeEvent[] = [];

  await runtime.startTurn(command, (event) => events.push(event));

  assert.deepEqual(inner.command?.payload.modelPreference, {
    provider: "xai",
    model: "grok-4.5",
  });
  const started = events.find((event) => event.type === "turn.started");
  assert.equal(started?.payload.runtime, "capture");
  assert.equal(started?.payload.routingMode, "auto");
  assert.equal(started?.payload.resolvedRoute, "screen_collaboration");
  assert.equal(started?.payload.provider, "xai");
  assert.equal(started?.payload.model, "grok-4.5");
  assert.equal(started?.payload.generation, 1);
  assert.equal(started?.payload.recallSource, "none");
  assert.equal(typeof started?.payload.recallMs, "number");
  assert.equal(started?.payload.apiKey, undefined);
  assert.equal(started?.payload.profiles, undefined);
});

test("an inner runtime cannot forge routing metadata on a legacy default turn", async () => {
  const inner = new RoutingCaptureRuntime();
  const runtime = new ProductKernelRuntime(
    inner,
    createYishuKernel({ storeBackend: "memory" }),
  );
  const command = makeTurnStartCommand();
  command.payload.utterance = "你好";
  const events: RuntimeEvent[] = [];

  await runtime.startTurn(command, (event) => events.push(event));

  const started = events.find((event) => event.type === "turn.started");
  assert.equal(started?.payload.routingMode, undefined);
  assert.equal(started?.payload.resolvedRoute, undefined);
});

test("product actions and clarifications keep their existing short-circuits", async () => {
  const inner = new RoutingCaptureRuntime();
  const runtime = new ProductKernelRuntime(
    inner,
    createYishuKernel({ storeBackend: "memory" }),
  );
  const command = makeTurnStartCommand();
  command.payload.utterance = "记住：路由设置不改变产品动作";
  command.payload.modelRouting = {
    mode: "auto",
    profiles: {
      realtimeConversation: { provider: LOCAL_GROK_PROVIDER, model: "MiniMax-M3" },
      screenCollaboration: { provider: "xai", model: "grok-4.5" },
      deepTask: { provider: "openai-codex", model: "gpt-5.5" },
    },
  };
  const events: RuntimeEvent[] = [];

  await runtime.startTurn(command, (event) => events.push(event));

  assert.equal(inner.command, undefined);
  assert.ok(events.some((event) => event.type === "product.action.completed"));
  const started = events.find((event) => event.type === "turn.started");
  assert.equal(started?.payload.routingMode, undefined);
  assert.equal(started?.payload.resolvedRoute, undefined);

  const clarification = makeTurnStartCommand();
  clarification.payload.utterance = "20分钟后提醒我";
  clarification.payload.modelRouting = command.payload.modelRouting;
  const clarificationEvents: RuntimeEvent[] = [];
  await runtime.startTurn(clarification, (event) => clarificationEvents.push(event));

  assert.equal(inner.command, undefined);
  const clarificationStarted = clarificationEvents.find((event) => event.type === "turn.started");
  assert.equal(clarificationStarted?.payload.routingMode, undefined);
  assert.equal(clarificationStarted?.payload.resolvedRoute, undefined);
});

test("switching A to B to A evicts the previous conversation session before every changed model", async () => {
  const inner = new RoutingCaptureRuntime();
  const runtime = new ProductKernelRuntime(
    inner,
    createYishuKernel({ storeBackend: "memory" }),
  );
  const conversationId = makeTurnStartCommand().requestId;
  const choices = [
    { provider: "xai", model: "grok-4.5" },
    { provider: "openai-codex", model: "gpt-5.5" },
    { provider: "xai", model: "grok-4.5" },
  ] as const;

  for (const preference of choices) {
    const command = makeTurnStartCommand();
    command.payload.utterance = "继续讨论这个方案";
    command.payload.conversationId = conversationId;
    command.payload.modelRouting = { mode: "fixed_model", preference };
    await runtime.startTurn(command, () => undefined);
  }

  assert.deepEqual(
    inner.commands.map((command) => command.payload.modelPreference),
    choices,
  );
  assert.deepEqual(inner.releasedConversationIds, [conversationId, conversationId]);
});
