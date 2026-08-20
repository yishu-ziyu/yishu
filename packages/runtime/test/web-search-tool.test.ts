import assert from "node:assert/strict";
import test from "node:test";
import { createWebSearchTool } from "../src/web-search-tool.js";

test("web_search uses anonymous read-only search and wraps external results as untrusted", async () => {
  let request: { input: string; init: RequestInit } | undefined;
  const tool = createWebSearchTool(async (input, init) => {
    request = { input, init };
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{
          type: "text",
          text: "## Result\n- Source: https://example.com/current\n- Current fact.",
        }],
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  assert.equal(tool.executionMode, "parallel");

  const result = await tool.execute(
    "tool-call",
    { query: "current public fact" },
    undefined,
    undefined,
    {} as never,
  );

  assert.equal(request?.input, "https://api.anysearch.com/mcp");
  assert.equal(request?.init.method, "POST");
  assert.equal(new Headers(request?.init.headers).has("authorization"), false);
  const body = JSON.parse(String(request?.init.body)) as {
    params: { name: string; arguments: { query: string; max_results: number } };
  };
  assert.deepEqual(body.params, {
    name: "search",
    arguments: { query: "current public fact", max_results: 5 },
  });
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /<untrusted source="web_search">/);
  assert.match(text, /https:\/\/example\.com\/current/);
  assert.equal(result.details.provider, "anysearch");
});

test("web_search never forwards provider error bodies", async () => {
  const tool = createWebSearchTool(async () => new Response(
    "secret upstream diagnostic",
    { status: 429 },
  ));

  await assert.rejects(
    tool.execute("tool-call", { query: "current public fact" }, undefined, undefined, {} as never),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 429/);
      assert.doesNotMatch(error.message, /secret upstream diagnostic/);
      return true;
    },
  );
});
