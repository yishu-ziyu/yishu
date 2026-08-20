import type { RecalledMemory } from "./recall.js";

/** One user or assistant line in an EverOS add payload. */
export interface EverOSMemoryMessage {
  readonly senderId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestampMs: number;
}

export interface EverOSAddInput {
  readonly sessionId: string;
  readonly scopeKey: string;
  readonly messages: readonly EverOSMemoryMessage[];
  /** Keep this turn in EverOS's durable buffer until an explicit flush boundary. */
  readonly deferExtraction?: boolean;
}

export interface EverOSFlushInput {
  readonly sessionId: string;
  readonly scopeKey: string;
}

export interface EverOSSearchInput {
  readonly scopeKey: string;
  readonly query: string;
  readonly limit?: number;
}

export interface EverOSProfileInput {
  readonly scopeKey: string;
}

/**
 * Thin port over EverOS HTTP.
 * Production talks to the vendored EverOS server.
 * Tests inject a fake.
 */
export interface EverOSMemoryPort {
  add(input: EverOSAddInput): Promise<void>;
  flush(input: EverOSFlushInput): Promise<void>;
  search(input: EverOSSearchInput): Promise<RecalledMemory[]>;
  /** Explicit user-profile facts. Retrieved directly, not keyword-matched. */
  profile(input: EverOSProfileInput): Promise<RecalledMemory[]>;
  /** Present when the port owns a local server process. */
  dispose?(): Promise<void>;
}
