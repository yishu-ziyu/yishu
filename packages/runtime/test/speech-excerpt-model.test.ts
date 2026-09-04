import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clipSpokenSentences,
  createSpeechExcerptModel,
} from "../src/speech-excerpt-model.js";
import type { ModelProviderRuntime, ResolvedModel } from "../src/model-loop/types.js";

const COMPLETIONS_MODEL: ResolvedModel = {
  providerId: "xai",
  id: "grok-4.3",
  name: "Grok 4.3",
  api: "openai-completions",
  baseUrl: "https://api.x.ai/v1",
  input: ["text", "image"],
  contextWindow: 128_000,
  maxTokens: 16_384,
};

const CODEX_MODEL: ResolvedModel = {
  providerId: "openai-codex",
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  input: ["text"],
  contextWindow: 128_000,
  maxTokens: 16_384,
};

function fakeRuntime(model: ResolvedModel): ModelProviderRuntime {
  return {
    getProvider: () => undefined,
    getAvailable: async () => [],
    checkAuth: async () => undefined,
    getAuth: async () => undefined,
    login: async () => undefined,
    logout: async () => undefined,
    resolveModel: async () => model,
    bearer: async () => "test-bearer",
    extraHeaders: async () => (
      model.api === "codex-responses" ? { "chatgpt-account-id": "acct-1" } : {}
    ),
    providerVersion: () => 1,
  };
}

const ESSAY = "第一句。第二句。第三句。第四句。第五句。第六句。第七句。第八句。";

test("clipSpokenSentences keeps at most two sentences and rejects a wall", () => {
  assert.equal(clipSpokenSentences(ESSAY), "第一句。第二句。");
  assert.equal(clipSpokenSentences("已经设好提醒。"), "已经设好提醒。");
  assert.throws(() => clipSpokenSentences("长".repeat(81)));
});

test("completions excerpt uses the turn provider/model and clips to two sentences", async () => {
  let url = "";
  let body: Record<string, unknown> = {};
  const model = createSpeechExcerptModel(
    fakeRuntime(COMPLETIONS_MODEL),
    async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: ESSAY } }],
        }),
        { status: 200 },
      );
    },
  );
  const spoken = await model.excerpt({
    providerId: "xai",
    modelId: "grok-4.3",
    visibleText: ESSAY,
  });
  assert.equal(url, "https://api.x.ai/v1/chat/completions");
  assert.equal(body.model, "grok-4.3");
  assert.equal(body.stream, false);
  assert.equal(spoken, "第一句。第二句。");
  assert.notEqual(spoken, ESSAY);
});

test("MiniMax-M3 excerpt disables thinking", async () => {
  let body: Record<string, unknown> = {};
  const m3: ResolvedModel = { ...COMPLETIONS_MODEL, id: "MiniMax-M3", name: "MiniMax-M3", providerId: "yishu-local-grok", baseUrl: "https://api.minimaxi.com/v1" };
  const model = createSpeechExcerptModel(
    fakeRuntime(m3),
    async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "在。" } }] }),
        { status: 200 },
      );
    },
  );
  await model.excerpt({ providerId: m3.providerId, modelId: m3.id, visibleText: "在。" });
  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("Codex excerpt follows the same responses wire as memory extraction", async () => {
  let url = "";
  let headers: Record<string, string> = {};
  const encoder = new TextEncoder();
  const sse = [
    'data: {"type":"response.output_text.delta","delta":"今天多云。"}',
    'data: {"type":"response.output_text.delta","delta":"出门带件外套。"}',
    'data: {"type":"response.completed"}',
    "data: [DONE]",
    "",
  ].join("\n");
  const model = createSpeechExcerptModel(
    fakeRuntime(CODEX_MODEL),
    async (input, init) => {
      url = String(input);
      headers = init?.headers as Record<string, string>;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(sse));
            controller.close();
          },
        }),
        { status: 200 },
      );
    },
  );
  const spoken = await model.excerpt({
    providerId: "openai-codex",
    modelId: "gpt-5.4",
    visibleText: ESSAY,
  });
  assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(headers.accept, "text/event-stream");
  assert.equal(spoken, "今天多云。出门带件外套。");
});

test("excerpt prompt ignores a work receipt and speaks the finding", async () => {
  let system = "";
  const model = createSpeechExcerptModel(
    fakeRuntime(COMPLETIONS_MODEL),
    async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      system = body.messages[0]?.content ?? "";
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "深圳明天中雨。" } }] }),
        { status: 200 },
      );
    },
  );
  await model.excerpt({
    providerId: "xai",
    modelId: "grok-4.3",
    visibleText: "「查天气」整理好了。深圳明天中雨。",
  });
  assert.match(system, /announces that work is finished/);
  assert.match(system, /ignore that wrapper/);
  assert.match(system, /finding a person would hear/);
  assert.doesNotMatch(system, /整理好了/);
});

test("excerpt failure throws and does not return the visible essay", async () => {
  const model = createSpeechExcerptModel(
    fakeRuntime(COMPLETIONS_MODEL),
    async () => new Response("nope", { status: 500 }),
  );
  await assert.rejects(
    () => model.excerpt({
      providerId: "xai",
      modelId: "grok-4.3",
      visibleText: ESSAY,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /第一句/);
      return true;
    },
  );
});
