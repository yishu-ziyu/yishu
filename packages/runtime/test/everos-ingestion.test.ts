import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  EverOSAddInput,
  EverOSFlushInput,
  EverOSMemoryPort,
  RecalledMemory,
} from "@yishu/kernel";
import { EverOSIngestionCoordinator } from "../src/everos-ingestion.js";
import type {
  EverOSPendingSession,
  EverOSPendingSessionStore,
} from "../src/everos-pending-sessions.js";

class RecordingEverOS implements EverOSMemoryPort {
  readonly operations: string[] = [];
  readonly adds: EverOSAddInput[] = [];
  readonly flushes: EverOSFlushInput[] = [];
  disposed = false;

  async add(input: EverOSAddInput): Promise<void> {
    this.operations.push("add");
    this.adds.push(input);
  }

  async flush(input: EverOSFlushInput): Promise<void> {
    this.operations.push("flush");
    this.flushes.push(input);
  }

  async search(): Promise<RecalledMemory[]> {
    return [];
  }

  async profile(): Promise<RecalledMemory[]> {
    return [];
  }

  async dispose(): Promise<void> {
    this.operations.push("dispose");
    this.disposed = true;
  }
}

class MemoryPendingSessions implements EverOSPendingSessionStore {
  readonly rows = new Map<string, EverOSPendingSession>();

  constructor(seed: readonly EverOSPendingSession[] = []) {
    for (const row of seed) this.rows.set(`${row.scopeKey}:${row.sessionId}`, row);
  }

  async list(): Promise<readonly EverOSPendingSession[]> {
    return [...this.rows.values()];
  }

  async add(input: EverOSPendingSession): Promise<void> {
    this.rows.set(`${input.scopeKey}:${input.sessionId}`, input);
  }

  async remove(input: EverOSPendingSession): Promise<void> {
    this.rows.delete(`${input.scopeKey}:${input.sessionId}`);
  }
}

function input(sessionId = "conversation-1"): EverOSAddInput {
  return {
    sessionId,
    scopeKey: "personal",
    messages: [{
      senderId: "owner",
      role: "user",
      content: "我喜欢无糖咖啡",
      timestampMs: 1,
    }],
  };
}

test("ordinary turns share one idle flush per conversation", async () => {
  const everos = new RecordingEverOS();
  const coordinator = new EverOSIngestionCoordinator(everos, { idleMs: 15 });
  await coordinator.ingest(input());
  await coordinator.ingest(input());
  assert.equal(everos.flushes.length, 0);
  assert.ok(everos.adds.every((row) => row.deferExtraction === true));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(everos.flushes.length, 1);
  await coordinator.dispose();
});

test("explicit remember flushes after its add", async () => {
  const everos = new RecordingEverOS();
  const coordinator = new EverOSIngestionCoordinator(everos, { idleMs: 60_000 });
  await coordinator.ingest(input("note-1"), { flushNow: true });
  assert.deepEqual(everos.operations, ["add", "flush"]);
  await coordinator.dispose();
});

test("dispose flushes pending sessions before releasing the owned port", async () => {
  const everos = new RecordingEverOS();
  const coordinator = new EverOSIngestionCoordinator(everos, { idleMs: 60_000 });
  await coordinator.ingest(input());
  await coordinator.dispose();
  assert.deepEqual(everos.operations, ["add", "flush", "dispose"]);
  assert.equal(everos.disposed, true);
});

test("startup flushes a session that survived a previous process", async () => {
  const pending = new MemoryPendingSessions([{
    sessionId: "conversation-from-crash",
    scopeKey: "personal",
  }]);
  const everos = new RecordingEverOS();
  const coordinator = new EverOSIngestionCoordinator(everos, {
    idleMs: 60_000,
    pendingStore: pending,
  });
  await coordinator.initialize();
  assert.deepEqual(everos.flushes, [{
    sessionId: "conversation-from-crash",
    scopeKey: "personal",
  }]);
  assert.equal(pending.rows.size, 0);
  await coordinator.dispose();
});

test("dispose releases the owned process when extraction is hung", async () => {
  const everos = new RecordingEverOS();
  everos.flush = async () => new Promise<void>(() => undefined);
  const coordinator = new EverOSIngestionCoordinator(everos, {
    idleMs: 60_000,
    disposeFlushMs: 10,
  });
  await coordinator.ingest(input());
  await coordinator.dispose();
  assert.equal(everos.disposed, true);
});
