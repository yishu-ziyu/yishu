/**
 * Routine scheduler: polls the file store for due cron routines and fires
 * them as hidden wake turns (own conversation id, so they never supersede
 * the user's live turn). Results ride the ordinary turn event stream plus
 * automation.* lifecycle events for the UI.
 */

import { randomUUID } from "node:crypto";
import {
  buildAutomationWakePrompt,
  dueAutomations,
  FileAutomationStore,
  renderAutomationRuntimeStatusReminder,
  type AutomationRecord,
} from "@yishu/kernel";
import { PROTOCOL_VERSION, runtimeEvent, type RuntimeEvent, type TurnStartCommand } from "./protocol.js";

export const AUTOMATION_TICK_MS = 15_000;
export const AUTOMATION_CONVERSATION_PREFIX = "yishu-routine-";
const WAKE_TURN_TIMEOUT_MS = 5 * 60_000;
const MAX_CONCURRENT_WAKE_TURNS = 2;

export type AutomationSchedulerEmit = (event: RuntimeEvent) => void;

function emptyContextFrame(now: Date) {
  const iso = now.toISOString();
  return {
    schemaVersion: PROTOCOL_VERSION,
    frameId: randomUUID(),
    capturedAt: iso,
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    cursor: { value: { x: 0, y: 0, coordinateSpace: "global-top-left" as const }, source: "automation-wake", capturedAt: iso, confidence: 1 },
    pointerTrail: [],
    frontmostApplication: null,
    activeWindow: null,
    elementUnderCursor: null,
    screenshots: [],
    warnings: [],
  };
}

export class AutomationScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly inFlight = new Set<string>();
  private readonly runningConversations = new Set<string>();
  private readonly wakeText = new Map<string, string>();
  private disposed = false;

  constructor(
    private readonly store: FileAutomationStore,
    private readonly startTurn: (command: TurnStartCommand, emit: AutomationSchedulerEmit) => Promise<void>,
    private readonly emit: AutomationSchedulerEmit,
  ) {}

  start(): void {
    if (this.timer !== undefined || this.disposed) return;
    this.timer = setInterval(() => void this.tick(), AUTOMATION_TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  automationConversationId(automationId: string): string {
    return `${AUTOMATION_CONVERSATION_PREFIX}${automationId}`;
  }

  statusReminder(firingAutomationId?: string): string | null {
    try {
      return renderAutomationRuntimeStatusReminder(this.store.list(), undefined, {
        ...(firingAutomationId === undefined ? {} : { firingAutomationId }),
      });
    } catch {
      return null;
    }
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.disposed) return;
    let records: AutomationRecord[];
    try {
      records = this.store.list();
    } catch {
      return;
    }
    for (const index of dueAutomations(records, now)) {
      const record = records[index];
      if (record == null || this.inFlight.has(record.id)) continue;
      this.inFlight.add(record.id);
      void this.fire(record, "schedule").finally(() => this.inFlight.delete(record.id));
    }
  }

  async runNow(automationId: string): Promise<{ accepted: boolean; code?: string }> {
    const record = this.store.get(automationId);
    if (record == null) return { accepted: false, code: "automation_not_found" };
    if (this.inFlight.has(record.id)) return { accepted: false, code: "already_running" };
    this.inFlight.add(record.id);
    void this.fire(record, "manual").finally(() => this.inFlight.delete(record.id));
    return { accepted: true };
  }

  private async fire(record: AutomationRecord, trigger: "schedule" | "manual"): Promise<void> {
    if (this.runningConversations.size >= MAX_CONCURRENT_WAKE_TURNS) return;
    const startedAt = Date.now();
    const run = this.store.beginRun({ id: record.id, trigger, at: startedAt });
    if (run == null) return;
    const conversationId = this.automationConversationId(record.id);
    this.runningConversations.add(conversationId);
    this.emit(runtimeEvent("automation.run.started", run.id, run.id, {
      automationId: record.id,
      automationName: record.name,
      trigger,
      startedAt,
    }));

    const command: TurnStartCommand = {
      schemaVersion: PROTOCOL_VERSION,
      type: "turn.start",
      requestId: run.id,
      traceId: randomUUID(),
      sentAt: new Date(startedAt).toISOString(),
      payload: {
        utterance: buildAutomationWakePrompt(record, trigger === "manual" ? { trigger: "manual" } : {}),
        contextFrame: emptyContextFrame(new Date(startedAt)),
        capabilityProfile: "conversation",
        conversationId,
        // Private keeps wake turns out of the durable history ledger: a
        // routine firing is not a user conversation row.
        sessionScope: { kind: "private" },
      },
    };

    let outcome: "ok" | "error" = "ok";
    let detail: string | undefined;
    let text = "";
    const sink: AutomationSchedulerEmit = (event) => {
      if (event.requestId !== run.id) return;
      if (event.type === "response.delta") {
        const chunk = (event.payload as { text?: unknown }).text;
        if (typeof chunk === "string") text += chunk;
      }
      if (event.type === "response.completed") {
        const finalText = (event.payload as { text?: unknown }).text;
        if (typeof finalText === "string" && finalText.length > 0) text = finalText;
      }
      if (event.type === "turn.failed" || event.type === "runtime.error") {
        outcome = "error";
        const message = (event.payload as { message?: unknown }).message;
        detail = typeof message === "string" ? message : "wake turn failed";
      }
      this.emit(event);
    };

    try {
      await settlesWithin(this.startTurn(command, sink), WAKE_TURN_TIMEOUT_MS);
    } catch {
      outcome = "error";
      detail = detail ?? "wake turn timed out";
    } finally {
      this.runningConversations.delete(conversationId);
    }

    this.store.recordRun(record.id, startedAt);
    const finished = this.store.finishRun(record.id, run.id, outcome, Date.now(), detail ?? (text ? text.slice(0, 300) : undefined));
    this.wakeText.set(record.id, text);
    const summary = text.trim().slice(0, 240);
    this.emit(runtimeEvent("automation.run.finished", run.id, run.id, {
      automationId: record.id,
      automationName: record.name,
      runId: run.id,
      trigger,
      status: outcome,
      ...(detail !== undefined ? { detail } : {}),
      ...(summary.length > 0 ? { summary } : {}),
      ...(finished?.nextRunAt != null ? { nextRunAt: finished.nextRunAt } : {}),
    }));
  }
}

async function settlesWithin(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
