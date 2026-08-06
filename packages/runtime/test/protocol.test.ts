import assert from "node:assert/strict";
import test from "node:test";
import { PI_CAPABILITY_PROFILES } from "../src/capability-profiles.js";
import { buildGroundedPrompt } from "../src/context-prompt.js";
import { MockAgentRuntime } from "../src/mock-runtime.js";
import { YISHU_SYSTEM_PROMPT } from "../src/persona.js";
import {
  clientCommandSchema,
  computerActionResultCommandSchema,
  LOCAL_GROK_BASE_URL,
  LOCAL_GROK_PROVIDER,
  modelPreferenceSchema,
} from "../src/protocol.js";
import { makeTurnStartCommand } from "./fixtures.js";

test("turn command validates as the shared protocol", () => {
  const command = makeTurnStartCommand();
  assert.equal(clientCommandSchema.parse(command).type, "turn.start");
});

test("computer action result validates as a typed client command", () => {
  const requestId = makeTurnStartCommand().requestId;
  const command = {
    schemaVersion: 1,
    type: "computer.action.result",
    requestId,
    traceId: makeTurnStartCommand().traceId,
    sentAt: new Date().toISOString(),
    payload: {
      actionId: makeTurnStartCommand().requestId,
      succeeded: true,
      verified: true,
      message: "Target became selected.",
    },
  } as const;

  assert.equal(computerActionResultCommandSchema.parse(command).type, "computer.action.result");
  assert.equal(clientCommandSchema.parse(command).type, "computer.action.result");
});

test("model preference round-trips only the local Grok route", () => {
  const preference = {
    provider: LOCAL_GROK_PROVIDER,
    model: "grok-4.5",
  } as const;

  assert.deepEqual(modelPreferenceSchema.parse(preference), preference);
  assert.equal(LOCAL_GROK_BASE_URL, "http://127.0.0.1:8787/v1");

  const command = makeTurnStartCommand();
  command.payload.modelPreference = preference;
  assert.deepEqual(
    clientCommandSchema.parse(command).payload.modelPreference,
    preference,
  );
});

test("model preference rejects arbitrary URLs, providers, models, and fields", () => {
  const invalidProvider = {
    provider: "https://attacker.example/v1",
    model: "grok-4.5",
  };
  assert.throws(() => modelPreferenceSchema.parse(invalidProvider));
  assert.throws(() => clientCommandSchema.parse({
    ...makeTurnStartCommand(),
    payload: { ...makeTurnStartCommand().payload, modelPreference: invalidProvider },
  }));

  const invalidModel = {
    provider: LOCAL_GROK_PROVIDER,
    model: "gpt-4o",
  };
  assert.throws(() => modelPreferenceSchema.parse(invalidModel));
  assert.throws(() => clientCommandSchema.parse({
    ...makeTurnStartCommand(),
    payload: { ...makeTurnStartCommand().payload, modelPreference: invalidModel },
  }));

  const unknownGrok = {
    provider: LOCAL_GROK_PROVIDER,
    model: "grok-not-in-clicky-picker",
  };
  assert.throws(() => modelPreferenceSchema.parse(unknownGrok));

  const unexpectedUrl = {
    provider: LOCAL_GROK_PROVIDER,
    model: "grok-4.5",
    baseUrl: "https://attacker.example/v1",
  };
  assert.throws(() => modelPreferenceSchema.parse(unexpectedUrl));
  assert.throws(() => clientCommandSchema.parse({
    ...makeTurnStartCommand(),
    payload: { ...makeTurnStartCommand().payload, modelPreference: unexpectedUrl },
  }));
});

test("grounded prompt includes evidence but never screenshot bytes", () => {
  const prompt = buildGroundedPrompt(makeTurnStartCommand());
  assert.match(prompt, /Markup/);
  assert.match(prompt, /这个按钮为什么是灰色的/);
  assert.doesNotMatch(prompt, /c2NyZWVu/);
});

test("capability profiles retain mature Pi tools only where they belong", () => {
  assert.equal(PI_CAPABILITY_PROFILES.conversation.noTools, "builtin");
  assert.deepEqual(PI_CAPABILITY_PROFILES.observe.tools, ["read", "grep", "find", "ls"]);
  assert.ok(PI_CAPABILITY_PROFILES.build.tools?.includes("bash"));
  assert.deepEqual(PI_CAPABILITY_PROFILES.owner, {});
});

test("Yishu persona keeps agency without leaking private reflection", () => {
  assert.match(YISHU_SYSTEM_PROMPT, /主观能动性/);
  assert.match(YISHU_SYSTEM_PROMPT, /尽量不拒绝/);
  assert.match(YISHU_SYSTEM_PROMPT, /不输出 <mood>/);
  assert.match(YISHU_SYSTEM_PROMPT, /工具返回成功不等于/);
  assert.match(YISHU_SYSTEM_PROMPT, /Hanako 不是另一个对外身份/);
});

test("mock runtime completes a grounded response", async () => {
  const runtime = new MockAgentRuntime();
  const events: Array<{ type: string; payload: unknown }> = [];
  await runtime.startTurn(makeTurnStartCommand(), (event) => events.push(event));

  const completed = events.find((event) => event.type === "response.completed");
  assert.ok(completed);
  assert.match(JSON.stringify(completed.payload), /Markup/);
  await runtime.dispose();
});
