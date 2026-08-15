/**
 * PR-2 read-side: PKR recalls into the turn cache; the engine prepends the
 * memory block to the first user message. No command-payload attachment.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createYishuKernel } from "@yishu/kernel";
import { ProductKernelRuntime } from "../src/product-kernel-runtime.js";
import { YishuLoopRuntimeAdapter } from "../src/loop-adapter.js";
import type {
  ModelProviderRuntime,
  ResolvedModel,
} from "../src/model-loop/types.js";
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

function installFetchStub(): { requests: CapturedRequest[]; restore(): void } {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as CapturedRequest["body"];
    requests.push({ url: String(_input), body });
    const lines = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "好的，先给结论。" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    return new Response(sseBody(lines), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  return { requests, restore: () => { globalThis.fetch = originalFetch; } };
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

function firstUserText(request: CapturedRequest | undefined): string {
  const user = request?.body.messages.find((message) => message.role === "user");
  return userText(user?.content);
}

function commandFor(utterance: string, scope: "personal" | "private"): TurnStartCommand {
  const command = makeTurnStartCommand();
  command.payload.utterance = utterance;
  command.payload.conversationId = randomUUID();
  command.payload.sessionScope = { kind: scope };
  command.payload.contextFrame.screenshots = [];
  return command;
}

test("engine prepends cached recall once; private turns get no memory block", async (t) => {
  const fetchStub = installFetchStub();
  t.after(fetchStub.restore);

  const kernel = createYishuKernel({ storeBackend: "memory" });
  const now = "2026-08-08T12:00:00.000Z";
  await kernel.store.addMemory({
    claim: "验收回答先给结论",
    source: "conversation",
    capturedAt: now,
    scope: "personal",
    confidence: 0.95,
    lastConfirmedAt: now,
    supersedes: null,
    tags: ["style"],
  });

  const adapter = new YishuLoopRuntimeAdapter(process.cwd(), undefined, {
    modelRuntimePromise: Promise.resolve(providerRuntime),
  });
  const runtime = new ProductKernelRuntime(adapter, kernel);
  t.after(() => runtime.dispose());

  const personalEvents: RuntimeEvent[] = [];
  await runtime.startTurn(
    commandFor("我希望你怎么回答？", "personal"),
    (event) => {
      if (event.type === "turn.failed") {
        assert.fail(`unexpected turn failure: ${JSON.stringify(event.payload)}`);
      }
      personalEvents.push(event);
    },
  );

  const used = personalEvents.find((event) => event.type === "memory.used");
  assert.ok(used, "memory.used must still fire on the product path");
  assert.equal(used?.payload.count, 1);
  assert.match(String(used?.payload.summary1 ?? ""), /验收回答先给结论/);

  assert.equal(fetchStub.requests.length, 1);
  const personalUser = firstUserText(fetchStub.requests[0]);
  assert.match(personalUser, /<durable_memories>/);
  assert.match(personalUser, /验收回答先给结论/);
  assert.equal(
    personalUser.split("<durable_memories>").length - 1,
    1,
    "memory block must be assembled once, not also attached onto the command",
  );
  assert.match(personalUser, /^The user previously asked you to remember/);

  const privateEvents: RuntimeEvent[] = [];
  await runtime.startTurn(
    commandFor("我希望你怎么回答？", "private"),
    (event) => {
      if (event.type === "turn.failed") {
        assert.fail(`unexpected private turn failure: ${JSON.stringify(event.payload)}`);
      }
      privateEvents.push(event);
    },
  );

  assert.ok(!privateEvents.some((event) => event.type === "memory.used"));
  assert.equal(fetchStub.requests.length, 2);
  const privateUser = firstUserText(fetchStub.requests[1]);
  assert.doesNotMatch(privateUser, /durable_memories/);
  assert.doesNotMatch(privateUser, /验收回答先给结论/);
});
