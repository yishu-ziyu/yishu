import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompletionsExtractionModel } from "../src/memory-extraction-model.js";
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

const SAMPLE_INPUT = {
  providerId: "xai",
  modelId: "grok-4.3",
  utterance: "以后用要点列表回答我",
  replyText: "好的。",
  existingFacts: [],
};

test("completions providers POST /chat/completions", async () => {
  let url = "";
  let body: Record<string, unknown> = {};
  const model = createCompletionsExtractionModel(
    fakeRuntime(COMPLETIONS_MODEL),
    async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{
            message: { content: '{"new_facts":["用户偏好要点列表"],"confirmed_fact_ids":[]}' },
          }],
        }),
        { status: 200 },
      );
    },
  );
  const output = await model.extract({ ...SAMPLE_INPUT });
  assert.equal(url, "https://api.x.ai/v1/chat/completions");
  assert.equal(body.stream, false);
  assert.deepEqual(output.newFacts, ["用户偏好要点列表"]);
});

test("MiniMax-M3 extraction disables thinking", async () => {
  let body: Record<string, unknown> = {};
  const m3: ResolvedModel = { ...COMPLETIONS_MODEL, id: "MiniMax-M3", name: "MiniMax-M3", providerId: "yishu-local-grok", baseUrl: "https://api.minimaxi.com/v1" };
  const model = createCompletionsExtractionModel(
    fakeRuntime(m3),
    async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"new_facts":[],"confirmed_fact_ids":[]}' } }],
        }),
        { status: 200 },
      );
    },
  );
  await model.extract({ ...SAMPLE_INPUT, providerId: m3.providerId, modelId: m3.id });
  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("Codex providers POST /codex/responses and read the SSE wire", async () => {
  let url = "";
  let headers: Record<string, string> = {};
  const encoder = new TextEncoder();
  const sse = [
    'data: {"type":"response.output_text.delta","delta":"{\\"new_facts\\":[],"}',
    'data: {"type":"response.output_text.delta","delta":"\\"confirmed_fact_ids\\":[]}"}',
    'data: {"type":"response.completed"}',
    "data: [DONE]",
    "",
  ].join("\n");
  const model = createCompletionsExtractionModel(
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
  const output = await model.extract({
    ...SAMPLE_INPUT,
    providerId: "openai-codex",
    modelId: "gpt-5.4",
  });
  assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(headers.accept, "text/event-stream");
  assert.equal(headers["OpenAI-Beta"], "responses=experimental");
  assert.equal(headers.originator, "codex_cli_rs");
  assert.equal(headers["chatgpt-account-id"], "acct-1");
  assert.deepEqual(output, { newFacts: [], confirmedFactIds: [] });
});
