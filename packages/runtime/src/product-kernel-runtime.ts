import { randomUUID } from "node:crypto";
import {
  createDefaultProductKernel,
  formatProductActionSpeech,
  memoryScopeForSession,
  normalizeSessionScope,
  sessionScopesEqual,
  routeProductUtterance,
  recallRelevantMemories,
  sanitizeVisibleText,
  selectRelevantMindLessons,
  type FinderHistoryBackExecutor,
  type ConversationEvent,
  type ConversationTurn,
  type RecalledMemory,
  type TrailSourceFrame,
  type SessionScope,
  type YishuKernel,
} from "@yishu/kernel";
import type {
  ContextFrame,
  ConversationId,
  HistoryDeleteCommand,
  HistoryListCommand,
  HistoryOpenCommand,
  MemoryForgetCommand,
  MemoryListCommand,
  RuntimeEvent,
  TrailObserveCommand,
  TurnCancelCommand,
  TurnStartCommand,
  TurnSteerCommand,
} from "./protocol.js";
import { runtimeEvent } from "./protocol.js";
import type { AgentRuntime, RuntimeEventSink } from "./runtime-port.js";
import type { ComputerUsePort } from "./computer-use-port.js";
import type { YishuAuthService } from "./auth-service.js";
import { RuntimeTaskProgressTracker } from "./task-progress.js";
import { RuntimeSuggestionTracker } from "./suggestion-loop.js";
import {
  attachRecalledMemories,
  attachRecalledMind,
  type PromptMemorySnippet,
} from "./context-prompt.js";

type TerminalKind = "completed" | "cancelled" | "failed";

function terminalKindForStatus(status: ConversationTurn["status"]): TerminalKind {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

interface TurnLedgerState {
  readonly command: TurnStartCommand;
  readonly conversationId: string;
  readonly traceId: string;
  readonly emit: RuntimeEventSink;
  readonly seenEventIds: Set<string>;
  readonly sessionScope: SessionScope;
  readonly durable: boolean;
  productActionAbortController?: AbortController | undefined;
  productActionCancelRequested: boolean;
  preparePromise?: Promise<unknown>;
  innerStarted: boolean;
  terminalKind?: TerminalKind;
  pendingTerminal?: RuntimeEvent;
  terminalPersistence?: Promise<void>;
  terminalDelivered: boolean;
  ledgerError?: unknown;
}

interface ReplayRecord {
  readonly turn: ConversationTurn;
  readonly events: ConversationEvent[];
}

/**
 * Product layer wrapper around any AgentRuntime (Pi / mock / agent-core).
 *
 * The wrapper owns the durable conversation projection.  The inner runtime
 * remains an execution harness; it never writes product conversation state.
 * Durable writes are deliberately serialized because runtime event callbacks
 * are synchronous while store mutations are asynchronous.
 */
export class ProductKernelRuntime implements AgentRuntime {
  readonly kernel: YishuKernel;
  private readonly taskTrackers = new Map<string, RuntimeTaskProgressTracker>();
  private readonly suggestionTrackers = new Map<string, RuntimeSuggestionTracker>();
  private readonly activeRequestIds = new Set<string>();
  private readonly activeTurns = new Map<string, TurnLedgerState>();
  private readonly activeTurnOperations = new Set<Promise<void>>();
  private ledgerTail: Promise<void> = Promise.resolve();
  private disposed = false;

  /** Forward the optional auth capability without making the kernel own OAuth. */
  get authService(): YishuAuthService | undefined {
    return (this.inner as AgentRuntime & { authService?: YishuAuthService }).authService;
  }

  constructor(
    private readonly inner: AgentRuntime,
    kernel: YishuKernel = createDefaultProductKernel(),
    private readonly computerUsePort?: ComputerUsePort,
  ) {
    this.kernel = kernel;
  }

  observeTrail(command: TrailObserveCommand, emit: RuntimeEventSink): void {
    const sessionScope = normalizeSessionScope(command.payload.sessionScope);
    if (sessionScope.kind === "private") {
      emit(runtimeEvent("trail.skipped", command.requestId, command.traceId, {
        reason: "private_session",
      }));
      return;
    }
    const entry = this.kernel.trail.append(
      contextFrameToTrailSource(command.payload.contextFrame),
    );
    emit(
      runtimeEvent("trail.appended", command.requestId, command.traceId, {
        frameId: entry.frameId,
        trailSize: this.kernel.trail.size(),
        appName: entry.appName,
        windowTitle: entry.windowTitle,
      }),
    );
  }

  /**
   * Read-only history list for the product UI. Never includes raw events,
   * screenshots, or hidden reasoning — only compact visible rows.
   */
  async listHistory(command: HistoryListCommand, emit: RuntimeEventSink): Promise<void> {
    if (this.disposed) {
      emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
        code: "runtime_disposed",
        message: "ProductKernelRuntime has been disposed.",
      }));
      return;
    }
    try {
      const sessionScope = normalizeSessionScope(command.payload.sessionScope);
      const items = await this.kernel.store.listConversations({
        sessionScope,
        ...(command.payload.limit !== undefined ? { limit: command.payload.limit } : {}),
      });
      emit(runtimeEvent("history.listed", command.requestId, command.traceId, {
        sessionScope,
        limit: command.payload.limit ?? items.length,
        items: items.map((item) => ({
          id: item.id,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          status: item.status,
          sessionScope: item.sessionScope,
          title: item.title,
          summary: item.summary,
        })),
      }));
    } catch {
      emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
        code: "history_list_failed",
        message: "暂时无法读取历史对话。",
      }));
    }
  }

  /**
   * Validate and open one durable conversation for continue. Returns only
   * user-visible turn text so the client can restore local context cache.
   */
  async openHistory(command: HistoryOpenCommand, emit: RuntimeEventSink): Promise<void> {
    if (this.disposed) {
      emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
        code: "runtime_disposed",
        message: "ProductKernelRuntime has been disposed.",
      }));
      return;
    }
    try {
      const expectedScope = normalizeSessionScope(command.payload.sessionScope);
      if (expectedScope.kind === "private") {
        emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
          code: "private_session_not_readable",
          message: "不保存的对话不会留下历史。",
        }));
        return;
      }
      const conversation = await this.kernel.store.getConversation(
        command.payload.conversationId,
      );
      if (!conversation) {
        emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
          code: "conversation_not_found",
          message: "找不到这段对话。",
        }));
        return;
      }
      if (!sessionScopesEqual(conversation.sessionScope, expectedScope)) {
        emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
          code: "scope_mismatch",
          message: "这段对话不在当前范围。",
        }));
        return;
      }
      if (conversation.status === "archived") {
        emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
          code: "conversation_archived",
          message: "这段对话已删除，不能继续。",
        }));
        return;
      }
      const turns = await this.kernel.store.listConversationTurns(conversation.id);
      // Cap restored visible context so open history cannot dump an unbounded
      // transcript into the client cache.
      const visibleTurns = turns
        .filter((turn) => {
          const hasUser = turn.userInput !== undefined && turn.userInput.trim().length > 0;
          const hasAssistant =
            turn.assistantOutput !== undefined && turn.assistantOutput.trim().length > 0;
          return hasUser || hasAssistant;
        })
        .slice(-20)
        .map((turn) => ({
          id: turn.id,
          sequence: turn.sequence,
          status: turn.status,
          createdAt: turn.createdAt,
          updatedAt: turn.updatedAt,
          ...(turn.userInput !== undefined
            ? { userInput: sanitizeVisibleText(turn.userInput, "conversation user input") }
            : {}),
          ...(turn.assistantOutput !== undefined
            ? {
                assistantOutput: sanitizeVisibleText(
                  turn.assistantOutput,
                  "conversation assistant output",
                ),
              }
            : {}),
        }));
      emit(runtimeEvent(
        "history.opened",
        command.requestId,
        command.traceId,
        {
          conversation: {
            id: conversation.id,
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
            status: conversation.status,
            sessionScope: conversation.sessionScope,
            ...(conversation.title !== undefined ? { title: conversation.title } : {}),
          },
          turns: visibleTurns,
        },
        conversation.id,
      ));
    } catch {
      emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
        code: "history_open_failed",
        message: "暂时无法打开这段对话。",
      }));
    }
  }

  /**
   * Soft-delete one personal history row (status=archived). Emits only after
   * store confirms success so the UI can remove the row safely.
   */
  async deleteHistory(command: HistoryDeleteCommand, emit: RuntimeEventSink): Promise<void> {
    if (this.disposed) {
      emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
        code: "runtime_disposed",
        message: "ProductKernelRuntime has been disposed.",
      }));
      return;
    }
    try {
      const expectedScope = normalizeSessionScope(command.payload.sessionScope);
      if (expectedScope.kind === "private") {
        emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
          code: "private_session_not_deletable",
          message: "不保存的对话不会留下历史，也无需删除。",
        }));
        return;
      }
      // This product entry only deletes from "我的" (personal).
      if (expectedScope.kind !== "personal") {
        emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
          code: "scope_not_supported",
          message: "只能删除「我的」历史对话。",
        }));
        return;
      }
      const existing = await this.kernel.store.getConversation(
        command.payload.conversationId,
      );
      if (!existing) {
        emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
          code: "conversation_not_found",
          message: "找不到这段对话。",
        }));
        return;
      }
      if (!sessionScopesEqual(existing.sessionScope, expectedScope)) {
        emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
          code: "scope_mismatch",
          message: "这段对话不在当前范围。",
        }));
        return;
      }
      const archived = await this.kernel.store.archiveConversation(existing.id, {
        expectedScope,
      });
      if (!archived || archived.status !== "archived") {
        emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
          code: "history_delete_failed",
          message: "删除失败，原对话仍保留。",
        }));
        return;
      }
      emit(runtimeEvent(
        "history.deleted",
        command.requestId,
        command.traceId,
        {
          conversationId: archived.id,
          status: archived.status,
          sessionScope: archived.sessionScope,
          alreadyArchived: existing.status === "archived",
        },
        archived.id,
      ));
    } catch {
      emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
        code: "history_delete_failed",
        message: "删除失败，原对话仍保留。",
      }));
    }
  }

  /**
   * Read-only personal memory list for the "我的" panel.
   * Private/project are rejected; only the personal memory namespace is listed.
   */
  async listMemories(command: MemoryListCommand, emit: RuntimeEventSink): Promise<void> {
    if (this.disposed) {
      emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
        code: "runtime_disposed",
        message: "ProductKernelRuntime has been disposed.",
      }));
      return;
    }
    try {
      const sessionScope = normalizeSessionScope(command.payload.sessionScope);
      if (sessionScope.kind === "private") {
        emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
          code: "private_session_not_readable",
          message: "不保存的对话不会留下长期记忆列表。",
        }));
        return;
      }
      if (sessionScope.kind !== "personal") {
        emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
          code: "scope_not_supported",
          message: "只能在「我的」查看个人记忆。",
        }));
        return;
      }
      const memoryScope = memoryScopeForSession(sessionScope);
      if (memoryScope === null) {
        emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
          code: "scope_not_supported",
          message: "只能在「我的」查看个人记忆。",
        }));
        return;
      }
      const items = await this.kernel.store.listMemories({
        scope: memoryScope,
        ...(command.payload.limit !== undefined ? { limit: command.payload.limit } : {}),
      });
      emit(runtimeEvent("memory.listed", command.requestId, command.traceId, {
        sessionScope,
        limit: command.payload.limit ?? items.length,
        items: items.map((item) => ({
          id: item.id,
          summary: item.summary,
          capturedAt: item.capturedAt,
          lastConfirmedAt: item.lastConfirmedAt,
          source: item.source,
          scope: item.scope,
        })),
      }));
    } catch {
      emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
        code: "memory_list_failed",
        message: "暂时无法读取已保存的记忆。",
      }));
    }
  }

  /**
   * User-confirmed forget by exact memory id + personal scope.
   * Hard-deletes the claim; only emits success after storage confirms.
   */
  async forgetMemory(command: MemoryForgetCommand, emit: RuntimeEventSink): Promise<void> {
    if (this.disposed) {
      emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
        code: "runtime_disposed",
        message: "ProductKernelRuntime has been disposed.",
      }));
      return;
    }
    try {
      const sessionScope = normalizeSessionScope(command.payload.sessionScope);
      if (sessionScope.kind === "private") {
        emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
          code: "private_session_not_deletable",
          message: "不保存的对话不会留下长期记忆，也无需忘记。",
        }));
        return;
      }
      if (sessionScope.kind !== "personal") {
        emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
          code: "scope_not_supported",
          message: "只能忘记「我的」里的个人记忆。",
        }));
        return;
      }
      const memoryScope = memoryScopeForSession(sessionScope);
      if (memoryScope === null) {
        emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
          code: "scope_not_supported",
          message: "只能忘记「我的」里的个人记忆。",
        }));
        return;
      }
      const result = await this.kernel.store.forgetMemory(command.payload.memoryId, {
        expectedScope: memoryScope,
      });
      if (result === null) {
        emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
          code: "scope_mismatch",
          message: "这条记忆不在当前范围，未删除。",
        }));
        return;
      }
      emit(runtimeEvent("memory.forgotten", command.requestId, command.traceId, {
        memoryId: result.id,
        sessionScope,
        alreadyGone: result.alreadyGone,
      }));
    } catch {
      emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
        code: "memory_forget_failed",
        message: "忘记失败，原记忆仍保留。",
      }));
    }
  }

  async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
    if (this.disposed) {
      emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
        code: "runtime_disposed",
        message: "ProductKernelRuntime has been disposed.",
      }, command.payload.conversationId ?? command.requestId));
      return;
    }
    if (this.activeRequestIds.has(command.requestId)) {
      const existing = this.activeTurns.get(command.requestId);
      emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
        code: "duplicate_request",
        message: "A turn with this request id is already active.",
      }, existing?.conversationId ?? command.payload.conversationId ?? command.requestId));
      return;
    }

    const sessionScope = normalizeSessionScope(command.payload.sessionScope);
    const state: TurnLedgerState = {
      command,
      conversationId: command.payload.conversationId ?? command.requestId,
      traceId: command.traceId,
      emit,
      seenEventIds: new Set<string>(),
      sessionScope,
      durable: sessionScope.kind !== "private",
      productActionCancelRequested: false,
      innerStarted: false,
      terminalDelivered: false,
    };
    this.activeRequestIds.add(command.requestId);
    this.activeTurns.set(command.requestId, state);
    const operation = this.runTurn(state);
    this.activeTurnOperations.add(operation);
    try {
      await operation;
    } finally {
      this.activeTurnOperations.delete(operation);
      this.activeRequestIds.delete(command.requestId);
      this.activeTurns.delete(command.requestId);
    }
  }

  private async runTurn(state: TurnLedgerState): Promise<void> {
    const { command } = state;

    if (state.durable) {
      try {
        const preparation = this.prepareTurn(state);
        state.preparePromise = preparation;
        const replay = await preparation;
        if (replay === "replayed" || replay === "recovery_required" || replay === "conflict") {
          return;
        }
      } catch {
        // A ledger read failure is a hard boundary: do not execute the model or
        // tools without knowing whether this request already ran.
        this.emitSafeFailure(state, "conversation_ledger_unavailable");
        return;
      }
    }

    if (state.terminalKind) return;

    // Live frame enters the product trail once the durable turn gate is open.
    if (state.sessionScope.kind !== "private") {
      this.kernel.trail.append(contextFrameToTrailSource(command.payload.contextFrame));
    }

    const route = routeProductUtterance(
      command.payload.utterance,
      command.payload.contextFrame,
    );
    if (!route) {
      await this.runInnerTurn(state);
      return;
    }

    if (state.sessionScope.kind === "private") {
      await this.completePrivateProductActionBlock(state);
      return;
    }

    const memoryScope = memoryScopeForSession(state.sessionScope);
    const scopedRoute = memoryScope === null
      ? route
      : {
          ...route,
          input: route.action === "remember" || route.action === "record_learning"
            ? { ...route.input, scope: memoryScope }
            : route.input,
        };
    await this.runProductAction(state, scopedRoute);
  }

  /**
   * Create the durable turn before touching the execution harness.  Existing
   * terminal turns are replayed, existing open turns fail closed, and an id
   * reused in another conversation is rejected.
   */
  private async prepareTurn(
    state: TurnLedgerState,
  ): Promise<"new" | "replayed" | "recovery_required" | "conflict"> {
    const { command } = state;
    const conversation = await this.kernel.store.getConversation(state.conversationId);
    if (conversation && !sessionScopesEqual(conversation.sessionScope, state.sessionScope)) {
      this.emitSafeFailure(state, "request_reuse_conflict");
      return "conflict";
    }
    const turns = await this.kernel.store.listConversationTurns(state.conversationId);
    const existing = turns.find((turn) => turn.id === command.requestId);
    const crossConversation = await this.kernel.store.getConversationTurn(command.requestId);

    if (crossConversation && crossConversation.conversationId !== state.conversationId) {
      this.emitSafeFailure(state, "request_reuse_conflict");
      return "conflict";
    }

    if (existing) {
      if (!sessionScopesEqual(existing.sessionScope, state.sessionScope)) {
        this.emitSafeFailure(state, "request_reuse_conflict");
        return "conflict";
      }
      if (existing.traceId !== undefined && existing.traceId !== state.traceId) {
        this.emitSafeFailure(state, "request_reuse_conflict");
        return "conflict";
      }
      if (
        existing.userInput !== undefined
        && ledgerText(existing.userInput) !== ledgerText(command.payload.utterance)
      ) {
        this.emitSafeFailure(state, "request_reuse_conflict");
        return "conflict";
      }

      if (existing.status === "open") {
        await this.recoverOpenTurn(state, existing);
        return "recovery_required";
      }

      // The turn row is already terminal.  Latch that durable outcome before
      // reading the replay events so concurrent cancel/steer calls cannot
      // append a late user event or invoke the inner runtime while replay is
      // waiting on the event barrier.
      state.terminalKind = terminalKindForStatus(existing.status);
      const events = await this.kernel.store.listConversationEvents(state.conversationId);
      await this.replayTerminalTurn(state, { turn: existing, events });
      return "replayed";
    }

    await this.enqueueLedger(state, async () => {
      await this.kernel.store.upsertConversation({
        id: state.conversationId,
        status: "active",
        sessionScope: state.sessionScope,
      });
      await this.kernel.store.upsertConversationTurn({
        id: command.requestId,
        conversationId: state.conversationId,
        status: "open",
        traceId: state.traceId,
        userInput: ledgerText(command.payload.utterance),
        sessionScope: state.sessionScope,
      });
      await this.kernel.store.appendConversationEvent({
        id: randomUUID(),
        conversationId: state.conversationId,
        turnId: command.requestId,
        type: "turn.started",
        occurredAt: new Date().toISOString(),
        payload: { traceId: state.traceId },
      });
      await this.kernel.store.appendConversationEvent({
        id: randomUUID(),
        conversationId: state.conversationId,
        turnId: command.requestId,
        type: "turn.user_input",
        occurredAt: new Date().toISOString(),
        payload: eventText(command.payload.utterance),
      });
    });
    await this.flushState(state);
    return "new";
  }

  private async runInnerTurn(state: TurnLedgerState): Promise<void> {
    const tracker = state.durable
      ? new RuntimeTaskProgressTracker(this.kernel.taskTruth, state.command)
      : undefined;
    if (tracker) this.taskTrackers.set(state.command.requestId, tracker);
    const suggestionTracker = state.durable
      ? new RuntimeSuggestionTracker(this.kernel, state.command)
      : undefined;
    if (suggestionTracker) {
      this.suggestionTrackers.set(state.command.requestId, suggestionTracker);
    }

    try {
      // Cancel/dispose may close the gate during prepare or recall.  Never start
      // the inner harness after a terminal outcome, or delayed events can hang
      // forever waiting for a cancel that already finished without innerStarted.
      if (state.terminalKind) {
        await this.settleState(state);
        return;
      }

      // Ordinary turns: small scoped MemoryClaim recall only. Private / failed
      // retrieval never pretends a memory was used.
      const recalled = await this.recallForOrdinaryTurn(state);
      if (state.terminalKind) {
        await this.settleState(state);
        return;
      }
      if (recalled.length > 0) {
        this.emitMemoryUsed(state, recalled);
      }
      // Learned Mind lessons close the loop: bounded, private-safe, and any
      // retrieval failure degrades to no lessons rather than breaking the turn.
      const mindLessons = await this.recallMindForOrdinaryTurn(state);
      if (state.terminalKind) {
        await this.settleState(state);
        return;
      }
      const commandForInner = attachRecalledMind(
        attachRecalledMemories(
          state.command,
          recalled.map(toPromptMemorySnippet),
        ),
        mindLessons,
      );

      // Mark started before the last terminal check so a concurrent cancelTurn
      // will invoke inner.cancelTurn and unblock a gated startTurn.
      state.innerStarted = true;
      if (state.terminalKind) {
        await this.settleState(state);
        return;
      }

      try {
        await this.inner.startTurn(commandForInner, (event) => {
          tracker?.observe(event);
          suggestionTracker?.observe(event);
          this.acceptRuntimeEvent(state, event);
        });
      } catch {
        tracker?.recordRuntimeFailure("start");
        if (!state.terminalKind) {
          this.acceptRuntimeEvent(
            state,
            runtimeEvent("turn.failed", state.command.requestId, state.traceId, {
              code: "runtime_operation_failed",
            }),
          );
        }
      }
    } finally {
      try {
        await tracker?.flush();
      } catch {
        if (!state.terminalKind) {
          this.acceptRuntimeEvent(
            state,
            runtimeEvent("turn.failed", state.command.requestId, state.traceId, {
              code: "task_truth_unavailable",
            }),
          );
        } else if (state.terminalKind === "completed" && !state.terminalPersistence) {
          this.replacePendingWithFailure(state, "task_truth_unavailable");
        }
      }
      await suggestionTracker?.flush();
      if (tracker && this.taskTrackers.get(state.command.requestId) === tracker) {
        this.taskTrackers.delete(state.command.requestId);
      }
      if (
        suggestionTracker
        && this.suggestionTrackers.get(state.command.requestId) === suggestionTracker
      ) {
        this.suggestionTrackers.delete(state.command.requestId);
      }
    }

    if (!state.terminalKind) {
      this.acceptRuntimeEvent(
        state,
        runtimeEvent("turn.failed", state.command.requestId, state.traceId, {
          code: "turn_ended_without_terminal",
        }),
      );
    }
    await this.settleState(state);
  }

  private async completePrivateProductActionBlock(state: TurnLedgerState): Promise<void> {
    const text = "这是私密会话：我不会读取或写入记忆，也不会把这轮加入历史。请切换到个人或项目会话后再保存。";
    this.acceptRuntimeEvent(
      state,
      runtimeEvent("turn.started", state.command.requestId, state.traceId, {
        capabilityProfile: state.command.payload.capabilityProfile,
        privateSession: true,
      }),
    );
    this.acceptRuntimeEvent(
      state,
      runtimeEvent("response.delta", state.command.requestId, state.traceId, { text }),
    );
    this.acceptRuntimeEvent(
      state,
      runtimeEvent("response.completed", state.command.requestId, state.traceId, {
        text,
        verified: true,
      }),
    );
    await this.settleState(state);
  }

  private replacePendingWithFailure(state: TurnLedgerState, code: string): void {
    state.terminalKind = "failed";
    state.pendingTerminal = runtimeEvent(
      "turn.failed",
      state.command.requestId,
      state.traceId,
      { code },
    );
  }

  private async runProductAction(
    state: TurnLedgerState,
    route: NonNullable<ReturnType<typeof routeProductUtterance>>,
  ): Promise<void> {
    const { command } = state;
    const actionRoute = route.action === "finder_history_back"
      ? {
          ...route,
          input: {
            ...route.input,
            intentId: randomUUID(),
            attemptId: randomUUID(),
            basisFrameId: command.payload.contextFrame.frameId,
          },
        }
      : route;
    this.acceptRuntimeEvent(
      state,
      runtimeEvent("turn.started", command.requestId, state.traceId, {
        capabilityProfile: command.payload.capabilityProfile,
        productAction: actionRoute.action,
      }),
    );

    const productActionAbortController = new AbortController();
    state.productActionAbortController = productActionAbortController;
    if (this.disposed) {
      state.productActionCancelRequested = true;
      productActionAbortController.abort("runtime_disposed");
    }
    let receipt: Awaited<ReturnType<YishuKernel["registry"]["invoke"]>>;
    try {
      const actionDeps = actionRoute.action === "finder_history_back"
        ? { finderHistoryBack: this.finderHistoryBackExecutor(state) }
        : undefined;
      receipt = await this.kernel.registry.invoke(actionRoute.action, {
        caller: "voice",
        input: actionRoute.input,
        contextFrame: command.payload.contextFrame,
        signal: productActionAbortController.signal,
      }, actionDeps);
    } catch {
      if (productActionAbortController.signal.aborted || state.terminalKind === "cancelled") {
        if (!state.terminalKind) {
          this.acceptRuntimeEvent(
            state,
            runtimeEvent("turn.cancelled", command.requestId, state.traceId, {
              reason: "product_action_cancelled",
            }),
          );
        }
        if (state.productActionAbortController === productActionAbortController) {
          state.productActionAbortController = undefined;
        }
        await this.settleState(state);
        return;
      }
      if (!state.terminalKind) {
        this.acceptRuntimeEvent(
          state,
          runtimeEvent("turn.failed", command.requestId, state.traceId, {
            code: "product_action_failed",
          }),
        );
      }
      if (state.productActionAbortController === productActionAbortController) {
        state.productActionAbortController = undefined;
      }
      await this.settleState(state);
      return;
    }

    try {
      const cancelRequested =
        state.productActionCancelRequested
        || productActionAbortController.signal.aborted
        || this.disposed;

      // A pre-commit cancellation means no product side effect was made.  Keep
      // this a plain cancelled turn, with no action success receipt or speech.
      if (receipt.status === "cancelled") {
        if (!state.terminalKind) {
          this.acceptRuntimeEvent(
            state,
            runtimeEvent("turn.cancelled", command.requestId, state.traceId, {
              reason: "product_action_cancelled",
            }),
          );
        }
        await this.settleState(state);
        return;
      }

      // Once an action has committed, a stop request must not pretend that
      // nothing happened.  Persist the safe action receipt first, then fail the
      // turn with a stable reconciliation code; never speak success.
      if (
        receipt.status === "cancelled_after_commit"
        || (cancelRequested && (receipt.status === "ok" || receipt.status === "verified"))
      ) {
        this.emitProductActionCompleted(state, receipt);
        this.acceptRuntimeEvent(
          state,
          runtimeEvent("turn.failed", command.requestId, state.traceId, {
            code: "action_committed_after_cancel",
          }),
        );
        await this.settleState(state);
        return;
      }

      // A cancellation request that resolves to another non-success receipt is
      // still terminal, but must not emit a misleading success response.
      if (cancelRequested) {
        this.emitProductActionCompleted(state, receipt);
        this.acceptRuntimeEvent(
          state,
          runtimeEvent("turn.failed", command.requestId, state.traceId, {
            code: "product_action_failed",
          }),
        );
        await this.settleState(state);
        return;
      }

      // Cancellation may not have been requested, but another terminal gate
      // could have won the race.  Do not append any late action output.
      if (state.terminalKind) {
        await this.settleState(state);
        return;
      }

      const speech = formatProductActionSpeech(
        actionRoute.action,
        receipt.status,
        receipt.output,
      );
      this.emitProductActionCompleted(state, receipt);
      this.acceptRuntimeEvent(
        state,
        runtimeEvent("response.delta", command.requestId, state.traceId, { text: speech }),
      );

      const verified =
        receipt.status === "verified"
        || (receipt.status === "ok" && actionRoute.action !== "remember_how");
      if (receipt.status === "failed" && !receipt.output) {
        this.acceptRuntimeEvent(
          state,
          runtimeEvent("turn.failed", command.requestId, state.traceId, {
            code: "product_action_failed",
            message: receipt.message,
          }),
        );
      } else {
        this.acceptRuntimeEvent(
          state,
          runtimeEvent("response.completed", command.requestId, state.traceId, {
            text: speech,
            verified,
            productAction: actionRoute.action,
            receiptStatus: receipt.status,
          }),
        );
      }
      await this.settleState(state);
    } finally {
      // Keep the controller registered through receipt reconciliation so a
      // stop racing the invoke promise cannot close the turn as cancelled
      // before a committed side effect is accounted for.
      if (state.productActionAbortController === productActionAbortController) {
        state.productActionAbortController = undefined;
      }
    }
  }

  /**
   * The Product Kernel is the only producer of this semantic request. The
   * same typed port is shared with Pi, but this path never starts Pi/model
   * execution and carries a fresh current-frame basis through to Swift.
   */
  private finderHistoryBackExecutor(
    state: TurnLedgerState,
  ): FinderHistoryBackExecutor {
    return {
      perform: async (request, signal) => {
        if (!this.computerUsePort) {
          return {
            succeeded: false,
            verified: false,
            status: "failed",
            code: "runtime_error",
            method: "unknown",
            message: "The macOS computer-use bridge is unavailable.",
          };
        }
        return this.computerUsePort.perform({
          action: "finder_history_back",
          x: 0,
          y: 0,
          targetBundleId: request.targetBundleId,
          targetPid: request.targetPid,
        }, {
          requestId: state.command.requestId,
          traceId: state.traceId,
          intentId: request.intentId,
          attemptId: request.attemptId,
          basisFrameId: request.basisFrameId,
          effectClass: "navigation",
        }, signal);
      },
    };
  }

  private emitProductActionCompleted(
    state: TurnLedgerState,
    receipt: Awaited<ReturnType<YishuKernel["registry"]["invoke"]>>,
  ): void {
    this.acceptRuntimeEvent(
      state,
      runtimeEvent("product.action.completed", state.command.requestId, state.traceId, {
        actionName: receipt.actionName,
        status: receipt.status,
        receiptId: receipt.receiptId,
        auditId: receipt.auditId,
        message: receipt.message,
        output: summarizeOutput(receipt.output),
      }),
    );
  }

  async steerTurn(command: TurnSteerCommand, emit: RuntimeEventSink): Promise<void> {
    const state = this.activeTurns.get(command.requestId);
    if (!state) {
      await this.inner.steerTurn(command, (event) => {
        const safeEvent = sanitizeClientEvent(enrichFreeEvent(event, command.requestId));
        if (safeEvent) emit(safeEvent);
      });
      return;
    }
    await state.preparePromise?.catch(() => undefined);
    if (state.terminalKind) return;

    if (state.durable) {
      try {
        await this.enqueueLedger(state, async () => {
          await this.kernel.store.appendConversationEvent({
            id: randomUUID(),
            conversationId: state.conversationId,
            turnId: state.command.requestId,
            type: "turn.user_input",
            occurredAt: new Date().toISOString(),
            payload: { ...eventText(command.payload.message), channel: "steer" },
          });
        });
        await this.flushState(state);
      } catch {
        this.emitSafeFailure(state, "conversation_ledger_failed");
        return;
      }
    }

    const tracker = this.taskTrackers.get(command.requestId);
    const suggestionTracker = this.suggestionTrackers.get(command.requestId);
    try {
      state.innerStarted = true;
      await this.inner.steerTurn(command, (event) => {
        tracker?.observe(event);
        suggestionTracker?.observe(event);
        this.acceptRuntimeEvent(state, event);
      });
    } catch {
      tracker?.recordRuntimeFailure("steer");
      if (!state.terminalKind) {
        this.acceptRuntimeEvent(
          state,
          runtimeEvent("turn.failed", command.requestId, state.traceId, {
            code: "steer_failed",
          }),
        );
      }
    }
    if (state.terminalKind) {
      try {
        await tracker?.flush();
      } catch {
        if (state.terminalKind === "completed" && !state.terminalPersistence) {
          this.replacePendingWithFailure(state, "task_truth_unavailable");
        }
      }
      await suggestionTracker?.flush();
      await this.settleState(state);
    }
  }

  async cancelTurn(command: TurnCancelCommand, emit: RuntimeEventSink): Promise<void> {
    const state = this.activeTurns.get(command.requestId);
    if (!state) {
      await this.inner.cancelTurn(command, (event) => {
        const safeEvent = sanitizeClientEvent(enrichFreeEvent(event, command.requestId));
        if (safeEvent) emit(safeEvent);
      });
      return;
    }
    await state.preparePromise?.catch(() => undefined);
    if (state.terminalKind) return;

    // Product actions are reconciled by the registry receipt.  Do not close
    // the turn gate here: a post-commit receipt must be able to record the
    // action before the turn is failed.  The reason is fixed and never copies
    // user-provided text into the signal.
    if (state.productActionAbortController !== undefined) {
      state.productActionCancelRequested = true;
      state.productActionAbortController.abort("product_action_cancelled");
      return;
    }

    // Close the product gate before invoking a potentially slow inner
    // cancellation.  Product actions do not have an inner turn to cancel.
    const cancelledEvent = runtimeEvent("turn.cancelled", command.requestId, state.traceId, {
      reason: state.productActionAbortController === undefined
        ? safeMetadata(command.payload.reason) ?? "user_cancelled"
        : "product_action_cancelled",
    });
    this.taskTrackers.get(command.requestId)?.observe(cancelledEvent);
    this.suggestionTrackers.get(command.requestId)?.observe(cancelledEvent);
    this.acceptRuntimeEvent(state, cancelledEvent);
    if (state.innerStarted) {
      try {
        await this.inner.cancelTurn(command, (event) => {
          this.taskTrackers.get(command.requestId)?.observe(event);
          this.suggestionTrackers.get(command.requestId)?.observe(event);
          this.acceptRuntimeEvent(state, event);
        });
      } catch {
        // The durable cancelled state is already authoritative.  Do not
        // expose an inner error containing provider/tool details.
      }
    }
    try {
      await this.taskTrackers.get(command.requestId)?.flush();
    } catch {
      // Preserve an explicit user cancellation even if TaskTruth persistence
      // is unavailable; the ledger turn remains the authoritative outcome.
    }
    await this.suggestionTrackers.get(command.requestId)?.flush();
    await this.settleState(state);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    // Abort product actions before waiting for active turn operations.  The
    // registry receives this signal and returns a fixed cancelled receipt,
    // allowing dispose to drain without late action writes or speech.
    for (const state of this.activeTurns.values()) {
      if (state.productActionAbortController !== undefined) {
        state.productActionCancelRequested = true;
        state.productActionAbortController.abort("runtime_disposed");
      }
    }
    let disposeError: unknown;
    try {
      await this.inner.dispose();
    } catch (error) {
      disposeError = error;
    }

    // A runtime may dispose its session before its startTurn promise settles.
    // Wait for every producer before taking the final durable snapshot.
    await Promise.allSettled([...this.activeTurnOperations]);
    await Promise.allSettled([...this.taskTrackers.values()].map((tracker) => tracker.flush()));
    await Promise.allSettled(
      [...this.suggestionTrackers.values()].map((tracker) => tracker.flush()),
    );
    for (const state of this.activeTurns.values()) {
      if (!state.terminalKind) {
        const cancelled = runtimeEvent(
          "turn.cancelled",
          state.command.requestId,
          state.traceId,
          { reason: "runtime_disposed" },
        );
        this.suggestionTrackers.get(state.command.requestId)?.observe(cancelled);
        this.acceptRuntimeEvent(state, cancelled);
        await this.suggestionTrackers.get(state.command.requestId)?.flush();
        await this.settleState(state);
      }
    }
    await this.flushLedger();
    this.taskTrackers.clear();
    this.suggestionTrackers.clear();
    this.activeRequestIds.clear();
    this.activeTurns.clear();
    if (disposeError !== undefined) throw disposeError;
  }

  private acceptRuntimeEvent(state: TurnLedgerState, rawEvent: RuntimeEvent): void {
    if (state.terminalKind) return;
    if (state.seenEventIds.has(rawEvent.eventId)) return;
    state.seenEventIds.add(rawEvent.eventId);
    const event = sanitizeClientEvent(enrichEvent(rawEvent, state));
    if (!event) return;

    if (event.type === "response.completed") {
      state.terminalKind = "completed";
      state.pendingTerminal = event;
      return;
    }
    if (event.type === "turn.cancelled") {
      state.terminalKind = "cancelled";
      state.pendingTerminal = event;
      return;
    }
    if (event.type === "turn.failed" || event.type === "runtime.error") {
      state.terminalKind = "failed";
      state.pendingTerminal = event;
      return;
    }

    // The outer gate wrote the canonical turn.started before invoking the
    // harness.  Keep the harness event live (it may carry provider metadata),
    // but do not create a second durable start record.
    if (event.type === "turn.started") {
      state.emit(event);
      return;
    }

    const projection = projectionFor(event);
    if (!projection) {
      // response.delta intentionally remains a live-only stream.
      state.emit(event);
      return;
    }
    if (!state.durable) {
      state.emit(event);
      return;
    }
    void this.enqueueLedger(state, async () => {
      await this.kernel.store.appendConversationEvent({
        id: event.eventId,
        conversationId: state.conversationId,
        turnId: state.command.requestId,
        type: projection.type,
        occurredAt: event.occurredAt,
        payload: projection.payload,
      });
    }).catch(() => undefined);
    state.emit(event);
  }

  private async persistCompleted(state: TurnLedgerState, event: RuntimeEvent): Promise<void> {
    const text = typeof event.payload.text === "string" ? ledgerText(event.payload.text) : undefined;
    if (text !== undefined) {
      await this.kernel.store.appendConversationEvent({
        id: randomUUID(),
        conversationId: state.conversationId,
        turnId: state.command.requestId,
        type: "turn.assistant_output",
        occurredAt: event.occurredAt,
        payload: eventText(text),
      });
    }
    await this.kernel.store.appendConversationEvent({
      id: event.eventId,
      conversationId: state.conversationId,
      turnId: state.command.requestId,
      type: "turn.completed",
      occurredAt: event.occurredAt,
      payload: {
        verified: event.payload.verified === true,
        ...(safeMetadata(event.payload.verifier)
          ? { verifier: safeMetadata(event.payload.verifier)! }
          : {}),
      },
    });
    await this.kernel.store.upsertConversationTurn({
      id: state.command.requestId,
      conversationId: state.conversationId,
      status: "completed",
      traceId: state.traceId,
      ...(text === undefined ? {} : { assistantOutput: text }),
    });
  }

  private async persistCancelled(state: TurnLedgerState, event: RuntimeEvent): Promise<void> {
    await this.kernel.store.appendConversationEvent({
      id: event.eventId,
      conversationId: state.conversationId,
      turnId: state.command.requestId,
      type: "turn.cancelled",
      occurredAt: event.occurredAt,
      payload: {
        reason: safeMetadata(event.payload.reason) ?? "user_cancelled",
      },
    });
    await this.kernel.store.upsertConversationTurn({
      id: state.command.requestId,
      conversationId: state.conversationId,
      status: "cancelled",
      traceId: state.traceId,
    });
  }

  private async persistFailed(state: TurnLedgerState, event: RuntimeEvent): Promise<void> {
    await this.kernel.store.appendConversationEvent({
      id: event.eventId,
      conversationId: state.conversationId,
      turnId: state.command.requestId,
      type: "turn.failed",
      occurredAt: event.occurredAt,
      payload: {
        code: safeMetadata(event.payload.code) ?? "runtime_operation_failed",
      },
    });
    await this.kernel.store.upsertConversationTurn({
      id: state.command.requestId,
      conversationId: state.conversationId,
      status: "failed",
      traceId: state.traceId,
    });
  }

  private async recoverOpenTurn(state: TurnLedgerState, existing: ConversationTurn): Promise<void> {
    await this.enqueueLedger(state, async () => {
      await this.kernel.store.appendConversationEvent({
        id: randomUUID(),
        conversationId: state.conversationId,
        turnId: existing.id,
        type: "turn.failed",
        occurredAt: new Date().toISOString(),
        payload: { code: "recovery_required" },
      });
      await this.kernel.store.upsertConversationTurn({
        id: existing.id,
        conversationId: state.conversationId,
        status: "failed",
        traceId: existing.traceId ?? state.traceId,
      });
    });
    await this.flushState(state);
    state.terminalKind = "failed";
    state.terminalDelivered = true;
    this.emitSafeFailure(state, "recovery_required");
  }

  private async replayTerminalTurn(state: TurnLedgerState, record: ReplayRecord): Promise<void> {
    // Keep this defensive latch for callers that may replay a terminal record
    // from a future store barrier implementation directly.
    state.terminalKind = terminalKindForStatus(record.turn.status);
    const event = [...record.events]
      .filter((candidate) => candidate.turnId === record.turn.id)
      .reverse()
      .find((candidate) =>
        candidate.type === "turn.completed"
        || candidate.type === "turn.cancelled"
        || candidate.type === "turn.failed",
      );
    if (record.turn.status === "completed") {
      const replayed = sanitizeClientEvent(enrichEvent(runtimeEvent(
        "response.completed",
        state.command.requestId,
        state.traceId,
        {
          text: record.turn.assistantOutput ?? "",
          verified: event?.type === "turn.completed" && event.payload.verified === true,
          replayed: true,
        },
      ), state));
      if (replayed) state.emit(replayed);
      state.terminalDelivered = true;
      return;
    }
    if (record.turn.status === "cancelled") {
      const replayed = sanitizeClientEvent(enrichEvent(runtimeEvent(
        "turn.cancelled",
        state.command.requestId,
        state.traceId,
        { reason: event?.type === "turn.cancelled" ? event.payload.reason : "user_cancelled" },
      ), state));
      if (replayed) state.emit(replayed);
      state.terminalDelivered = true;
      return;
    }
    const replayed = sanitizeClientEvent(enrichEvent(runtimeEvent(
      "turn.failed",
      state.command.requestId,
      state.traceId,
      { code: event?.type === "turn.failed" ? event.payload.code : "runtime_operation_failed" },
    ), state));
    if (replayed) state.emit(replayed);
    state.terminalDelivered = true;
  }

  private emitSafeFailure(state: TurnLedgerState, code: string): void {
    state.emit(enrichEvent(runtimeEvent(
      "turn.failed",
      state.command.requestId,
      state.traceId,
      { code },
    ), state));
  }

  private async settleState(state: TurnLedgerState): Promise<void> {
    if (!state.durable) {
      if (state.pendingTerminal && !state.terminalDelivered) {
        state.emit(sanitizeClientEvent(state.pendingTerminal) ?? state.pendingTerminal);
        state.terminalDelivered = true;
      }
      return;
    }
    try {
      // Intermediate receipts must be durable before the terminal projection
      // is even queued.  This keeps a failed event write from being followed
      // by a visible success.
      await this.flushState(state);
      if (state.pendingTerminal && !state.terminalPersistence) {
        const terminal = sanitizeClientEvent(state.pendingTerminal) ?? state.pendingTerminal;
        state.terminalPersistence = this.enqueueLedger(state, async () => {
          if (state.terminalKind === "completed") {
            await this.persistCompleted(state, terminal);
          } else if (state.terminalKind === "cancelled") {
            await this.persistCancelled(state, terminal);
          } else {
            await this.persistFailed(state, terminal);
          }
        });
      }
      await state.terminalPersistence;
      await this.flushState(state);
    } catch {
      // A durable failure must never be represented as a successful visible
      // response.  Do not include provider/store error text in the event.
      if (!state.terminalDelivered) {
        state.emit(enrichEvent(runtimeEvent(
          "runtime.error",
          state.command.requestId,
          state.traceId,
          { code: "conversation_ledger_failed" },
        ), state));
        state.emit(enrichEvent(runtimeEvent(
          "turn.failed",
          state.command.requestId,
          state.traceId,
          { code: "conversation_ledger_failed" },
        ), state));
        state.terminalDelivered = true;
      }
      return;
    }
    if (state.pendingTerminal && !state.terminalDelivered) {
      state.emit(sanitizeClientEvent(state.pendingTerminal) ?? state.pendingTerminal);
      state.terminalDelivered = true;
    }
  }

  private async enqueueLedger(
    state: TurnLedgerState,
    operation: () => Promise<void>,
  ): Promise<void> {
    const run = this.ledgerTail.then(async () => {
      if (state.ledgerError !== undefined) return;
      await operation();
    });
    this.ledgerTail = run.then(
      () => undefined,
      (error) => {
        state.ledgerError ??= error;
      },
    );
    return run;
  }

  private async flushState(state: TurnLedgerState): Promise<void> {
    await this.flushLedger();
    if (state.ledgerError !== undefined) throw state.ledgerError;
  }

  private async flushLedger(): Promise<void> {
    await this.ledgerTail;
  }

  /**
   * Personal/project ordinary turns only. Never reads durable memory for
   * private ("不保存") sessions. Retrieval errors degrade to no memories.
   */
  private async recallForOrdinaryTurn(
    state: TurnLedgerState,
  ): Promise<RecalledMemory[]> {
    if (state.sessionScope.kind === "private") return [];
    const scope = memoryScopeForSession(state.sessionScope);
    if (scope === null) return [];
    try {
      return await recallRelevantMemories(
        this.kernel.store,
        state.command.payload.utterance,
        { scope },
      );
    } catch {
      return [];
    }
  }

  /**
   * Ordinary turns also recall a few learned Mind lessons, scoped by token
   * overlap with the utterance. Private ("不保存") sessions never read the
   * Mind document; retrieval errors degrade to no lessons, never a failure.
   */
  private async recallMindForOrdinaryTurn(
    state: TurnLedgerState,
  ): Promise<string[]> {
    if (state.sessionScope.kind === "private") return [];
    try {
      const mind = await this.kernel.store.getMind();
      return selectRelevantMindLessons(
        mind.markdown,
        state.command.payload.utterance,
      );
    } catch {
      return [];
    }
  }

  private emitMemoryUsed(
    state: TurnLedgerState,
    memories: readonly RecalledMemory[],
  ): void {
    if (memories.length === 0) return;
    // Flat, bounded payload only: IDs, short summaries, source, time, scope.
    const payload: Record<string, string | number | boolean | null> = {
      count: memories.length,
    };
    for (const [index, memory] of memories.entries()) {
      const n = index + 1;
      payload[`memoryId${n}`] = memory.id;
      payload[`summary${n}`] = memory.summary.slice(0, 80);
      payload[`source${n}`] = memory.source;
      payload[`capturedAt${n}`] = memory.capturedAt;
      payload[`scope${n}`] = memory.scope;
    }
    this.acceptRuntimeEvent(
      state,
      runtimeEvent(
        "memory.used",
        state.command.requestId,
        state.traceId,
        payload,
      ),
    );
  }
}

function toPromptMemorySnippet(memory: RecalledMemory): PromptMemorySnippet {
  return {
    id: memory.id,
    claim: memory.claim,
    source: memory.source,
    capturedAt: memory.capturedAt,
    scope: memory.scope,
  };
}

type ClientEventScalar = string | number | boolean | null;
type ClientEventPayload = Record<string, ClientEventScalar>;

const SAFE_PRODUCT_ACTIONS = new Set([
  "remember",
  "forget",
  "remember_how",
  "share_context",
  "record_learning",
  "run_skill",
  "finder_history_back",
]);

const SAFE_PRODUCT_STATUSES = new Set([
  "ok",
  "needs_approval",
  "denied",
  "failed",
  "cancelled",
  "cancelled_after_commit",
  "verified",
]);

const SAFE_RUNTIME_STATUSES = new Set([
  "active",
  "blocked",
  "cancelled",
  "completed",
  "done",
  "failed",
  "idle",
  "running",
  "steering_received",
  "trajectory_summary",
]);

const SAFE_FAILURE_CODES = new Set([
  "agent_core_turn_failed",
  "conversation_ledger_failed",
  "conversation_ledger_unavailable",
  "action_committed_after_cancel",
  "duplicate_request",
  "invalid_model_preference",
  "late_failure_after_cancel",
  "pi_turn_failed",
  "product_action_failed",
  "recovery_required",
  "request_reuse_conflict",
  "runtime_disposed",
  "runtime_operation_failed",
  "scripted_failure",
  "steer_failed",
  "task_truth_unavailable",
  "turn_ended_without_terminal",
  "turn_not_active",
]);

/**
 * Runtime events are a client boundary as well as a ledger boundary.  Keep
 * the fields that Clicky needs, but never forward arbitrary provider/tool
 * payloads, nested output objects, diagnostics, or hidden reasoning.
 */
function sanitizeClientEvent(event: RuntimeEvent): RuntimeEvent | undefined {
  const payload = asRecord(event.payload);
  switch (event.type) {
    case "turn.started":
      return withClientPayload(event, pickSafe(payload, [
        "runtime",
        "capabilityProfile",
        "provider",
        "model",
      ]));
    case "response.delta":
      return withClientPayload(event, safeVisibleTextPayload(payload.text));
    case "response.completed": {
      const safeText = safeVisibleTextPayload(payload.text);
      return withClientPayload(event, {
        ...safeText,
        verified: payload.verified === true,
        ...(payload.replayed === true ? { replayed: true } : {}),
      });
    }
    case "tool.started":
    case "tool.completed":
      return withClientPayload(event, pickSafe(payload, [
        "toolName",
        "runtime",
        "isError",
        "compatibilityMode",
      ]));
    case "computer.action.requested": {
      const safeAction = safeComputerActionPayload(payload);
      return safeAction ? withClientPayload(event, safeAction) : undefined;
    }
    case "runtime.status":
      return withClientPayload(event, safeRuntimeStatusPayload(payload));
    case "product.action.completed":
      return withClientPayload(event, safeProductActionPayload(payload));
    case "memory.used":
      return withClientPayload(event, safeMemoryUsedPayload(payload));
    case "turn.cancelled":
      return withClientPayload(event, {
        reason: safeCancellationReason(payload.reason),
      });
    case "turn.failed":
    case "runtime.error":
      return withClientPayload(event, {
        code: safeFailureCode(payload.code),
      });
    default:
      return undefined;
  }
}

/**
 * memory.used is a live product UI notice. Keep only controlled scalars:
 * count + up to 3 {memoryId, summary, source, capturedAt, scope} slots.
 * Never forward raw tool args, screenshots, or unbounded claim text.
 */
function safeMemoryUsedPayload(
  payload: Record<string, unknown>,
): ClientEventPayload {
  const countRaw = payload.count;
  const count =
    typeof countRaw === "number" && Number.isInteger(countRaw)
      ? Math.min(3, Math.max(0, countRaw))
      : 0;
  const result: ClientEventPayload = { count };
  for (let n = 1; n <= count; n += 1) {
    const memoryId = safeIdentifier(payload[`memoryId${n}`]);
    if (memoryId !== undefined) result[`memoryId${n}`] = memoryId;
    const summary = boundedVisibleString(payload[`summary${n}`], 80);
    if (summary !== undefined) result[`summary${n}`] = summary;
    const source = safeMemorySource(payload[`source${n}`]);
    if (source !== undefined) result[`source${n}`] = source;
    const capturedAt = safeIsoTimestamp(payload[`capturedAt${n}`]);
    if (capturedAt !== undefined) result[`capturedAt${n}`] = capturedAt;
    const scope = boundedVisibleString(payload[`scope${n}`], 80);
    if (scope !== undefined) result[`scope${n}`] = scope;
  }
  return result;
}

function safeMemorySource(value: unknown): string | undefined {
  if (
    value === "conversation"
    || value === "observation"
    || value === "user_correction"
    || value === "skill_verify"
    || value === "system"
  ) {
    return value;
  }
  return undefined;
}

function withClientPayload(
  event: RuntimeEvent,
  payload: ClientEventPayload,
): RuntimeEvent {
  return { ...event, payload };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeVisibleTextPayload(value: unknown): Record<string, string | boolean> {
  if (typeof value !== "string") return { text: "" };
  try {
    return eventText(value);
  } catch {
    return { text: "[omitted]" };
  }
}

function safeComputerActionPayload(payload: Record<string, unknown>): ClientEventPayload | undefined {
  const actionId = safeIdentifier(payload.actionId);
  const action = payload.action === "left_click" || payload.action === "finder_history_back"
    ? payload.action
    : undefined;
  if (actionId === undefined || action === undefined) {
    return undefined;
  }

  const result: ClientEventPayload = { actionId, action };
  if (action === "left_click") {
    const x = finiteNonNegative(payload.x);
    const y = finiteNonNegative(payload.y);
    if (x === undefined || y === undefined) return undefined;
    result.x = x;
    result.y = y;
  } else {
    if (payload.targetBundleId !== "com.apple.finder" || !Number.isInteger(payload.targetPid)) {
      return undefined;
    }
    result.targetBundleId = payload.targetBundleId;
    result.targetPid = payload.targetPid as number;
  }
  if (Number.isInteger(payload.screen) && (payload.screen as number) > 0) {
    result.screen = payload.screen as number;
  }
  const label = boundedVisibleString(payload.label, 120);
  if (label !== undefined) result.label = label;
  const effectClass = safeMetadata(payload.effectClass);
  if (effectClass !== undefined) result.effectClass = effectClass;
  for (const key of ["intentId", "attemptId", "basisFrameId"] as const) {
    const identifier = safeIdentifier(payload[key]);
    if (identifier !== undefined) result[key] = identifier;
  }
  return result;
}

function safeRuntimeStatusPayload(payload: Record<string, unknown>): ClientEventPayload {
  const result: ClientEventPayload = {
    status: safeRuntimeStatus(payload.status),
  };
  const stepCount = boundedCount(payload.stepCount);
  if (stepCount !== undefined) result.stepCount = stepCount;
  if (typeof payload.accepted === "boolean") result.accepted = payload.accepted;
  const trajectoryId = safeIdentifier(payload.trajectoryId);
  if (trajectoryId !== undefined) result.trajectoryId = trajectoryId;
  const trajectoryStatus = safeRuntimeStatus(payload.trajectoryStatus, "unknown");
  if (trajectoryStatus !== "unknown") result.trajectoryStatus = trajectoryStatus;
  if (Array.isArray(payload.toolsUsed)) {
    result.toolsUsedCount = Math.min(payload.toolsUsed.length, 1000);
  }
  return result;
}

function safeProductActionPayload(payload: Record<string, unknown>): ClientEventPayload {
  const actionName = safeMetadata(payload.actionName);
  const status = safeMetadata(payload.status);
  const result: ClientEventPayload = {
    actionName: actionName && SAFE_PRODUCT_ACTIONS.has(actionName) ? actionName : "unknown",
    status: status && SAFE_PRODUCT_STATUSES.has(status) ? status : "unknown",
  };
  const receiptId = safeIdentifier(payload.receiptId);
  if (receiptId !== undefined) result.receiptId = receiptId;
  const auditId = safeIdentifier(payload.auditId);
  if (auditId !== undefined) result.auditId = auditId;
  Object.assign(result, summarizeProductActionOutput(actionName, payload.output));
  return result;
}

function summarizeProductActionOutput(
  actionName: string | undefined,
  output: unknown,
): ClientEventPayload {
  const value = asRecord(output);
  if (actionName === "share_context") {
    const capsule = asRecord(value.capsule);
    const provenance = asRecord(capsule.provenance);
    const result: ClientEventPayload = {};
    const capsuleId = safeIdentifier(capsule.capsuleId);
    if (capsuleId !== undefined) result.capsuleId = capsuleId;
    const expiresAt = safeIsoTimestamp(capsule.expiresAt);
    if (expiresAt !== undefined) result.expiresAt = expiresAt;
    const trailEntryCount = boundedCount(provenance.trailEntryCount);
    if (trailEntryCount !== undefined) result.trailEntryCount = trailEntryCount;
    return result;
  }
  if (actionName === "remember") {
    const memoryId = safeIdentifier(value.id);
    return memoryId === undefined ? {} : { memoryId };
  }
  if (actionName === "remember_how") {
    const candidate = asRecord(value.candidate);
    const skill = asRecord(value.skill);
    const result: ClientEventPayload = {};
    const candidateId = safeIdentifier(candidate.id);
    if (candidateId !== undefined) result.candidateId = candidateId;
    const skillId = safeIdentifier(skill.id);
    if (skillId !== undefined) result.skillId = skillId;
    const entryCount = boundedCount(value.entryCount);
    if (entryCount !== undefined) result.entryCount = entryCount;
    const report = asRecord(value.verifyReport);
    if (typeof report.verified === "boolean") result.verified = report.verified;
    const confidence = boundedConfidence(report.confidence);
    if (confidence !== undefined) result.confidence = confidence;
    return result;
  }
  if (actionName === "record_learning") {
    const learningId = safeIdentifier(value.id);
    return learningId === undefined ? {} : { learningId };
  }
  if (actionName === "run_skill") {
    const result: ClientEventPayload = {};
    const mode = safeMetadata(value.mode);
    if (mode === "skill" || mode === "capsule_fallback") result.mode = mode;
    const skillId = safeIdentifier(value.skillId);
    if (skillId !== undefined) result.skillId = skillId;
    if (typeof value.capsuleReady === "boolean") result.capsuleReady = value.capsuleReady;
    if (typeof value.revalidated === "boolean") result.revalidated = value.revalidated;
    const confidence = boundedConfidence(value.revalidateConfidence);
    if (confidence !== undefined) result.revalidateConfidence = confidence;
    return result;
  }
  if (actionName === "forget") {
    const retiredId = safeIdentifier(value.retiredId);
    return retiredId === undefined ? {} : { retiredId };
  }
  if (actionName === "finder_history_back") {
    const result: ClientEventPayload = {};
    if (typeof value.succeeded === "boolean") result.succeeded = value.succeeded;
    if (typeof value.verified === "boolean") result.verified = value.verified;
    const status = safeMetadata(value.status);
    if (status && ["delivered", "verified", "unverified", "blocked", "stale", "cancelled", "failed"].includes(status)) {
      result.computerStatus = status;
    }
    const code = safeMetadata(value.code);
    if (code && [
      "frontmost_mismatch",
      "target_stale",
      "ax_lookup_failed",
      "ax_press_failed",
      "ax_press_unverified",
      "verified_accessibility",
      "runtime_error",
    ].includes(code)) {
      result.code = code;
    }
    const method = safeMetadata(value.method);
    if (method && ["ax_press", "unknown"].includes(method)) result.method = method;
    return result;
  }
  return {};
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function boundedCount(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= 100_000
    ? value
    : undefined;
}

function boundedConfidence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function safeIdentifier(value: unknown): string | undefined {
  if (
    typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) return undefined;
  return value.toLowerCase();
}

function safeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}

function boundedVisibleString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const safe = safeVisibleTextPayload(value).text;
  if (typeof safe !== "string" || safe.length === 0) return undefined;
  return safe.slice(0, maxLength);
}

function safeRuntimeStatus(value: unknown, fallback = "unknown"): string {
  const status = safeMetadata(value);
  return status && SAFE_RUNTIME_STATUSES.has(status) ? status : fallback;
}

function safeCancellationReason(value: unknown): string {
  return safeMetadata(value) ?? "user_cancelled";
}

function safeFailureCode(value: unknown): string {
  const code = safeMetadata(value);
  return code && SAFE_FAILURE_CODES.has(code) ? code : "runtime_operation_failed";
}

function projectionFor(event: RuntimeEvent): {
  type: "turn.started" | "tool.started" | "tool.completed" | "action.requested" | "action.completed" | "task.updated";
  payload: Record<string, string | number | boolean | null>;
} | undefined {
  switch (event.type) {
    case "turn.started":
      return {
        type: "turn.started",
        payload: pickSafe(event.payload, ["runtime", "capabilityProfile", "provider", "model"]),
      };
    case "tool.started":
      return {
        type: "tool.started",
        payload: pickSafe(event.payload, ["toolName", "runtime", "compatibilityMode"]),
      };
    case "tool.completed":
      return {
        type: "tool.completed",
        payload: pickSafe(event.payload, ["toolName", "runtime", "isError", "compatibilityMode"]),
      };
    case "computer.action.requested":
      return {
        type: "action.requested",
        payload: pickSafe(event.payload, ["actionId", "effectClass"]),
      };
    case "product.action.completed":
      return {
        type: "action.completed",
        payload: pickSafe(event.payload, ["actionName", "status", "receiptId", "auditId"]),
      };
    case "runtime.status":
      return {
        type: "task.updated",
        payload: pickSafe(event.payload, ["status", "stepCount", "toolsUsed", "accepted"]),
      };
    default:
      return undefined;
  }
}

function pickSafe(
  payload: Record<string, unknown>,
  keys: readonly string[],
): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    const value = payload[key];
    if (
      value === null
      || typeof value === "string"
      || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value))
    ) {
      const text = typeof value === "string" ? safeMetadata(value) : value;
      if (text !== undefined) result[key] = text;
      else if (value === null || typeof value === "boolean" || typeof value === "number") result[key] = value;
    }
  }
  return result;
}

function enrichEvent(event: RuntimeEvent, state: TurnLedgerState): RuntimeEvent {
  return {
    ...event,
    requestId: state.command.requestId,
    traceId: state.traceId,
    conversationId: state.conversationId as ConversationId,
  };
}

function enrichFreeEvent(event: RuntimeEvent, conversationId: string): RuntimeEvent {
  return {
    ...event,
    conversationId: conversationId as ConversationId,
  };
}

function eventText(value: string): Record<string, string | boolean> {
  const text = sanitizeVisibleText(value, "conversation event text");
  const bounded = text.slice(0, 500);
  return bounded.length < text.length ? { text: bounded, truncated: true } : { text: bounded };
}

function ledgerText(value: string): string {
  return sanitizeVisibleText(value, "conversation visible text");
}

function safeMetadata(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let sanitized: string;
  try {
    sanitized = sanitizeVisibleText(value, "runtime metadata");
  } catch {
    return undefined;
  }
  if (sanitized.includes("[redacted]")) return "redacted";
  const compact = sanitized
    .replace(/[^a-zA-Z0-9._:-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 120);
  return compact.length > 0 ? compact : undefined;
}

export function contextFrameToTrailSource(frame: ContextFrame): TrailSourceFrame {
  return {
    frameId: frame.frameId,
    capturedAt: frame.capturedAt,
    expiresAt: frame.expiresAt,
    frontmostApplication: frame.frontmostApplication,
    activeWindow: frame.activeWindow,
    elementUnderCursor: frame.elementUnderCursor,
    cursor: frame.cursor,
    screenshots: frame.screenshots.map((s) => ({
      label: s.label,
      base64Data: s.base64Data,
      mediaType: s.mediaType,
      displayWidthPoints: s.displayWidthPoints,
      displayHeightPoints: s.displayHeightPoints,
      screenshotWidthPixels: s.screenshotWidthPixels,
      screenshotHeightPixels: s.screenshotHeightPixels,
    })),
    warnings: frame.warnings,
  };
}

function summarizeOutput(output: unknown): unknown {
  if (output == null) return null;
  if (typeof output !== "object") return output;
  const o = output as Record<string, unknown>;
  // Drop large capsule JSON from live event payloads; keep ids and counts.
  if ("capsule" in o && o.capsule && typeof o.capsule === "object") {
    const c = o.capsule as Record<string, unknown>;
    return {
      ...o,
      capsule: {
        capsuleId: c.capsuleId,
        expiresAt: c.expiresAt,
        schemaVersion: c.schemaVersion,
        provenance: c.provenance,
      },
      capsuleJson: undefined,
    };
  }
  if ("trailSummary" in o) {
    const { trailSummary: _drop, ...rest } = o;
    return rest;
  }
  return o;
}
