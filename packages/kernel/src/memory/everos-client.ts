import {
  MEMORY_RECALL_MAX_CLAIM_CHARS,
  MEMORY_RECALL_MAX_ITEMS,
  MEMORY_RECALL_MAX_TOTAL_CHARS,
  MEMORY_RECALL_SUMMARY_CHARS,
  type RecalledMemory,
} from "./recall.js";
import {
  DEFAULT_EVEROS_IDENTITY,
  EVEROS_ASSISTANT_SENDER_ID,
  EVEROS_USER_ID,
  assertValidEverOSIdentity,
  type EverOSIdentity,
  everosProjectId,
  memoryScopeFromEverOSProject,
} from "./everos-ids.js";
import type {
  EverOSAddInput,
  EverOSFlushInput,
  EverOSMemoryPort,
  EverOSProfileInput,
  EverOSSearchInput,
} from "./everos-port.js";

export const EVEROS_PROFILE_ID_PREFIX = "profile:";
export const EVEROS_MIN_SEARCH_SCORE = 0.2;

export interface EverOSHttpClientOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly identity?: EverOSIdentity;
  readonly searchMethod?: "keyword" | "hybrid";
}

interface SearchAtomicFact {
  readonly id?: unknown;
  readonly content?: unknown;
}

interface SearchEpisode {
  readonly id?: unknown;
  readonly summary?: unknown;
  readonly subject?: unknown;
  readonly episode?: unknown;
  readonly timestamp?: unknown;
  readonly project_id?: unknown;
  readonly atomic_facts?: unknown;
}

interface SearchResponseBody {
  readonly data?: {
    readonly episodes?: unknown;
    readonly profiles?: unknown;
  };
}

interface ProfileRecord {
  readonly id?: unknown;
  readonly profile_data?: unknown;
  readonly updated_at?: unknown;
  readonly score?: unknown;
}

export function isEverOSProfileMemory(memory: { id: string }): boolean {
  return memory.id.startsWith(EVEROS_PROFILE_ID_PREFIX);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function truncateChars(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}

function isSafeMemoryText(value: string): boolean {
  if (!value || value.trim().length === 0) return false;
  if (/(api[_-]?key|password|secret|token|bearer)\s*[:=]/i.test(value)) return false;
  if (/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(value)) return false;
  if (/data:image\//i.test(value)) return false;
  if (/sk-[A-Za-z0-9]{16,}/.test(value)) return false;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return false;
  return true;
}

function capturedAtOf(value: unknown): string {
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    return value;
  }
  return new Date().toISOString();
}

function passesSearchScore(score: unknown): boolean {
  if (typeof score !== "number" || !Number.isFinite(score)) return true;
  return score >= EVEROS_MIN_SEARCH_SCORE;
}

function profileClaimTexts(data: Record<string, unknown>): string[] {
  const texts: string[] = [];
  const explicit = Array.isArray(data.explicit_info) ? data.explicit_info : [];
  for (const row of explicit) {
    if (!row || typeof row !== "object") continue;
    const description = asString((row as { description?: unknown }).description);
    if (description) texts.push(description);
  }
  return texts;
}

export function mapEverOSProfiles(
  raw: unknown,
  scopeKey: string,
  identity: EverOSIdentity = DEFAULT_EVEROS_IDENTITY,
): RecalledMemory[] {
  return mapProfileRecords(raw, scopeKey, identity);
}

function mapProfileRecords(
  raw: unknown,
  scopeKey: string,
  identity: EverOSIdentity,
): RecalledMemory[] {
  if (!Array.isArray(raw)) return [];
  const scope = memoryScopeFromEverOSProject(
    everosProjectId(scopeKey, identity),
    identity,
  );
  const selected: RecalledMemory[] = [];
  for (const item of raw as ProfileRecord[]) {
    const id = asString(item.id) ?? "user";
    const data = item.profile_data;
    if (!data || typeof data !== "object") continue;
    const capturedAt = capturedAtOf(item.updated_at);
    for (const [index, text] of profileClaimTexts(data as Record<string, unknown>).entries()) {
      const recalled = toRecalled(`${EVEROS_PROFILE_ID_PREFIX}${id}:${index}`, text, capturedAt, scope);
      if (recalled) selected.push(recalled);
    }
  }
  return selected;
}

function toRecalled(
  id: string,
  text: string,
  capturedAt: string,
  scope: string,
): RecalledMemory | undefined {
  const claim = truncateChars(text.trim(), MEMORY_RECALL_MAX_CLAIM_CHARS);
  if (!isSafeMemoryText(claim)) return undefined;
  return {
    id,
    claim,
    summary: truncateChars(claim, MEMORY_RECALL_SUMMARY_CHARS),
    source: "conversation",
    capturedAt,
    scope,
    confidence: 0.8,
    authority: "derived",
  };
}

export function mapEverOSSearchHits(
  body: SearchResponseBody,
  scopeKey: string,
  identity: EverOSIdentity = DEFAULT_EVEROS_IDENTITY,
): RecalledMemory[] {
  const episodes = Array.isArray(body.data?.episodes)
    ? (body.data.episodes as SearchEpisode[])
    : [];
  const selected: RecalledMemory[] = [];
  let totalChars = 0;

  const push = (item: RecalledMemory | undefined): void => {
    if (item === undefined) return;
    if (selected.length >= MEMORY_RECALL_MAX_ITEMS) return;
    if (totalChars + item.claim.length > MEMORY_RECALL_MAX_TOTAL_CHARS && selected.length > 0) {
      return;
    }
    selected.push(item);
    totalChars += item.claim.length;
  };

  for (const episode of episodes) {
    if (selected.length >= MEMORY_RECALL_MAX_ITEMS) break;
    const projectId = asString(episode.project_id) ?? everosProjectId(scopeKey, identity);
    const scope = memoryScopeFromEverOSProject(projectId, identity);
    const capturedAt = capturedAtOf(episode.timestamp);
    const facts = Array.isArray(episode.atomic_facts)
      ? (episode.atomic_facts as SearchAtomicFact[])
      : [];
    for (const fact of facts) {
      const id = asString(fact.id);
      const content = asString(fact.content);
      if (id === undefined || content === undefined) continue;
      if (!passesSearchScore((fact as { score?: unknown }).score)) continue;
      push(toRecalled(id, content, capturedAt, scope));
    }
    if (facts.length === 0) {
      const id = asString(episode.id);
      const text = asString(episode.summary)
        ?? asString(episode.subject)
        ?? asString(episode.episode);
      if (id !== undefined && text !== undefined) {
        push(toRecalled(id, text, capturedAt, scope));
      }
    }
  }

  return selected;
}

export class EverOSHttpClient implements EverOSMemoryPort {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly identity: EverOSIdentity;
  private readonly searchMethod: "keyword" | "hybrid";

  constructor(options: EverOSHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.identity = options.identity ?? DEFAULT_EVEROS_IDENTITY;
    assertValidEverOSIdentity(this.identity);
    this.searchMethod = options.searchMethod ?? "keyword";
  }

  async add(input: EverOSAddInput): Promise<void> {
    const projectId = everosProjectId(input.scopeKey, this.identity);
    await this.post("/api/v2/memory/add", {
      session_id: input.sessionId,
      app_id: this.identity.appId,
      project_id: projectId,
      ...(input.deferExtraction === undefined
        ? {}
        : { defer_extraction: input.deferExtraction }),
      messages: input.messages.map((message) => ({
        sender_id: message.role === "user" ? this.identity.userId : message.senderId,
        role: message.role,
        timestamp: message.timestampMs,
        content: message.content,
      })),
    });
  }

  async flush(input: EverOSFlushInput): Promise<void> {
    await this.post("/api/v2/memory/flush", {
      session_id: input.sessionId,
      app_id: this.identity.appId,
      project_id: everosProjectId(input.scopeKey, this.identity),
    });
  }

  async search(input: EverOSSearchInput): Promise<RecalledMemory[]> {
    const body = await this.post("/api/v2/memory/search", {
      user_id: this.identity.userId,
      app_id: this.identity.appId,
      project_id: everosProjectId(input.scopeKey, this.identity),
      query: input.query,
      method: this.searchMethod,
      // -1 keeps EverOS's own distance cutoff. The client still applies its
      // small prompt cap after retrieval.
      top_k: input.limit ?? -1,
    });
    return mapEverOSSearchHits(body as SearchResponseBody, input.scopeKey, this.identity);
  }

  async profile(input: EverOSProfileInput): Promise<RecalledMemory[]> {
    const body = await this.post("/api/v2/memory/get", {
      user_id: this.identity.userId,
      app_id: this.identity.appId,
      project_id: everosProjectId(input.scopeKey, this.identity),
      memory_type: "profile",
      page: 1,
      page_size: 5,
    });
    return mapEverOSProfiles(
      (body as SearchResponseBody).data?.profiles,
      input.scopeKey,
      this.identity,
    );
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`everos_${path}_failed_${response.status}`);
    }
    return response.json() as Promise<unknown>;
  }
}

export function everosMessagesForTurn(input: {
  utterance: string;
  replyText?: string;
  timestampMs?: number;
}): EverOSAddInput["messages"] {
  const timestampMs = input.timestampMs ?? Date.now();
  const messages: Array<EverOSAddInput["messages"][number]> = [
    {
      senderId: EVEROS_USER_ID,
      role: "user",
      content: input.utterance,
      timestampMs,
    },
  ];
  if (input.replyText !== undefined && input.replyText.trim().length > 0) {
    messages.push({
      senderId: EVEROS_ASSISTANT_SENDER_ID,
      role: "assistant",
      content: input.replyText,
      timestampMs: timestampMs + 1,
    });
  }
  return messages;
}
