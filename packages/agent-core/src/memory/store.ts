import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Progressive memory layers (book Ch3 simplified). */
export type MemoryLayer = "working" | "session" | "long_term" | "profile";

/** Higher = preferred in search ranking. */
const LAYER_RANK: Record<MemoryLayer, number> = {
  profile: 4,
  long_term: 3,
  session: 2,
  working: 1,
};

export interface MemoryCard {
  id: string;
  kind: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /**
   * Progressive memory layer.
   * Missing on legacy cards → treated as `"session"`.
   */
  layer?: MemoryLayer;
}

export interface MemorySearchOptions {
  /** When set, only cards in this layer (legacy missing layer = session). */
  layer?: MemoryLayer;
}

export interface MemoryStore {
  add(input: {
    content: string;
    kind?: string;
    tags?: string[];
    layer?: MemoryLayer;
  }): Promise<MemoryCard>;
  search(query: string, options?: MemorySearchOptions): Promise<MemoryCard[]>;
  list(): Promise<MemoryCard[]>;
  promoteMemory(id: string, toLayer: MemoryLayer): Promise<MemoryCard | null>;
  load(): Promise<void>;
  save(): Promise<void>;
}

/** Effective layer for ranking/filter; legacy cards without layer → session. */
export function effectiveLayer(card: MemoryCard): MemoryLayer {
  return card.layer ?? "session";
}

export function isMemoryLayer(value: unknown): value is MemoryLayer {
  return (
    value === "working" ||
    value === "session" ||
    value === "long_term" ||
    value === "profile"
  );
}

/**
 * File-backed memory: JSON array at memoryPath.
 * Falls back to empty store if file missing.
 */
export class FileMemoryStore implements MemoryStore {
  private cards: MemoryCard[] = [];
  private loaded = false;

  constructor(private readonly memoryPath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.memoryPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        this.cards = parsed as MemoryCard[];
      } else if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { cards?: unknown }).cards)
      ) {
        this.cards = (parsed as { cards: MemoryCard[] }).cards;
      } else {
        this.cards = [];
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.cards = [];
      } else {
        throw err;
      }
    }
    this.loaded = true;
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.memoryPath), { recursive: true });
    await fs.writeFile(
      this.memoryPath,
      JSON.stringify(this.cards, null, 2),
      "utf8",
    );
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  async add(input: {
    content: string;
    kind?: string;
    tags?: string[];
    layer?: MemoryLayer;
  }): Promise<MemoryCard> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const layer: MemoryLayer = input.layer ?? "session";
    const card: MemoryCard = {
      id: randomUUID(),
      kind: input.kind ?? "note",
      content: input.content,
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
      layer,
    };
    this.cards.push(card);
    await this.save();
    return card;
  }

  async search(
    query: string,
    options?: MemorySearchOptions,
  ): Promise<MemoryCard[]> {
    await this.ensureLoaded();
    let pool = this.cards;
    if (options?.layer) {
      const want = options.layer;
      pool = pool.filter((c) => effectiveLayer(c) === want);
    }

    const tokens = query
      .toLowerCase()
      .split(/[\s,，、]+/)
      .filter(Boolean);

    const hits =
      tokens.length === 0
        ? [...pool]
        : pool.filter((c) => {
            const hay =
              `${c.content} ${c.kind} ${c.tags.join(" ")}`.toLowerCase();
            return tokens.some((t) => hay.includes(t));
          });

    // Rank: profile > long_term > session > working; then newer first
    hits.sort((a, b) => {
      const rankDiff =
        LAYER_RANK[effectiveLayer(b)] - LAYER_RANK[effectiveLayer(a)];
      if (rankDiff !== 0) return rankDiff;
      return b.updatedAt.localeCompare(a.updatedAt);
    });

    return hits;
  }

  async list(): Promise<MemoryCard[]> {
    await this.ensureLoaded();
    return [...this.cards];
  }

  /**
   * Move a card to another progressive layer.
   * Returns null if id is missing.
   */
  async promoteMemory(
    id: string,
    toLayer: MemoryLayer,
  ): Promise<MemoryCard | null> {
    await this.ensureLoaded();
    const card = this.cards.find((c) => c.id === id);
    if (!card) return null;
    card.layer = toLayer;
    card.updatedAt = new Date().toISOString();
    await this.save();
    return card;
  }
}
