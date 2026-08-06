import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface KnowledgeDoc {
  id: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  createdAt: string;
}

export interface KnowledgeSearchHit {
  doc: KnowledgeDoc;
  score: number;
  snippet: string;
}

export interface KnowledgeIngestInput {
  title: string;
  content: string;
  tags?: string[];
  source?: string;
}

/** Default offline seed docs (book Ch3 RAG starter set). */
export const DEFAULT_KNOWLEDGE_SEEDS: ReadonlyArray<
  Omit<KnowledgeDoc, "id" | "createdAt">
> = [
  {
    title: "ReAct Pattern",
    content:
      "ReAct interleaves think (reason), act (tool call), and observe (tool result) until the agent can answer. " +
      "Pattern: Thought -> Action -> Observation, repeated. Ground answers in tool evidence, not free invention.",
    tags: ["react", "agent", "pattern", "loop"],
    source: "seed",
  },
  {
    title: "Yishu Product",
    content:
      "奕枢（Yishu）是唯一用户可见身份。Voice and spatial presence are primary interfaces. " +
      "Context is evidence: every context item carries source, capture time, confidence, and expiry. " +
      "Pi is the execution harness; identity, memory, and permissions stay product-owned.",
    tags: ["yishu", "奕枢", "product", "identity"],
    source: "seed",
  },
  {
    title: "Agent Formula",
    content:
      "Agent = LLM + context + tools. " +
      "LLM decides; context supplies evidence and memory; tools act on the world. " +
      "Without tools the model only talks; without context it cannot ground; without LLM there is no policy.",
    tags: ["agent", "formula", "llm", "tools", "context"],
    source: "seed",
  },
];

/**
 * File-backed knowledge base: single index.json under knowledgeDir.
 * Offline, no vector DB - token overlap scoring with rank.
 */
export class FileKnowledgeStore {
  private docs: KnowledgeDoc[] = [];
  private loaded = false;
  private readonly indexPath: string;

  constructor(private readonly knowledgeDir: string) {
    this.indexPath = path.join(knowledgeDir, "index.json");
  }

  get dir(): string {
    return this.knowledgeDir;
  }

  get path(): string {
    return this.indexPath;
  }

  async load(): Promise<void> {
    let existed = true;
    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        this.docs = parsed as KnowledgeDoc[];
      } else if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { docs?: unknown }).docs)
      ) {
        this.docs = (parsed as { docs: KnowledgeDoc[] }).docs;
      } else {
        this.docs = [];
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.docs = [];
        existed = false;
      } else {
        throw err;
      }
    }
    this.loaded = true;

    // Seed starter docs when store is empty (first load or missing file)
    if (this.docs.length === 0) {
      const now = new Date().toISOString();
      this.docs = DEFAULT_KNOWLEDGE_SEEDS.map((s) => ({
        id: randomUUID(),
        title: s.title,
        content: s.content,
        tags: [...s.tags],
        source: s.source,
        createdAt: now,
      }));
      // Always persist seeds so subsequent loads stay stable
      await this.save();
      if (!existed) {
        // no-op marker for clarity: first create
      }
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(this.knowledgeDir, { recursive: true });
    await fs.writeFile(
      this.indexPath,
      JSON.stringify(this.docs, null, 2),
      "utf8",
    );
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  async ingest(input: KnowledgeIngestInput): Promise<KnowledgeDoc> {
    await this.ensureLoaded();
    const doc: KnowledgeDoc = {
      id: randomUUID(),
      title: input.title,
      content: input.content,
      tags: input.tags ?? [],
      source: input.source ?? "ingest",
      createdAt: new Date().toISOString(),
    };
    this.docs.push(doc);
    await this.save();
    return doc;
  }

  /**
   * Token-overlap search with score ranking (title/tag boost).
   * Higher score first; empty query returns all with score 0.
   */
  async search(
    query: string,
    limit = 5,
  ): Promise<KnowledgeSearchHit[]> {
    await this.ensureLoaded();
    const tokens = tokenize(query);
    const hits: KnowledgeSearchHit[] = [];

    for (const doc of this.docs) {
      const titleL = doc.title.toLowerCase();
      const contentL = doc.content.toLowerCase();
      const tagsL = doc.tags.map((t) => t.toLowerCase());
      const hay = `${titleL} ${contentL} ${tagsL.join(" ")} ${doc.source}`.toLowerCase();

      let score = 0;
      if (tokens.length === 0) {
        hits.push({
          doc,
          score: 0,
          snippet: snippetOf(doc.content),
        });
        continue;
      }

      for (const t of tokens) {
        if (!hay.includes(t)) continue;
        score += 1;
        if (titleL.includes(t)) score += 2;
        if (tagsL.some((tag) => tag.includes(t) || t.includes(tag))) {
          score += 1;
        }
        // light density: count non-overlapping occurrences in content
        score += Math.min(3, countOccurrences(contentL, t));
      }

      if (score > 0) {
        hits.push({
          doc,
          score,
          snippet: snippetOf(doc.content),
        });
      }
    }

    hits.sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title));
    return hits.slice(0, Math.max(0, limit));
  }

  async list(): Promise<KnowledgeDoc[]> {
    await this.ensureLoaded();
    return [...this.docs];
  }
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，、;；:：]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function snippetOf(content: string, max = 220): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}…`;
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (from < hay.length) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    count += 1;
    from = i + needle.length;
  }
  return count;
}
