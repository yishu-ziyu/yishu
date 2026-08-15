/**
 * ADR 0015 B-architecture behavior tests: the engine owns assembly timing at
 * three moments — skill catalog into the stable system prefix at session
 * creation, memory block leading the turn's first user message, and the
 * status bar as a transient trailing message after each tool batch — plus the
 * adapter-level promotion invalidation (skillsVersion in the session cache
 * key).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createYishuAgentSession } from "../src/model-loop/model-session.js";
import type {
  ModelProviderRuntime,
  ResolvedModel,
  ToolDefinition,
} from "../src/model-loop/types.js";
import type { SkillL1Entry, TurnContextProviders } from "../src/model-loop/turn-context.js";
import { YishuLoopRuntimeAdapter } from "../src/loop-adapter.js";
import type { RuntimeEvent, TurnStartCommand } from "../src/protocol.js";
import { makeTurnStartCommand } from "./fixtures.js";

const MODEL: ResolvedModel = {
  providerId: "local-grok",
  id: "test-model",
  name: "test-model",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:8787/v1",
  input: ["text"],
  contextWindow: 128_000,
  maxTokens: 4_096,
};

const providerRuntime = {
  getProvider: () => undefined,
  getAvailable: async () => [],
  checkAuth: async () => undefined,
  getAuth: async () => undefined,
  login: async () => undefined,
  logout: async () => undefined,
  resolveModel: async () => MODEL,
  bearer: async () => "stub-bearer",
  extraHeaders: async () => ({}),
  providerVersion: () => 0,
} as unknown as ModelProviderRuntime;

const echoTool: ToolDefinition<any, any> = {
  name: "echo",
  label: "echo",
  description: "Return the input unchanged.",
  promptSnippet: "",
  promptGuidelines: [],
  parameters: { type: "object" },
  executionMode: "sequential",
  async execute() {
    return { content: [{ type: "text", text: "echoed" }], details: undefined };
  },
};

interface CapturedRequest {
  url: string;
  body: {
    model: string;
    messages: Array<{ role: string; content: unknown }>;
    tools?: unknown[];
  };
}

function sseBody(lines: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

function installFetchStub(
  script: (request: CapturedRequest, callIndex: number) => readonly string[],
): { requests: CapturedRequest[]; restore(): void } {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as CapturedRequest["body"];
    const request: CapturedRequest = { url: String(_input), body };
    requests.push(request);
    const lines = script(request, requests.length - 1);
    return new Response(sseBody(lines), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  return { requests, restore: () => { globalThis.fetch = originalFetch; } };
}

function textResponse(text: string): readonly string[] {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
}

function toolCallResponse(call: { id: string; name: string; argumentsJson: string }): readonly string[] {
  return [
    `data: ${JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: call.id,
            function: { name: call.name, arguments: call.argumentsJson },
          }],
        },
      }],
    })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
}

function messageTexts(request: CapturedRequest): string[] {
  return request.body.messages.map((message) => String(message.content ?? ""));
}

test("engine assembles catalog prefix, memory block, and transient status bar", async (t) => {
  const fetchStub = installFetchStub((_request, index) =>
    index === 0
      ? toolCallResponse({ id: "call_1", name: "echo", argumentsJson: "{}" })
      : textResponse("好的。"));
  t.after(fetchStub.restore);

  const memoryCalls: string[] = [];
  const statusBarCalls: Array<{ toolCallCount: number; lastToolName?: string; lastToolFailed: boolean }> = [];
  const context: TurnContextProviders = {
    skillCatalog: async () => [
      { name: "export-notes", description: "导出笔记 · Notes · 打开导出面板" },
    ],
    assembleTurnMemory: async (turnText) => {
      memoryCalls.push(turnText);
      return "MEMORY: 用户偏好要点列表";
    },
    statusBar: async (state) => {
      statusBarCalls.push(state);
      return `[executor: ${state.toolCallCount} tool call, last ${state.lastToolName} ok]`;
    },
  };

  const { session } = await createYishuAgentSession({
    model: MODEL,
    providerRuntime,
    systemPrompt: "PERSONA",
    customTools: [echoTool],
    context,
  });
  t.after(() => session.dispose());

  await session.prompt("你好");

  assert.deepEqual(memoryCalls, ["你好"]);
  assert.equal(fetchStub.requests.length, 2, "tool call forces a second model iteration");
  const [first, second] = fetchStub.requests;

  // L1 catalog joined the stable system prefix at session creation.
  const systemPrefix = String(first.body.messages[0]?.content);
  assert.match(systemPrefix, /PERSONA/);
  assert.match(systemPrefix, /## Verified skills available/);
  assert.match(systemPrefix, /export-notes: 导出笔记/);

  // Memory block leads the turn's first user message.
  const firstUser = first.body.messages.find((message) => message.role === "user");
  assert.equal(firstUser?.content, "MEMORY: 用户偏好要点列表\n\n你好");

  // No status text before the first tool batch.
  assert.equal(messageTexts(first).some((text) => text.includes("[executor:")), false);

  // After the tool batch the status bar rides only the next model call.
  assert.deepEqual(statusBarCalls, [{ toolCallCount: 1, lastToolName: "echo", lastToolFailed: false }]);
  const secondTail = second.body.messages.at(-1);
  assert.equal(secondTail?.role, "user");
  assert.equal(secondTail?.content, "[executor: 1 tool call, last echo ok]");

  // The transient tail never persists into history: a later turn on the same
  // session must not carry any status text.
  await session.prompt("再来一次");
  assert.equal(fetchStub.requests.length, 3);
  assert.equal(
    messageTexts(fetchStub.requests[2]!).some((text) => text.includes("[executor:")),
    false,
    "status bar text is transient and must not leak into later turns",
  );
});

test("skill promotion invalidates cached sessions and cold-starts the new catalog", async (t) => {
  const fetchStub = installFetchStub(() => textResponse("完成。"));
  t.after(fetchStub.restore);

  let catalog: readonly SkillL1Entry[] = [{ name: "skill-a", description: "A" }];
  const adapter = new YishuLoopRuntimeAdapter(process.cwd(), undefined, {
    modelRuntimePromise: Promise.resolve(providerRuntime),
  });
  t.after(() => adapter.dispose());
  adapter.setTurnContextProviderFactory((scopeKind) => ({
    skillCatalog: async () => (scopeKind === "private" ? [] : catalog),
  }));

  const conversationId = randomUUID();
  const command = (utterance: string): TurnStartCommand => {
    const next = makeTurnStartCommand();
    next.payload.utterance = utterance;
    next.payload.conversationId = conversationId;
    return next;
  };
  const sink = (event: RuntimeEvent): void => {
    if (event.type === "turn.failed") {
      assert.fail(`unexpected turn failure: ${JSON.stringify(event.payload)}`);
    }
  };

  await adapter.startTurn(command("第一句"), sink);
  assert.equal(fetchStub.requests.length, 1);
  assert.match(messageTexts(fetchStub.requests[0]!)[0] ?? "", /skill-a/);

  // Promotion: catalog changes and the adapter retires cached sessions.
  catalog = [{ name: "skill-b", description: "B" }];
  adapter.invalidateSkillSessions();

  await adapter.startTurn(command("第二句"), sink);
  assert.equal(fetchStub.requests.length, 2);
  const secondSystem = messageTexts(fetchStub.requests[1]!)[0] ?? "";
  assert.match(secondSystem, /skill-b/);
  assert.doesNotMatch(secondSystem, /skill-a/);
});
