/**
 * Turn context provider ports (ADR 0015, B architecture).
 *
 * The engine owns assembly timing; the product layer owns the data. The
 * engine calls these at three moments: session creation (skill catalog into
 * the stable system prefix), before the first model call of a turn (memory
 * block), and after each tool batch (status bar, injected as a transient
 * trailing message that never enters history).
 *
 * model-loop never imports @yishu/kernel; loop-adapter supplies
 * implementations via `setTurnContextProviderFactory`.
 */

export interface SkillL1Entry {
  readonly name: string;
  readonly description: string;
}

export interface StatusBarToolState {
  readonly toolCallCount: number;
  readonly lastToolName?: string;
  readonly lastToolFailed: boolean;
}

export interface TurnContextProviders {
  /** Verified-skill L1 catalog; resolved once at session creation. */
  skillCatalog?(): Promise<readonly SkillL1Entry[]>;
  /**
   * Recall block for this turn (memory overview, scoped). Returned text is
   * prepended to the first user message of the turn. Returning undefined
   * adds nothing.
   */
  assembleTurnMemory?(turnText: string): Promise<string | undefined>;
  /**
   * End-of-context status bar, refreshed after every tool batch. The text is
   * injected as a transient trailing message on the next model call only and
   * is never persisted into the session history.
   */
  statusBar?(state: StatusBarToolState): Promise<string | undefined>;
}

/** Factories are per-session so implementations can close over scope/conversation. */
export type TurnContextProviderFactory = (
  scopeKind: string,
  conversationId: string,
) => TurnContextProviders;
