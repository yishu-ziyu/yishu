import assert from "node:assert/strict";
import { test } from "node:test";
import { createYishuAgentSession, FIRST_BYTE_FALLBACK_SPEECH, MAX_MODEL_ITERATIONS, resolveFirstByteTimeoutMs } from "../src/model-loop/model-session.js";
import type {
  ModelProviderRuntime,
  ResolvedModel,
  ToolDefinition,
} from "../src/model-loop/types.js";

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

function sseBody(lines: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

function hangingBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start() {
      // Never enqueue or close: first-byte timeout must abort this reader.
    },
  });
}

function delayedRestBody(
  firstLines: readonly string[],
  restLines: readonly string[],
  delayMs: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of firstLines) controller.enqueue(encoder.encode(line));
      setTimeout(() => {
        for (const line of restLines) controller.enqueue(encoder.encode(line));
        controller.close();
      }, delayMs);
    },
  });
}

function toolCallsResponse(
  calls: readonly { id: string; name: string; argumentsJson: string }[],
  spoken: string | false = "行。",
): readonly string[] {
  const chunks: string[] = [];
  if (spoken) {
    chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content: spoken } }] })}\n\n`);
  }
  chunks.push(
    `data: ${JSON.stringify({
      choices: [{
        delta: {
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            function: { name: call.name, arguments: call.argumentsJson },
          })),
        },
      }],
    })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
    "data: [DONE]\n\n",
  );
  return chunks;
}

function installFetchStub(
  script: (callIndex: number) => Response | Promise<Response>,
): { restore(): void } {
  const originalFetch = globalThis.fetch;
  let callIndex = 0;
  globalThis.fetch = (async () => script(callIndex++)) as typeof fetch;
  return { restore: () => { globalThis.fetch = originalFetch; } };
}

function okStream(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

test("first-byte timeout defaults to 8s and honors YISHU_MODEL_FIRST_BYTE_MS", () => {
  assert.equal(resolveFirstByteTimeoutMs(undefined, {}), 8_000);
  assert.equal(resolveFirstByteTimeoutMs(undefined, { YISHU_MODEL_FIRST_BYTE_MS: "2500" }), 2_500);
  assert.equal(resolveFirstByteTimeoutMs(40, { YISHU_MODEL_FIRST_BYTE_MS: "2500" }), 40);
});

test("a silent model stream fails instead of hanging past the first-byte deadline", async (t) => {
  const fetchStub = installFetchStub(() => okStream(hangingBody()));
  t.after(fetchStub.restore);

  const { session } = await createYishuAgentSession({
    model: MODEL,
    providerRuntime,
    systemPrompt: "PERSONA",
    customTools: [],
    streamFirstByteTimeoutMs: 40,
  });
  t.after(() => session.dispose());

  let spoken = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      spoken += event.assistantMessageEvent.delta;
    }
  });
  t.after(unsubscribe);

  const startedAt = Date.now();
  await assert.rejects(session.prompt("你好"), (error: unknown) => {
    assert.match(String(error), /timed out waiting for the first byte/);
    return true;
  });
  assert.ok(Date.now() - startedAt < 1_000, "first-byte timeout must not wait the production 20s");
  assert.equal(session.agent.state.errorMessage, "Model stream timed out waiting for the first byte.");
  assert.equal(spoken, FIRST_BYTE_FALLBACK_SPEECH);
});

test("MiniMax content on the finish chunk is spoken", async (t) => {
  const fetchStub = installFetchStub(() => okStream(sseBody([
    `data: ${JSON.stringify({
      choices: [{ delta: { role: "assistant", content: "", reasoning_content: "hidden" } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: { content: "今天是星期五。" }, finish_reason: "stop" }],
    })}\n\n`,
    "data: [DONE]\n\n",
  ])));
  t.after(fetchStub.restore);

  const { session } = await createYishuAgentSession({
    model: MODEL,
    providerRuntime,
    systemPrompt: "PERSONA",
    customTools: [],
  });
  t.after(() => session.dispose());

  let spoken = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      spoken += event.assistantMessageEvent.delta;
    }
  });
  t.after(unsubscribe);

  await session.prompt("今天星期几？");
  assert.equal(spoken, "今天是星期五。");
  assert.equal(session.agent.state.errorMessage, null);
});

test("SSE first bytes and reasoning_content are traced without being spoken", async (t) => {
  const fetchStub = installFetchStub(() => okStream(sseBody([
    ": ping\n\n",
    `data: ${JSON.stringify({
      choices: [{ delta: { role: "assistant", content: "", reasoning_content: "hidden-chain" } }],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: { content: "在。" } }],
    })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ])));
  t.after(fetchStub.restore);

  const { session } = await createYishuAgentSession({
    model: MODEL,
    providerRuntime,
    systemPrompt: "PERSONA",
    customTools: [],
  });
  t.after(() => session.dispose());

  const types: string[] = [];
  let spoken = "";
  let reasoning = "";
  const unsubscribe = session.subscribe((event) => {
    types.push(event.type);
    if (event.type === "reasoning_delta") reasoning += event.delta;
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      spoken += event.assistantMessageEvent.delta;
    }
  });
  t.after(unsubscribe);

  await session.prompt("在吗");
  assert.equal(spoken, "在。");
  assert.equal(reasoning, "hidden-chain");
  const sse = types.indexOf("sse_first_byte");
  const thought = types.indexOf("reasoning_delta");
  const visible = types.indexOf("message_update");
  assert.ok(sse >= 0 && thought > sse && visible > thought);
});

test("first-byte timeout does not abort a stream that already started speaking", async (t) => {
  const fetchStub = installFetchStub(() => okStream(delayedRestBody(
    [`data: ${JSON.stringify({ choices: [{ delta: { content: "先" } }] })}\n\n`],
    [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "后。" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ],
    80,
  )));
  t.after(fetchStub.restore);

  const { session } = await createYishuAgentSession({
    model: MODEL,
    providerRuntime,
    systemPrompt: "PERSONA",
    customTools: [],
    streamFirstByteTimeoutMs: 40,
  });
  t.after(() => session.dispose());

  let spoken = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      spoken += event.assistantMessageEvent.delta;
    }
  });
  t.after(unsubscribe);

  await session.prompt("你好");
  assert.equal(spoken, "先后。");
  assert.equal(session.agent.state.errorMessage, null);
});

test("cancel stops later tools in the same batch", async (t) => {
  const order: string[] = [];
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const slow: ToolDefinition = {
    name: "slow",
    label: "slow",
    description: "blocks until aborted",
    promptSnippet: "",
    promptGuidelines: [],
    parameters: { type: "object" },
    executionMode: "sequential",
    async execute(_id, _params, signal) {
      order.push("slow-start");
      markFirstStarted();
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return { content: [{ type: "text", text: "slow" }], details: undefined };
    },
  };
  const later: ToolDefinition = {
    name: "later",
    label: "later",
    description: "must not run after cancel",
    promptSnippet: "",
    promptGuidelines: [],
    parameters: { type: "object" },
    executionMode: "sequential",
    async execute() {
      order.push("later");
      return { content: [{ type: "text", text: "later" }], details: undefined };
    },
  };

  const fetchStub = installFetchStub(() => okStream(sseBody(toolCallsResponse([
    { id: "call_1", name: "slow", argumentsJson: "{}" },
    { id: "call_2", name: "later", argumentsJson: "{}" },
  ]))));
  t.after(fetchStub.restore);

  const { session } = await createYishuAgentSession({
    model: MODEL,
    providerRuntime,
    systemPrompt: "PERSONA",
    customTools: [slow, later],
  });
  t.after(() => session.dispose());

  const prompt = session.prompt("做两步");
  await firstStarted;
  await session.abort();
  await assert.rejects(prompt, /aborted/i);
  assert.deepEqual(order, ["slow-start"]);
});

test("the last model call withholds tools so a looping turn can still speak", async (t) => {
  const requests: Array<{
    tools?: unknown;
    messages?: Array<{ role?: string; content?: unknown }>;
  }> = [];
  let callIndex = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    if (init && typeof init === "object" && "body" in init && typeof init.body === "string") {
      requests.push(JSON.parse(init.body) as (typeof requests)[number]);
    }
    const lines = callIndex < MAX_MODEL_ITERATIONS - 1
      ? toolCallsResponse([{ id: `call_${callIndex}`, name: "echo", argumentsJson: "{}" }])
      : stopResponse();
    callIndex += 1;
    return okStream(sseBody(lines));
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const echo: ToolDefinition = {
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

  const { session } = await createYishuAgentSession({
    model: MODEL,
    providerRuntime,
    systemPrompt: "PERSONA",
    customTools: [echo],
  });
  t.after(() => session.dispose());

  const deltas: string[] = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      deltas.push(event.assistantMessageEvent.delta);
    }
  });
  t.after(unsubscribe);

  await session.prompt("循环");
  assert.equal(callIndex, MAX_MODEL_ITERATIONS);
  assert.equal(requests.length, MAX_MODEL_ITERATIONS);
  for (const request of requests.slice(0, MAX_MODEL_ITERATIONS - 1)) {
    assert.ok(Array.isArray(request.tools) && request.tools.length > 0);
  }
  assert.equal(requests[MAX_MODEL_ITERATIONS - 1]?.tools, undefined);
  const lastMessages = requests[MAX_MODEL_ITERATIONS - 1]?.messages ?? [];
  const lastUser = [...lastMessages].reverse().find((message) => message.role === "user");
  assert.match(String(lastUser?.content ?? ""), /不要再调用工具/);
  assert.match(deltas.join(""), /好/);
});

function stopResponse(): readonly string[] {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "好。" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
}

function timedTool(
  name: string,
  mode: ToolDefinition["executionMode"],
  delayMs: number,
  order: string[],
): ToolDefinition {
  return {
    name,
    label: name,
    description: name,
    promptSnippet: "",
    promptGuidelines: [],
    parameters: { type: "object" },
    executionMode: mode,
    async execute() {
      order.push(`${name}-start`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      order.push(`${name}-end`);
      return { content: [{ type: "text", text: name }], details: undefined };
    },
  };
}

test("parallel tools in one batch overlap", async (t) => {
  const order: string[] = [];
  const fetchBodies: Array<{ messages?: Array<{ role?: string; tool_call_id?: string }> }> = [];
  const realFetch = globalThis.fetch;
  let callIndex = 0;
  globalThis.fetch = (async (_input, init) => {
    if (init && typeof init === "object" && "body" in init && typeof init.body === "string") {
      fetchBodies.push(JSON.parse(init.body) as { messages?: Array<{ role?: string; tool_call_id?: string }> });
    }
    const body = callIndex === 0
      ? toolCallsResponse([
        { id: "call_a", name: "lookup_a", argumentsJson: "{}" },
        { id: "call_b", name: "lookup_b", argumentsJson: "{}" },
      ])
      : stopResponse();
    callIndex += 1;
    return okStream(sseBody(body));
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const { session } = await createYishuAgentSession({
    model: MODEL,
    providerRuntime,
    systemPrompt: "PERSONA",
    customTools: [
      timedTool("lookup_a", "parallel", 80, order),
      timedTool("lookup_b", "parallel", 20, order),
    ],
  });
  t.after(() => session.dispose());

  const startedAt = Date.now();
  await session.prompt("同时查两件");
  const elapsed = Date.now() - startedAt;

  assert.ok(order.indexOf("lookup_a-start") < order.indexOf("lookup_b-end"));
  assert.ok(order.indexOf("lookup_b-start") < order.indexOf("lookup_a-end"));
  assert.ok(order.indexOf("lookup_b-end") < order.indexOf("lookup_a-end"));
  assert.ok(elapsed < 140, `independent 80ms+20ms tools must overlap, took ${elapsed}ms`);

  const followUp = fetchBodies.at(-1);
  const toolIds = (followUp?.messages ?? [])
    .filter((message) => message.role === "tool")
    .map((message) => message.tool_call_id);
  assert.deepEqual(toolIds, ["call_a", "call_b"]);
});

test("a parallel lookup may overlap a sequential click", async (t) => {
  const order: string[] = [];
  const fetchStub = installFetchStub((callIndex) => {
    return okStream(sseBody(callIndex === 0
      ? toolCallsResponse([
        { id: "call_click", name: "click_a", argumentsJson: "{}" },
        { id: "call_lookup", name: "lookup_a", argumentsJson: "{}" },
      ])
      : stopResponse()));
  });
  t.after(fetchStub.restore);

  const { session } = await createYishuAgentSession({
    model: MODEL,
    providerRuntime,
    systemPrompt: "PERSONA",
    customTools: [
      timedTool("click_a", "sequential", 80, order),
      timedTool("lookup_a", "parallel", 80, order),
    ],
  });
  t.after(() => session.dispose());

  const startedAt = Date.now();
  await session.prompt("边点边查");
  const elapsed = Date.now() - startedAt;
  assert.ok(order.indexOf("click_a-start") < order.indexOf("lookup_a-end"));
  assert.ok(order.indexOf("lookup_a-start") < order.indexOf("click_a-end"));
  assert.ok(elapsed < 140, `lookup must not wait behind the click, took ${elapsed}ms`);
});

test("sequential tools in one batch stay one at a time", async (t) => {
  const order: string[] = [];
  const fetchStub = installFetchStub((callIndex) => {
    return okStream(sseBody(callIndex === 0
      ? toolCallsResponse([
        { id: "call_1", name: "click_a", argumentsJson: "{}" },
        { id: "call_2", name: "click_b", argumentsJson: "{}" },
      ])
      : stopResponse()));
  });
  t.after(fetchStub.restore);

  const { session } = await createYishuAgentSession({
    model: MODEL,
    providerRuntime,
    systemPrompt: "PERSONA",
    customTools: [
      timedTool("click_a", "sequential", 40, order),
      timedTool("click_b", "sequential", 40, order),
    ],
  });
  t.after(() => session.dispose());

  await session.prompt("点两下");
  assert.deepEqual(order, ["click_a-start", "click_a-end", "click_b-start", "click_b-end"]);
});

test("cancel still skips a later sequential tool when a parallel tool is in the batch", async (t) => {
  const order: string[] = [];
  let markSlowStarted!: () => void;
  const slowStarted = new Promise<void>((resolve) => {
    markSlowStarted = resolve;
  });
  const lookup: ToolDefinition = {
    name: "lookup",
    label: "lookup",
    description: "independent",
    promptSnippet: "",
    promptGuidelines: [],
    parameters: { type: "object" },
    executionMode: "parallel",
    async execute() {
      order.push("lookup-start");
      await new Promise((resolve) => setTimeout(resolve, 200));
      order.push("lookup-end");
      return { content: [{ type: "text", text: "lookup" }], details: undefined };
    },
  };
  const slow: ToolDefinition = {
    name: "slow",
    label: "slow",
    description: "blocks until aborted",
    promptSnippet: "",
    promptGuidelines: [],
    parameters: { type: "object" },
    executionMode: "sequential",
    async execute(_id, _params, signal) {
      order.push("slow-start");
      markSlowStarted();
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return { content: [{ type: "text", text: "slow" }], details: undefined };
    },
  };
  const later: ToolDefinition = {
    name: "later",
    label: "later",
    description: "must not run after cancel",
    promptSnippet: "",
    promptGuidelines: [],
    parameters: { type: "object" },
    executionMode: "sequential",
    async execute() {
      order.push("later");
      return { content: [{ type: "text", text: "later" }], details: undefined };
    },
  };

  const fetchStub = installFetchStub(() => okStream(sseBody(toolCallsResponse([
    { id: "call_lookup", name: "lookup", argumentsJson: "{}" },
    { id: "call_slow", name: "slow", argumentsJson: "{}" },
    { id: "call_later", name: "later", argumentsJson: "{}" },
  ]))));
  t.after(fetchStub.restore);

  const { session } = await createYishuAgentSession({
    model: MODEL,
    providerRuntime,
    systemPrompt: "PERSONA",
    customTools: [lookup, slow, later],
  });
  t.after(() => session.dispose());

  const prompt = session.prompt("一起做");
  await slowStarted;
  await session.abort();
  await assert.rejects(prompt, /aborted/i);
  assert.ok(order.includes("lookup-start"));
  assert.ok(order.includes("slow-start"));
  assert.equal(order.includes("later"), false);
});

test("a tool recapture image is sent on the next model call, not the turn-start image", async (t) => {
  const bodies: Array<{ messages?: Array<{ role?: string; content?: unknown }> }> = [];
  const realFetch = globalThis.fetch;
  let callIndex = 0;
  globalThis.fetch = (async (_input, init) => {
    if (init && typeof init === "object" && "body" in init && typeof init.body === "string") {
      bodies.push(JSON.parse(init.body) as { messages?: Array<{ role?: string; content?: unknown }> });
    }
    const body = callIndex === 0
      ? toolCallsResponse([{ id: "call_click", name: "click_a", argumentsJson: "{}" }])
      : stopResponse();
    callIndex += 1;
    return okStream(sseBody(body));
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const click: ToolDefinition = {
    name: "click_a",
    label: "click",
    description: "click",
    promptSnippet: "",
    promptGuidelines: [],
    parameters: { type: "object" },
    executionMode: "sequential",
    async execute() {
      return {
        content: [{ type: "text", text: "clicked" }],
        details: undefined,
        images: [{ type: "image", data: "abc123", mimeType: "image/jpeg", label: "after" }],
      };
    },
  };
  const { session } = await createYishuAgentSession({
    model: MODEL,
    providerRuntime,
    systemPrompt: "PERSONA",
    customTools: [click],
  });
  t.after(() => session.dispose());
  await session.prompt("点一下", {
    images: [{ type: "image", data: "turn-start", mimeType: "image/jpeg" }],
  });
  const followUp = bodies.at(-1)?.messages ?? [];
  const recapture = followUp.find((message) => (
    message.role === "user"
    && JSON.stringify(message.content).includes("abc123")
  ));
  assert.ok(recapture, "follow-up model call must include the recaptured screenshot");
  assert.match(JSON.stringify(recapture.content), /Fresh observation after the last action/);
  assert.equal(JSON.stringify(followUp).includes("turn-start"), true);
});

test("YISHU_FAULT=model_stall emits a spoken fallback then times out", async (t) => {
  const previousFault = process.env.YISHU_FAULT;
  process.env.YISHU_FAULT = "model_stall";
  t.after(() => {
    if (previousFault === undefined) delete process.env.YISHU_FAULT;
    else process.env.YISHU_FAULT = previousFault;
  });

  const { session } = await createYishuAgentSession({
    model: MODEL,
    providerRuntime,
    systemPrompt: "PERSONA",
    customTools: [],
    streamFirstByteTimeoutMs: 40,
  });
  t.after(() => session.dispose());

  let spoken = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      spoken += event.assistantMessageEvent.delta;
    }
  });
  t.after(unsubscribe);

  await assert.rejects(session.prompt("你好"), /timed out waiting for the first byte/);
  assert.equal(spoken, FIRST_BYTE_FALLBACK_SPEECH);
});

test("a tool-only first output injects one ack-first reminder before tools run", async (t) => {
  const requests: Array<{
    tools?: unknown;
    messages?: Array<{ role?: string; content?: unknown }>;
  }> = [];
  let callIndex = 0;
  let echoRuns = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    if (init && typeof init === "object" && "body" in init && typeof init.body === "string") {
      requests.push(JSON.parse(init.body) as (typeof requests)[number]);
    }
    const lines = callIndex === 0
      ? toolCallsResponse([{ id: "call_1", name: "echo", argumentsJson: "{}" }], false)
      : stopResponse();
    callIndex += 1;
    return okStream(sseBody(lines));
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const echo: ToolDefinition = {
    name: "echo",
    label: "echo",
    description: "echo",
    promptSnippet: "",
    promptGuidelines: [],
    parameters: { type: "object" },
    executionMode: "sequential",
    async execute() {
      echoRuns += 1;
      return { content: [{ type: "text", text: "echoed" }], details: undefined };
    },
  };

  const { session } = await createYishuAgentSession({
    model: MODEL,
    providerRuntime,
    systemPrompt: "PERSONA",
    customTools: [echo],
  });
  t.after(() => session.dispose());

  await session.prompt("查一下");
  assert.equal(callIndex, 2);
  assert.equal(echoRuns, 0);
  const reminder = requests[1]?.messages?.at(-1);
  assert.equal(reminder?.role, "user");
  assert.match(String(reminder?.content ?? ""), /先开口再说/);
});
