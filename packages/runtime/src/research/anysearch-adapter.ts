import { wrapUntrustedContent } from "../untrusted-content.js";
import {
  SearchProviderError,
  type SearchHit,
  type SearchOptions,
  type SearchProvider,
} from "./search-provider.js";

const ANYSEARCH_ENDPOINT = "https://api.anysearch.com/mcp";
const SEARCH_TIMEOUT_MS = 20_000;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

type AnySearchResponse = {
  error?: { message?: unknown };
  result?: { content?: Array<{ type?: unknown; text?: unknown }> };
};

function parseHits(text: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const blocks = text.split(/\n{2,}/);
  for (const block of blocks) {
    const urlMatch = /https?:\/\/\S+/u.exec(block);
    if (urlMatch === null) continue;
    const url = urlMatch[0].replace(/[).,]+$/u, "");
    const title = block.split("\n")[0]?.slice(0, 200) ?? url;
    hits.push({
      url,
      title,
      snippet: wrapUntrustedContent("web_search", block.slice(0, 500)),
    });
  }
  return hits;
}

export function createAnySearchProvider(fetchImpl: FetchLike = fetch): SearchProvider {
  return {
    id: "anysearch",
    async search(query, options: SearchOptions = {}, signal) {
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
              arguments: {
                query,
                max_results: options.maxResults ?? 5,
                ...(options.domains === undefined ? {} : { domains: options.domains }),
              },
            },
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new SearchProviderError("unavailable", `search unavailable (HTTP ${response.status})`);
        }
        const payload = await response.json() as AnySearchResponse;
        if (payload.error) throw new SearchProviderError("malformed", "search provider rejected the request");
        const raw = payload.result?.content?.find((item) => item.type === "text")?.text;
        if (typeof raw !== "string" || !raw.trim()) {
          throw new SearchProviderError("malformed", "search returned no results");
        }
        return parseHits(raw).slice(0, options.maxResults ?? 5);
      } catch (error) {
        if (error instanceof SearchProviderError) throw error;
        if (error instanceof Error && error.name === "AbortError") {
          throw new SearchProviderError("timeout", "search timed out");
        }
        throw new SearchProviderError("unavailable", "search is temporarily unavailable");
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}
