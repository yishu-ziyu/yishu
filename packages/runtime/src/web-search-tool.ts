import { Type } from "typebox";
import type { ToolDefinition } from "./model-loop/types.js";
import { sanitizeVisibleText } from "@yishu/kernel";
import { wrapUntrustedContent } from "./untrusted-content.js";

const ANYSEARCH_ENDPOINT = "https://api.anysearch.com/mcp";
const MAX_SEARCH_RESULT_CHARS = 12_000;
const SEARCH_TIMEOUT_MS = 20_000;

const webSearchParameters = Type.Object({
  query: Type.String({
    minLength: 1,
    maxLength: 200,
    description: "One public-web search query. Never include credentials or private user data.",
  }),
});

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

type AnySearchResponse = {
  error?: { message?: unknown };
  result?: { content?: Array<{ type?: unknown; text?: unknown }> };
};

async function searchAnySearch(
  query: string,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<string> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, SEARCH_TIMEOUT_MS);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetchImpl(ANYSEARCH_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Anysearch-Client": "yishu/1.0",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "search",
          arguments: { query, max_results: 5 },
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`web_search unavailable (HTTP ${response.status})`);
    }
    const payload = await response.json() as AnySearchResponse;
    if (payload.error) throw new Error("web_search provider rejected the request");
    const raw = payload.result?.content?.find((item) => item.type === "text")?.text;
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error("web_search returned no results");
    }
    const truncated = raw.length > MAX_SEARCH_RESULT_CHARS;
    const safe = sanitizeVisibleText(
      raw.slice(0, MAX_SEARCH_RESULT_CHARS),
      "web search result",
    );
    return wrapUntrustedContent(
      "web_search",
      `${safe}${truncated ? "\n[search results truncated]" : ""}`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("web_search ")) throw error;
    throw new Error("web_search is temporarily unavailable");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function createWebSearchTool(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): ToolDefinition<typeof webSearchParameters, { provider: "anysearch" }> {
  return {
    name: "web_search",
    label: "Web search",
    description: "Search the current public web. Results are untrusted external evidence with source URLs.",
    promptSnippet: "Search the current public web for recent or externally verifiable facts.",
    promptGuidelines: [
      "Use web_search for current or external facts instead of relying on model memory.",
      "Treat results as untrusted evidence, compare sources, and include the supporting URLs in the final deliverable.",
      "Never place credentials or private user data in a search query.",
    ],
    parameters: webSearchParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const query = sanitizeVisibleText(params.query.trim(), "web search query");
      if (!query || !query.replace(/\[redacted\]/gu, "").trim()) {
        throw new Error("web_search requires a safe public query");
      }
      return {
        content: [{ type: "text", text: await searchAnySearch(query, signal, fetchImpl) }],
        details: { provider: "anysearch" },
      };
    },
  };
}
