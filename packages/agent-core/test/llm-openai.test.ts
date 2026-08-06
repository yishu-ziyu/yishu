import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OpenAiCompatibleLlm,
  createLlmFromEnv,
  shouldUseOpenAiFromEnv,
} from "../src/llm-openai.js";
import { DeterministicLlm } from "../src/llm.js";
import type { ToolDefinition } from "../src/types.js";

const sampleTools: ToolDefinition[] = [
  {
    name: "code_exec",
    description: "Evaluate a JS expression",
    category: "execution",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string" },
        language: { type: "string" },
      },
      required: ["expression"],
    },
    execute: async () => ({ ok: true, content: "ok" }),
  },
];

describe("OpenAiCompatibleLlm", () => {
  it("maps tools and parses tool_calls from a fixed mock fetch response", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      const body = {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_abc123",
                  type: "function",
                  function: {
                    name: "code_exec",
                    arguments: JSON.stringify({
                      expression: "17*19+3",
                      language: "js",
                    }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const llm = new OpenAiCompatibleLlm({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "gpt-test",
      fetchImpl,
    });

    const result = await llm.complete(
      [{ role: "user", content: "计算 17*19+3" }],
      sampleTools,
    );

    assert.equal(result.type, "tool_calls");
    if (result.type !== "tool_calls") return;

    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]?.id, "call_abc123");
    assert.equal(result.toolCalls[0]?.name, "code_exec");
    assert.deepEqual(result.toolCalls[0]?.arguments, {
      expression: "17*19+3",
      language: "js",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://example.test/v1/chat/completions");
    const sent = JSON.parse(String(calls[0]?.init?.body ?? "{}")) as {
      model: string;
      messages: unknown[];
      tools: Array<{ type: string; function: { name: string } }>;
      tool_choice: string;
    };
    assert.equal(sent.model, "gpt-test");
    assert.equal(sent.tool_choice, "auto");
    assert.equal(sent.tools[0]?.function.name, "code_exec");
    assert.ok(Array.isArray(sent.messages));

    const headers = calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer test-key");
  });

  it("returns text when response has no tool_calls", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "结果是 326。" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const llm = new OpenAiCompatibleLlm({
      baseUrl: "https://example.test/v1/",
      apiKey: "k",
      model: "m",
      fetchImpl,
    });

    const result = await llm.complete([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: "code_exec",
            arguments: { expression: "1+1" },
          },
        ],
      },
      {
        role: "tool",
        content: "result=2",
        toolCallId: "call_1",
        name: "code_exec",
      },
    ]);

    assert.equal(result.type, "text");
    if (result.type === "text") {
      assert.equal(result.text, "结果是 326。");
    }
  });

  it("throws on HTTP error body", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({ error: { message: "invalid api key" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      );

    const llm = new OpenAiCompatibleLlm({
      baseUrl: "https://example.test/v1",
      apiKey: "bad",
      model: "m",
      fetchImpl,
    });

    await assert.rejects(
      () => llm.complete([{ role: "user", content: "x" }]),
      /401|invalid api key/,
    );
  });

  it("uses global fetch when fetchImpl is omitted", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_global",
                    type: "function",
                    function: {
                      name: "code_exec",
                      arguments: '{"expression":"1+1"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    try {
      const llm = new OpenAiCompatibleLlm({
        baseUrl: "https://example.test/v1",
        apiKey: "k",
        model: "m",
      });
      const result = await llm.complete(
        [{ role: "user", content: "1+1" }],
        sampleTools,
      );
      assert.equal(result.type, "tool_calls");
      if (result.type === "tool_calls") {
        assert.equal(result.toolCalls[0]?.id, "call_global");
        assert.equal(result.toolCalls[0]?.name, "code_exec");
      }
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("createLlmFromEnv", () => {
  it("returns DeterministicLlm when no key and not openai mode", () => {
    const llm = createLlmFromEnv({});
    assert.ok(llm instanceof DeterministicLlm);
    assert.equal(shouldUseOpenAiFromEnv({}), false);
  });

  it("returns DeterministicLlm when YISHU_AGENT_LLM=mock even with key", () => {
    const llm = createLlmFromEnv({
      YISHU_AGENT_LLM: "mock",
      OPENAI_API_KEY: "sk-test",
    });
    assert.ok(llm instanceof DeterministicLlm);
    assert.equal(
      shouldUseOpenAiFromEnv({
        YISHU_AGENT_LLM: "mock",
        OPENAI_API_KEY: "sk-test",
      }),
      false,
    );
  });

  it("returns OpenAiCompatibleLlm when YISHU_AGENT_LLM=openai", () => {
    const llm = createLlmFromEnv({
      YISHU_AGENT_LLM: "openai",
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: "https://example.test/v1",
      OPENAI_MODEL: "gpt-test",
    });
    assert.ok(llm instanceof OpenAiCompatibleLlm);
  });

  it("returns OpenAiCompatibleLlm when OPENROUTER_API_KEY present", () => {
    const llm = createLlmFromEnv({
      OPENROUTER_API_KEY: "or-test",
    });
    assert.ok(llm instanceof OpenAiCompatibleLlm);
  });

  it("throws when openai mode without any key", () => {
    assert.throws(
      () => createLlmFromEnv({ YISHU_AGENT_LLM: "openai" }),
      /OPENAI_API_KEY|OPENROUTER_API_KEY/,
    );
  });
});
