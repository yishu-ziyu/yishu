import { randomUUID } from "node:crypto";

/** Book ch4: async agent event priorities (higher first on drain). */
export type EventPriority = "low" | "normal" | "high" | "critical";

/**
 * In-process agent event (timer.tick, github.webhook, user.message, ...).
 */
export interface AgentEvent {
  id: string;
  type: string;
  priority: EventPriority;
  payload: unknown;
  at: string;
}

export type EventHandler = (event: AgentEvent) => void | Promise<void>;

const PRIORITY_RANK: Record<EventPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/**
 * Simple priority queue + pub/sub for offline async agent loops.
 * emit enqueues; drain dispatches by priority (critical → low).
 */
export class EventBus {
  private readonly queue: AgentEvent[] = [];
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly onceHandlers = new Map<string, Set<EventHandler>>();

  /** Number of events waiting to be drained. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Enqueue an event. Does not invoke handlers until drain().
   */
  emit(
    type: string,
    payload: unknown = undefined,
    priority: EventPriority = "normal",
  ): AgentEvent {
    const event: AgentEvent = {
      id: randomUUID(),
      type,
      priority,
      payload,
      at: new Date().toISOString(),
    };
    this.queue.push(event);
    return event;
  }

  /** Subscribe to event type. Returns unsubscribe. */
  on(type: string, handler: EventHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.handlers.delete(type);
    };
  }

  /** Subscribe once; auto-removed after first delivery. */
  once(type: string, handler: EventHandler): () => void {
    let set = this.onceHandlers.get(type);
    if (!set) {
      set = new Set();
      this.onceHandlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.onceHandlers.delete(type);
    };
  }

  /**
   * Process all pending events sorted by priority, then FIFO within same rank.
   * @returns number of events processed
   */
  async drain(): Promise<number> {
    if (this.queue.length === 0) return 0;

    const batch = this.queue.splice(0, this.queue.length);
    batch.sort((a, b) => {
      const d = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (d !== 0) return d;
      return a.at.localeCompare(b.at);
    });

    for (const event of batch) {
      await this.dispatch(event);
    }
    return batch.length;
  }

  private async dispatch(event: AgentEvent): Promise<void> {
    const regular = this.handlers.get(event.type);
    if (regular) {
      for (const h of [...regular]) {
        await h(event);
      }
    }

    const once = this.onceHandlers.get(event.type);
    if (once && once.size > 0) {
      const list = [...once];
      once.clear();
      this.onceHandlers.delete(event.type);
      for (const h of list) {
        await h(event);
      }
    }
  }
}
