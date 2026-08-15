import { randomUUID } from "node:crypto";
import {
  createDefaultProductKernel,
  formatProductActionSpeech,
  memoryScopeForSession,
  normalizeSessionScope,
  sessionScopeKey,
  sessionScopesEqual,
  routeProductUtterance,
  recallRelevantMemories,
  sanitizeVisibleText,
  selectRelevantMindLessons,
  type CreateNoteExecutor,
  type CreateNoteRequest,
  type ScheduleTimeReminderExecutor,
  type FinderHistoryBackExecutor,
  type ConversationEvent,
  type ConversationTurn,
  type RecalledMemory,
  type TrailSourceFrame,
  type SessionScope,
  type TaskExecutionContract,
  type YishuKernel,
  createTaskExecutionContract,
} from "@yishu/kernel";
import type {
  ContextFrame,
  ConversationId,
  DelegatedTaskCancelCommand,
  HistoryDeleteCommand,
  HistoryListCommand,
  HistoryOpenCommand,
  MemoryForgetCommand,
  MemoryListCommand,
  RuntimeEvent,
  TrailObserveCommand,
  TurnCancelCommand,
  TurnInterruptCommand,
  TurnStartCommand,
  TurnSteerCommand,
} from "./protocol.js";
import { runtimeEvent } from "./protocol.js";
import type { AgentRuntime, RuntimeEventSink } from "./runtime-port.js";
import { ComputerActionError, type ComputerUsePort } from "./computer-use-port.js";
import type { YishuAuthService } from "./auth-service.js";
import { RuntimeTaskProgressTracker } from "./task-progress.js";
import { attachTaskExecutionContract } from "./task-contract.js";
import { trustedExternalReceiptFor } from "./trusted-task-receipt.js";
import { RuntimeSuggestionTracker } from "./suggestion-loop.js";
import {
  attachBehaviorRules,
  attachConversationHistory,
  attachDelegatedResults,
  attachRecentTrail,
  attachRecalledMemories,
  attachRecalledMind,
  type PromptBehaviorRule,
  type PromptConversationTurn,
  type PromptMemorySnippet,
  type PromptTrailObservation,
} from "./context-prompt.js";
import {
  DelegationCoordinator,
  isCurrentPageActionsNoteUtterance,
  type DelegatedResult,
  type DelegatedTaskPresenceUpdate,
  type CurrentPageNoteInput,
  type CurrentPageNoteResult,
} from "./delegation.js";
import { contextFrameToTrailSource } from "./trail-source.js";
import type {
  StatusBarToolState,
  TurnContextProviderFactory,
} from "./model-loop/index.js";

type TerminalKind = "completed" | "cancelled" | "failed";

function terminalKindForStatus(status: ConversationTurn["status"]): TerminalKind {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

const COMPUTER_EFFECT_INTENT = /(?:\b(?:click|press|open|close|type|enter|select|drag|scroll|send|delete|move|rename|create|save|execute)\b|点击|打开|关闭|输入|选择|拖动|滚动|发送|删除|移动|重命名|创建|保存|执行)/iu;
const CONVERSATION_HISTORY_MAX_TURNS = 10;
const CONVERSATION_HISTORY_TEXT_BYTES = 5_000;
const RECENT_TRAIL_WINDOW_MS = 2 * 60_000;
const RECENT_TRAIL_MAX_ENTRIES = 8;
const BEHAVIOR_RULE_MAX_ITEMS = 3;
const BEHAVIOR_RULE_MAX_CHARS = 1_200;
const RUNTIME_SHUTDOWN_TIMEOUT_MS = 2_000;
const CONTEXT_WATCH_OBSERVATION_MAX_AGE_MS = 30_000;
const CONTEXT_WATCH_CLOCK_SKEW_MS = 5_000;
const CONVERSATION_SUPERSEDE_TIMEOUT_MS = 2_000;
const INTERRUPT_STEER_TIMEOUT_MS = 35_000;

const GENERATION_EVENT_TYPES = new Set<RuntimeEvent["type"]>([
  "turn.started",
  "response.delta",
  "tool.started",
  "tool.completed",
  "computer.action.requested",
  "runtime.status",
  "response.completed",
  "turn.cancelled",
  "turn.failed",
  "runtime.error",
]);

async function settlesWithin(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([
      operation.then(() => true),
      timedOut,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function contractForOrdinaryTurn(command: TurnStartCommand): TaskExecutionContract {
  const objective = sanitizeVisibleText(command.payload.utterance, "task objective")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 160);
  const currentPageNote = isCurrentPageActionsNoteUtterance(command.payload.utterance);
  const externalEffect = COMPUTER_EFFECT_INTENT.test(command.payload.utterance) || currentPageNote;
  return createTaskExecutionContract({
    objective: objective || "完成本轮任务",
    successMode: externalEffect ? "external_effect" : "read_only_delivery",
    authority: currentPageNote ? "explicit_approval" : externalEffect ? "reversible" : "automatic",
    risk: externalEffect ? "medium" : "low",
    maxAttempts: 1,
  });
}

function trustedExternalVerification(
  event: RuntimeEvent,
): { source: "action_receipt"; verified: boolean } | undefined {
  if (event.type !== "response.completed") return undefined;
  const verified = trustedExternalReceiptFor(event);
  return verified === undefined ? undefined : { source: "action_receipt", verified };
}

type CurrentPageNoteSource = {
  sourceBundleId: string;
  sourcePid: number;
  sourceWindowNumber: number;
  sourceWindowTitle: string;
  sourceWindowBounds: { x: number; y: number; width: number; height: number };
};

function currentPageNoteScreenshot(
  frame: ContextFrame,
): ContextFrame["screenshots"][number] | null {
  const windowNumber = frame.activeWindow?.value.windowNumber;
  if (windowNumber === undefined || !Number.isInteger(windowNumber) || windowNumber <= 0) return null;
  const matching = frame.screenshots.filter(
    (screenshot) => screenshot.sourceWindowNumber === windowNumber,
  );
  return matching.length === 1 ? matching[0]! : null;
}

function currentPageNoteSource(frame: ContextFrame, now = new Date()): CurrentPageNoteSource | null {
  const app = frame.frontmostApplication?.value;
  const window = frame.activeWindow?.value;
  const bundleId = app?.bundleIdentifier?.trim();
  const title = window?.title?.trim();
  const bounds = window?.bounds;
  const windowNumber = window?.windowNumber;
  const frameCapturedAt = Date.parse(frame.capturedAt);
  const frameExpiresAt = Date.parse(frame.expiresAt);
  const appCapturedAt = Date.parse(frame.frontmostApplication?.capturedAt ?? "");
  const windowCapturedAt = Date.parse(frame.activeWindow?.capturedAt ?? "");
  const nowMs = now.getTime();
  if (
    !Number.isFinite(frameCapturedAt) || !Number.isFinite(frameExpiresAt)
    || !Number.isFinite(appCapturedAt) || !Number.isFinite(windowCapturedAt)
    || frameCapturedAt > nowMs || nowMs >= frameExpiresAt
    || appCapturedAt > nowMs || windowCapturedAt > nowMs
    || nowMs - appCapturedAt > 60_000 || nowMs - windowCapturedAt > 60_000
    || (frame.frontmostApplication?.confidence ?? 0) < 0.8
    || (frame.activeWindow?.confidence ?? 0) < 0.8
  ) return null;
  if (currentPageNoteScreenshot(frame) === null) return null;
  if (windowNumber === undefined || !Number.isInteger(windowNumber) || windowNumber <= 0) return null;
  if (
    !bundleId
    || !app || app.processIdentifier <= 0
    || !window || window.processIdentifier !== app.processIdentifier
    || !title || title.length > 240
    || !bounds
    || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)
    || !Number.isFinite(bounds.width) || bounds.width <= 0
    || !Number.isFinite(bounds.height) || bounds.height <= 0
  ) return null;
  return {
    sourceBundleId: bundleId,
    sourcePid: app.processIdentifier,
    sourceWindowNumber: windowNumber,
    sourceWindowTitle: title,
    sourceWindowBounds: { ...bounds },
  };
}

function pageNoteCommandForInner(command: TurnStartCommand): TurnStartCommand {
  if (!isCurrentPageActionsNoteUtterance(command.payload.utterance)) return command;
  const screenshot = currentPageNoteScreenshot(command.payload.contextFrame);
  return {
    ...command,
    payload: {
      ...command.payload,
      contextFrame: {
        ...command.payload.contextFrame,
        screenshots: screenshot === null ? [] : [screenshot],
      },
    },
  };
}

function isSourceBoundCreateNoteRequest(request: CreateNoteRequest): request is CreateNoteRequest & CurrentPageNoteSource {
  const candidate = request as Partial<CurrentPageNoteSource>;
  return typeof candidate.sourceBundleId === "string"
    && typeof candidate.sourcePid === "number"
    && typeof candidate.sourceWindowNumber === "number"
    && typeof candidate.sourceWindowTitle === "string"
    && candidate.sourceWindowBounds !== undefined;
}

function currentPageNoteCompletionText(result: CurrentPageNoteResult | undefined): string {
  if (result === undefined) return "这次没有创建备忘录。";
  if (result.verified) return "已经整理成一条备忘录，并确认写入。";
  if (result.succeeded || result.status === "unverified") return "可能已经创建，但还不能确认；我不会重复。";
  if (result.code === "target_stale") return "页面已变化，这次没有创建备忘录。";
  return "这次没有创建备忘录。";
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
  currentPageNoteAttempted?: boolean;
  currentPageNoteResult?: CurrentPageNoteResult;
  currentPageNoteReceiptInFlight?: boolean;
  currentPageNoteDispatched?: boolean;
  currentPageNoteCancelRequested?: boolean;
  currentPageNoteReceiptSettled?: Promise<void>;
  currentPageNoteReceiptSettle?: () => void;
  readonly interruptEligible: boolean;
  generation: number;
  effectsStarted: boolean;
  effectsBlocked: boolean;
  interruptPending: boolean;
  interruptedGeneration?: number;
  awaitingSteerGeneration?: number;
  steerSubmitted: boolean;
  interruptTimeout?: ReturnType<typeof setTimeout>;
  supersedeRequested: boolean;
  preparePromise?: Promise<unknown>;
  innerStarted: boolean;
  terminalKind?: TerminalKind;
  pendingTerminal?: RuntimeEvent;
  terminalPersistence?: Promise<void>;
  terminalDelivered: boolean;
  ledgerError?: unknown;
  contract?: TaskExecutionContract;
}

interface ReplayRecord {
  readonly turn: ConversationTurn;
  readonly events: ConversationEvent[];
}

/**
 * Product layer wrapper around the Pi AgentRuntime or its protocol test double.
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
  private readonly pendingStartTraceByRequestId = new Map<string, string>();
  private readonly cancelledPendingRequestIds = new Set<string>();
  private readonly activeTurns = new Map<string, TurnLedgerState>();
  private readonly activeTurnOperations = new Set<Promise<void>>();
  private readonly conversationAdmissionTails = new Map<string, Promise<void>>();
  private trailObservationTail: Promise<void> = Promise.resolve();
  /** Runtime side of delegated execution; public like `kernel` for tests/UI seams. */
  readonly delegation: DelegationCoordinator;
  private ledgerTail: Promise<void> = Promise.resolve();
  private readonly recoveryReady: Promise<void>;
  private activeTrailScopeKey: string | undefined;
  private taskPresenceSink: ((update: DelegatedTaskPresenceUpdate) => void) | undefined;
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
    // Runtime side of delegated execution (RFC v2 / ADR 0009): child turns run
    // directly on the inner harness with their own conversation identity; the
    // kernel keeps the only task-status truth.
    this.delegation = new DelegationCoordinator({
      kernel,
      executeTurn: (command, emit) => this.inner.startTurn(command, emit),
      cancelTurn: (command, emit) => this.inner.cancelTurn(command, emit),
      ...("releaseConversationSession" in this.inner
        && typeof (this.inner as { releaseConversationSession?: unknown }).releaseConversationSession === "function"
        ? {
            releaseConversationSession: (conversationId: string) => {
              (this.inner as unknown as { releaseConversationSession(id: string): void })
                .releaseConversationSession(conversationId);
            },
          }
        : {}),
    });
    this.recoveryReady = this.recoverDurableDelegationState();
    // Additive seam: PiRuntimeAdapter asks this coordinator for the session
    // tool policy at the createSession boundary (Main keeps computer_control
    // and gets delegate; delegated children get neither). Other AgentRuntime
    // implementations simply lack the method. The policy stays structurally
    // typed so Pi-specific tool types never leak into this product wrapper.
    (
      this.inner as {
        setSessionToolPolicy?: (
          policy: (conversationId: string) => { computerControl: boolean; extraTools: unknown[] },
        ) => void;
      }
    ).setSessionToolPolicy?.((conversationId) => this.delegation.sessionToolPolicyFor(conversationId));
    // ADR 0015 B architecture: the product layer owns turn-context data, the
    // engine owns assembly timing. Skills L1 comes from the kernel's
    // verified-skill registry (empty for private scopes); the status bar v1
    // renders engine-observable facts only. Turn-memory recall stays on the
    // PKR prompt path until the read-side PR moves it into assembleTurnMemory.
    (
      this.inner as {
        setTurnContextProviderFactory?: (factory: TurnContextProviderFactory) => void;
      }
    ).setTurnContextProviderFactory?.((scopeKind) => ({
      skillCatalog: async () => {
        if (scopeKind === "private") return [];
        try {
          const skills = await this.kernel.store.listVerifiedSkills();
          return skills.map((skill) => ({
            name: skill.name,
            description: verifiedSkillL1Description(skill),
          }));
        } catch {
          return [];
        }
      },
      statusBar: async (state) => formatEngineStatusBar(state),
    }));
  }

  /** Wait for the constructor-started durable recovery without changing it. */
  async initialize(): Promise<void> {
    await this.recoveryReady;
  }

  /** One projection sink shared by delegated work and product-owned reminders. */
  setTaskPresenceSink(
    sink?: (update: DelegatedTaskPresenceUpdate) => void,
  ): void {
    this.taskPresenceSink = sink;
    this.delegation.setPresenceSink(sink);
  }

  async observeTrail(command: TrailObserveCommand, emit: RuntimeEventSink): Promise<void> {
    const operation = this.trailObservationTail.then(() =>
      this.observeTrailSerial(command, emit));
    this.trailObservationTail = operation.catch(() => undefined);
    return operation;
  }

  private async observeTrailSerial(
    command: TrailObserveCommand,
    emit: RuntimeEventSink,
  ): Promise<void> {
    const sessionScope = normalizeSessionScope(command.payload.sessionScope);
    this.activateTrailScope(sessionScope);
    if (sessionScope.kind === "private") {
      emit(runtimeEvent("trail.skipped", command.requestId, command.traceId, {
        reason: "private_session",
      }));
      return;
    }
    const entry = this.kernel.trail.append(
      contextFrameToTrailSource(command.payload.contextFrame),
      sessionScope,
    );
    emit(
      runtimeEvent("trail.appended", command.requestId, command.traceId, {
        frameId: entry.frameId,
        trailSize: this.kernel.trail.size(sessionScope),
        appName: entry.appName,
        windowTitle: entry.windowTitle,
      }),
    );

    // The trail remains an in-memory observation surface. Initiative evaluation
    // additionally requires a fresh foreground identity so stale/null samples
    // can never arm or fire a durable watch.
    const observedBundleId = freshObservedBundleId(command.payload.contextFrame);
    if (observedBundleId === null) return;

    await this.recoveryReady;
    const watches = await this.kernel.store.listActiveContextWatches(sessionScope);
    for (const watch of watches) {
      if (watch.state === "waiting_for_departure") {
        if (observedBundleId === watch.targetBundleId) continue;
        const armed = await this.kernel.store.transitionContextWatch({
          id: watch.id,
          sessionScope,
          expectedState: "waiting_for_departure",
          nextState: "armed",
          occurredAt: command.payload.contextFrame.capturedAt,
          observationFrameId: command.payload.contextFrame.frameId,
        });
        if (armed !== null) {
          const task = (await this.kernel.store.listTasks({ sessionScope }))
            .find((candidate) => candidate.id === armed.taskId);
          this.emitTaskPresence({
            taskId: armed.taskId,
            parentId: armed.mandateId,
            mainConversationId: armed.mainConversationId,
            taskKind: "context_reminder",
            watchState: "armed",
            title: task?.title ?? `提醒：${armed.reminder}`,
            status: "running",
            createdAt: armed.createdAt,
            updatedAt: armed.armedAt ?? command.payload.contextFrame.capturedAt,
          });
        }
        continue;
      }
      if (observedBundleId !== watch.targetBundleId) continue;
      const fired = await this.kernel.store.transitionContextWatch({
        id: watch.id,
        sessionScope,
        expectedState: "armed",
        nextState: "fired",
        occurredAt: command.payload.contextFrame.capturedAt,
        observationFrameId: command.payload.contextFrame.frameId,
      });
      if (fired === null) continue;

      // The store CAS has already committed watch + TaskTruth + ResultInbox.
      // Presence is intentionally emitted only afterwards and only by the CAS
      // winner, so repeated/concurrent samples cannot announce twice.
      this.emitTaskPresence({
        taskId: fired.taskId,
        parentId: fired.mandateId,
        mainConversationId: fired.mainConversationId,
        taskKind: "context_reminder",
        watchState: "fired",
        title: `提醒：${fired.reminder}`,
        status: "done",
        createdAt: fired.createdAt,
        updatedAt: fired.firedAt ?? command.payload.contextFrame.capturedAt,
        resultKind: "completed",
        summary: `提醒：${fired.reminder}`,
        sequence: [],
      });
    }
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
    const conversationId = command.payload.conversationId ?? command.requestId;
    const pendingTrace = this.pendingStartTraceByRequestId.get(command.requestId);
    if (pendingTrace !== undefined) {
      if (pendingTrace === command.traceId) return;
      emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
        code: "duplicate_request",
        message: "A turn with this request id is already awaiting admission.",
      }, conversationId));
      return;
    }
    this.pendingStartTraceByRequestId.set(command.requestId, command.traceId);
    let releaseAdmission: (() => void) | undefined;
    let state: TurnLedgerState | undefined;
    let operation: Promise<void> | undefined;
    try {
      releaseAdmission = await this.acquireConversationAdmission(conversationId);
      if (this.disposed) {
        emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
          code: "runtime_disposed",
          message: "ProductKernelRuntime has been disposed.",
        }, conversationId));
        return;
      }
      if (this.activeRequestIds.has(command.requestId)) {
        const existing = this.activeTurns.get(command.requestId);
        if (existing?.traceId === command.traceId) return;
        emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
          code: "duplicate_request",
          message: "A turn with this request id is already active.",
        }, existing?.conversationId ?? conversationId));
        return;
      }

      const sessionScope = normalizeSessionScope(command.payload.sessionScope);
      const cancelledBeforeAdmission = this.cancelledPendingRequestIds.has(command.requestId);
      const previous = cancelledBeforeAdmission
        ? undefined
        : [...this.activeTurns.values()].find((candidate) =>
            candidate.conversationId.toLowerCase() === conversationId.toLowerCase()
            && !candidate.terminalKind
            && sessionScopesEqual(candidate.sessionScope, sessionScope));
      if (previous !== undefined) {
        // Last explicit turn wins inside one Main conversation. Latch a gate on
        // the old producer first, evict its cached Pi conversation immediately,
        // then grant bounded cleanup time before the replacement is admitted.
        previous.supersedeRequested = true;
        this.releaseInnerConversationSession(previous.conversationId);
        await settlesWithin(this.cancelTurn({
          schemaVersion: command.schemaVersion,
          type: "turn.cancel",
          requestId: previous.command.requestId,
          traceId: previous.traceId,
          sentAt: new Date().toISOString(),
          payload: { reason: "turn_superseded" },
        }, () => undefined), CONVERSATION_SUPERSEDE_TIMEOUT_MS);
      }

      this.activateTrailScope(sessionScope);
      state = {
        command,
        conversationId,
        traceId: command.traceId,
        emit,
        seenEventIds: new Set<string>(),
        sessionScope,
        durable: sessionScope.kind !== "private",
        productActionCancelRequested: false,
        interruptEligible:
          command.payload.capabilityProfile === "conversation"
          && contractForOrdinaryTurn(command).successMode === "read_only_delivery"
          && routeProductUtterance(command.payload.utterance, command.payload.contextFrame) === null,
        generation: 1,
        effectsStarted: false,
        effectsBlocked: false,
        interruptPending: false,
        steerSubmitted: false,
        supersedeRequested: false,
        innerStarted: false,
        terminalDelivered: false,
        contract: contractForOrdinaryTurn(command),
      };
      this.activeRequestIds.add(command.requestId);
      this.activeTurns.set(command.requestId, state);
      operation = cancelledBeforeAdmission
        ? this.runCancelledPendingStart(state)
        : this.runTurn(state);
      this.activeTurnOperations.add(operation);
    } finally {
      this.pendingStartTraceByRequestId.delete(command.requestId);
      this.cancelledPendingRequestIds.delete(command.requestId);
      releaseAdmission?.();
    }

    if (state === undefined || operation === undefined) return;
    try {
      await operation;
    } finally {
      this.activeTurnOperations.delete(operation);
      this.activeRequestIds.delete(command.requestId);
      this.activeTurns.delete(command.requestId);
    }
  }

  private async runCancelledPendingStart(state: TurnLedgerState): Promise<void> {
    if (state.durable) {
      try {
        await this.recoveryReady;
        const preparation = this.prepareTurn(state);
        state.preparePromise = preparation;
        const replay = await preparation;
        if (replay !== "new") return;
      } catch {
        this.emitSafeFailure(state, "conversation_ledger_unavailable");
        return;
      }
    }
    this.acceptRuntimeEvent(state, runtimeEvent(
      "turn.cancelled",
      state.command.requestId,
      state.traceId,
      { reason: "cancelled_before_admission", generation: state.generation },
    ));
    await this.settleState(state);
  }

  private async runTurn(state: TurnLedgerState): Promise<void> {
    const { command } = state;

    if (state.durable) {
      try {
        await this.recoveryReady;
        await this.reconcileClaimedDeliveries(false);
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

    if (state.terminalKind) {
      await this.settleState(state);
      return;
    }
    if (state.supersedeRequested) {
      this.acceptRuntimeEvent(
        state,
        runtimeEvent("turn.cancelled", command.requestId, state.traceId, {
          reason: "turn_superseded",
        }),
      );
      await this.settleState(state);
      return;
    }

    // Live frame enters the product trail once the durable turn gate is open.
    if (state.sessionScope.kind !== "private") {
      this.kernel.trail.append(
        contextFrameToTrailSource(command.payload.contextFrame),
        state.sessionScope,
      );
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
    const scopedRoute = {
      ...route,
      input: route.action === "watch_app_return"
        ? { ...route.input, mainConversationId: state.conversationId }
        : memoryScope !== null
          && (route.action === "remember" || route.action === "record_learning")
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
      ? new RuntimeTaskProgressTracker(this.kernel.taskTruth, state.command, state.contract)
      : undefined;
    if (tracker) this.taskTrackers.set(state.command.requestId, tracker);
    const suggestionTracker = state.durable
      ? new RuntimeSuggestionTracker(this.kernel, state.command)
      : undefined;
    if (suggestionTracker) {
      this.suggestionTrackers.set(state.command.requestId, suggestionTracker);
    }
    // Register the active Main turn (with its frame and model preference) so
    // the delegate tool can build the handoff capsule and link child
    // parentage while this turn runs on the harness.
    this.delegation.noteMainTurn(state.conversationId, {
      requestId: state.command.requestId,
      sessionScope: state.sessionScope,
      contextFrame: state.command.payload.contextFrame,
      ...(this.canSaveCurrentPageActionsToNote(state)
        ? {
            saveCurrentPageActionsToNote: (input, signal) =>
              this.saveCurrentPageActionsToNote(state, input, signal),
          }
        : {}),
      ...(state.command.payload.modelPreference !== undefined
        ? { modelPreference: state.command.payload.modelPreference }
        : {}),
    });

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
      const conversationHistory = await this.conversationHistoryForOrdinaryTurn(state);
      if (state.terminalKind) {
        await this.settleState(state);
        return;
      }
      const behaviorRules = await this.behaviorRulesForOrdinaryTurn(state);
      if (state.terminalKind) {
        await this.settleState(state);
        return;
      }
      const recentTrail = this.recentTrailForOrdinaryTurn(state);
      // Delegated child results re-enter the Main conversation here: one-shot,
      // payload-only, and never into private sessions.
      const delegatedResults = await this.delegatedResultsForOrdinaryTurn(state);
      let commandForInner: TurnStartCommand = pageNoteCommandForInner(state.command);
      commandForInner = attachConversationHistory(commandForInner, conversationHistory);
      commandForInner = attachRecalledMemories(
        commandForInner,
        recalled.map(toPromptMemorySnippet),
      );
      commandForInner = attachBehaviorRules(commandForInner, behaviorRules);
      commandForInner = attachRecalledMind(commandForInner, mindLessons);
      commandForInner = attachDelegatedResults(commandForInner, delegatedResults);
      commandForInner = attachRecentTrail(commandForInner, recentTrail);
      commandForInner = attachTaskExecutionContract(commandForInner, state.contract!);
      // Mark started before the last terminal check so a concurrent cancelTurn
      // will invoke inner.cancelTurn and unblock a gated startTurn.
      state.innerStarted = true;
      if (state.terminalKind) {
        await this.settleState(state);
        return;
      }

      try {
        const admission = tracker?.requestAttempt({
          proposedAuthority: state.contract?.authority ?? "automatic",
          proposedRisk: state.contract?.risk ?? "low",
        });
        if (admission?.decision === "escalate") {
          this.acceptRuntimeEvent(state, runtimeEvent(
            "turn.failed",
            state.command.requestId,
            state.traceId,
            { code: "task_attempt_escalation_required", reason: admission.reason },
          ));
          await this.settleState(state);
          return;
        }
        await this.inner.startTurn(commandForInner, (event) => {
          if (this.acceptRuntimeEvent(state, event)) {
            tracker?.observe(event, trustedExternalVerification(event));
            suggestionTracker?.observe(event);
          }
        });
      } catch {
        tracker?.recordRuntimeFailure("start");
        if (!state.terminalKind) {
          this.acceptRuntimeEvent(
            state,
            runtimeEvent("turn.failed", state.command.requestId, state.traceId, {
              code: "runtime_operation_failed",
              generation: state.generation,
            }),
          );
        }
      }
    } finally {
      this.delegation.clearMainTurn(state.conversationId, state.command.requestId);
      try {
        await tracker?.flush();
      } catch {
        if (!state.terminalKind) {
          this.acceptRuntimeEvent(
            state,
            runtimeEvent("turn.failed", state.command.requestId, state.traceId, {
              code: "task_truth_unavailable",
              generation: state.generation,
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
          generation: state.generation,
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
      || route.action === "create_note"
      || route.action === "schedule_time_reminder"
      ? {
          ...route,
          input: {
            ...route.input,
            ...(route.action === "schedule_time_reminder" ? { reminderId: randomUUID() } : {}),
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
        : actionRoute.action === "create_note"
          ? { createNote: this.createNoteExecutor(state) }
          : actionRoute.action === "schedule_time_reminder"
            ? { scheduleTimeReminder: this.scheduleTimeReminderExecutor(state) }
          : undefined;
      receipt = await this.kernel.registry.invoke(actionRoute.action, {
        caller: "voice",
        input: actionRoute.input,
        contextFrame: command.payload.contextFrame,
        sessionScope: state.sessionScope,
        signal: productActionAbortController.signal,
        ...(actionRoute.action === "create_note" || actionRoute.action === "schedule_time_reminder"
          ? { approved: true }
          : {}),
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

      if (
        actionRoute.action === "remember_how"
        && (receipt.output as { skill?: unknown } | undefined)?.skill
      ) {
        (this.inner as { invalidateSkillSessions?: () => void })
          .invalidateSkillSessions?.();
      }

      if (
        actionRoute.action === "watch_app_return"
        && (receipt.status === "ok" || receipt.status === "verified")
      ) {
        this.emitCreatedContextWatchPresence(receipt.output);
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

  /** Create exactly one note, then require the macOS side to read it back. */
  private createNoteExecutor(state: TurnLedgerState): CreateNoteExecutor {
    return {
      perform: async (request, signal) => {
        if (!this.computerUsePort) {
          return {
            succeeded: false,
            verified: false,
            status: "failed",
            code: "runtime_error",
            method: "unknown",
            message: "The macOS Notes bridge is unavailable.",
          };
        }
        let endPageNoteReconciliation: (() => void) | undefined;
        try {
          return await this.computerUsePort.perform({
            action: "create_note",
            x: 0,
            y: 0,
            content: request.content,
            title: request.title,
            targetBundleId: "com.apple.Notes",
            ...(isSourceBoundCreateNoteRequest(request)
              ? {
                  sourceBundleId: request.sourceBundleId,
                  sourcePid: request.sourcePid,
                  sourceWindowNumber: request.sourceWindowNumber,
                  sourceWindowTitle: request.sourceWindowTitle,
                  sourceWindowBounds: request.sourceWindowBounds,
                }
              : {}),
          }, {
            requestId: state.command.requestId,
            traceId: state.traceId,
            intentId: request.intentId,
            attemptId: request.attemptId,
            basisFrameId: request.basisFrameId,
            effectClass: "write",
            ...(isSourceBoundCreateNoteRequest(request)
              ? {
                  onDispatched: () => {
                    state.currentPageNoteDispatched = true;
                    if (state.currentPageNoteReceiptSettled === undefined) {
                      state.currentPageNoteReceiptSettled = new Promise<void>((resolve) => {
                        state.currentPageNoteReceiptSettle = resolve;
                      });
                    }
                    endPageNoteReconciliation = this.beginPageNoteReceiptReconciliation(
                      state.command.requestId,
                    );
                  },
                }
              : {}),
          });
        } catch (error) {
          if (error instanceof ComputerActionError && error.code === "timeout") {
            return {
              succeeded: true,
              verified: false,
              status: "unverified",
              code: "timeout",
              method: "unknown",
              attemptId: request.attemptId,
              message: "Note creation may have been submitted, but its result is unknown.",
            };
          }
          throw error;
        } finally {
          endPageNoteReconciliation?.();
        }
      },
    };
  }

  /**
   * Only the Pi adapter knows how to keep its shared port receipt alive while
   * cancelling model work. Other inner runtimes simply do not expose this
   * optional, request-scoped reconciliation fence.
   */
  private beginPageNoteReceiptReconciliation(requestId: string): (() => void) | undefined {
    const inner = this.inner as {
      beginPageNoteReceiptReconciliation?: (id: string) => () => void;
    };
    return inner.beginPageNoteReceiptReconciliation?.(requestId);
  }

  private canSaveCurrentPageActionsToNote(state: TurnLedgerState): boolean {
    if (state.sessionScope.kind === "private") return false;
    if (!isCurrentPageActionsNoteUtterance(state.command.payload.utterance)) return false;
    return currentPageNoteSource(state.command.payload.contextFrame) !== null;
  }

  /**
   * The model may supply only the small, visible outline.  Source identity is
   * reconstructed solely from the frame that authorized this still-live turn.
   */
  private async saveCurrentPageActionsToNote(
    state: TurnLedgerState,
    input: CurrentPageNoteInput,
    signal?: AbortSignal,
  ): Promise<CurrentPageNoteResult> {
    const source = currentPageNoteSource(state.command.payload.contextFrame);
    if (!source || state.terminalKind || state.supersedeRequested || state.sessionScope.kind === "private") {
      return this.settleCurrentPageNote(state, { dispatched: false, succeeded: false, verified: false, status: "blocked", code: "target_stale" });
    }
    // Consume the single product attempt before any await.  Pi may issue a
    // second sequential tool call after an unknown or failed receipt; a Notes
    // write must never be retried or duplicated within this turn.
    if (state.currentPageNoteAttempted) {
      return { dispatched: false, succeeded: false, verified: false, status: "blocked", code: "runtime_error" };
    }
    state.currentPageNoteAttempted = true;
    state.currentPageNoteReceiptInFlight = true;
    const content = input.items.map((item, index) => `${index + 1}. ${item}`).join("\n");
    const intentId = randomUUID();
    const attemptId = randomUUID();
    try {
      const receipt = await this.kernel.registry.invoke("create_note", {
        caller: "voice",
        input: {
          title: input.title,
          content,
          targetBundleId: "com.apple.Notes",
          intentId,
          attemptId,
          basisFrameId: state.command.payload.contextFrame.frameId,
          ...source,
        },
        contextFrame: state.command.payload.contextFrame,
        sessionScope: state.sessionScope,
        approved: true,
      }, { createNote: this.createNoteExecutor(state) });
      const output = receipt.output as {
        succeeded?: boolean;
        verified?: boolean;
        status?: CurrentPageNoteResult["status"];
        code?: string;
      } | undefined;
      const result = this.settleCurrentPageNote(state, {
        dispatched: true,
        succeeded: output?.succeeded === true,
        verified: output?.verified === true,
        status: output?.status ?? "failed",
        ...(output?.code === undefined ? {} : { code: output.code }),
      });
      await this.reconcileCancelledPageNote(state, receipt, result);
      return result;
    } catch (error) {
      if (error instanceof ComputerActionError && error.code === "timeout") {
        const result = this.settleCurrentPageNote(state, { dispatched: true, succeeded: true, verified: false, status: "unverified", code: "timeout" });
        await this.reconcileCancelledPageNote(state, undefined, result);
        return result;
      }
      const result = this.settleCurrentPageNote(state, {
        dispatched: state.currentPageNoteDispatched === true,
        succeeded: false,
        verified: false,
        status: signal?.aborted ? "cancelled" : "failed",
        code: signal?.aborted ? "cancelled" : "runtime_error",
      });
      await this.reconcileCancelledPageNote(state, undefined, result);
      return result;
    } finally {
      state.currentPageNoteReceiptInFlight = false;
      state.currentPageNoteReceiptSettle?.();
      delete state.currentPageNoteReceiptSettle;
    }
  }

  private async reconcileCancelledPageNote(
    state: TurnLedgerState,
    receipt: Awaited<ReturnType<YishuKernel["registry"]["invoke"]>> | undefined,
    result: CurrentPageNoteResult,
  ): Promise<void> {
    if (!state.currentPageNoteCancelRequested || state.terminalKind) return;
    // The port receipt is now final. Permit the two content-free durable
    // events below through the cancellation gate before this tool returns.
    state.currentPageNoteReceiptInFlight = false;
    if (receipt !== undefined) this.emitProductActionCompleted(state, receipt);
    else this.emitCurrentPageNoteOutcome(state, result);
    this.acceptRuntimeEvent(
      state,
      runtimeEvent("turn.failed", state.command.requestId, state.traceId, {
        code: result.verified ? "action_committed_after_cancel"
          : state.currentPageNoteDispatched ? "action_outcome_unknown"
            : "product_action_failed",
      }),
    );
    await this.settleState(state);
  }

  private emitCurrentPageNoteOutcome(state: TurnLedgerState, result: CurrentPageNoteResult): void {
    this.acceptRuntimeEvent(
      state,
      runtimeEvent("product.action.completed", state.command.requestId, state.traceId, {
        actionName: "create_note",
        status: result.verified ? "verified" : "failed",
        output: {
          succeeded: result.succeeded,
          verified: result.verified,
          status: result.status,
          ...(result.code === undefined ? {} : { code: result.code }),
        },
        receiptId: randomUUID(),
        auditId: randomUUID(),
      }),
    );
  }

  private settleCurrentPageNote(
    state: TurnLedgerState,
    result: CurrentPageNoteResult,
  ): CurrentPageNoteResult {
    if (state.currentPageNoteResult === undefined) state.currentPageNoteResult = result;
    return state.currentPageNoteResult;
  }

  /** Schedule once through macOS, then require pending-notification read-back. */
  private scheduleTimeReminderExecutor(state: TurnLedgerState): ScheduleTimeReminderExecutor {
    return {
      perform: async (request, signal) => {
        if (!this.computerUsePort) {
          return { succeeded: false, verified: false, status: "failed", code: "runtime_error", method: "unknown", message: "The reminder bridge is unavailable." };
        }
        try {
          return await this.computerUsePort.perform({
            action: "schedule_reminder",
            x: 0,
            y: 0,
            reminderId: request.reminderId,
            delaySeconds: request.delaySeconds,
            body: request.body,
          }, {
            requestId: state.command.requestId,
            traceId: state.traceId,
            intentId: request.intentId,
            attemptId: request.attemptId,
            basisFrameId: request.basisFrameId,
            effectClass: "schedule",
          });
        } catch (error) {
          if (error instanceof ComputerActionError) {
            if (error.code === "timeout") {
              return {
                succeeded: true,
                verified: false,
                status: "unverified",
                code: "timeout",
                method: "unknown",
                attemptId: request.attemptId,
                message: "The reminder may have been submitted, but its result is unknown.",
              };
            }
            return {
              succeeded: false,
              verified: false,
              status: "failed",
              code: error.code,
              method: error.method,
              attemptId: request.attemptId,
              message: "The reminder was not confirmed as scheduled.",
            };
          }
          throw error;
        }
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

  async interruptTurn(command: TurnInterruptCommand, emit: RuntimeEventSink): Promise<void> {
    const state = this.activeTurns.get(command.requestId);
    const reject = (generation: number, code: string): void => {
      emit(runtimeEvent(
        "turn.interrupt.rejected",
        command.requestId,
        command.traceId,
        { generation, code },
        state?.conversationId as ConversationId | undefined,
      ));
    };

    if (!state) {
      reject(command.payload.expectedGeneration, "turn_not_active");
      return;
    }
    if (command.traceId !== state.traceId) {
      reject(state.generation, "trace_mismatch");
      return;
    }
    if (state.terminalKind) {
      reject(state.generation, "turn_terminal");
      return;
    }
    if (command.payload.expectedGeneration !== state.generation) {
      reject(state.generation, "stale_generation");
      return;
    }
    if (!state.interruptEligible) {
      reject(state.generation, "ineligible_turn");
      return;
    }
    if (state.effectsStarted) {
      reject(state.generation, "effect_started");
      return;
    }
    if (state.interruptPending || state.awaitingSteerGeneration !== undefined) {
      reject(state.generation, "interrupt_in_progress");
      return;
    }
    if (state.generation >= Number.MAX_SAFE_INTEGER) {
      reject(state.generation, "generation_exhausted");
      return;
    }

    // This synchronous latch wins or loses atomically against the synchronous
    // Runtime event sink. Once set, no later product/tool/computer effect can
    // cross the Product boundary while the inner Pi gate is being installed.
    const interruptedGeneration = state.generation;
    const nextGeneration = interruptedGeneration + 1;
    const effectsWereBlocked = state.effectsBlocked;
    const previouslyInterruptedGeneration = state.interruptedGeneration;
    state.effectsBlocked = true;
    state.interruptPending = true;
    state.interruptedGeneration = interruptedGeneration;

    const innerInterrupt = this.inner.interruptTurn;
    if (!innerInterrupt) {
      state.interruptPending = false;
      state.effectsBlocked = effectsWereBlocked;
      if (previouslyInterruptedGeneration === undefined) delete state.interruptedGeneration;
      else state.interruptedGeneration = previouslyInterruptedGeneration;
      reject(state.generation, "unsupported");
      return;
    }

    let innerAccepted = false;
    let innerRejectedCode: string | undefined;
    let innerSettled = false;
    try {
      innerSettled = await settlesWithin(
        innerInterrupt.call(this.inner, command, (event) => {
          if (event.requestId !== command.requestId || event.traceId !== command.traceId) return;
          if (event.type === "turn.interrupt.accepted"
            && event.payload.interruptedGeneration === interruptedGeneration
            && event.payload.nextGeneration === nextGeneration) {
            innerAccepted = true;
            return;
          }
          if (event.type === "turn.interrupt.rejected"
            && event.payload.generation === interruptedGeneration
            && typeof event.payload.code === "string") {
            innerRejectedCode = mapInnerInterruptRejection(event.payload.code);
          }
        }),
        RUNTIME_SHUTDOWN_TIMEOUT_MS,
      );
    } catch {
      // An exception is ambiguous: Pi may already have raised its output and
      // effect floor before the acknowledgement was lost. Keep the Product
      // floor and cancel below instead of reopening the old generation.
    }

    state.interruptPending = false;
    if (innerSettled && !innerAccepted && innerRejectedCode !== undefined) {
      state.effectsBlocked = effectsWereBlocked;
      if (previouslyInterruptedGeneration === undefined) delete state.interruptedGeneration;
      else state.interruptedGeneration = previouslyInterruptedGeneration;
      reject(state.generation, innerRejectedCode);
      return;
    }
    if (state.terminalKind || !innerSettled || !innerAccepted || innerRejectedCode !== undefined) {
      reject(state.generation, "inner_rejected");
      await this.cancelTurn({
        schemaVersion: command.schemaVersion,
        type: "turn.cancel",
        requestId: command.requestId,
        traceId: command.traceId,
        sentAt: new Date().toISOString(),
        payload: { reason: "interrupt_ack_ambiguous" },
      }, () => undefined);
      return;
    }

    state.generation = nextGeneration;
    state.awaitingSteerGeneration = nextGeneration;
    state.steerSubmitted = false;
    this.armInterruptTimeout(state);
    emit(runtimeEvent(
      "turn.interrupt.accepted",
      command.requestId,
      command.traceId,
      { interruptedGeneration, nextGeneration },
      state.conversationId as ConversationId,
    ));
  }

  private armInterruptTimeout(state: TurnLedgerState): void {
    this.clearInterruptTimeout(state);
    state.interruptTimeout = setTimeout(() => {
      if (state.terminalKind
        || state.awaitingSteerGeneration === undefined
        || state.steerSubmitted) return;
      void this.cancelTurn({
        schemaVersion: state.command.schemaVersion,
        type: "turn.cancel",
        requestId: state.command.requestId,
        traceId: state.traceId,
        sentAt: new Date().toISOString(),
        payload: { reason: "interrupt_steer_timeout" },
      }, () => undefined);
    }, INTERRUPT_STEER_TIMEOUT_MS);
    state.interruptTimeout.unref?.();
  }

  private clearInterruptTimeout(state: TurnLedgerState): void {
    if (state.interruptTimeout !== undefined) clearTimeout(state.interruptTimeout);
    delete state.interruptTimeout;
  }

  async steerTurn(command: TurnSteerCommand, emit: RuntimeEventSink): Promise<void> {
    const state = this.activeTurns.get(command.requestId);
    if (!state) {
      emit(runtimeEvent("turn.interrupt.rejected", command.requestId, command.traceId, {
        generation: command.payload.nextGeneration,
        code: "turn_not_active",
      }));
      return;
    }
    if (command.traceId !== state.traceId) {
      emit(runtimeEvent("turn.interrupt.rejected", command.requestId, command.traceId, {
        generation: state.generation,
        code: "trace_mismatch",
      }, state.conversationId as ConversationId));
      return;
    }
    if (state.terminalKind
      || state.awaitingSteerGeneration !== command.payload.nextGeneration
      || state.generation !== command.payload.nextGeneration) {
      emit(runtimeEvent("turn.interrupt.rejected", command.requestId, command.traceId, {
        generation: state.generation,
        code: state.terminalKind ? "turn_terminal" : "stale_generation",
      }, state.conversationId as ConversationId));
      return;
    }
    if (state.steerSubmitted) {
      emit(runtimeEvent("turn.interrupt.rejected", command.requestId, command.traceId, {
        generation: state.generation,
        code: "duplicate_steer",
      }, state.conversationId as ConversationId));
      return;
    }
    if (COMPUTER_EFFECT_INTENT.test(command.payload.message)
      || routeProductUtterance(command.payload.message, state.command.payload.contextFrame) !== null) {
      emit(runtimeEvent("turn.interrupt.rejected", command.requestId, command.traceId, {
        generation: state.generation,
        code: "effectful_steer",
      }, state.conversationId as ConversationId));
      return;
    }

    // One-shot CAS occurs before the first await and therefore before the
    // durable user-input append. Concurrent duplicate steers cannot both win.
    state.steerSubmitted = true;
    this.clearInterruptTimeout(state);
    const preparationSettled = state.preparePromise === undefined
      || await settlesWithin(
        state.preparePromise.catch(() => undefined),
        RUNTIME_SHUTDOWN_TIMEOUT_MS,
      );
    if (!preparationSettled) {
      await this.cancelTurn({
        schemaVersion: command.schemaVersion,
        type: "turn.cancel",
        requestId: command.requestId,
        traceId: command.traceId,
        sentAt: new Date().toISOString(),
        payload: { reason: "steer_prepare_timeout" },
      }, () => undefined);
      return;
    }
    if (state.terminalKind) return;

    if (state.durable) {
      try {
        await this.enqueueLedger(state, async () => {
          const replaced = await this.kernel.store.replaceOpenConversationTurnInput({
            conversationId: state.conversationId,
            turnId: state.command.requestId,
            traceId: state.traceId,
            userInput: ledgerText(command.payload.message),
          });
          if (!replaced) throw new Error("steer_turn_input_conflict");
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
        state.steerSubmitted = false;
        this.armInterruptTimeout(state);
        this.emitSafeFailure(state, "conversation_ledger_failed");
        return;
      }
    }

    const tracker = this.taskTrackers.get(command.requestId);
    const suggestionTracker = this.suggestionTrackers.get(command.requestId);
    try {
      state.innerStarted = true;
      await this.inner.steerTurn(command, (event) => {
        if (this.acceptRuntimeEvent(state, event)) {
          tracker?.observe(event);
          suggestionTracker?.observe(event);
        }
      });
    } catch {
      tracker?.recordRuntimeFailure("steer");
      if (!state.terminalKind) {
        this.acceptRuntimeEvent(
          state,
          runtimeEvent("turn.failed", command.requestId, state.traceId, {
            code: "steer_failed",
            generation: state.generation,
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
    const cancelDeadline = Date.now() + RUNTIME_SHUTDOWN_TIMEOUT_MS;
    const cancelInnerAtMost = async (sink: RuntimeEventSink): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2_000);
      });
      try {
        await Promise.race([
          Promise.resolve()
            .then(() => this.inner.cancelTurn(command, sink))
            .then(() => undefined, () => undefined),
          timeout,
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };

    const state = this.activeTurns.get(command.requestId);
    if (!state
      && this.pendingStartTraceByRequestId.get(command.requestId) === command.traceId) {
      // Tombstone the request itself. The pending start owns emission and
      // durable settlement once it acquires conversation admission; no
      // unscoped inner cancellation can race and then let the start through.
      this.cancelledPendingRequestIds.add(command.requestId);
      return;
    }
    if (!state) {
      let acceptingEvents = true;
      await cancelInnerAtMost((event) => {
        if (!acceptingEvents) return;
        const safeEvent = sanitizeClientEvent(enrichFreeEvent(event, command.requestId));
        if (safeEvent) emit(safeEvent);
      });
      acceptingEvents = false;
      return;
    }
    if (command.traceId !== state.traceId) return;
    if (state.terminalKind) return;
    this.clearInterruptTimeout(state);

    // Product actions are reconciled by the registry receipt.  Do not close
    // the turn gate here: a post-commit receipt must be able to record the
    // action before the turn is failed.  The reason is fixed and never copies
    // user-provided text into the signal.
    if (state.productActionAbortController !== undefined) {
      state.productActionCancelRequested = true;
      state.productActionAbortController.abort("product_action_cancelled");
      return;
    }

    // The page-to-note action is running inside Pi, but its source-bound
    // macOS request already crossed the effect boundary. Stop Pi now while
    // keeping that one port receipt alive; its reconciliation below owns the
    // durable terminal outcome and never presents a success response.
    if (state.currentPageNoteReceiptInFlight && state.currentPageNoteDispatched) {
      state.currentPageNoteCancelRequested = true;
      await cancelInnerAtMost(() => undefined);
      return;
    }

    // Close the product gate before waiting for preparation or invoking a
    // potentially slow inner cancellation. A hung store must not keep stdio
    // cancellation open; runTurn owns eventual durable settlement.
    // This is a Product-authored terminal, not an old provider terminal. Drop
    // the interruption wait latch first so supersede, watchdog, and explicit
    // cancellation can always close an accepted-but-not-yet-steered turn.
    state.interruptPending = false;
    delete state.awaitingSteerGeneration;
    state.steerSubmitted = false;
    const cancelledEvent = runtimeEvent("turn.cancelled", command.requestId, state.traceId, {
      reason: state.productActionAbortController === undefined
        ? safeMetadata(command.payload.reason) ?? "user_cancelled"
        : "product_action_cancelled",
      generation: state.generation,
    });
    this.taskTrackers.get(command.requestId)?.observe(cancelledEvent);
    this.suggestionTrackers.get(command.requestId)?.observe(cancelledEvent);
    this.acceptRuntimeEvent(state, cancelledEvent);
    const innerCancellation = state.innerStarted
      ? cancelInnerAtMost(() => undefined)
      : Promise.resolve();
    const preparationSettled = !state.durable
      || (state.preparePromise !== undefined
        && await settlesWithin(
          state.preparePromise.catch(() => undefined),
          Math.max(0, cancelDeadline - Date.now()),
        ));
    if (!preparationSettled) {
      await innerCancellation;
      return;
    }
    try {
      await settlesWithin(
        this.taskTrackers.get(command.requestId)?.flush() ?? Promise.resolve(),
        Math.max(0, cancelDeadline - Date.now()),
      );
    } catch {
      // Preserve an explicit user cancellation even if TaskTruth persistence
      // is unavailable; the ledger turn remains the authoritative outcome.
    }
    await settlesWithin(
      this.suggestionTrackers.get(command.requestId)?.flush() ?? Promise.resolve(),
      Math.max(0, cancelDeadline - Date.now()),
    );
    await settlesWithin(this.settleState(state), Math.max(0, cancelDeadline - Date.now()));
    // The product cancellation gate is already closed. The inner harness gets
    // the same bounded cleanup window; late events cannot reopen the turn.
    await innerCancellation;
  }

  async cancelTask(command: DelegatedTaskCancelCommand): Promise<boolean> {
    if (await this.delegation.cancelDelegatedTask(command)) return true;

    const task = (await this.kernel.store.listTasks()).find((candidate) =>
      candidate.id === command.payload.taskId
      && candidate.status === "running"
      && candidate.mainConversationId?.toLowerCase()
        === command.payload.mainConversationId.toLowerCase()
      && contextWatchIdFromEvidence(candidate.evidence) !== null);
    if (task === undefined || task.sessionScope.kind === "private") return false;
    const conversation = await this.kernel.store.getConversation(command.payload.mainConversationId);
    if (
      conversation === null
      || !sessionScopesEqual(conversation.sessionScope, task.sessionScope)
    ) return false;

    const watches = await this.kernel.store.listActiveContextWatches(task.sessionScope);
    const watch = watches.find((candidate) => candidate.taskId === task.id);
    if (watch === undefined) return false;
    const cancelledAt = new Date().toISOString();
    const cancelled = await this.kernel.store.cancelContextWatch(
      watch.id,
      task.sessionScope,
      cancelledAt,
    );
    if (cancelled === null) return false;
    this.emitTaskPresence({
      taskId: task.id,
      parentId: cancelled.mandateId,
      mainConversationId: cancelled.mainConversationId,
      taskKind: "context_reminder",
      watchState: "cancelled",
      title: task.title,
      status: "cancelled",
      createdAt: task.createdAt,
      updatedAt: cancelledAt,
      resultKind: "cancelled",
      summary: "提醒已取消。",
      sequence: [],
    });
    return true;
  }

  /** Compatibility name retained for current stdio and Swift callers. */
  async cancelDelegatedTask(command: DelegatedTaskCancelCommand): Promise<boolean> {
    return this.cancelTask(command);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const deadline = Date.now() + RUNTIME_SHUTDOWN_TIMEOUT_MS;
    const runBeforeDeadline = async (
      operation: () => Promise<unknown>,
      reserveMs = 0,
    ): Promise<boolean> => {
      const remaining = deadline - Date.now() - reserveMs;
      if (remaining <= 0) return false;
      return settlesWithin(
        Promise.resolve().then(operation).catch(() => undefined),
        remaining,
      );
    };
    // Mark delegation shutdown before the inner harness goes down so children
    // whose turns die with the harness settle as cancelled, deterministically.
    this.delegation.beginDispose();
    const productActionStates = new Set<TurnLedgerState>();
    const pageNoteReceiptStates = new Set<TurnLedgerState>();
    const ordinarySettlement: Array<Promise<void>> = [];

    // Latch ordinary cancellation synchronously so late provider events are
    // ignored. Product actions are different: abort requests reconciliation,
    // but their terminal truth must wait for the receipt because the side
    // effect may already have committed.
    for (const state of this.activeTurns.values()) {
      this.clearInterruptTimeout(state);
      if (state.productActionAbortController !== undefined) {
        productActionStates.add(state);
        state.productActionCancelRequested = true;
        state.productActionAbortController.abort("runtime_disposed");
        continue;
      }
      if (state.currentPageNoteReceiptInFlight && state.currentPageNoteDispatched) {
        // The request is already with macOS.  Dispose must stop Pi, but its
        // receipt remains the only honest source for the durable outcome.
        state.currentPageNoteCancelRequested = true;
        pageNoteReceiptStates.add(state);
        continue;
      }
      if (state.terminalKind) continue;
      const cancelled = runtimeEvent(
        "turn.cancelled",
        state.command.requestId,
        state.traceId,
        { reason: "runtime_disposed", generation: state.generation },
      );
      this.taskTrackers.get(state.command.requestId)?.observe(cancelled);
      this.suggestionTrackers.get(state.command.requestId)?.observe(cancelled);
      this.acceptRuntimeEvent(state, cancelled);
      ordinarySettlement.push((async () => {
        await state.preparePromise?.catch(() => undefined);
        this.taskTrackers.get(state.command.requestId)?.observe(cancelled);
        this.suggestionTrackers.get(state.command.requestId)?.observe(cancelled);
        await this.taskTrackers.get(state.command.requestId)?.flush().catch(() => undefined);
        await this.suggestionTrackers.get(state.command.requestId)?.flush().catch(() => undefined);
        await this.settleState(state);
      })());
    }

    let disposeError: unknown;
    const innerDispose = this.inner.dispose().catch((error) => {
      disposeError = error;
    });
    if (!await runBeforeDeadline(() => Promise.allSettled([
      innerDispose,
      ...ordinarySettlement,
      ...this.activeTurnOperations,
      ...[...pageNoteReceiptStates].map((state) => state.currentPageNoteReceiptSettled ?? Promise.resolve()),
      this.trailObservationTail,
    ]), 750)) {
      // A source-bound page-note receipt is intentionally still pending here.
      // Its explicit unknown outcome below is the normal bounded shutdown
      // result, not an inner-runtime failure.
      if (pageNoteReceiptStates.size === 0) {
        disposeError = new Error("Inner runtime shutdown timed out.");
      }
    }

    // A product action that still has no receipt at the deadline is not safely
    // describable as cancelled: its side effect may have committed. Persist an
    // explicit unknown outcome if the remaining store budget permits it.
    const unknownActionSettlements: Array<Promise<void>> = [];
    for (const state of productActionStates) {
      if (state.terminalKind) continue;
      this.replacePendingWithFailure(state, "action_outcome_unknown");
      unknownActionSettlements.push(this.settleState(state));
    }
    for (const state of pageNoteReceiptStates) {
      if (state.terminalKind) continue;
      state.currentPageNoteReceiptInFlight = false;
      const unknown: CurrentPageNoteResult = {
        dispatched: true,
        succeeded: true,
        verified: false,
        status: "unverified",
        code: "timeout",
      };
      this.settleCurrentPageNote(state, unknown);
      this.emitCurrentPageNoteOutcome(state, unknown);
      this.acceptRuntimeEvent(
        state,
        runtimeEvent("turn.failed", state.command.requestId, state.traceId, {
          code: "action_outcome_unknown",
        }),
      );
      unknownActionSettlements.push((async () => {
        // The product record is the fence: never dismantle the live receipt
        // before the unknown outcome is durable.
        await this.settleState(state);
        if (state.ledgerError !== undefined) {
          disposeError ??= new Error("Page-note unknown outcome was not durable.");
          return;
        }
        (this.inner as AgentRuntime & {
          abandonPageNoteReceiptReconciliation?: (requestId: string) => void;
        }).abandonPageNoteReceiptReconciliation?.(state.command.requestId);
      })());
    }
    if (!await runBeforeDeadline(
      () => Promise.allSettled(unknownActionSettlements),
      375,
    )) {
      disposeError ??= new Error("Product action reconciliation timed out.");
    }

    // Drain delegated children after the inner harness is down: their settle
    // path writes TaskTruth, so they must finish before the final snapshot.
    if (!await runBeforeDeadline(async () => {
      await this.delegation.dispose();
      await Promise.allSettled([...this.taskTrackers.values()].map((tracker) => tracker.flush()));
      await Promise.allSettled(
        [...this.suggestionTrackers.values()].map((tracker) => tracker.flush()),
      );
      await this.flushLedger();
    })) {
      disposeError ??= new Error("Runtime durable shutdown timed out.");
    }
    this.taskTrackers.clear();
    this.suggestionTrackers.clear();
    this.activeRequestIds.clear();
    this.pendingStartTraceByRequestId.clear();
    this.cancelledPendingRequestIds.clear();
    this.activeTurns.clear();
    if (disposeError !== undefined) throw disposeError;
  }

  private acceptRuntimeEvent(state: TurnLedgerState, rawEvent: RuntimeEvent): boolean {
    if (state.terminalKind) return false;
    if (rawEvent.requestId !== state.command.requestId || rawEvent.traceId !== state.traceId) return false;
    if (state.seenEventIds.has(rawEvent.eventId)) return false;
    state.seenEventIds.add(rawEvent.eventId);

    if (state.currentPageNoteCancelRequested
      && state.currentPageNoteReceiptInFlight
      && (rawEvent.type === "response.completed"
        || rawEvent.type === "turn.cancelled"
        || rawEvent.type === "turn.failed"
        || rawEvent.type === "runtime.error")) {
      return true;
    }

    if (GENERATION_EVENT_TYPES.has(rawEvent.type)) {
      const rawGeneration = safeGeneration(rawEvent.payload.generation);
      // Before the first interrupt, v1 inner test doubles may omit generation;
      // after the floor moves, ambiguity is unsafe and therefore suppressed.
      if (rawGeneration === undefined && state.interruptedGeneration !== undefined) return false;
      const generation = rawGeneration ?? state.generation;
      if (state.interruptPending && generation === state.interruptedGeneration) return false;
      if (generation !== state.generation) return false;
      const isTerminal = rawEvent.type === "response.completed"
        || rawEvent.type === "turn.cancelled"
        || rawEvent.type === "turn.failed"
        || rawEvent.type === "runtime.error";
      if (isTerminal && (state.interruptPending
        || (state.awaitingSteerGeneration !== undefined && !state.steerSubmitted))) return false;

      // The first replacement presentation event proves that the admitted
      // generation is live. Release only the one-shot steer latch so the same
      // turn can be interrupted again (1 -> 2 -> 3); the effect floor stays.
      if (state.steerSubmitted
        && state.awaitingSteerGeneration === generation
        && (rawEvent.type === "turn.started"
          || rawEvent.type === "response.delta"
          || (rawEvent.type === "runtime.status"
            && rawEvent.payload.status === "steering_received"))) {
        delete state.awaitingSteerGeneration;
        state.steerSubmitted = false;
      }
    }

    // The page-to-note turn carries visible personal content to the model only
    // transiently. Do not let a model repeat that title/items before or after
    // the tool call; the user sees one fixed outcome instead.
    if (isCurrentPageActionsNoteUtterance(state.command.payload.utterance)
      && rawEvent.type === "response.delta") return true;

    if (rawEvent.type === "tool.started"
      || rawEvent.type === "computer.action.requested"
      || rawEvent.type === "product.action.completed") {
      if (state.effectsBlocked) return false;
      state.effectsStarted = true;
    }

    const event = sanitizeClientEvent(enrichEvent(
      isCurrentPageActionsNoteUtterance(state.command.payload.utterance)
        && rawEvent.type === "response.completed"
        ? {
            ...rawEvent,
            payload: {
              ...rawEvent.payload,
              text: currentPageNoteCompletionText(state.currentPageNoteResult),
            },
          }
        : rawEvent,
      state,
    ));
    if (!event) return false;

    if (event.type === "response.completed") {
      this.clearInterruptTimeout(state);
      state.terminalKind = "completed";
      state.pendingTerminal = event;
      return true;
    }
    if (event.type === "turn.cancelled") {
      this.clearInterruptTimeout(state);
      state.terminalKind = "cancelled";
      state.pendingTerminal = event;
      return true;
    }
    if (event.type === "turn.failed" || event.type === "runtime.error") {
      this.clearInterruptTimeout(state);
      state.terminalKind = "failed";
      state.pendingTerminal = event;
      return true;
    }

    // The outer gate wrote the canonical turn.started before invoking the
    // harness.  Keep the harness event live (it may carry provider metadata),
    // but do not create a second durable start record.
    if (event.type === "turn.started") {
      state.emit(event);
      return true;
    }

    const projection = projectionFor(event);
    if (!projection) {
      // response.delta intentionally remains a live-only stream.
      state.emit(event);
      return true;
    }
    if (!state.durable) {
      state.emit(event);
      return true;
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
    return true;
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
    // Project the already-durable terminal before settling its ResultInbox
    // claim. If the process dies at this boundary, an at-least-once repeat is
    // preferable to silently acknowledging a result the user never saw.
    if (state.pendingTerminal && !state.terminalDelivered) {
      state.emit(sanitizeClientEvent(state.pendingTerminal) ?? state.pendingTerminal);
      state.terminalDelivered = true;
    }
    // ResultInbox settlement follows, but does not participate in, the Main
    // turn's durable terminal transaction. A failed ack/release keeps the
    // claim for startup reconciliation; it must never contradict a completed
    // conversation turn with a visible failure.
    try {
      if (state.terminalKind === "completed") {
        await this.delegation.inbox.ack(state.command.requestId, new Date().toISOString());
      } else {
        await this.delegation.inbox.release(state.command.requestId);
      }
    } catch {
      // Recovery inspects the durable claimTurnId status on next startup.
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

  private async acquireConversationAdmission(conversationId: string): Promise<() => void> {
    const key = conversationId.toLowerCase();
    const previous = this.conversationAdmissionTails.get(key) ?? Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.conversationAdmissionTails.set(key, tail);
    await previous.catch(() => undefined);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
      void tail.finally(() => {
        if (this.conversationAdmissionTails.get(key) === tail) {
          this.conversationAdmissionTails.delete(key);
        }
      });
    };
  }

  private releaseInnerConversationSession(conversationId: string): void {
    try {
      (
        this.inner as AgentRuntime & {
          releaseConversationSession?: (id: string) => void;
        }
      ).releaseConversationSession?.(conversationId);
    } catch {
      // The bounded cancel path below remains authoritative. Session eviction
      // is a supersede fence, never a reason to reject the replacement turn.
    }
  }

  private emitTaskPresence(update: DelegatedTaskPresenceUpdate): void {
    try {
      this.taskPresenceSink?.(update);
    } catch {
      // Presence is a post-commit projection. Transport failure cannot roll
      // durable task truth back or make a one-shot watch fire again.
    }
  }

  private emitCreatedContextWatchPresence(output: unknown): void {
    if (!isRecord(output) || !isRecord(output.watch) || !isRecord(output.task)) return;
    const watch = output.watch;
    const task = output.task;
    if (
      typeof watch.taskId !== "string"
      || typeof watch.mandateId !== "string"
      || typeof watch.mainConversationId !== "string"
      || typeof watch.createdAt !== "string"
      || typeof task.title !== "string"
      || typeof task.updatedAt !== "string"
    ) return;
    this.emitTaskPresence({
      taskId: watch.taskId,
      parentId: watch.mandateId,
      mainConversationId: watch.mainConversationId,
      taskKind: "context_reminder",
      watchState: "waiting_for_departure",
      title: task.title,
      status: "running",
      createdAt: watch.createdAt,
      updatedAt: task.updatedAt,
    });
  }

  private activateTrailScope(sessionScope: SessionScope): void {
    const nextScopeKey = sessionScopeKey(sessionScope);
    if (
      this.activeTrailScopeKey !== undefined
      && this.activeTrailScopeKey !== nextScopeKey
    ) {
      this.kernel.trail.clear();
    }
    if (sessionScope.kind === "private") {
      this.kernel.trail.clear();
    }
    this.activeTrailScopeKey = nextScopeKey;
  }

  /**
   * Rebuild only the visible part of this exact durable conversation. The
   * attachment is present on every product turn, but Pi renders it only when
   * it has just created a cold session.
   */
  private async conversationHistoryForOrdinaryTurn(
    state: TurnLedgerState,
  ): Promise<PromptConversationTurn[]> {
    if (state.sessionScope.kind === "private") return [];
    try {
      const conversation = await this.kernel.store.getConversation(state.conversationId);
      if (
        !conversation
        || conversation.status === "archived"
        || !sessionScopesEqual(conversation.sessionScope, state.sessionScope)
      ) {
        return [];
      }
      const turns = await this.kernel.store.listConversationTurns(state.conversationId);
      return boundedConversationHistory(
        turns.filter((turn) => (
          turn.status === "completed"
          && sessionScopesEqual(turn.sessionScope, state.sessionScope)
        )).sort((left, right) => left.sequence - right.sequence),
      );
    } catch {
      return [];
    }
  }

  /** Recent sanitized observations from this exact scope, excluding this turn's live frame. */
  private recentTrailForOrdinaryTurn(state: TurnLedgerState): PromptTrailObservation[] {
    if (state.sessionScope.kind === "private") return [];
    return this.kernel.trail.query({
      sessionScope: state.sessionScope,
      sinceMs: RECENT_TRAIL_WINDOW_MS,
      // The current frame may occupy one result slot before it is removed.
      limit: RECENT_TRAIL_MAX_ENTRIES + 1,
    })
      .filter((entry) => entry.frameId !== state.command.payload.contextFrame.frameId)
      .slice(-RECENT_TRAIL_MAX_ENTRIES)
      .map((entry) => ({
        frameId: entry.frameId,
        capturedAt: entry.capturedAt,
        appName: entry.appName,
        windowTitle: entry.windowTitle,
        axRole: entry.axRole,
        axTitle: entry.axTitle,
        axValuePreview: entry.axValuePreview,
        cursorRegion: entry.cursorRegion,
        warnings: [...entry.warnings],
      }));
  }

  /** Latest durable user corrections from this exact scope. */
  private async behaviorRulesForOrdinaryTurn(
    state: TurnLedgerState,
  ): Promise<PromptBehaviorRule[]> {
    if (state.sessionScope.kind === "private") return [];
    const scope = memoryScopeForSession(state.sessionScope);
    if (scope === null) return [];
    try {
      const rules = (await this.kernel.store.listLearnings())
        .filter((learning) => learning.scope === scope)
        .sort((left, right) => {
          const byTime = right.capturedAt.localeCompare(left.capturedAt);
          return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
        });
      const selected: PromptBehaviorRule[] = [];
      let totalChars = 0;
      for (const learning of rules) {
        if (selected.length >= BEHAVIOR_RULE_MAX_ITEMS) break;
        const rule = safeHistoryText(learning.rule, "learning rule");
        if (rule === undefined) continue;
        if (
          selected.length > 0
          && totalChars + rule.length > BEHAVIOR_RULE_MAX_CHARS
        ) {
          break;
        }
        selected.push({
          id: learning.id,
          rule,
          capturedAt: learning.capturedAt,
          scope: learning.scope,
        });
        totalChars += rule.length;
      }
      return selected;
    } catch {
      return [];
    }
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

  /**
   * Ordinary turns consume pending delegated child results (one-shot).
   * Private sessions never receive them: private delegations are refused at
   * the tool boundary, and inbox entries are keyed to the delegating
   * conversation anyway.
   */
  private async delegatedResultsForOrdinaryTurn(state: TurnLedgerState): Promise<DelegatedResult[]> {
    if (state.sessionScope.kind === "private") return [];
    try {
      return await this.delegation.claimForTurn(state.conversationId, state.command.requestId);
    } catch {
      return [];
    }
  }

  /** Typed, durable background-task projection used after sidecar restart. */
  async listTasks(mainConversationId: string): Promise<DelegatedTaskPresenceUpdate[]> {
    await this.recoveryReady;
    await this.reconcileClaimedDeliveries(false);
    await this.delegation.reconcilePendingSettlements();
    const [conversation, tasks, results] = await Promise.all([
      this.kernel.store.getConversation(mainConversationId),
      this.kernel.store.listTasks(),
      this.kernel.store.listDelegatedResults({ mainConversationId }),
    ]);
    if (conversation === null || conversation.sessionScope.kind === "private") return [];
    const resultByTask = new Map(results.map((result) => [result.taskId, result]));
    return tasks
      .filter((task) => task.mainConversationId !== undefined
        && (task.evidence.some((entry) => entry.startsWith("delegate:accepted:"))
          || contextWatchIdFromEvidence(task.evidence) !== null)
        && sessionScopesEqual(task.sessionScope, conversation.sessionScope)
        && task.mainConversationId.toLowerCase() === mainConversationId.toLowerCase())
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt)
        || right.createdAt.localeCompare(left.createdAt)
        || left.id.localeCompare(right.id))
      .slice(0, 64)
      .map((task) => {
        const result = resultByTask.get(task.id);
        const contextWatchId = contextWatchIdFromEvidence(task.evidence);
        const taskKind = contextWatchId === null ? "delegated" : "context_reminder";
        const watchState = taskKind === "context_reminder"
          ? contextWatchStateFromTask(task.status, task.evidence)
          : undefined;
        return {
          taskId: task.id,
          parentId: result?.parentId ?? task.parentId ?? contextWatchId!,
          mainConversationId: task.mainConversationId!,
          taskKind,
          ...(watchState === undefined ? {} : { watchState }),
          title: task.title,
          status: task.status,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          ...(result === undefined ? {} : {
            resultKind: result.resultKind,
            summary: result.summary,
            sequence: result.sequence,
          }),
          ...(result === undefined && taskKind === "context_reminder" && task.status === "cancelled"
            ? {
                resultKind: "cancelled" as const,
                summary: "提醒已取消。",
                sequence: [],
              }
            : {}),
        };
      });
  }

  /** Compatibility name retained while clients still call task.list V1. */
  async listDelegatedTasks(mainConversationId: string): Promise<DelegatedTaskPresenceUpdate[]> {
    return this.listTasks(mainConversationId);
  }

  private async recoverDurableDelegationState(): Promise<void> {
    await this.reconcileClaimedDeliveries(true);
    const running = (await this.kernel.store.listTasks()).filter((task) =>
      task.status === "running"
      && task.mainConversationId !== undefined
      && task.parentId !== undefined
      && task.evidence.some((entry) => entry.startsWith("delegate:accepted:")),
    );
    for (const task of running) {
      const parentId = task.parentId;
      const mainConversationId = task.mainConversationId;
      if (parentId === undefined || mainConversationId === undefined) continue;
      const observedAt = new Date().toISOString();
      await this.kernel.taskTruth.recordWithDelegatedResult({
        taskId: task.id,
        title: task.title,
        kind: "failed",
        observedAt,
        evidence: `delegate:failed:${task.id}:runtime_restart`,
        parentId,
        mainConversationId,
        sessionScope: task.sessionScope,
        ...(task.contract !== undefined ? { contract: task.contract } : {}),
      }, {
        taskId: task.id,
        parentId,
        mainConversationId,
        resultKind: "failed",
        summary: "后台任务因运行时重启中断，未自动重试。",
        completedAt: observedAt,
        sequence: [],
      });
    }
  }

  private async reconcileClaimedDeliveries(recoverOpen: boolean): Promise<void> {
    const claimed = await this.kernel.store.listDelegatedResults({ claimedOnly: true });
    for (const result of claimed) {
      if (!result.claimTurnId || result.deliveryTurnId) continue;
      const turn = await this.kernel.store.getConversationTurn(result.claimTurnId);
      if (turn?.status === "completed") {
        await this.kernel.store.ackDelegatedResults(result.claimTurnId);
        continue;
      }
      if (
        turn?.status === "open"
        && (recoverOpen || !this.activeRequestIds.has(result.claimTurnId))
      ) {
        await this.kernel.store.appendConversationEvent({
          id: randomUUID(),
          conversationId: turn.conversationId,
          turnId: turn.id,
          type: "turn.failed",
          payload: { code: "recovery_required" },
        });
        await this.kernel.store.upsertConversationTurn({
          id: turn.id,
          conversationId: turn.conversationId,
          status: "failed",
          ...(turn.traceId !== undefined ? { traceId: turn.traceId } : {}),
        });
        await this.kernel.store.releaseDelegatedResults(result.claimTurnId);
        continue;
      }
      if (turn == null || turn.status === "failed" || turn.status === "cancelled") {
        await this.kernel.store.releaseDelegatedResults(result.claimTurnId);
      }
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

/**
 * L1 catalog description for a verified skill (ADR 0015): trigger phrase
 * first, then the conditioning app, then the first procedural step — enough
 * for the model to decide whether to load the skill, nothing more.
 */
function verifiedSkillL1Description(skill: {
  triggerPhrase?: string;
  steps: readonly { description: string }[];
  conditions: Record<string, string>;
}): string {
  const parts: string[] = [];
  if (skill.triggerPhrase !== undefined && skill.triggerPhrase.length > 0) {
    parts.push(skill.triggerPhrase);
  }
  const app = skill.conditions.app;
  if (app !== undefined && app.length > 0) parts.push(app);
  const firstStep = skill.steps
    .map((step) => step.description.trim())
    .find((description) => description.length > 0);
  if (firstStep !== undefined) parts.push(firstStep);
  const text = parts.join(" · ").slice(0, 160).trim();
  return text.length > 0 ? text : "verified procedural skill";
}

/** Status bar v1 (ADR 0015): engine-observable facts only, single line. */
function formatEngineStatusBar(state: StatusBarToolState): string {
  const calls = `${state.toolCallCount} tool call${state.toolCallCount === 1 ? "" : "s"}`;
  const last = state.lastToolName === undefined
    ? ""
    : `, last ${state.lastToolName}${state.lastToolFailed ? " failed" : " ok"}`;
  return `[executor: ${calls}${last}]`;
}

function freshObservedBundleId(frame: ContextFrame, now = new Date()): string | null {
  const capturedAt = Date.parse(frame.capturedAt);
  const expiresAt = Date.parse(frame.expiresAt);
  const observedAt = Date.parse(frame.frontmostApplication?.capturedAt ?? "");
  const nowMs = now.getTime();
  if (
    !Number.isFinite(capturedAt)
    || !Number.isFinite(expiresAt)
    || !Number.isFinite(observedAt)
    || capturedAt > nowMs + CONTEXT_WATCH_CLOCK_SKEW_MS
    || observedAt > nowMs + CONTEXT_WATCH_CLOCK_SKEW_MS
    || nowMs - capturedAt > CONTEXT_WATCH_OBSERVATION_MAX_AGE_MS
    || nowMs - observedAt > CONTEXT_WATCH_OBSERVATION_MAX_AGE_MS
    || expiresAt <= nowMs
    || (frame.frontmostApplication?.confidence ?? 0) < 0.8
  ) return null;
  const bundleId = frame.frontmostApplication?.value.bundleIdentifier;
  return typeof bundleId === "string" && bundleId.length > 0 ? bundleId : null;
}

function contextWatchIdFromEvidence(evidence: readonly string[]): string | null {
  const prefix = "context_watch:waiting_for_departure:";
  const row = evidence.find((entry) => entry.startsWith(prefix));
  const id = row?.slice(prefix.length).trim() ?? "";
  return id.length > 0 ? id : null;
}

function contextWatchStateFromTask(
  status: "pending" | "running" | "blocked" | "done" | "failed" | "cancelled",
  evidence: readonly string[],
): DelegatedTaskPresenceUpdate["watchState"] {
  if (status === "cancelled" || evidence.some((entry) => entry.startsWith("context_watch:cancelled:"))) {
    return "cancelled";
  }
  if (status === "done" || evidence.some((entry) => entry.startsWith("context_watch:fired:"))) {
    return "fired";
  }
  if (evidence.some((entry) => entry.startsWith("context_watch:armed:"))) {
    return "armed";
  }
  return "waiting_for_departure";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  "watch_app_return",
  "finder_history_back",
  "create_note",
  "schedule_time_reminder",
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
  "action_outcome_unknown",
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
  "steer_replacement_failed_before_start",
  "task_truth_unavailable",
  "turn_ended_without_terminal",
  "turn_not_active",
]);

const SAFE_INTERRUPT_REJECTION_CODES = new Set([
  "duplicate_steer",
  "effect_started",
  "effectful_steer",
  "generation_exhausted",
  "ineligible_turn",
  "inner_rejected",
  "interrupt_in_progress",
  "stale_generation",
  "trace_mismatch",
  "turn_not_active",
  "turn_terminal",
  "unsupported",
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
        "generation",
      ]));
    case "turn.interrupt.accepted": {
      const interruptedGeneration = safeGeneration(payload.interruptedGeneration);
      const nextGeneration = safeGeneration(payload.nextGeneration);
      if (interruptedGeneration === undefined
        || nextGeneration !== interruptedGeneration + 1) return undefined;
      return withClientPayload(event, { interruptedGeneration, nextGeneration });
    }
    case "turn.interrupt.rejected": {
      const generation = safeGeneration(payload.generation);
      const code = safeMetadata(payload.code);
      if (generation === undefined || code === undefined
        || !SAFE_INTERRUPT_REJECTION_CODES.has(code)) return undefined;
      return withClientPayload(event, { generation, code });
    }
    case "response.delta": {
      const generation = safeGeneration(payload.generation);
      return withClientPayload(event, {
        ...safeVisibleTextPayload(payload.text),
        ...(generation === undefined ? {} : { generation }),
      });
    }
    case "response.completed": {
      const safeText = safeVisibleTextPayload(payload.text);
      const generation = safeGeneration(payload.generation);
      return withClientPayload(event, {
        ...safeText,
        verified: payload.verified === true,
        ...(payload.replayed === true ? { replayed: true } : {}),
        ...(generation === undefined ? {} : { generation }),
      });
    }
    case "tool.started":
    case "tool.completed":
      return withClientPayload(event, pickSafe(payload, [
        "toolName",
        "runtime",
        "isError",
        "compatibilityMode",
        "generation",
      ]));
    case "computer.action.requested": {
      const safeAction = safeComputerActionPayload(payload);
      const generation = safeGeneration(payload.generation);
      return safeAction ? withClientPayload(event, {
        ...safeAction,
        ...(generation === undefined ? {} : { generation }),
      }) : undefined;
    }
    case "runtime.status": {
      const generation = safeGeneration(payload.generation);
      return withClientPayload(event, {
        ...safeRuntimeStatusPayload(payload),
        ...(generation === undefined ? {} : { generation }),
      });
    }
    case "product.action.completed":
      return withClientPayload(event, safeProductActionPayload(payload));
    case "memory.used":
      return withClientPayload(event, safeMemoryUsedPayload(payload));
    case "turn.cancelled":
      {
        const generation = safeGeneration(payload.generation);
      return withClientPayload(event, {
        reason: safeCancellationReason(payload.reason),
        ...(generation === undefined ? {} : { generation }),
      });
      }
    case "turn.failed":
    case "runtime.error":
      {
        const generation = safeGeneration(payload.generation);
      return withClientPayload(event, {
        code: safeFailureCode(payload.code),
        ...(generation === undefined ? {} : { generation }),
      });
      }
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
  const action = payload.action === "left_click"
    || payload.action === "finder_history_back"
    || payload.action === "set_text"
    || payload.action === "create_note"
    || payload.action === "schedule_reminder"
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
  } else if (action === "finder_history_back") {
    if (payload.targetBundleId !== "com.apple.finder" || !Number.isInteger(payload.targetPid)) {
      return undefined;
    }
    result.targetBundleId = payload.targetBundleId;
    result.targetPid = payload.targetPid as number;
  } else if (action === "set_text") {
    const text = typeof payload.text === "string" && payload.text.length > 0 && payload.text.length <= 10_000
      ? payload.text
      : undefined;
    const targetBundleId = boundedVisibleString(payload.targetBundleId, 255);
    if (
      text === undefined
      || targetBundleId === undefined
      || !Number.isInteger(payload.targetPid)
      || (payload.targetPid as number) <= 0
    ) {
      return undefined;
    }
    result.text = text;
    result.targetBundleId = targetBundleId;
    result.targetPid = payload.targetPid as number;
  } else if (action === "create_note") {
    const content = typeof payload.content === "string"
      && payload.content.trim().length > 0
      && payload.content.length <= 5_000
      ? payload.content
      : undefined;
    const title = typeof payload.title === "string"
      && payload.title.trim().length > 0
      && payload.title.length <= 120
      ? payload.title
      : undefined;
    if (
      content === undefined
      || title === undefined
      || payload.targetBundleId !== "com.apple.Notes"
    ) {
      return undefined;
    }
    result.content = content;
    result.title = title;
    result.targetBundleId = "com.apple.Notes";
    const sourceValues = [
      payload.sourceBundleId,
      payload.sourcePid,
      payload.sourceWindowNumber,
      payload.sourceWindowTitle,
      payload.sourceWindowBounds,
    ];
    const sourceCount = sourceValues.filter((value) => value !== undefined).length;
    if (sourceCount !== 0 && sourceCount !== sourceValues.length) return undefined;
    if (sourceCount === sourceValues.length) {
      const sourceBundleId = boundedVisibleString(payload.sourceBundleId, 255);
      const sourceWindowTitle = typeof payload.sourceWindowTitle === "string"
        && payload.sourceWindowTitle.trim() === payload.sourceWindowTitle
        && payload.sourceWindowTitle.length > 0
        && payload.sourceWindowTitle.length <= 240
        ? payload.sourceWindowTitle
        : undefined;
      const sourceBounds = payload.sourceWindowBounds;
      if (
        sourceBundleId === undefined
        || !Number.isInteger(payload.sourcePid) || (payload.sourcePid as number) <= 0
        || !Number.isInteger(payload.sourceWindowNumber) || (payload.sourceWindowNumber as number) <= 0
        || sourceWindowTitle === undefined
        || !isValidSourceWindowBounds(sourceBounds)
      ) return undefined;
      result.sourceBundleId = sourceBundleId;
      result.sourcePid = payload.sourcePid as number;
      result.sourceWindowNumber = payload.sourceWindowNumber as number;
      result.sourceWindowTitle = sourceWindowTitle;
      result.sourceWindowBounds = sourceBounds as never;
    }
  } else {
    const reminderId = safeIdentifier(payload.reminderId);
    const delaySeconds = payload.delaySeconds;
    const body = typeof payload.body === "string"
      && payload.body.trim().length > 0
      && payload.body.length <= 500
      ? payload.body
      : undefined;
    if (reminderId === undefined
      || !Number.isInteger(delaySeconds)
      || (delaySeconds as number) < 60
      || (delaySeconds as number) > 86_400
      || body === undefined) return undefined;
    result.reminderId = reminderId;
    result.delaySeconds = delaySeconds as number;
    result.body = body;
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

function isValidSourceWindowBounds(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (!isRecord(value) || Object.keys(value).length !== 4) return false;
  const { x, y, width, height } = value;
  return typeof x === "number" && Number.isFinite(x)
    && typeof y === "number" && Number.isFinite(y)
    && typeof width === "number" && Number.isFinite(width) && width > 0
    && typeof height === "number" && Number.isFinite(height) && height > 0;
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
  if (actionName === "finder_history_back" || actionName === "create_note" || actionName === "schedule_time_reminder") {
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
      "verified_system_notification",
      "permission_denied",
      "notification_permission_pending",
      "notification_permission_denied",
      "notification_schedule_failed",
      "timeout",
      "runtime_error",
    ].includes(code)) {
      result.code = code;
    }
    const method = safeMetadata(value.method);
    const safeMethods = actionName === "create_note" || actionName === "schedule_time_reminder"
      ? ["native_command", "unknown"]
      : ["ax_press", "unknown"];
    if (method && safeMethods.includes(method)) result.method = method;
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

function mapInnerInterruptRejection(value: unknown): string {
  switch (safeMetadata(value)) {
    case "already_interrupted":
      return "interrupt_in_progress";
    case "effect_already_dispatched":
      return "effect_started";
    case "generation_mismatch":
      return "stale_generation";
    case "terminal":
      return "turn_terminal";
    default:
      return "inner_rejected";
  }
}

function projectionFor(event: RuntimeEvent): {
  type: "turn.started" | "tool.started" | "tool.completed" | "action.requested" | "action.completed" | "task.updated";
  payload: Record<string, string | number | boolean | null>;
} | undefined {
  switch (event.type) {
    case "turn.started":
      return {
        type: "turn.started",
        payload: pickSafe(event.payload, ["runtime", "capabilityProfile", "provider", "model", "generation"]),
      };
    case "tool.started":
      return {
        type: "tool.started",
        payload: pickSafe(event.payload, ["toolName", "runtime", "compatibilityMode", "generation"]),
      };
    case "tool.completed":
      return {
        type: "tool.completed",
        payload: pickSafe(event.payload, ["toolName", "runtime", "isError", "compatibilityMode", "generation"]),
      };
    case "computer.action.requested":
      return {
        type: "action.requested",
        payload: pickSafe(event.payload, ["actionId", "effectClass", "generation"]),
      };
    case "product.action.completed":
      return {
        type: "action.completed",
        payload: pickSafe(event.payload, ["actionName", "status", "receiptId", "auditId"]),
      };
    case "runtime.status":
      return {
        type: "task.updated",
        payload: pickSafe(event.payload, ["status", "stepCount", "toolsUsed", "accepted", "generation"]),
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
  const payload = asRecord(event.payload);
  const generation = safeGeneration(payload.generation) ?? state.generation;
  return {
    ...event,
    requestId: state.command.requestId,
    traceId: state.traceId,
    conversationId: state.conversationId as ConversationId,
    payload: GENERATION_EVENT_TYPES.has(event.type)
      ? { ...payload, generation }
      : payload,
  };
}

function enrichFreeEvent(event: RuntimeEvent, conversationId: string): RuntimeEvent {
  return {
    ...event,
    conversationId: conversationId as ConversationId,
  };
}

function boundedConversationHistory(
  turns: readonly ConversationTurn[],
): PromptConversationTurn[] {
  const candidates = turns.slice(-CONVERSATION_HISTORY_MAX_TURNS).map((turn) => ({
    id: turn.id,
    capturedAt: turn.createdAt,
    userInput: safeHistoryText(turn.userInput, "conversation user input"),
    assistantOutput: safeHistoryText(
      turn.assistantOutput,
      "conversation assistant output",
    ),
  }));
  const selected: PromptConversationTurn[] = [];
  let remainingBytes = CONVERSATION_HISTORY_TEXT_BYTES;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!;
    if (candidate.userInput === undefined && candidate.assistantOutput === undefined) continue;
    let userInput = candidate.userInput;
    let assistantOutput = candidate.assistantOutput;
    const userBytes = utf8Bytes(userInput);
    const assistantBytes = utf8Bytes(assistantOutput);
    const candidateBytes = userBytes + assistantBytes;

    if (candidateBytes > remainingBytes) {
      if (selected.length > 0 || remainingBytes <= 0) break;
      if (userBytes > 0 && assistantBytes > 0) {
        const userBudget = Math.floor(remainingBytes * userBytes / candidateBytes);
        userInput = truncateUtf8(userInput!, userBudget);
        assistantOutput = truncateUtf8(
          assistantOutput!,
          remainingBytes - utf8Bytes(userInput),
        );
      } else if (userInput !== undefined) {
        userInput = truncateUtf8(userInput, remainingBytes);
      } else if (assistantOutput !== undefined) {
        assistantOutput = truncateUtf8(assistantOutput, remainingBytes);
      }
    }

    const usedBytes = utf8Bytes(userInput) + utf8Bytes(assistantOutput);
    if (usedBytes === 0) break;
    selected.unshift({
      id: candidate.id,
      capturedAt: candidate.capturedAt,
      ...(userInput !== undefined && userInput.length > 0 ? { userInput } : {}),
      ...(assistantOutput !== undefined && assistantOutput.length > 0
        ? { assistantOutput }
        : {}),
    });
    remainingBytes -= usedBytes;
  }

  return selected;
}

function safeHistoryText(value: string | undefined, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  try {
    const safe = sanitizeVisibleText(value, fieldName).trim();
    return safe.length > 0 ? safe : undefined;
  } catch {
    return undefined;
  }
}

function utf8Bytes(value: string | undefined): number {
  return value === undefined ? 0 : Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
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

function safeGeneration(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1
    ? value
    : undefined;
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
