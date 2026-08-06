import type { AgentRunResult, YishuAgent } from "../harness.js";
import type { AgentEvent, EventBus, EventPriority } from "./bus.js";

export interface AsyncAgentOptions {
  agent: YishuAgent;
  bus: EventBus;
  /** Keep last N run summaries (default 32). */
  resultLimit?: number;
}

/** Compact summary of one agent run triggered by an event. */
export interface AsyncRunSummary {
  eventId: string;
  eventType: string;
  task: string;
  finalText: string;
  toolsUsed: string[];
  accepted: boolean;
  trajectoryId: string;
  at: string;
}

/** Heartbeat recorded on timer.tick (no LLM). */
export interface HeartbeatStatus {
  eventId: string;
  at: string;
  pending: number;
  resultsCount: number;
  payload: unknown;
}

/**
 * Book ch4: event-driven agent loop.
 * Subscribes to bus event types; callers emit then drain.
 */
export class AsyncAgent {
  private readonly agent: YishuAgent;
  private readonly bus: EventBus;
  private readonly resultLimit: number;
  private readonly unsubs: Array<() => void> = [];
  private started = false;
  private readonly _results: AsyncRunSummary[] = [];
  private readonly _heartbeats: HeartbeatStatus[] = [];

  constructor(options: AsyncAgentOptions) {
    this.agent = options.agent;
    this.bus = options.bus;
    this.resultLimit = options.resultLimit ?? 32;
  }

  /** Last N run summaries (oldest first). */
  get results(): readonly AsyncRunSummary[] {
    return this._results;
  }

  /** Last N timer.tick heartbeats (oldest first). */
  get heartbeats(): readonly HeartbeatStatus[] {
    return this._heartbeats;
  }

  get lastResult(): AsyncRunSummary | undefined {
    return this._results[this._results.length - 1];
  }

  get isRunning(): boolean {
    return this.started;
  }

  /**
   * Subscribe to user.message / task.request / timer.tick.
   * Idempotent while already started.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubs.push(
      this.bus.on("user.message", (ev) => this.onUserOrTask(ev)),
      this.bus.on("task.request", (ev) => this.onUserOrTask(ev)),
      this.bus.on("timer.tick", (ev) => this.onTimerTick(ev)),
    );
  }

  /** Unsubscribe all handlers. */
  stop(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.started = false;
  }

  /**
   * Emit then drain (and keep draining while handlers re-enqueue).
   * Preferred one-shot entry for CLI / tests.
   */
  async handle(
    type: string,
    payload: unknown = undefined,
    priority: EventPriority = "normal",
  ): Promise<number> {
    this.bus.emit(type, payload, priority);
    let total = 0;
    // Handlers may emit follow-ups; drain until idle.
    while (this.bus.pending > 0) {
      total += await this.bus.drain();
    }
    return total;
  }

  private async onUserOrTask(event: AgentEvent): Promise<void> {
    const task = extractTaskText(event.payload);
    if (!task) return;
    const result = await this.agent.run(task);
    this.pushResult(toSummary(event, task, result));
  }

  private onTimerTick(event: AgentEvent): void {
    this._heartbeats.push({
      eventId: event.id,
      at: new Date().toISOString(),
      pending: this.bus.pending,
      resultsCount: this._results.length,
      payload: event.payload,
    });
    while (this._heartbeats.length > this.resultLimit) {
      this._heartbeats.shift();
    }
  }

  private pushResult(summary: AsyncRunSummary): void {
    this._results.push(summary);
    while (this._results.length > this.resultLimit) {
      this._results.shift();
    }
  }
}

function extractTaskText(payload: unknown): string {
  if (typeof payload === "string") return payload.trim();
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    for (const key of ["text", "task", "message", "prompt"] as const) {
      const v = p[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "";
}

function toSummary(
  event: AgentEvent,
  task: string,
  result: AgentRunResult,
): AsyncRunSummary {
  return {
    eventId: event.id,
    eventType: event.type,
    task,
    finalText: result.finalText,
    toolsUsed: result.toolsUsed,
    accepted: result.accepted,
    trajectoryId: result.trajectory.id,
    at: new Date().toISOString(),
  };
}
