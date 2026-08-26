import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  QUALITY_EVENT_NAMES,
  QUALITY_EVENT_SCHEMA_VERSION,
  QUALITY_EVENT_STATUSES,
  QualityEventRejectedError,
  type QualityEvent,
  type QualityEventInput,
  type QualityEventStatus,
} from "./quality-event.js";
import { sanitizeQualityAttributes } from "./quality-redaction.js";

const NAMES = new Set<string>(QUALITY_EVENT_NAMES);
const STATUSES = new Set<string>(QUALITY_EVENT_STATUSES);
const DEFAULT_MAX_EVENTS = 20_000;
const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export interface QualityRecorderOptions {
  storePath?: string;
  now?: () => Date;
  maxEvents?: number;
  retentionMs?: number;
  maxBytes?: number;
}

export interface QualityRecorder {
  record(input: QualityEventInput): Promise<QualityEvent | null>;
  list(options?: { sessionId?: string; limit?: number }): Promise<QualityEvent[]>;
  clear(): Promise<void>;
  pause(): void;
  resume(): void;
  readonly paused: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStoredEvent(value: unknown): QualityEvent | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== QUALITY_EVENT_SCHEMA_VERSION) return null;
  if (typeof value.eventId !== "string" || typeof value.occurredAt !== "string") return null;
  if (typeof value.sessionId !== "string" || typeof value.name !== "string") return null;
  if (!NAMES.has(value.name)) return null;
  try {
    const attributes = sanitizeQualityAttributes(
      isRecord(value.attributes) ? value.attributes : {},
    );
    const event: QualityEvent = {
      schemaVersion: QUALITY_EVENT_SCHEMA_VERSION,
      eventId: value.eventId,
      occurredAt: value.occurredAt,
      sessionId: value.sessionId,
      name: value.name as QualityEvent["name"],
      attributes,
    };
    if (typeof value.requestId === "string") event.requestId = value.requestId;
    if (typeof value.traceId === "string") event.traceId = value.traceId;
    if (typeof value.spanId === "string") event.spanId = value.spanId;
    if (typeof value.parentSpanId === "string") event.parentSpanId = value.parentSpanId;
    if (typeof value.durationMs === "number" && Number.isFinite(value.durationMs)) {
      event.durationMs = value.durationMs;
    }
    if (typeof value.status === "string" && STATUSES.has(value.status)) {
      event.status = value.status as QualityEventStatus;
    }
    return event;
  } catch {
    return null;
  }
}

export function createQualityRecorder(options: QualityRecorderOptions = {}): QualityRecorder {
  const events: QualityEvent[] = [];
  let paused = false;
  const now = options.now ?? (() => new Date());
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const storePath = options.storePath;
  let chain = Promise.resolve();

  const persist = async (event: QualityEvent): Promise<void> => {
    if (storePath === undefined) return;
    await mkdir(path.dirname(storePath), { recursive: true });
    await appendFile(storePath, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
  };

  const prune = (): void => {
    const cutoff = now().getTime() - retentionMs;
    while (events.length > 0) {
      const first = events[0];
      if (first === undefined) break;
      const stamp = Date.parse(first.occurredAt);
      if (events.length > maxEvents || (Number.isFinite(stamp) && stamp < cutoff)) {
        events.shift();
        continue;
      }
      break;
    }
  };

  const record = async (input: QualityEventInput): Promise<QualityEvent | null> => {
    if (paused) return null;
    try {
      if (!NAMES.has(input.name)) {
        throw new QualityEventRejectedError(`Unknown quality event '${input.name}'.`);
      }
      if (input.sessionId.trim().length === 0) {
        throw new QualityEventRejectedError("Quality event requires sessionId.");
      }
      if (input.status !== undefined && !STATUSES.has(input.status)) {
        throw new QualityEventRejectedError(`Unknown quality status '${input.status}'.`);
      }
      const event: QualityEvent = {
        schemaVersion: QUALITY_EVENT_SCHEMA_VERSION,
        eventId: randomUUID(),
        occurredAt: input.occurredAt ?? now().toISOString(),
        sessionId: input.sessionId,
        name: input.name,
        attributes: sanitizeQualityAttributes(input.attributes),
      };
      if (input.requestId !== undefined) event.requestId = input.requestId;
      if (input.traceId !== undefined) event.traceId = input.traceId;
      if (input.spanId !== undefined) event.spanId = input.spanId;
      if (input.parentSpanId !== undefined) event.parentSpanId = input.parentSpanId;
      if (input.durationMs !== undefined) event.durationMs = input.durationMs;
      if (input.status !== undefined) event.status = input.status;
      events.push(event);
      prune();
      while (estimateQualityStoreBytes(events) > maxBytes && events.length > 1) {
        events.shift();
      }
      await persist(event);
      return event;
    } catch {
      return null;
    }
  };

  return {
    get paused() {
      return paused;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    record(input) {
      const run = chain.then(() => record(input), () => record(input));
      chain = run.then(() => undefined, () => undefined);
      return run;
    },
    async list(filter = {}) {
      const limit = filter.limit ?? events.length;
      return events
        .filter((event) => filter.sessionId === undefined || event.sessionId === filter.sessionId)
        .slice(-limit);
    },
    async clear() {
      events.length = 0;
      if (storePath === undefined) return;
      await rm(storePath, { force: true });
      await writeFile(storePath, "", { encoding: "utf8" }).catch(() => undefined);
    },
  };
}

export async function loadQualityEvents(storePath: string): Promise<QualityEvent[]> {
  try {
    const raw = await readFile(storePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return parseStoredEvent(JSON.parse(line) as unknown);
        } catch {
          return null;
        }
      })
      .filter((event): event is QualityEvent => event !== null);
  } catch {
    return [];
  }
}

export function estimateQualityStoreBytes(events: readonly QualityEvent[]): number {
  return events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event), "utf8"), 0);
}
