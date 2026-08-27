export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  publishedAt?: string;
}

export interface SearchOptions {
  recency?: "day" | "week" | "month" | "any";
  domains?: string[];
  maxResults?: number;
}

export type SearchProviderErrorCode =
  | "timeout"
  | "quota"
  | "malformed"
  | "unavailable";

export class SearchProviderError extends Error {
  readonly code: SearchProviderErrorCode;

  constructor(code: SearchProviderErrorCode, message: string) {
    super(message);
    this.name = "SearchProviderError";
    this.code = code;
  }
}

export interface SearchProvider {
  id: string;
  search(query: string, options?: SearchOptions, signal?: AbortSignal): Promise<SearchHit[]>;
}

export function dedupeSearchHits(hits: readonly SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const result: SearchHit[] = [];
  for (const hit of hits) {
    const key = canonicalizeUrl(hit.url);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...hit, url: key });
  }
  return result;
}

export function canonicalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    if (parsed.pathname.endsWith("/") && parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}
