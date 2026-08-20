import type {
  EverOSAddInput,
  EverOSFlushInput,
  EverOSMemoryPort,
} from "@yishu/kernel";
import type { EverOSPendingSessionStore } from "./everos-pending-sessions.js";

export const EVEROS_IDLE_FLUSH_MS = 30_000;
const EVEROS_DISPOSE_FLUSH_MS = 500;

interface EverOSIngestionOptions {
  readonly idleMs?: number;
  readonly pendingStore?: EverOSPendingSessionStore;
  readonly disposeFlushMs?: number;
}

interface SessionState extends EverOSFlushInput {
  tail: Promise<void>;
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

function sessionKey(input: EverOSFlushInput): string {
  return `${input.scopeKey}\u0000${input.sessionId}`;
}

/**
 * Serializes writes per EverOS session and turns idle/dispose into extraction
 * boundaries. Product turns never wait for this coordinator.
 */
export class EverOSIngestionCoordinator {
  private readonly sessions = new Map<string, SessionState>();
  private readonly idleMs: number;
  private readonly disposeFlushMs: number;
  private closing = false;
  private disposal: Promise<void> | undefined;
  private readonly recoveryReady: Promise<void>;

  constructor(
    private readonly everos: EverOSMemoryPort,
    options: EverOSIngestionOptions = {},
  ) {
    this.idleMs = options.idleMs ?? EVEROS_IDLE_FLUSH_MS;
    this.disposeFlushMs = options.disposeFlushMs ?? EVEROS_DISPOSE_FLUSH_MS;
    this.pendingStore = options.pendingStore;
    this.recoveryReady = this.recoverPending();
    void this.recoveryReady.catch(() => undefined);
  }

  private readonly pendingStore: EverOSPendingSessionStore | undefined;

  async initialize(): Promise<void> {
    await this.recoveryReady;
  }

  async ingest(
    input: EverOSAddInput,
    options: { readonly flushNow?: boolean } = {},
  ): Promise<void> {
    if (this.closing) throw new Error("everos_ingestion_closed");
    await this.initialize();
    const state = this.stateFor(input);
    await this.pendingStore?.add({
      sessionId: input.sessionId,
      scopeKey: input.scopeKey,
    });
    const added = this.enqueue(state, async () => {
      await this.everos.add({ ...input, deferExtraction: true });
      state.dirty = true;
    });

    if (options.flushNow === true) {
      this.clearTimer(state);
      await added;
      await this.flushState(state);
      return;
    }

    this.scheduleIdleFlush(state);
    await added;
  }

  async flushAll(): Promise<void> {
    await this.initialize();
    await Promise.all([...this.sessions.values()].map((state) => this.flushState(state)));
  }

  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal;
    this.closing = true;
    for (const state of this.sessions.values()) this.clearTimer(state);
    this.disposal = (async () => {
      await this.recoveryReady.catch(() => undefined);
      const flushes = Promise.allSettled(
        [...this.sessions.values()].map((state) => this.flushState(state)),
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          flushes,
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, this.disposeFlushMs);
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
      await this.everos.dispose?.().catch(() => undefined);
    })();
    await this.disposal;
  }

  private stateFor(input: EverOSFlushInput): SessionState {
    const key = sessionKey(input);
    const existing = this.sessions.get(key);
    if (existing !== undefined) return existing;
    const created: SessionState = {
      sessionId: input.sessionId,
      scopeKey: input.scopeKey,
      tail: Promise.resolve(),
      dirty: false,
    };
    this.sessions.set(key, created);
    return created;
  }

  private enqueue(state: SessionState, operation: () => Promise<void>): Promise<void> {
    const run = state.tail.then(operation);
    state.tail = run.catch(() => undefined);
    return run;
  }

  private flushState(state: SessionState): Promise<void> {
    this.clearTimer(state);
    return this.enqueue(state, async () => {
      if (!state.dirty) return;
      await this.everos.flush({
        sessionId: state.sessionId,
        scopeKey: state.scopeKey,
      });
      await this.pendingStore?.remove({
        sessionId: state.sessionId,
        scopeKey: state.scopeKey,
      });
      state.dirty = false;
    });
  }

  private scheduleIdleFlush(state: SessionState): void {
    this.clearTimer(state);
    state.timer = setTimeout(() => {
      delete state.timer;
      void this.flushState(state).catch(() => undefined);
    }, this.idleMs);
  }

  private clearTimer(state: SessionState): void {
    if (state.timer === undefined) return;
    clearTimeout(state.timer);
    delete state.timer;
  }

  private async recoverPending(): Promise<void> {
    const pending = await this.pendingStore?.list() ?? [];
    const flushes = pending.map((input) => {
      const state = this.stateFor(input);
      state.dirty = true;
      return this.flushState(state);
    });
    await Promise.allSettled(flushes);
  }
}
