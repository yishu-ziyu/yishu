import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createDefaultProductKernel,
  formatProductActionSpeech,
  memoryScopeForSession,
  normalizeSessionScope,
  sessionScopeKey,
  sessionScopesEqual,
  taskExecutionContractForIntent,
  RELATIVE_TIME_REMINDER_CLARIFY_SPEECH,
  recallFromVisibleFacts,
  readLegacyFactClaims,
  everosMessagesForTurn,
  isEverOSProfileMemory,
  assertPersistableMemoryText,
  selectRelevantMindLessons,
  type CreateNoteExecutor,
  type CreateNoteRequest,
  type ScheduleTimeReminderExecutor,
  type FinderHistoryBackExecutor,
  type ConversationEvent,
  type ConversationTurn,
  type RecalledMemory,
  type VisibleMemoryAuthoritySnapshot,
  type EverOSMemoryPort,
  type TrailSourceFrame,
  type ConversationArchiveFailureReason,
  type ConversationOpenFailureReason,
  type SessionScope,
  type TaskExecutionContract,
  type TurnIntentFrame,
  type ProductUtteranceRoute,
  type YishuKernel,
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
  MemoryRememberCommand,
  SpeechExcerptCommand,
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
import { attachTurnIntentFrame } from "./intent-frame.js";
import { trustedExternalReceiptFor } from "./trusted-task-receipt.js";
import { RuntimeSuggestionTracker } from "./suggestion-loop.js";
import {
  attachBehaviorRules,
  attachConversationHistory,
  attachDelegatedResults,
  attachRecentTrail,
  attachRecalledMind,
  formatTurnMemoryBlock,
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
import {
  runExtractionPass,
  type ExtractionSnapshot,
  type MemoryExtractionModel,
} from "@yishu/kernel";
import type { SpeechExcerptModel } from "./speech-excerpt-model.js";
import { BrowserSessionHub } from "./browser-session.js";
import { openStagehandDriver } from "./stagehand-browser-driver.js";
import { EverOSIngestionCoordinator } from "./everos-ingestion.js";
import type { EverOSPendingSessionStore } from "./everos-pending-sessions.js";
import { ingestVerifiedTaskLearning } from "./everos-task-learning.js";
import { recordConversationModel, resolveTurnModelRouting } from "./model-routing.js";
import {
  GENERATION_EVENT_TYPES,
  acceptScopedDerivedMemories,
  asRecord,
  boundedConversationHistory,
  contextWatchIdFromEvidence,
  contextWatchStateFromTask,
  enrichEvent,
  enrichFreeEvent,
  eventText,
  formatEngineStatusBar,
  freshObservedBundleId,
  intentForUtterance,
  isRecord,
  ledgerText,
  mapInnerInterruptRejection,
  projectionFor,
  safeGeneration,
  safeHistoryText,
  safeMetadata,
  sanitizeClientEvent,
  speechOutputForProductAction,
  summarizeOutput,
  toPromptMemorySnippet,
  verifiedSkillL1Description,
} from "./product-kernel-runtime.helpers.js";
import type { TurnLedgerState } from "./product-kernel-runtime.helpers.js";

type TerminalKind = "completed" | "cancelled" | "failed";

/** Debounce between a turn settle and the async extraction drain (ADR 0016). */
const EXTRACTION_DRAIN_DELAY_MS = 1_500;

function terminalKindForStatus(status: ConversationTurn["status"]): TerminalKind {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

const RECENT_TRAIL_WINDOW_MS = 2 * 60_000;
const RECENT_TRAIL_MAX_ENTRIES = 8;
const BEHAVIOR_RULE_MAX_ITEMS = 3;
const BEHAVIOR_RULE_MAX_CHARS = 1_200;
const RUNTIME_SHUTDOWN_TIMEOUT_MS = 2_000;
const CONVERSATION_SUPERSEDE_TIMEOUT_MS = 2_000;
const INTERRUPT_STEER_TIMEOUT_MS = 35_000;


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


interface ReplayRecord {
  readonly turn: ConversationTurn;
  readonly events: ConversationEvent[];
}

function wireHistoryOpenFailure(reason: ConversationOpenFailureReason): {
  code: string;
  message: string;
} {
  switch (reason) {
    case "private":
      return { code: "private_session_not_readable", message: "不保存的对话不会留下历史。" };
    case "not_found":
      return { code: "conversation_not_found", message: "找不到这段对话。" };
    case "scope_mismatch":
      return { code: "scope_mismatch", message: "这段对话不在当前范围。" };
    case "archived":
      return { code: "conversation_archived", message: "这段对话已删除，不能继续。" };
  }
}

function wireHistoryArchiveFailure(reason: ConversationArchiveFailureReason): {
  code: string;
  message: string;
} {
  switch (reason) {
    case "private":
      return {
        code: "private_session_not_deletable",
        message: "不保存的对话不会留下历史，也无需删除。",
      };
    case "scope_not_supported":
      return { code: "scope_not_supported", message: "只能删除「我的」历史对话。" };
    case "not_found":
      return { code: "conversation_not_found", message: "找不到这段对话。" };
    case "scope_mismatch":
      return { code: "scope_mismatch", message: "这段对话不在当前范围。" };
    case "archive_failed":
      return { code: "history_delete_failed", message: "删除失败，原对话仍保留。" };
  }
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
  /**
   * Transitional full kernel. History list/open/archive go through
   * `kernel.conversations`; other domains still depend on the complete object.
   */
  readonly kernel: YishuKernel;
  private readonly taskTrackers = new Map<string, RuntimeTaskProgressTracker>();
  private readonly suggestionTrackers = new Map<string, RuntimeSuggestionTracker>();
  private readonly activeRequestIds = new Set<string>();
  private readonly pendingStartTraceByRequestId = new Map<string, string>();
  private readonly cancelledPendingRequestIds = new Set<string>();
  private readonly activeTurns = new Map<string, TurnLedgerState>();
  private readonly activeTurnOperations = new Set<Promise<void>>();
  private readonly conversationAdmissionTails = new Map<string, Promise<void>>();
  /** Last effective model per Main conversation; a change forces cold Kernel-history rebuild. */
  private readonly conversationModelKeys = new Map<string, string>();
  private trailObservationTail: Promise<void> = Promise.resolve();
  /** Runtime side of delegated execution; public like `kernel` for tests/UI seams. */
  readonly delegation: DelegationCoordinator;
  private readonly browserSessions: BrowserSessionHub;
  private ledgerTail: Promise<void> = Promise.resolve();
  private readonly recoveryReady: Promise<void>;
  private activeTrailScopeKey: string | undefined;
  private taskPresenceSink: ((update: DelegatedTaskPresenceUpdate) => void) | undefined;
  /** Optional write-side memory extraction worker (ADR 0016 #3). */
  private readonly extractionModel: MemoryExtractionModel | undefined;
  /** Vendored EverOS HTTP port. When set, it owns extraction and recall candidates. */
  private readonly everos: EverOSMemoryPort | undefined;
  /** Session-aware write boundary for the EverOS port. */
  private readonly everosIngestion: EverOSIngestionCoordinator | undefined;
  /** Optional same-turn spoken excerpt (voice mouth, not memory). */
  private readonly speechExcerptModel: SpeechExcerptModel | undefined;
  private extractionDrainScheduled = false;
  private extractionDrainTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly visibleReady: Promise<void>;

  /** Forward the optional auth capability without making the kernel own OAuth. */
  get authService(): YishuAuthService | undefined {
    return (this.inner as AgentRuntime & { authService?: YishuAuthService }).authService;
  }

  constructor(
    private readonly inner: AgentRuntime,
    kernel: YishuKernel = createDefaultProductKernel(),
    private readonly computerUsePort?: ComputerUsePort,
    options: {
      memoryExtractionModel?: MemoryExtractionModel;
      speechExcerptModel?: SpeechExcerptModel;
      everos?: EverOSMemoryPort;
      everosIdleMs?: number;
      everosPendingStore?: EverOSPendingSessionStore;
    } = {},
  ) {
    this.kernel = kernel;
    this.browserSessions = new BrowserSessionHub(openStagehandDriver);
    this.speechExcerptModel = options.speechExcerptModel;
    this.everos = options.everos;
    this.everosIngestion = options.everos === undefined
      ? undefined
      : new EverOSIngestionCoordinator(options.everos, {
          ...(options.everosIdleMs === undefined ? {} : { idleMs: options.everosIdleMs }),
          ...(options.everosPendingStore === undefined
            ? {}
            : { pendingStore: options.everosPendingStore }),
        });
    // Runtime side of delegated execution (RFC v2 / ADR 0009): child turns run
    // directly on the inner harness with their own conversation identity; the
    // kernel keeps the only task-status truth.
    this.delegation = new DelegationCoordinator({
      kernel,
      executeTurn: (command, emit) => this.inner.startTurn(command, emit),
      cancelTurn: (command, emit) => this.inner.cancelTurn(command, emit),
      ...(this.everosIngestion === undefined
        ? {}
        : {
            onSettledTask: (task) => {
              if (this.everosIngestion === undefined) return;
              void ingestVerifiedTaskLearning(this.everosIngestion, task)
                .catch(() => undefined);
            },
          }),
      ...("releaseConversationSession" in this.inner
        && typeof (this.inner as { releaseConversationSession?: unknown }).releaseConversationSession === "function"
        ? {
            releaseConversationSession: (conversationId: string) => {
              void this.browserSessions.close(conversationId);
              (this.inner as unknown as { releaseConversationSession(id: string): void })
                .releaseConversationSession(conversationId);
            },
          }
        : {}),
      browser: this.browserSessions,
    });
    this.recoveryReady = this.recoverDurableDelegationState();
    // Additive seam: YishuLoopRuntimeAdapter asks this coordinator for the session
    // tool policy at the createSession boundary (Main keeps computer_control,
    // web_search, and delegate; delegated children get web_search but neither
    // computer_control nor recursive delegate). Other AgentRuntime
    // implementations simply lack the method. The policy stays structurally
    // typed so model-loop tool types never leak into this product wrapper.
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
    // renders engine-observable facts only. Turn memory is assembled here
    // from the per-turn recall cache — never re-attached onto the command.
    (
      this.inner as {
        setTurnContextProviderFactory?: (factory: TurnContextProviderFactory) => void;
      }
    ).setTurnContextProviderFactory?.((scopeKind, conversationId) => ({
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
      assembleTurnMemory: async () => {
        if (scopeKind === "private") return undefined;
        const state = this.activeTurnForConversation(conversationId);
        const recalled = state?.recalledMemories ?? [];
        if (recalled.length === 0) return undefined;
        return formatTurnMemoryBlock(recalled.map(toPromptMemorySnippet));
      },
      statusBar: async (state) => formatEngineStatusBar(state),
    }));
    // ADR 0016 #3: write-side extraction worker. Startup drain replays
    // pending/failed rows from before a crash; every enqueue schedules the
    // next drain. Turns never wait for extraction.
    if (
      this.everos === undefined
      && this.kernel.memory !== undefined
      && options.memoryExtractionModel !== undefined
    ) {
      this.extractionModel = options.memoryExtractionModel;
      void this.drainExtraction().catch(() => undefined);
    }
    this.visibleReady = this.hydrateVisibleMemory().catch(() => undefined);
  }

  private scheduleExtractionDrain(): void {
    if (this.extractionModel === undefined || this.disposed) return;
    if (this.extractionDrainScheduled) return;
    this.extractionDrainScheduled = true;
    this.extractionDrainTimer = setTimeout(() => {
      this.extractionDrainScheduled = false;
      this.extractionDrainTimer = undefined;
      void this.drainExtraction().catch(() => undefined);
    }, EXTRACTION_DRAIN_DELAY_MS);
  }

  private async drainExtraction(): Promise<void> {
    const memory = this.kernel.memory;
    if (memory === undefined || this.extractionModel === undefined || this.disposed) {
      return;
    }
    await runExtractionPass({
      queue: memory.queue,
      truth: memory.truth,
      store: memory.extraction,
      model: this.extractionModel,
      visible: memory.visible,
    });
  }

  /**
   * ADR 0017: ordinary turns and spoken/panel remember go to EverOS.
   * Homemade queue stays only when EverOS is not wired.
   */
  private enqueueMemoryExtraction(state: TurnLedgerState, replyText: string | undefined): void {
    if (this.disposed) return;
    if (this.everosIngestion !== undefined) {
      if (state.productAction !== undefined && state.productAction !== "remember") return;
      this.ingestEverOS(state, replyText);
      return;
    }
    // Enqueueing is independent of having a model in this process: rows stay
    // pending and replay wherever a model is wired (ADR 0016 #3).
    if (this.kernel.memory === undefined) return;
    if (state.productAction !== undefined) return;
    const scopeKey = memoryScopeForSession(state.sessionScope);
    if (scopeKey === null) return;
    const preference = state.command.payload.modelPreference;
    if (preference === undefined || replyText === undefined) return;
    const snapshot: ExtractionSnapshot = {
      turnId: state.command.requestId,
      conversationId: state.conversationId,
      scopeKey,
      utterance: state.command.payload.utterance,
      replyText,
      providerId: preference.provider,
      modelId: preference.model,
      capturedAt: new Date().toISOString(),
    };
    void this.kernel.memory.queue.enqueue(snapshot)
      .then(() => {
        // Only schedule a drain when this process can actually extract.
        if (this.extractionModel !== undefined) this.scheduleExtractionDrain();
      })
      .catch(() => undefined);
  }

  private ingestEverOS(state: TurnLedgerState, replyText: string | undefined): void {
    if (this.everosIngestion === undefined) return;
    const scopeKey = memoryScopeForSession(state.sessionScope);
    if (scopeKey === null) return;
    const utterance = state.command.payload.utterance;
    try {
      assertPersistableMemoryText(utterance, "memory utterance");
      if (replyText !== undefined) assertPersistableMemoryText(replyText, "memory reply");
    } catch {
      return;
    }
    const sessionId = state.conversationId;
    const messages = everosMessagesForTurn({
      utterance,
      ...(replyText === undefined ? {} : { replyText }),
    });
    void this.everosIngestion.ingest(
      { sessionId, scopeKey, messages },
      { flushNow: state.productAction === "remember" },
    )
      .catch(() => undefined);
  }

  private async hydrateVisibleMemory(): Promise<void> {
    const memory = this.kernel.memory;
    if (memory === undefined) return;
    const leftover = await readLegacyFactClaims(
      path.join(memory.truth.root, "personal", "facts", "preferences.md"),
    );
    await this.kernel.memories.hydrateVisible(leftover);
  }

  /** Wait for the constructor-started durable recovery without changing it. */
  async initialize(): Promise<void> {
    await this.recoveryReady;
    await this.visibleReady;
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
    const advances = await this.kernel.contextWatches.observeApplication({
      sessionScope,
      observedBundleId,
      occurredAt: command.payload.contextFrame.capturedAt,
      observationFrameId: command.payload.contextFrame.frameId,
    });
    for (const advance of advances) {
      const { watch } = advance;
      if (advance.kind === "armed") {
        this.emitTaskPresence({
          taskId: watch.taskId,
          parentId: watch.mandateId,
          mainConversationId: watch.mainConversationId,
          taskKind: "context_reminder",
          watchState: "armed",
          title: advance.taskTitle,
          status: "running",
          createdAt: watch.createdAt,
          updatedAt: watch.armedAt ?? command.payload.contextFrame.capturedAt,
        });
        continue;
      }

      // The store CAS has already committed watch + TaskTruth + ResultInbox.
      // Presence is intentionally emitted only afterwards and only by the CAS
      // winner, so repeated/concurrent samples cannot announce twice.
      const reminderTitle = `提醒：${watch.reminder}`;
      this.emitTaskPresence({
        taskId: watch.taskId,
        parentId: watch.mandateId,
        mainConversationId: watch.mainConversationId,
        taskKind: "context_reminder",
        watchState: "fired",
        title: reminderTitle,
        status: "done",
        createdAt: watch.createdAt,
        updatedAt: watch.firedAt ?? command.payload.contextFrame.capturedAt,
        resultKind: "completed",
        summary: reminderTitle,
        sequence: [],
      });
    }
  }

  /**
   * Read-only history list for the product UI. Never includes raw events,
   * screenshots, or hidden reasoning — only compact visible rows.
   * Product policy lives on kernel.conversations; this method maps wire in/out.
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
      const items = await this.kernel.conversations.list({
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
   * Product policy lives on kernel.conversations; this method maps wire in/out.
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
      const result = await this.kernel.conversations.open({
        conversationId: command.payload.conversationId,
        expectedScope,
      });
      if (!result.ok) {
        emit(runtimeEvent(
          "history.failed",
          command.requestId,
          command.traceId,
          wireHistoryOpenFailure(result.reason),
        ));
        return;
      }
      const { conversation, turns } = result;
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
          turns: turns.map((turn) => ({
            id: turn.id,
            sequence: turn.sequence,
            status: turn.status,
            createdAt: turn.createdAt,
            updatedAt: turn.updatedAt,
            ...(turn.userInput !== undefined ? { userInput: turn.userInput } : {}),
            ...(turn.assistantOutput !== undefined
              ? { assistantOutput: turn.assistantOutput }
              : {}),
          })),
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
   * Product policy lives on kernel.conversations; this method maps wire in/out.
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
      const result = await this.kernel.conversations.archivePersonal({
        conversationId: command.payload.conversationId,
        expectedScope,
      });
      if (!result.ok) {
        emit(runtimeEvent(
          "history.failed",
          command.requestId,
          command.traceId,
          wireHistoryArchiveFailure(result.reason),
        ));
        return;
      }
      emit(runtimeEvent(
        "history.deleted",
        command.requestId,
        command.traceId,
        {
          conversationId: result.conversationId,
          status: result.status,
          sessionScope: result.sessionScope,
          alreadyArchived: result.alreadyArchived,
        },
        result.conversationId,
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
      const items = await this.kernel.memories.list({
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
      const result = await this.kernel.memories.forget({
        id: command.payload.memoryId,
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

  /**
   * Panel note write. Uses the product remember action (same store as
   * spoken「记住…」). Empty text never reaches here; unverified writes
   * are not reported as success.
   */
  async rememberMemory(command: MemoryRememberCommand, emit: RuntimeEventSink): Promise<void> {
    if (this.disposed) {
      emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
        code: "runtime_disposed",
        message: "这次没有记下。",
      }));
      return;
    }
    try {
      const sessionScope = normalizeSessionScope(command.payload.sessionScope);
      if (sessionScope.kind === "private") {
        emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
          code: "private_session_not_writable",
          message: "不保存的对话里不会记下长期内容。",
        }));
        return;
      }
      if (sessionScope.kind !== "personal") {
        emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
          code: "scope_not_supported",
          message: "只能在「我的」里记下。",
        }));
        return;
      }
      const memoryScope = memoryScopeForSession(sessionScope);
      if (memoryScope === null) {
        emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
          code: "scope_not_supported",
          message: "只能在「我的」里记下。",
        }));
        return;
      }
      const text = command.payload.text.trim();
      if (text.length === 0) {
        emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
          code: "empty_text",
          message: "先写一句再记下。",
        }));
        return;
      }
      const receipt = await this.kernel.registry.invoke("remember", {
        caller: "ui",
        input: {
          claim: text,
          scope: memoryScope,
          source: "conversation",
          confidence: 0.95,
        },
      });
      const output = asRecord(receipt.output);
      const memoryId = typeof output.id === "string" ? output.id : undefined;
      if (receipt.status === "verified" && memoryId !== undefined) {
        if (this.everosIngestion !== undefined) {
          const sessionId = `note-${memoryId}`;
          void this.everosIngestion.ingest({
            sessionId,
            scopeKey: memoryScope,
            messages: everosMessagesForTurn({ utterance: text }),
          }, { flushNow: true })
            .catch(() => undefined);
        }
        const item = await this.kernel.memories.findVisible({
          id: memoryId,
          scope: memoryScope,
        });
        if (item === undefined) {
          emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
            code: "memory_unconfirmed",
            message: "可能记下了，但我没能确认。",
          }));
          return;
        }
        emit(runtimeEvent("memory.remembered", command.requestId, command.traceId, {
          memoryId: item.id,
          summary: item.summary,
          capturedAt: item.capturedAt,
          source: item.source,
          scope: item.scope,
          confirmed: true,
        }));
        return;
      }
      const maybeWritten = receipt.status === "cancelled_after_commit"
        || memoryId !== undefined;
      emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
        code: maybeWritten ? "memory_unconfirmed" : "memory_remember_failed",
        message: maybeWritten
          ? "可能记下了，但我没能确认。"
          : "这次没有记下。",
      }));
    } catch {
      emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
        code: "memory_remember_failed",
        message: "这次没有记下。",
      }));
    }
  }

  /**
   * Same-turn spoken excerpt. Never echoes the visible essay on failure.
   */
  async excerptSpeech(command: SpeechExcerptCommand, emit: RuntimeEventSink): Promise<void> {
    if (this.disposed) {
      emit(runtimeEvent("speech.failed", command.requestId, command.traceId, {
        code: "runtime_disposed",
        message: "ProductKernelRuntime has been disposed.",
      }));
      return;
    }
    if (this.speechExcerptModel === undefined) {
      emit(runtimeEvent("speech.failed", command.requestId, command.traceId, {
        code: "excerpt_unavailable",
        message: "暂时无法抽出口播。",
      }));
      return;
    }
    try {
      const spokenText = await this.speechExcerptModel.excerpt({
        providerId: command.payload.modelPreference.provider,
        modelId: command.payload.modelPreference.model,
        visibleText: command.payload.visibleText,
      });
      const trimmed = spokenText.trim();
      if (!trimmed) {
        emit(runtimeEvent("speech.failed", command.requestId, command.traceId, {
          code: "excerpt_empty",
          message: "暂时无法抽出口播。",
        }));
        return;
      }
      emit(runtimeEvent("speech.excerpted", command.requestId, command.traceId, {
        spokenText: trimmed,
        provider: command.payload.modelPreference.provider,
        model: command.payload.modelPreference.model,
      }));
    } catch {
      emit(runtimeEvent("speech.failed", command.requestId, command.traceId, {
        code: "excerpt_failed",
        message: "暂时无法抽出口播。",
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
        this.conversationModelKeys.delete(previous.conversationId.toLowerCase());
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
      const intent = intentForUtterance(
        command.payload.utterance,
        command.payload.contextFrame,
      );
      const modelRouting = resolveTurnModelRouting(
        command,
        intent,
        isCurrentPageActionsNoteUtterance(command.payload.utterance),
      );
      state = {
        command: modelRouting.command,
        conversationId,
        traceId: command.traceId,
        emit,
        seenEventIds: new Set<string>(),
        sessionScope,
        durable: sessionScope.kind !== "private",
        productActionCancelRequested: false,
        interruptEligible:
          command.payload.capabilityProfile === "conversation"
          && intent.steerable,
        generation: 1,
        effectsStarted: false,
        effectsBlocked: false,
        interruptPending: false,
        steerSubmitted: false,
        supersedeRequested: false,
        innerStarted: false,
        terminalDelivered: false,
        intent,
        ...(modelRouting.decision === undefined
          ? {}
          : { modelRouting: modelRouting.decision }),
        contract: taskExecutionContractForIntent(intent),
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

    const intentRoute = state.intent.route;
    if (intentRoute.kind === "model") {
      await this.runInnerTurn(state);
      return;
    }
    if (intentRoute.kind === "clarify") {
      await this.completeSpokenProductReply(state, RELATIVE_TIME_REMINDER_CLARIFY_SPEECH);
      return;
    }

    if (state.sessionScope.kind === "private") {
      await this.completePrivateProductActionBlock(state);
      return;
    }

    const route = intentRoute.value;
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
    if (recordConversationModel(
      this.conversationModelKeys,
      state.conversationId,
      state.command.payload.modelPreference,
    )) this.releaseInnerConversationSession(state.conversationId);
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
      // retrieval never pretends a memory was used. The engine later prepends
      // the cached block via assembleTurnMemory (ADR 0015 PR-2).
      const recalled = await this.recallForOrdinaryTurn(state);
      state.recalledMemories = recalled;
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
      commandForInner = attachBehaviorRules(commandForInner, behaviorRules);
      commandForInner = attachRecalledMind(commandForInner, mindLessons);
      commandForInner = attachDelegatedResults(commandForInner, delegatedResults);
      commandForInner = attachRecentTrail(commandForInner, recentTrail);
      commandForInner = attachTurnIntentFrame(commandForInner, state.intent);
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

  private async completeSpokenProductReply(state: TurnLedgerState, text: string): Promise<void> {
    this.acceptRuntimeEvent(
      state,
      runtimeEvent("turn.started", state.command.requestId, state.traceId, {
        capabilityProfile: state.command.payload.capabilityProfile,
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
    route: ProductUtteranceRoute,
  ): Promise<void> {
    const { command } = state;
    // ADR 0016 #5: product-action turns never enqueue memory extraction —
    // their ledger receipts are already the task truth.
    state.productAction = route.action;
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

      // ADR 0015 #4: remember_how may have promoted a verified skill, which
      // changes the L1 catalog. Retire cached harness sessions so the next
      // turn cold-starts with the new system prefix. Applies even when the
      // receipt later resolves to cancelled_after_commit — the promotion is
      // durable either way.
      if (
        actionRoute.action === "remember_how"
        && (receipt.output as { skill?: unknown } | undefined)?.skill
      ) {
        (this.inner as { invalidateSkillSessions?: () => void })
          .invalidateSkillSessions?.();
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
        actionRoute.action === "watch_app_return"
        && (receipt.status === "ok" || receipt.status === "verified")
      ) {
        this.emitCreatedContextWatchPresence(receipt.output);
      }

      const speech = formatProductActionSpeech(
        actionRoute.action,
        receipt.status,
        speechOutputForProductAction(actionRoute, receipt.output),
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
    const steerIntent = intentForUtterance(
      command.payload.message,
      state.command.payload.contextFrame,
    );
    if (!steerIntent.steerable) {
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

    const cancelledAt = new Date().toISOString();
    const cancelled = await this.kernel.contextWatches.cancelTask({
      taskId: command.payload.taskId,
      mainConversationId: command.payload.mainConversationId,
      cancelledAt,
    });
    if (cancelled === null) return false;
    const { task, watch } = cancelled;
    this.emitTaskPresence({
      taskId: task.id,
      parentId: watch.mandateId,
      mainConversationId: watch.mainConversationId,
      taskKind: "context_reminder",
      watchState: "cancelled",
      title: task.title,
      status: "cancelled",
      createdAt: task.createdAt,
      updatedAt: cancelled.cancelledAt,
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
    void this.browserSessions.dispose();
    const everosDispose = this.everosIngestion?.dispose().catch(() => undefined)
      ?? Promise.resolve();
    if (this.extractionDrainTimer !== undefined) {
      clearTimeout(this.extractionDrainTimer);
      this.extractionDrainTimer = undefined;
    }
    this.kernel.memory?.queue.close?.();
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
      everosDispose,
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
    // ADR 0016 #3: fire-and-forget extraction enqueue after the durable
    // terminal write; the turn has already settled for the user.
    this.enqueueMemoryExtraction(state, text);
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
      const opened = await this.kernel.conversations.open({
        conversationId: state.conversationId,
        expectedScope: state.sessionScope,
        completedOnly: true,
      });
      if (!opened.ok) {
        return [];
      }
      const turns = opened.turns
        .filter((turn) => turn.status === "completed")
        .map((turn) => ({
          ...turn,
          conversationId: opened.conversation.id,
          sessionScope: opened.conversation.sessionScope,
        }));
      return boundedConversationHistory(
        turns.sort((left, right) => left.sequence - right.sequence),
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
    const merged: RecalledMemory[] = [];
    const seen = new Set<string>();
    const pushAll = (rows: readonly RecalledMemory[]): void => {
      for (const row of rows) {
        const key = row.claim.replace(/\s+/gu, " ").trim().toLowerCase();
        if (key.length === 0 || seen.has(key)) continue;
        seen.add(key);
        merged.push(row);
      }
    };

    // The one visible file is the personal projection. Project memory must
    // come from its scoped index/engine, never from personal markdown.
    const visible = scope === "personal" ? this.kernel.memory?.visible : undefined;
    let visibleUsed = false;
    let authority: VisibleMemoryAuthoritySnapshot | undefined;
    let derivedRecallAllowed = true;
    if (visible !== undefined) {
      if (await visible.exists()) {
        visibleUsed = true;
        try {
          authority = await visible.reconcileAuthority();
          pushAll(recallFromVisibleFacts(
            authority.facts,
            state.command.payload.utterance,
            { scope },
          ));
        } catch {
          derivedRecallAllowed = false;
          try {
            pushAll(recallFromVisibleFacts(
              await visible.listFacts(),
              state.command.payload.utterance,
              { scope },
            ));
          } catch {
            // The visible authority surface is unreadable; use no durable memory.
          }
        }
      }
    }

    if (!derivedRecallAllowed) return merged;

    const acceptedDerived = (rows: readonly RecalledMemory[]): RecalledMemory[] =>
      acceptScopedDerivedMemories(rows, scope, authority);

    if (this.everos !== undefined) {
      try {
        pushAll(acceptedDerived(await this.everos.profile({ scopeKey: scope })));
      } catch {
        // Derived profile facts are optional; a miss must not skip other memory.
      }
      try {
        pushAll(acceptedDerived(await this.everos.search({
          scopeKey: scope,
          query: state.command.payload.utterance,
        })));
        return merged;
      } catch {
        // Fall through to the store index if EverOS is down.
      }
    }

    if (!visibleUsed) {
      try {
        pushAll(await this.kernel.memories.recall(
          state.command.payload.utterance,
          { scope },
        ));
      } catch {
        return merged;
      }
    }
    return merged;
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

  private activeTurnForConversation(conversationId: string): TurnLedgerState | undefined {
    const key = conversationId.toLowerCase();
    let found: TurnLedgerState | undefined;
    for (const state of this.activeTurns.values()) {
      if (state.conversationId.toLowerCase() !== key) continue;
      if (state.terminalKind) continue;
      found = state;
    }
    return found;
  }

  private emitMemoryUsed(
    state: TurnLedgerState,
    memories: readonly RecalledMemory[],
  ): void {
    // Standing persona shapes speech every turn. It is not a "used a memory" notice.
    const announced = memories.filter((memory) => !isEverOSProfileMemory(memory));
    if (announced.length === 0) return;
    // Flat, bounded payload only: IDs, short summaries, source, time, scope.
    const payload: Record<string, string | number | boolean | null> = {
      count: announced.length,
    };
    for (const [index, memory] of announced.entries()) {
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
