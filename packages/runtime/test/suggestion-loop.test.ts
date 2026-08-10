import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createYishuKernel, type YishuKernel } from "@yishu/kernel";
import {
  runtimeEvent,
  type RuntimeEvent,
  type SessionScope,
  type TurnStartCommand,
} from "../src/protocol.js";
import { RuntimeSuggestionTracker } from "../src/suggestion-loop.js";
import { makeTurnStartCommand } from "./fixtures.js";

function toolStarted(command: TurnStartCommand): RuntimeEvent {
  return runtimeEvent("tool.started", command.requestId, command.traceId, {
    toolName: "computer_control",
  });
}

/** `verified === undefined` models the common no-verification tool turn. */
function responseCompleted(command: TurnStartCommand, verified?: boolean): RuntimeEvent {
  const payload: { text: string; verified?: boolean } = { text: "done" };
  if (verified !== undefined) payload.verified = verified;
  return runtimeEvent("response.completed", command.requestId, command.traceId, payload);
}

function turnCancelled(command: TurnStartCommand): RuntimeEvent {
  return runtimeEvent("turn.cancelled", command.requestId, command.traceId, {
    reason: "user_cancelled",
  });
}

function turnFailed(command: TurnStartCommand): RuntimeEvent {
  return runtimeEvent("turn.failed", command.requestId, command.traceId, {
    code: "scripted_failure",
    message: "boom",
  });
}

function runtimeError(command: TurnStartCommand): RuntimeEvent {
  return runtimeEvent("runtime.error", command.requestId, command.traceId, {
    code: "scripted_error",
    message: "boom",
  });
}

/** Drive one tracker with a scripted event sequence; no real timers involved. */
async function runScriptedTurn(
  kernel: YishuKernel,
  script: (command: TurnStartCommand) => RuntimeEvent[],
  sessionScope?: SessionScope,
): Promise<void> {
  const command = makeTurnStartCommand();
  command.payload.conversationId = randomUUID();
  if (sessionScope !== undefined) command.payload.sessionScope = sessionScope;
  const tracker = new RuntimeSuggestionTracker(kernel, command);
  for (const event of script(command)) tracker.observe(event);
  await tracker.flush();
}

async function mindMarkdown(kernel: YishuKernel): Promise<string> {
  return (await kernel.store.getMind()).markdown;
}

test("verified completion settles succeeded; two successes teach the mind", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });

  await runScriptedTurn(kernel, (c) => [toolStarted(c), responseCompleted(c, true)]);
  let suggestions = await kernel.store.listSuggestions();
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.status, "succeeded");
  assert.equal(typeof suggestions[0]?.outcomeAt, "string");
  // One success is not enough to rewrite the mind.
  assert.equal((await mindMarkdown(kernel)).trim(), "");

  await runScriptedTurn(kernel, (c) => [toolStarted(c), responseCompleted(c, true)]);
  suggestions = await kernel.store.listSuggestions();
  assert.equal(suggestions.length, 2);
  assert.ok(suggestions.every((item) => item.status === "succeeded"));
  const markdown = await mindMarkdown(kernel);
  assert.match(markdown, /tool-computer-control/);
  assert.match(markdown, /worked 2 times/);
});

test("explicit negative verification settles failed", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });

  await runScriptedTurn(kernel, (c) => [toolStarted(c), responseCompleted(c, false)]);

  const suggestions = await kernel.store.listSuggestions();
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.status, "failed");
  assert.equal(typeof suggestions[0]?.outcomeAt, "string");
});

test("completion without a verification signal settles unknown, never failed", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });

  await runScriptedTurn(kernel, (c) => [toolStarted(c), responseCompleted(c)]);
  await runScriptedTurn(kernel, (c) => [toolStarted(c), responseCompleted(c)]);
  await runScriptedTurn(kernel, (c) => [toolStarted(c), responseCompleted(c)]);

  const suggestions = await kernel.store.listSuggestions();
  assert.equal(suggestions.length, 3);
  assert.ok(suggestions.every((item) => item.status === "unknown"));
  // unknown is a terminal outcome record, so outcomeAt is stamped.
  assert.ok(suggestions.every((item) => typeof item.outcomeAt === "string"));
  // Repeated unknowns never trigger a mind write.
  assert.equal((await mindMarkdown(kernel)).trim(), "");
});

test("unknown adds no evidence: one success plus unknowns cannot teach the mind", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });

  await runScriptedTurn(kernel, (c) => [toolStarted(c), responseCompleted(c, true)]);
  await runScriptedTurn(kernel, (c) => [toolStarted(c), responseCompleted(c)]);
  await runScriptedTurn(kernel, (c) => [toolStarted(c), responseCompleted(c)]);

  const suggestions = await kernel.store.listSuggestions();
  assert.deepEqual(
    suggestions.map((item) => item.status),
    ["succeeded", "unknown", "unknown"],
  );
  assert.equal((await mindMarkdown(kernel)).trim(), "");
});

test("unknown adds no evidence: two failures plus one unknown still teach a failed lesson", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });

  await runScriptedTurn(kernel, (c) => [toolStarted(c), responseCompleted(c, false)]);
  await runScriptedTurn(kernel, (c) => [toolStarted(c), responseCompleted(c)]);
  await runScriptedTurn(kernel, (c) => [toolStarted(c), responseCompleted(c, false)]);

  const suggestions = await kernel.store.listSuggestions();
  assert.deepEqual(
    suggestions.map((item) => item.status),
    ["failed", "unknown", "failed"],
  );
  const markdown = await mindMarkdown(kernel);
  assert.match(markdown, /tool-computer-control/);
  assert.match(markdown, /failed 2 times/);
});

test("turn.cancelled settles ignored and adds no evidence", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });

  await runScriptedTurn(kernel, (c) => [toolStarted(c), turnCancelled(c)]);
  await runScriptedTurn(kernel, (c) => [toolStarted(c), turnCancelled(c)]);

  const suggestions = await kernel.store.listSuggestions();
  assert.equal(suggestions.length, 2);
  assert.ok(suggestions.every((item) => item.status === "ignored"));
  assert.equal((await mindMarkdown(kernel)).trim(), "");
});

test("turn.failed and runtime.error settle failed", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });

  await runScriptedTurn(kernel, (c) => [toolStarted(c), turnFailed(c)]);
  await runScriptedTurn(kernel, (c) => [toolStarted(c), runtimeError(c)]);

  const suggestions = await kernel.store.listSuggestions();
  assert.equal(suggestions.length, 2);
  assert.ok(suggestions.every((item) => item.status === "failed"));
});

test("private sessions record no suggestion at all", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });

  await runScriptedTurn(
    kernel,
    (c) => [toolStarted(c), responseCompleted(c, true)],
    { kind: "private" },
  );

  assert.deepEqual(await kernel.store.listSuggestions(), []);
  assert.equal((await mindMarkdown(kernel)).trim(), "");
});

test("pure-conversation turns record no suggestion and settle nothing", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });

  await runScriptedTurn(kernel, (c) => [responseCompleted(c, true)]);

  assert.deepEqual(await kernel.store.listSuggestions(), []);
});

test("a terminal event racing the first tool event still settles exactly once", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const command = makeTurnStartCommand();
  command.payload.conversationId = randomUUID();
  const tracker = new RuntimeSuggestionTracker(kernel, command);

  // Same tick: the create path is still in flight when the terminal event lands.
  tracker.observe(toolStarted(command));
  tracker.observe(responseCompleted(command, true));
  await tracker.flush();

  const suggestions = await kernel.store.listSuggestions();
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.status, "succeeded");
  assert.equal(typeof suggestions[0]?.outcomeAt, "string");
});

test("flush swallows persistence errors and the next turn is unaffected", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const store = kernel.store;
  const original = store.addSuggestion.bind(store);
  let failNext = true;
  store.addSuggestion = (input, options) => {
    if (failNext) {
      failNext = false;
      return Promise.reject(new Error("store_boom"));
    }
    return original(input, options);
  };

  // The failing turn must resolve flush cleanly and record nothing.
  await runScriptedTurn(kernel, (c) => [toolStarted(c), responseCompleted(c, true)]);
  assert.deepEqual(await kernel.store.listSuggestions(), []);

  // The store recovered: the next turn records and settles normally.
  await runScriptedTurn(kernel, (c) => [toolStarted(c), responseCompleted(c, true)]);
  const suggestions = await kernel.store.listSuggestions();
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.status, "succeeded");
});
