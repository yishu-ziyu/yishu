import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  createYishuAgentSession,
  createYishuProviderRuntime,
  isFirstByteTimeoutError,
  type AnyToolDefinition,
  type ModelProviderRuntime,
  type ModelSession,
  type ResolvedModel,
  type ToolDefinition,
  type TurnContextProviderFactory,
} from "./model-loop/index.js";
import {
  AssistantOutputGenerationProjector,
  attachObservationalPointDirective,
  isDirectComputerActionUtterance,
} from "./assistant-output.js";
import { intentAllowsComputerEffect } from "./intent-frame.js";
import {
  createComputerControlTool,
  type ComputerControlToolAction,
} from "./computer-control-tool.js";
import { createDesktopLoopState, type DesktopLoopState } from "./desktop/desktop-loop.js";
import {
  authorizedTextForUtterance,
  computerActionCompletionText,
  desktopActionBudgetForTurn,
  digestComputerControlAction,
  nextDesktopObservation,
  observationFromContextFrame,
  rememberUnknownCommit,
  shouldRunCompatibilityComputerAction,
  unknownCommitBlocksRetry,
  withFreshObservation,
} from "./desktop/computer-turn.js";
import { desktopStepBudget } from "./desktop/desktop-policy.js";

export {
  authorizedTextForUtterance,
  computerActionCompletionText,
  computerActionLimitForUtterance,
  desktopActionBudgetForTurn,
  isDesktopWorkUtterance,
  isExplicitTextInputUtterance,
  shouldRunCompatibilityComputerAction,
} from "./desktop/computer-turn.js";
import { isCurrentPageActionsNoteUtterance } from "./delegation.js";
import { DEFAULT_SESSION_TOOL_POLICY, type SessionToolPolicy } from "./session-policy.js";
import {
  ComputerActionError,
  UnavailableComputerUsePort,
  type ComputerActionResult,
  type ComputerUsePort,
} from "./computer-use-port.js";
import { buildGroundedPrompt, screenshotDimensionCaption } from "./context-prompt.js";
import { YISHU_SYSTEM_PROMPT } from "./persona.js";
import {
  safeRuntimeErrorMessage,
  YishuAuthService,
  type AuthTransitionKind,
} from "./auth-service.js";
import { createYishuCredentialStore } from "./auth-store.js";
import { readModelConfigSync } from "./model-config.js";
import type { AuthProviderId } from "./auth-protocol.js";
import {
  LOCAL_GROK_BASE_URL,
  LOCAL_GROK_DEFAULT_MODEL,
  LOCAL_GROK_PROVIDER,
  modelPreferenceSchema,
  runtimeEvent,
  type CapabilityProfile,
  type ComputerAction,
  type ModelPreference,
  type TurnCancelCommand,
  type TurnInterruptCommand,
  type TurnStartCommand,
  type TurnSteerCommand,
} from "./protocol.js";
import type { AgentRuntime, RuntimeEventSink } from "./runtime-port.js";
import { evaluateActionBoundary, taskExecutionContractFromCommand } from "./task-contract.js";
import {
  normalizeSessionScope,
  sessionScopeKey,
  type SessionScope,
  type TaskExecutionContract,
} from "@yishu/kernel";
import { markTrustedExternalReceipt } from "./trusted-task-receipt.js";

type RuntimeModel = ResolvedModel;
const SESSION_ABORT_TIMEOUT_MS = 2_000;
const INTERRUPTION_STEER_TIMEOUT_MS = 30_000;

interface DeferredSignal {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

interface SteerCycle {
  readonly generation: number;
  readonly submitted: DeferredSignal;
  readonly supersededSignal: DeferredSignal;
  readonly deadlineAt: number;
  operation?: Promise<void>;
  text?: string;
  userObserved?: boolean;
  assistantStarted?: boolean;
  superseded?: boolean;
}

function deferredSignal(): DeferredSignal {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function abortSessionWithin(session: ModelSession): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SESSION_ABORT_TIMEOUT_MS);
  });
  try {
    await Promise.race([session.abort().catch(() => undefined), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface ActiveComputerTurn {
  requestId: string;
  traceId: string;
  intentId: string;
  basisFrameId: string;
  directComputerAction: boolean;
  authorizedText?: string;
  allowedActionSequence: Array<"set_text" | "left_click">;
  actionBudget: number;
  frontmostTarget?: {
    targetBundleId: string;
    targetPid: number;
  };
  contract?: TaskExecutionContract;
  emit: RuntimeEventSink;
  actionCount: number;
  allActionsVerified: boolean;
  lastResult?: ComputerActionResult;
  generationState?: PiTurnGenerationState;
  desktop: DesktopLoopState;
}

interface AssistantMessageIdentity {
  role?: string;
  timestamp?: number;
  responseId?: string;
  provider?: string;
  model?: string;
  content?: string | Array<{ type?: string; text?: string }>;
}

type InterruptDecision = {
  accepted: true;
  interruptedGeneration: number;
  nextGeneration: number;
} | {
  accepted: false;
  generation: number;
  reason: "generation_mismatch" | "effect_already_dispatched" | "terminal";
};

class SteerReplacementFailedBeforeStartError extends Error {
  constructor() {
    super("Pi replacement failed before producing an assistant response.");
    this.name = "SteerReplacementFailedBeforeStartError";
  }
}

function assistantMessageIdentity(message: AssistantMessageIdentity | undefined): string | undefined {
  if (message?.role !== "assistant"
    || typeof message.responseId !== "string"
    || message.responseId.length === 0) return undefined;
  return JSON.stringify([
    message.responseId,
    message.provider ?? "",
    message.model ?? "",
  ]);
}

function userMessageText(message: AssistantMessageIdentity | undefined): string | undefined {
  if (message?.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content.trim();
  const text = message.content
    ?.filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
  return text && text.length > 0 ? text : undefined;
}

/**
 * Synchronous per-turn arbiter for presentation generations and irreversible
 * effect dispatch. JavaScript runs each method without an await boundary: an
 * interrupt either advances the floor first, or observes the already-latched
 * effect and rejects. It can never acknowledge an interrupt and dispatch the
 * old generation afterwards.
 */
class PiTurnGenerationState {
  readonly output = new AssistantOutputGenerationProjector();
  private readonly generationByMessage = new Map<string, number>();
  private readonly steerCycles = new Map<number, SteerCycle>();
  private readonly textByGeneration = new Map<number, string>();
  private readonly directActionByGeneration = new Map<number, boolean>();
  private readonly effectsAllowedByGeneration = new Map<number, boolean>();
  private readonly generationByToolCall = new Map<string, number>();
  private initialMessageUnbound = true;
  private initialUserBoundaryPassed = false;
  private authoritativeGeneration = 1;
  private currentAssistantGeneration: number | undefined;
  private lastAssistantGeneration: number | undefined;
  private effectDispatchGeneration: number | undefined;
  private nextAssistantGeneration: number | undefined;
  private readonly initialPromptAdmitted = deferredSignal();
  private terminal = false;
  private lastEndedGeneration: number | undefined;

  constructor(
    initialDirectAction: boolean,
    initialEffectsAllowed: boolean,
    private readonly interruptionSteerTimeoutMs = INTERRUPTION_STEER_TIMEOUT_MS,
  ) {
    const generation = this.output.beginGeneration();
    this.directActionByGeneration.set(generation, initialDirectAction);
    this.effectsAllowedByGeneration.set(generation, initialEffectsAllowed);
    this.textByGeneration.set(generation, "");
    // The initial prompt normally consumes this signal itself. Keep a
    // rejection observer attached for the preflight-false path where no steer
    // was submitted and therefore nobody else awaits the barrier.
    void this.initialPromptAdmitted.promise.catch(() => undefined);
  }

  markInitialPromptAdmitted(): void {
    this.initialPromptAdmitted.resolve();
  }

  rejectInitialPrompt(error: Error): void {
    this.initialPromptAdmitted.reject(error);
  }

  async awaitInitialPromptAdmitted(): Promise<void> {
    await this.initialPromptAdmitted.promise;
  }

  get currentGeneration(): number {
    return this.authoritativeGeneration;
  }

  beginAssistantMessage(message: AssistantMessageIdentity | undefined): number | undefined {
    const identity = assistantMessageIdentity(message);
    if (message?.role !== "assistant") return undefined;
    let generation: number;
    if (this.initialMessageUnbound) {
      this.initialMessageUnbound = false;
      this.initialUserBoundaryPassed = true;
      generation = this.output.ensureGeneration();
    } else if (this.nextAssistantGeneration !== undefined) {
      generation = this.nextAssistantGeneration;
      this.output.beginGeneration(generation);
      this.directActionByGeneration.set(generation, false);
      this.effectsAllowedByGeneration.set(generation, false);
      this.textByGeneration.set(generation, "");
      this.nextAssistantGeneration = undefined;
      const cycle = this.steerCycles.get(generation);
      if (cycle !== undefined) cycle.assistantStarted = true;
    } else {
      // Provider tool continuations still belong to the same user reply. An
      // assistant message only becomes a new product generation after Pi has
      // visibly injected the admitted steering user message.
      generation = this.output.ensureGeneration();
    }
    this.currentAssistantGeneration = generation;
    if (identity !== undefined) this.rememberAssistantIdentity(identity, generation);
    return generation;
  }

  observeUserMessage(message: AssistantMessageIdentity | undefined): void {
    const text = userMessageText(message);
    if (text === undefined) return;
    if (!this.initialUserBoundaryPassed) {
      // The first Pi user message belongs to the original prompt, even when a
      // barge-in was accepted during prompt preflight and the utterance text is
      // identical. Subsequent exact matches may be admitted steering input.
      this.initialUserBoundaryPassed = true;
      return;
    }
    for (const cycle of [...this.steerCycles.values()].sort((a, b) => a.generation - b.generation)) {
      if (cycle.userObserved
        || cycle.superseded && cycle.operation === undefined
        || cycle.text === undefined
        || cycle.text !== text
        || !this.canObserveSteerUser(cycle.generation)) continue;
      cycle.userObserved = true;
      // Pi may drain multiple queued steering messages into one provider run.
      // Until an assistant starts, the newest observed user message owns that
      // single response generation.
      this.nextAssistantGeneration = cycle.generation;
      return;
    }
  }

  observeAssistantMessageEnd(message: AssistantMessageIdentity | undefined): void {
    const generation = this.generationForMessage(message);
    if (generation === undefined) return;
    this.lastAssistantGeneration = generation;
    if (this.currentAssistantGeneration === generation) {
      this.currentAssistantGeneration = undefined;
    }
  }

  observeTurnEnd(message: AssistantMessageIdentity | undefined): void {
    const identity = assistantMessageIdentity(message);
    if (identity !== undefined) {
      const known = this.generationByMessage.get(identity);
      if (known !== undefined && known > 0) {
        this.lastEndedGeneration = Math.max(this.lastEndedGeneration ?? 0, known);
        this.lastAssistantGeneration = known;
        return;
      }
    }
    const generation = this.lastAssistantGeneration
      ?? this.currentAssistantGeneration
      ?? this.output.currentGeneration;
    if (generation !== undefined) {
      this.lastEndedGeneration = Math.max(this.lastEndedGeneration ?? 0, generation);
    }
  }

  generationForMessage(message: AssistantMessageIdentity | undefined): number | undefined {
    const identity = assistantMessageIdentity(message);
    if (identity !== undefined) {
      const known = this.generationByMessage.get(identity);
      if (known !== undefined) return known > 0 ? known : undefined;
    }
    if (this.initialMessageUnbound) {
      this.initialMessageUnbound = false;
      const generation = this.output.ensureGeneration();
      this.currentAssistantGeneration = generation;
      if (identity !== undefined) this.rememberAssistantIdentity(identity, generation);
      return generation;
    }
    if (identity !== undefined && this.currentAssistantGeneration !== undefined) {
      this.rememberAssistantIdentity(identity, this.currentAssistantGeneration);
      const known = this.generationByMessage.get(identity);
      return known !== undefined && known > 0 ? known : undefined;
    }
    return this.currentAssistantGeneration ?? this.output.currentGeneration;
  }

  appendText(generation: number, text: string): void {
    if (!this.output.accepts(generation) || text.length === 0) return;
    this.textByGeneration.set(generation, (this.textByGeneration.get(generation) ?? "") + text);
  }

  text(generation = this.currentGeneration): string {
    return this.textByGeneration.get(generation) ?? "";
  }

  isDirectAction(generation = this.currentGeneration): boolean {
    return this.directActionByGeneration.get(generation) === true;
  }

  interrupt(expectedGeneration: number): InterruptDecision {
    const generation = this.authoritativeGeneration;
    if (this.terminal) return { accepted: false, generation, reason: "terminal" };
    if (expectedGeneration !== generation) {
      return { accepted: false, generation, reason: "generation_mismatch" };
    }
    if (this.effectDispatchGeneration === generation) {
      return { accepted: false, generation, reason: "effect_already_dispatched" };
    }
    const interrupted = this.output.interruptGeneration(generation);
    const interruptedCycle = this.steerCycles.get(generation);
    if (interruptedCycle !== undefined) {
      interruptedCycle.superseded = true;
      interruptedCycle.supersededSignal.resolve();
      if (interruptedCycle.operation === undefined) interruptedCycle.submitted.resolve();
    }
    this.authoritativeGeneration = interrupted.nextGeneration;
    const cycle: SteerCycle = {
      generation: interrupted.nextGeneration,
      submitted: deferredSignal(),
      supersededSignal: deferredSignal(),
      deadlineAt: Date.now() + this.interruptionSteerTimeoutMs,
    };
    void cycle.supersededSignal.promise.catch(() => undefined);
    this.steerCycles.set(cycle.generation, cycle);
    return { accepted: true, ...interrupted };
  }

  admitConversationSteer(
    message: string,
    nextGeneration: number,
    operation: () => Promise<void>,
  ): number | undefined {
    const cycle = this.steerCycles.get(nextGeneration);
    if (this.terminal
      || cycle === undefined
      || cycle.superseded
      || cycle.operation !== undefined
      || this.authoritativeGeneration !== nextGeneration) return undefined;
    cycle.text = message.trim();
    cycle.operation = Promise.resolve().then(operation);
    // The turn owns and awaits the operation; attach an immediate rejection
    // observer so a provider preflight failure cannot become unhandled first.
    void cycle.operation.catch(() => undefined);
    cycle.submitted.resolve();
    return cycle.generation;
  }

  async awaitAdmittedReplacement(): Promise<void> {
    while (this.authoritativeGeneration > 1) {
      const targetGeneration = this.authoritativeGeneration;
      const cycle = this.steerCycles.get(targetGeneration);
      if (cycle === undefined) {
        throw new Error("Interrupted turn lost its conversational steer cycle.");
      }
      await this.awaitSteerSubmission(cycle);
      const operation = cycle.operation;
      if (operation === undefined) {
        if (cycle.superseded || this.authoritativeGeneration !== targetGeneration) continue;
        throw new Error("Interrupted turn ended without a conversational steer.");
      }
      let operationError: unknown;
      try {
        await this.awaitWithinCycleDeadline(cycle, operation);
      } catch (error) {
        operationError = error;
      }
      // A newer accepted barge-in supersedes this operation. The older prompt
      // may have carried the newer queued steer to completion, so join the
      // latest cycle instead of failing on the captured generation.
      if (this.authoritativeGeneration !== targetGeneration) continue;
      if (operationError !== undefined) {
        if (!cycle.assistantStarted) throw new SteerReplacementFailedBeforeStartError();
        throw operationError;
      }
      if (!cycle.assistantStarted) {
        throw new SteerReplacementFailedBeforeStartError();
      }
      if (!this.output.accepts(targetGeneration)) {
        throw new Error("Pi ended before producing the admitted steering response.");
      }
      return;
    }
  }

  beginEffectDispatch(): number | undefined {
    const generation = this.output.currentGeneration ?? this.authoritativeGeneration;
    if (this.terminal
      || !this.output.accepts(generation)
      || this.effectsAllowedByGeneration.get(generation) !== true) return undefined;
    this.effectDispatchGeneration = generation;
    return generation;
  }

  generationForToolStart(toolCallId: string | undefined): number {
    const generation = this.output.currentGeneration ?? this.authoritativeGeneration;
    if (toolCallId !== undefined) this.generationByToolCall.set(toolCallId, generation);
    return generation;
  }

  generationForToolEnd(toolCallId: string | undefined): number {
    const current = this.output.currentGeneration ?? this.authoritativeGeneration;
    if (toolCallId === undefined) return current;
    const generation = this.generationByToolCall.get(toolCallId) ?? current;
    this.generationByToolCall.delete(toolCallId);
    return generation;
  }

  accepts(generation: number): boolean {
    return !this.terminal && this.output.accepts(generation);
  }

  finish(): boolean {
    if (this.terminal || !this.output.accepts(this.authoritativeGeneration)) return false;
    this.terminal = true;
    return true;
  }

  private rememberAssistantIdentity(identity: string, generation: number): void {
    const known = this.generationByMessage.get(identity);
    if (known === undefined) {
      this.generationByMessage.set(identity, generation);
    } else if (known !== generation) {
      // A provider response id must never be reused to relabel stale output as
      // current. Zero is an internal fail-closed collision sentinel.
      this.generationByMessage.set(identity, 0);
    }
  }

  private canObserveSteerUser(generation: number): boolean {
    if (!this.initialUserBoundaryPassed || generation < 2) return false;
    for (let candidate = 2; candidate < generation; candidate += 1) {
      const predecessor = this.steerCycles.get(candidate);
      if (predecessor === undefined) return false;
      if (predecessor.assistantStarted) {
        if ((this.lastEndedGeneration ?? 0) < candidate) return false;
        continue;
      }
      if (!predecessor.userObserved
        && !(predecessor.superseded && predecessor.operation === undefined)) return false;
    }
    return true;
  }

  private async awaitSteerSubmission(cycle: SteerCycle): Promise<void> {
    await this.awaitWithinCycleDeadline(cycle, cycle.submitted.promise);
  }

  private async awaitWithinCycleDeadline(
    cycle: SteerCycle,
    operation: Promise<void>,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remaining = Math.max(0, cycle.deadlineAt - Date.now());
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Interrupted turn timed out waiting for conversational steer.")),
        remaining,
      );
    });
    try {
      await Promise.race([operation, cycle.supersededSignal.promise, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

interface ActiveProviderTurn {
  provider: AuthProviderId;
  requestId: string;
  session?: ModelSession;
  settled: Promise<void>;
  settle(): void;
  cancel(): Promise<void>;
}

class DuplicateRequestError extends Error {
  constructor() {
    super("A turn with this request id is already active.");
    this.name = "DuplicateRequestError";
  }
}

// This is deliberately not an API credential. The Clicky-owned loopback
// gateway terminates auth and forwards the request to the existing proxy.
// Supplying a stable non-secret value only satisfies pi-ai's OpenAI client
// requirement that a client key be present; no environment key is read here.
const LOCAL_PROXY_AUTH_SENTINEL =
  process.env.YISHU_VOICE_PROXY_TOKEN ?? "yishu-local-proxy-unavailable-sentinel";
delete process.env.YISHU_VOICE_PROXY_TOKEN;
if (process.env.YISHU_VOICE_PROXY_TOKEN !== undefined) {
  throw new Error("Voice proxy capability must not remain in the Pi process environment.");
}

/**
 * The single production provider runtime. Shared by the loop adapter and the
 * memory extraction model so extraction reuses the turn's provider OAuth
 * without a second credential surface (ADR 0016 #4).
 */
export function createDefaultProviderRuntime(): ModelProviderRuntime {
  return createYishuProviderRuntime({
    credentialStore: createYishuCredentialStore(),
    localGrokBearer: { value: () => LOCAL_PROXY_AUTH_SENTINEL },
    modelConfig: readModelConfigSync(),
  });
}

export function piSessionCacheKey(
  capabilityProfile: CapabilityProfile,
  preference: ModelPreference,
  generation: number,
  conversationId: string,
  sessionScope: SessionScope = { kind: "personal" },
  skillsVersion = 0,
): string {
  // Segment order matters: releaseConversationSession matches keys by the
  // trailing `:${conversationId}` suffix, so the skills version must precede
  // the conversation id (ADR 0015 #4).
  return `${capabilityProfile}:${preference.provider}:${generation}:${preference.model}:${sessionScopeKey(sessionScope)}:skills:${skillsVersion}:${conversationId}`;
}

/**
 * Optional injection seam for tests.  Both members default to the exact
 * production wiring: a product-owned local `ModelRuntime` and Pi's
 * `createYishuAgentSession`.  Callers that inject a model runtime still pass
 * through the OAuth provider policy install below.
 */
export interface YishuLoopRuntimeAdapterOptions {
  modelRuntimePromise?: Promise<ModelProviderRuntime>;
  createSession?: typeof createYishuAgentSession;
  interruptionSteerTimeoutMs?: number;
}

export class YishuLoopRuntimeAdapter implements AgentRuntime {
  private readonly workingDirectory: string;
  private readonly modelRuntimePromise: Promise<ModelProviderRuntime>;
  private readonly createSession: typeof createYishuAgentSession;
  private readonly interruptionSteerTimeoutMs: number;
  readonly authService: YishuAuthService;
  private readonly sessions = new Map<string, ModelSession>();
  private readonly activeSessionByRequestId = new Map<string, ModelSession>();
  private readonly sessionKeyByRequestId = new Map<string, string>();
  private readonly activeProviderTurns = new Map<string, ActiveProviderTurn>();
  private readonly activeGenerationByRequestId = new Map<string, PiTurnGenerationState>();
  private readonly activeGenerationBySessionKey = new Map<string, PiTurnGenerationState>();
  /**
   * A source-bound Notes write has crossed the physical dispatch boundary.
   * PTT still aborts Pi immediately, but must not discard the one pending
   * macOS receipt that tells us whether that irreversible write happened.
   */
  private readonly pageNoteReceiptReconciliations = new Set<string>();
  private computerUsePortDisposeDeferred = false;
  private readonly pendingRequestIds = new Set<string>();
  private readonly cancelledRequestIds = new Set<string>();
  private readonly activeTurnOperations = new Set<Promise<void>>();
  private readonly providerTransitions = new Set<AuthProviderId>();
  private readonly providerAuthGenerations = new Map<AuthProviderId, number>();
  /** Bumped by skill promotion; part of the session cache key (ADR 0015). */
  private skillsVersion = 0;
  /** Product-owned turn context providers (ADR 0015); unset keeps the engine bare. */
  private turnContextProviderFactory: TurnContextProviderFactory | undefined;
  private readonly activeComputerTurn = new AsyncLocalStorage<ActiveComputerTurn>();
  // Additive product seam: per-conversation session tool policy, decided at
  // the createSession boundary. Delegated child conversations receive neither
  // computer_control nor recursive delegate; the default keeps every session unchanged.
  private sessionToolPolicy: (conversationId: string) => SessionToolPolicy =
    () => DEFAULT_SESSION_TOOL_POLICY;
  private disposed = false;

  constructor(
    workingDirectory = process.cwd(),
    private readonly computerUsePort: ComputerUsePort = new UnavailableComputerUsePort(),
    options: YishuLoopRuntimeAdapterOptions = {},
  ) {
    this.workingDirectory = workingDirectory;
    this.createSession = options.createSession ?? createYishuAgentSession;
    this.interruptionSteerTimeoutMs = options.interruptionSteerTimeoutMs
      ?? INTERRUPTION_STEER_TIMEOUT_MS;
    // Keep provider/model state in this process. In particular, do not read
    // or write any global model catalog. OAuth state is product-owned under
    // Yishu/Auth/auth.json instead. The registry is OAuth-only by
    // construction; there is no ambient API-key path to strip.
    const modelRuntimePromise = options.modelRuntimePromise ?? Promise.resolve(
      createYishuProviderRuntime({
        credentialStore: createYishuCredentialStore(),
        localGrokBearer: { value: () => LOCAL_PROXY_AUTH_SENTINEL },
      }),
    );
    this.modelRuntimePromise = modelRuntimePromise;
    this.authService = new YishuAuthService(
      this.modelRuntimePromise as unknown as Promise<import("./auth-service.js").AuthModelRuntime>,
      {
        beginProviderTransition: (provider) => this.beginProviderTransition(provider),
        endProviderTransition: (provider, kind) => this.endProviderTransition(provider, kind),
      },
    );
  }

  /**
   * Additive seam for product-owned session tool policy (delegation V1,
   * ADR 0009). Called once per session creation; other runtimes simply lack
   * the method. The policy must stay cheap and synchronous.
   */
  setSessionToolPolicy(policy: (conversationId: string) => SessionToolPolicy): void {
    this.sessionToolPolicy = policy;
  }

  /**
   * ADR 0015 B architecture: the product layer supplies per-session turn
   * context providers (skill catalog / turn memory / status bar). Sessions
   * created after this call receive them; existing sessions keep theirs.
   */
  setTurnContextProviderFactory(factory: TurnContextProviderFactory): void {
    this.turnContextProviderFactory = factory;
  }

  /**
   * Skill promotion changed the L1 catalog: retire cached sessions so the
   * next turn cold-starts with the new system prefix (ADR 0015 #4).
   */
  invalidateSkillSessions(): void {
    this.skillsVersion += 1;
    for (const [key, session] of [...this.sessions.entries()]) {
      session.dispose();
      this.sessions.delete(key);
      this.activeGenerationBySessionKey.delete(key);
    }
  }

  beginPageNoteReceiptReconciliation(requestId: string): () => void {
    this.pageNoteReceiptReconciliations.add(requestId);
    return () => {
      this.pageNoteReceiptReconciliations.delete(requestId);
      this.disposeComputerUsePortIfReady();
    };
  }

  /**
   * Product calls this only after it has durably recorded the bounded unknown
   * outcome.  Until then a dispatched Notes request must keep its real receipt
   * alive even while the model session is being torn down.
   */
  abandonPageNoteReceiptReconciliation(requestId: string): void {
    if (!this.pageNoteReceiptReconciliations.delete(requestId)) return;
    this.computerUsePort.cancelRequest(requestId, "page_note_receipt_unknown");
    this.disposeComputerUsePortIfReady();
  }

  private disposeComputerUsePortIfReady(): void {
    if (!this.computerUsePortDisposeDeferred || this.pageNoteReceiptReconciliations.size > 0) return;
    this.computerUsePortDisposeDeferred = false;
    this.computerUsePort.dispose();
  }

  /**
   * Pi retains a session's complete tool registry for conversation continuity.
   * This activation list is therefore reset at every prompt boundary: a
   * current-page Note tool can exist in the registry but remains invisible on
   * all ordinary turns.
   */
  private activateToolsForTurn(
    session: ModelSession,
    policy: SessionToolPolicy,
  ): (() => void) | undefined {
    const registered = policy.registeredExtraTools ?? [];
    if (registered.length === 0) return undefined;
    const controllable = session as ModelSession & {
      getActiveToolNames?: () => readonly string[];
      setActiveToolsByName?: (names: readonly string[]) => void;
    };
    if (
      typeof controllable.getActiveToolNames !== "function"
      || typeof controllable.setActiveToolsByName !== "function"
    ) {
      throw new Error("Pi session does not support per-turn tool activation.");
    }
    const previous = [...controllable.getActiveToolNames()];
    const desired = previous.filter((name) => name !== "save_current_page_actions_to_note");
    if (policy.activeExtraToolNames?.includes("save_current_page_actions_to_note")) {
      desired.push("save_current_page_actions_to_note");
    }
    controllable.setActiveToolsByName(desired);
    return () => controllable.setActiveToolsByName!(previous);
  }

  private fenceEffectfulExtraTool(tool: ToolDefinition, sessionKey: string): ToolDefinition {
    if (!["delegate", "save_current_page_actions_to_note", "browser", "files"].includes(tool.name)) return tool;
    const execute = tool.execute.bind(tool);
    return {
      ...tool,
      execute: async (...args: Parameters<typeof tool.execute>) => {
        const activeTurn = this.activeComputerTurn.getStore();
        const generationState = activeTurn?.generationState
          ?? this.activeGenerationBySessionKey.get(sessionKey);
        if (generationState?.beginEffectDispatch() === undefined) {
          throw new Error(`${tool.name} was blocked because its assistant generation was interrupted.`);
        }
        const result = await execute(...args);
        if (tool.name === "save_current_page_actions_to_note" && activeTurn) {
          const details = result !== null && typeof result === "object" && "details" in result
            ? (result as { details?: unknown }).details
            : undefined;
          const dispatched = details !== null && typeof details === "object"
            && (details as { dispatched?: unknown }).dispatched === true;
          if (dispatched) {
            activeTurn.actionCount += 1;
            activeTurn.allActionsVerified &&= (details as { verified?: unknown }).verified === true;
          }
        }
        return result;
      },
    } as ToolDefinition;
  }

  /**
   * Synchronously detach every cached/active session for one conversation.
   * Used as the supersede fence before a replacement turn is admitted; the
   * old operation may still finish cleanup, but can no longer be reused.
   */
  releaseConversationSession(conversationId: string): void {
    const suffix = `:${conversationId}`;
    for (const [key, session] of this.sessions.entries()) {
      if (!key.endsWith(suffix)) continue;
      this.sessions.delete(key);
      this.activeGenerationBySessionKey.delete(key);
      for (const [requestId, activeSession] of this.activeSessionByRequestId.entries()) {
        if (activeSession !== session) continue;
        this.activeSessionByRequestId.delete(requestId);
        this.sessionKeyByRequestId.delete(requestId);
        this.cancelledRequestIds.add(requestId);
        this.activeGenerationByRequestId.delete(requestId);
        if (!this.pageNoteReceiptReconciliations.has(requestId)) {
          this.computerUsePort.cancelRequest(requestId, "turn_superseded");
        }
      }
      // Detachment is synchronous, so a replacement cannot reuse this Pi
      // session. Provider abort then gets the same bounded cleanup window as
      // explicit cancellation; dispose alone is not assumed to unblock prompt.
      void abortSessionWithin(session).finally(() => session.dispose());
    }
  }

  private evictSession(sessionKey: string, session: ModelSession): void {
    // A supersede/cancel fence may already have detached this exact object and
    // taken ownership of its bounded abort + dispose. The late runTurn finally
    // must not dispose the same provider session a second time.
    if (this.sessions.get(sessionKey) !== session) return;
    this.sessions.delete(sessionKey);
    this.activeGenerationBySessionKey.delete(sessionKey);
    session.dispose();
  }

  async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
    if (this.disposed) {
      emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
        code: "runtime_disposed",
        message: "YishuLoopRuntimeAdapter has been disposed.",
      }));
      return;
    }
    if (this.hasActiveRequest(command.requestId)) {
      emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
        code: "duplicate_request",
        message: "A turn with this request id is already active.",
      }));
      return;
    }

    this.pendingRequestIds.add(command.requestId);
    const operation = this.runTurn(command, emit);
    this.activeTurnOperations.add(operation);
    try {
      await operation;
    } finally {
      this.activeTurnOperations.delete(operation);
      this.pendingRequestIds.delete(command.requestId);
      this.cancelledRequestIds.delete(command.requestId);
    }
  }

  private async runTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
    let preference!: ModelPreference;
    let model: RuntimeModel;
    let session: ModelSession;
    let sessionKey = "";
    let sessionCreated = false;
    let providerTurn: ActiveProviderTurn | undefined;
    let reloginProvider: AuthProviderId | undefined;
    try {
      preference = this.resolveModelPreference(command.payload.modelPreference);
      if (preference.provider !== LOCAL_GROK_PROVIDER) {
        providerTurn = this.registerProviderTurn(preference.provider, command.requestId);
      }
      model = await this.modelFor(preference);
      if (this.isRequestCancelled(command.requestId)) {
        if (providerTurn) this.settleProviderTurn(providerTurn);
        return;
      }
      const acquiredSession = await this.sessionFor(
        command.payload.capabilityProfile,
        preference,
        model,
        command.payload.conversationId ?? command.requestId,
        normalizeSessionScope(command.payload.sessionScope),
      );
      session = acquiredSession.session;
      sessionCreated = acquiredSession.created;
      sessionKey = acquiredSession.key;
      if (this.isRequestCancelled(command.requestId)) {
        if (this.sessions.get(sessionKey) === session) this.sessions.delete(sessionKey);
        await abortSessionWithin(session);
        session.dispose();
        if (providerTurn) this.settleProviderTurn(providerTurn);
        return;
      }
      if (providerTurn) {
        providerTurn.session = session;
        this.ensureProviderAvailable(preference.provider);
      }
    } catch (error) {
      if (providerTurn) this.settleProviderTurn(providerTurn);
      if (this.isRequestCancelled(command.requestId)) return;
      if (error instanceof DuplicateRequestError) {
        emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
          code: "duplicate_request",
          message: "A turn with this request id is already active.",
        }));
        return;
      }
      if (preference && preference.provider !== LOCAL_GROK_PROVIDER) {
        await this.authService.reloginRequired(preference.provider).catch(() => undefined);
        emit(runtimeEvent("auth.failed", command.requestId, command.traceId, {
          provider: preference.provider,
          code: "relogin_required",
          message: "OAuth 登录不可用，请重新登录。",
        }));
      }
      emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
        code: "invalid_model_preference",
        message: safeRuntimeErrorMessage(error, "Model preference is unavailable."),
      }));
      return;
    }

    this.activeSessionByRequestId.set(command.requestId, session);
    this.sessionKeyByRequestId.set(command.requestId, sessionKey);
    if (this.isRequestCancelled(command.requestId)) {
      this.activeSessionByRequestId.delete(command.requestId);
      this.sessionKeyByRequestId.delete(command.requestId);
      if (this.sessions.get(sessionKey) === session) this.sessions.delete(sessionKey);
      await abortSessionWithin(session);
      session.dispose();
      if (providerTurn) this.settleProviderTurn(providerTurn);
      return;
    }

    const intentAllowsEffect = intentAllowsComputerEffect(command);
    const directComputerAction = intentAllowsEffect
      && isDirectComputerActionUtterance(command.payload.utterance);
    const observedFrontmost = command.payload.contextFrame.frontmostApplication?.value;
    const taskContract = taskExecutionContractFromCommand(command);
    const authorizedText = intentAllowsEffect
      ? authorizedTextForUtterance(command.payload.utterance)
      : undefined;
    const allowedActionSequence: Array<"set_text" | "left_click"> = [];
    const actionBudget = desktopActionBudgetForTurn({
      utterance: command.payload.utterance,
      intentAllowsEffect,
    });
    const generationState = new PiTurnGenerationState(
      directComputerAction,
      true,
      this.interruptionSteerTimeoutMs,
    );
    this.activeGenerationByRequestId.set(command.requestId, generationState);
    this.activeGenerationBySessionKey.set(sessionKey, generationState);
    const emitVisibleDelta = (generation: number, text: string): void => {
      if (text.length === 0 || !generationState.accepts(generation)) return;
      generationState.appendText(generation, text);
      emit(runtimeEvent("response.delta", command.requestId, command.traceId, {
        text,
        generation,
      }));
    };
    const unsubscribe = session.subscribe((event) => {
      if (this.isRequestCancelled(command.requestId)) return;
      if (event.type === "message_start") {
        generationState.observeUserMessage(event.message);
        generationState.beginAssistantMessage(event.message);
      }
      if (event.type === "message_end") {
        generationState.observeAssistantMessageEnd(event.message);
      }
      if (event.type === "turn_end") {
        generationState.observeTurnEnd(event.message);
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        const generation = generationState.generationForMessage(event.message);
        if (generation === undefined) return;
        emitVisibleDelta(generation, generationState.output.push(
          generation,
          event.assistantMessageEvent.delta,
          generationState.isDirectAction(generation),
        ));
      }

      if (event.type === "tool_execution_start") {
        const generation = generationState.generationForToolStart(event.toolCallId);
        if (!generationState.accepts(generation)) return;
        emit(runtimeEvent("tool.started", command.requestId, command.traceId, {
          toolName: event.toolName,
          generation,
        }));
      }

      if (event.type === "tool_execution_end") {
        const generation = generationState.generationForToolEnd(event.toolCallId);
        if (!generationState.accepts(generation)) return;
        emit(runtimeEvent("tool.completed", command.requestId, command.traceId, {
          toolName: event.toolName,
          isError: event.isError,
          generation,
        }));
      }
    });

    emit(runtimeEvent("turn.started", command.requestId, command.traceId, {
      runtime: "yishu-loop",
      capabilityProfile: command.payload.capabilityProfile,
      sessionId: session.sessionId,
      provider: preference.provider,
      model: preference.model,
      generation: generationState.currentGeneration,
      ...(preference.provider === LOCAL_GROK_PROVIDER ? { baseUrl: model.baseUrl } : {}),
    }));

    const computerTurn: ActiveComputerTurn = {
      requestId: command.requestId,
      traceId: command.traceId,
      intentId: randomUUID(),
      basisFrameId: command.payload.contextFrame.frameId,
      directComputerAction,
      ...(authorizedText !== undefined ? { authorizedText } : {}),
      allowedActionSequence,
      actionBudget,
      ...(observedFrontmost?.bundleIdentifier && observedFrontmost.processIdentifier > 0
        ? {
            frontmostTarget: {
              targetBundleId: observedFrontmost.bundleIdentifier,
              targetPid: observedFrontmost.processIdentifier,
            },
          }
        : {}),
      ...(taskContract !== undefined
        ? { contract: taskContract }
        : {}),
      emit,
      actionCount: 0,
      allActionsVerified: true,
      generationState,
      desktop: Object.assign(createDesktopLoopState({ budget: actionBudget }), {
        lastObservation: observationFromContextFrame(command.payload.contextFrame),
      }),
    };
    let completedSuccessfully = false;
    let restoreTools: (() => void) | undefined;
    try {
      await this.activeComputerTurn.run(computerTurn, async () => {
        restoreTools = this.activateToolsForTurn(
          session,
          this.sessionToolPolicy(command.payload.conversationId ?? command.requestId),
        );
        const currentPageNoteImageOnly = isCurrentPageActionsNoteUtterance(command.payload.utterance)
          && command.payload.contextFrame.screenshots.length === 1
          && command.payload.contextFrame.screenshots[0]?.sourceWindowNumber
            === command.payload.contextFrame.activeWindow?.value.windowNumber;
        await session.prompt(buildGroundedPrompt(command, {
          includeConversationHistory: sessionCreated,
          ...(currentPageNoteImageOnly ? { currentPageNoteImageOnly: true } : {}),
        }), {
          preflightResult: (accepted) => {
            if (accepted) generationState.markInitialPromptAdmitted();
            else generationState.rejectInitialPrompt(new Error("Initial Pi prompt preflight was rejected."));
          },
          images: command.payload.contextFrame.screenshots.map((screenshot) => ({
            type: "image" as const,
            data: screenshot.base64Data,
            mimeType: screenshot.mediaType,
            label: screenshotDimensionCaption(screenshot),
          })),
        });

        if (this.isRequestCancelled(command.requestId)) return;

        if (session.agent.state.errorMessage) {
          throw new Error(session.agent.state.errorMessage);
        }

        // An accepted interruption owns the turn until its explicitly admitted
        // conversational steer produces a replacement assistant generation.
        // If the first provider cycle already became idle, steerTurn starts a
        // fresh prompt on the same Pi session and this await joins it.
        await generationState.awaitAdmittedReplacement();

        const generation = generationState.currentGeneration;
        const completedOutput = generationState.output.complete(generation);
        if (completedOutput.stale) {
          throw new Error("Pi ended before the interrupted response was replaced.");
        }
        const compatibilityAction = completedOutput.computerActions.at(0)
          ?? (completedOutput.pointing === undefined
            ? undefined
            : {
              action: "left_click" as const,
              x: completedOutput.pointing.x,
              y: completedOutput.pointing.y,
              ...(completedOutput.pointing.screen === undefined
                ? {}
                : { screen: completedOutput.pointing.screen }),
              ...(completedOutput.pointing.label === undefined
                ? {}
                : { label: completedOutput.pointing.label }),
            });
        if (shouldRunCompatibilityComputerAction(
          generationState.isDirectAction(generation),
          computerTurn.actionCount,
          compatibilityAction !== undefined,
        ) && compatibilityAction) {
          emit(runtimeEvent("tool.started", command.requestId, command.traceId, {
            toolName: "computer_control",
            compatibilityMode: true,
            generation,
          }));
          let isError = false;
          try {
            await this.performComputerAction(compatibilityAction);
          } catch {
            isError = true;
          }
          if (this.isRequestCancelled(command.requestId)) return;
          emit(runtimeEvent("tool.completed", command.requestId, command.traceId, {
            toolName: "computer_control",
            isError,
            compatibilityMode: true,
            generation,
          }));
        }

        if (this.isRequestCancelled(command.requestId)) return;

        if (generationState.isDirectAction(generation) && computerTurn.actionCount > 0) {
          emitVisibleDelta(generation, this.conciseActionResult(computerTurn.lastResult));
        } else {
          emitVisibleDelta(generation, completedOutput.visibleDelta);
        }

        const spokenText = generationState.text(generation);
        const authoritativeText = generationState.isDirectAction(generation)
          || computerTurn.actionCount > 0
          ? spokenText
          : attachObservationalPointDirective(spokenText, completedOutput.pointing);
        if (authoritativeText.trim().length === 0) {
          throw new Error("Pi completed the turn without a user-visible response.");
        }
        if (!generationState.finish()) {
          throw new Error("Pi response generation was interrupted before completion.");
        }

        const completion = runtimeEvent("response.completed", command.requestId, command.traceId, {
          text: authoritativeText,
          generation,
          verified: computerTurn.actionCount > 0 && computerTurn.allActionsVerified,
          verifier: computerTurn.actionCount > 0
            ? "macos-accessibility-result"
            : "conversation-response-only",
        });
        emit(computerTurn.actionCount > 0
          ? markTrustedExternalReceipt(completion, computerTurn.allActionsVerified)
          : completion);
        completedSuccessfully = true;
      });
    } catch (error) {
      if (this.isRequestCancelled(command.requestId)) return;
      if (preference.provider !== LOCAL_GROK_PROVIDER) reloginProvider = preference.provider;
      emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
        code: error instanceof SteerReplacementFailedBeforeStartError
          ? "steer_replacement_failed_before_start"
          : isFirstByteTimeoutError(error)
            ? "first_byte_timeout"
            : "pi_turn_failed",
        message: safeRuntimeErrorMessage(error),
        generation: Math.max(
          generationState.currentGeneration,
          generationState.output.acceptanceFloor,
        ),
      }));
    } finally {
      restoreTools?.();
      unsubscribe();
      this.activeSessionByRequestId.delete(command.requestId);
      this.sessionKeyByRequestId.delete(command.requestId);
      this.activeGenerationByRequestId.delete(command.requestId);
      if (this.activeGenerationBySessionKey.get(sessionKey) === generationState) {
        this.activeGenerationBySessionKey.delete(sessionKey);
      }
      if (!completedSuccessfully || this.isRequestCancelled(command.requestId)) {
        this.evictSession(sessionKey, session);
      }
      if (providerTurn) this.settleProviderTurn(providerTurn);
    }
    if (reloginProvider) {
      await this.authService.reloginRequired(reloginProvider).catch(() => undefined);
    }
  }

  async steerTurn(command: TurnSteerCommand, emit: RuntimeEventSink): Promise<void> {
    const session = this.activeSessionByRequestId.get(command.requestId);
    const generationState = this.activeGenerationByRequestId.get(command.requestId);
    if (!session || !generationState) {
      emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
        code: "turn_not_active",
        message: "No active Pi turn matches this request.",
      }));
      return;
    }

    const nextGeneration = generationState.admitConversationSteer(
      command.payload.message,
      command.payload.nextGeneration,
      async () => {
        // ModelSession.prompt is the atomic SDK entry: while streaming it
        // queues exactly one steer; while idle it starts exactly one fresh run.
        // Checking isStreaming ourselves would race the provider settling.
        await generationState.awaitInitialPromptAdmitted();
        await session.prompt(command.payload.message, {
          streamingBehavior: "steer",
        });
      },
    );
    if (nextGeneration === undefined) {
      emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
        code: "steer_failed",
        message: "Conversational steer did not match an accepted interruption.",
        generation: generationState.currentGeneration,
      }));
      return;
    }
    emit(runtimeEvent("runtime.status", command.requestId, command.traceId, {
      status: "steering_received",
      generation: nextGeneration,
    }));
  }

  async interruptTurn(command: TurnInterruptCommand, emit: RuntimeEventSink): Promise<void> {
    const generationState = this.activeGenerationByRequestId.get(command.requestId);
    if (!generationState) {
      emit(runtimeEvent("turn.interrupt.rejected", command.requestId, command.traceId, {
        generation: command.payload.expectedGeneration,
        code: "turn_not_active",
      }));
      return;
    }

    const decision = generationState.interrupt(command.payload.expectedGeneration);
    if (!decision.accepted) {
      emit(runtimeEvent("turn.interrupt.rejected", command.requestId, command.traceId, {
        generation: decision.generation,
        code: decision.reason,
      }));
      return;
    }
    emit(runtimeEvent("turn.interrupt.accepted", command.requestId, command.traceId, {
      interruptedGeneration: decision.interruptedGeneration,
      nextGeneration: decision.nextGeneration,
    }));
  }

  async cancelTurn(command: TurnCancelCommand, emit: RuntimeEventSink): Promise<void> {
    if (this.hasActiveRequest(command.requestId)) {
      this.cancelledRequestIds.add(command.requestId);
    }
    if (!this.pageNoteReceiptReconciliations.has(command.requestId)) {
      this.computerUsePort.cancelRequest(command.requestId, command.payload.reason);
    }
    const session = this.activeSessionByRequestId.get(command.requestId);
    if (session) {
      this.activeSessionByRequestId.delete(command.requestId);
      this.activeGenerationByRequestId.delete(command.requestId);
      const sessionKey = this.sessionKeyByRequestId.get(command.requestId);
      this.sessionKeyByRequestId.delete(command.requestId);
      if (sessionKey !== undefined) this.activeGenerationBySessionKey.delete(sessionKey);
      // Remove the poisoned/aborting session from the cache before awaiting
      // provider cancellation. A superseding turn can then cold-start without
      // ever sharing the old session while abort is still in flight.
      if (sessionKey !== undefined && this.sessions.get(sessionKey) === session) {
        this.sessions.delete(sessionKey);
      }
      try {
        await abortSessionWithin(session);
      } finally {
        session.dispose();
      }
    }

    emit(runtimeEvent("turn.cancelled", command.requestId, command.traceId, {
      reason: command.payload.reason ?? "user_cancelled",
    }));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const requestId of this.pendingRequestIds) {
      this.cancelledRequestIds.add(requestId);
      if (!this.pageNoteReceiptReconciliations.has(requestId)) {
        this.computerUsePort.cancelRequest(requestId, "runtime_disposed");
      }
    }
    const active = [...this.activeProviderTurns.values()];
    await Promise.all(active.map((turn) => turn.cancel()));
    await Promise.all(active.map((turn) => turn.settled));
    for (const session of this.activeSessionByRequestId.values()) {
      await session.abort().catch(() => undefined);
    }
    if (this.pageNoteReceiptReconciliations.size === 0) {
      await Promise.allSettled([...this.activeTurnOperations]);
    }
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.activeSessionByRequestId.clear();
    this.activeGenerationByRequestId.clear();
    this.activeGenerationBySessionKey.clear();
    this.sessionKeyByRequestId.clear();
    this.activeProviderTurns.clear();
    this.pendingRequestIds.clear();
    this.cancelledRequestIds.clear();
    this.activeTurnOperations.clear();
    this.providerTransitions.clear();
    if (this.pageNoteReceiptReconciliations.size === 0) this.computerUsePort.dispose();
    else this.computerUsePortDisposeDeferred = true;
  }

  private async performComputerAction(
    action: ComputerControlToolAction,
    signal?: AbortSignal,
  ): Promise<ComputerActionResult> {
    const activeTurn = this.activeComputerTurn.getStore();
    if (!activeTurn) throw new Error("Computer action has no active turn context.");

    const attemptId = randomUUID();
    if (activeTurn.contract !== undefined) {
      const admission = evaluateActionBoundary(activeTurn.contract, {
        proposedAuthority: "reversible",
        proposedRisk: "medium",
      });
      if (admission.decision === "escalate") {
        const refusal: ComputerActionResult = {
          succeeded: false,
          verified: false,
          status: "blocked",
          code: "runtime_error",
          method: "unknown",
          attemptId,
          message: `Computer action requires escalation: ${admission.reason}.`,
        };
        throw new ComputerActionError(refusal.message, {
          status: refusal.status!,
          code: refusal.code!,
          method: refusal.method!,
          attemptId,
        }, refusal);
      }
    }
    const allowedActionSequence = activeTurn.allowedActionSequence ?? [];
    const actionBudget = activeTurn.actionBudget
      ?? (allowedActionSequence.length > 0 ? allowedActionSequence.length : desktopStepBudget());
    const desktop = activeTurn.desktop ?? createDesktopLoopState({ budget: actionBudget });
    activeTurn.desktop = desktop;
    const actionDigest = digestComputerControlAction(action);
    if (activeTurn.actionCount >= actionBudget) {
      const directLimit = activeTurn.directComputerAction && actionBudget <= 1;
      const refusal: ComputerActionResult = {
        succeeded: false,
        verified: false,
        status: "blocked",
        code: directLimit ? "direct_action_already_attempted" : "action_limit_reached",
        method: "unknown",
        attemptId,
        message: directLimit
          ? "This direct-click turn already attempted one computer action; a second dispatch was blocked."
          : "This turn reached its authorized desktop action limit; another dispatch was blocked.",
      };
      throw new ComputerActionError(refusal.message, {
        status: refusal.status!,
        code: refusal.code!,
        method: refusal.method!,
        attemptId,
      }, refusal);
    }
    if (unknownCommitBlocksRetry(desktop, actionDigest)) {
      const refusal: ComputerActionResult = {
        succeeded: false,
        verified: false,
        status: "blocked",
        code: "runtime_error",
        method: "unknown",
        attemptId,
        message: "An earlier commit for this action returned unknown; it will not be retried.",
      };
      throw new ComputerActionError(refusal.message, {
        status: refusal.status!,
        code: refusal.code!,
        method: refusal.method!,
        attemptId,
      }, refusal);
    }

    const expectedAction = allowedActionSequence[activeTurn.actionCount];
    if (expectedAction !== undefined && action.action !== expectedAction) {
      const refusal: ComputerActionResult = {
        succeeded: false,
        verified: false,
        status: "blocked",
        code: "runtime_error",
        method: "unknown",
        attemptId,
        message: `Desktop action was blocked: expected ${expectedAction}.`,
      };
      throw new ComputerActionError(refusal.message, {
        status: refusal.status!,
        code: refusal.code!,
        method: refusal.method!,
        attemptId,
      }, refusal);
    }

    let dispatchedAction: ComputerAction;
    if (action.action === "set_text") {
      if (activeTurn.authorizedText === undefined || action.text !== activeTurn.authorizedText) {
        const refusal: ComputerActionResult = {
          succeeded: false,
          verified: false,
          status: "blocked",
          code: "runtime_error",
          method: "unknown",
          attemptId,
          message: "Text input was blocked because it did not exactly match the user's authorized text.",
        };
        throw new ComputerActionError(refusal.message, {
          status: refusal.status!,
          code: refusal.code!,
          method: refusal.method!,
          attemptId,
        }, refusal);
      }
      if (!activeTurn.frontmostTarget) {
        const refusal: ComputerActionResult = {
          succeeded: false,
          verified: false,
          status: "stale",
          code: "frontmost_mismatch",
          method: "unknown",
          attemptId,
          message: "The Context Frame has no frontmost app identity for safe text input.",
        };
        throw new ComputerActionError(refusal.message, {
          status: refusal.status!,
          code: refusal.code!,
          method: refusal.method!,
          attemptId,
        }, refusal);
      }
      dispatchedAction = { ...action, ...activeTurn.frontmostTarget };
    } else {
      dispatchedAction = action;
    }

    const effectGeneration = activeTurn.generationState?.beginEffectDispatch();
    if (activeTurn.generationState !== undefined && effectGeneration === undefined) {
      const refusal: ComputerActionResult = {
        succeeded: false,
        verified: false,
        status: "cancelled",
        code: "cancelled",
        method: "unknown",
        attemptId,
        message: "Desktop action was blocked because its assistant generation was interrupted.",
      };
      throw new ComputerActionError(refusal.message, {
        status: refusal.status!,
        code: refusal.code!,
        method: refusal.method!,
        attemptId,
      }, refusal);
    }

    // Count only dispatched actions. A blocked second call must not emit a
    // computer.action.requested event, while the original attempt still keeps
    // the compatibility POINT fallback behind actionCount === 0.
    activeTurn.actionCount += 1;
    try {
      const result = await this.computerUsePort.perform(dispatchedAction, {
        requestId: activeTurn.requestId,
        traceId: activeTurn.traceId,
        intentId: activeTurn.intentId,
        attemptId,
        basisFrameId: activeTurn.basisFrameId,
        effectClass: "write",
        ...(effectGeneration === undefined ? {} : { generation: effectGeneration }),
      }, signal);
      rememberUnknownCommit(desktop, actionDigest, result);
      const observation = nextDesktopObservation(desktop.lastObservation, result, action);
      desktop.lastObservation = observation;
      const fresh = withFreshObservation(result, observation);
      activeTurn.lastResult = fresh;
      activeTurn.allActionsVerified &&= fresh.verified === true;
      return fresh;
    } catch (error) {
      const actionError = error instanceof ComputerActionError ? error : undefined;
      activeTurn.lastResult = {
        succeeded: false,
        verified: false,
        message: error instanceof Error ? error.message : String(error),
        status: actionError?.status ?? "failed",
        code: actionError?.code ?? "runtime_error",
        method: actionError?.method ?? "unknown",
        attemptId: actionError?.attemptId ?? attemptId,
      };
      activeTurn.allActionsVerified = false;
      throw error;
    }
  }

  private conciseActionResult(result: ComputerActionResult | undefined): string {
    return computerActionCompletionText(result);
  }

  private resolveModelPreference(rawPreference: ModelPreference | undefined): ModelPreference {
    return modelPreferenceSchema.parse(
      rawPreference ?? {
        provider: LOCAL_GROK_PROVIDER,
        model: LOCAL_GROK_DEFAULT_MODEL,
      },
    );
  }

  private async modelFor(preference: ModelPreference): Promise<RuntimeModel> {
    this.ensureProviderAvailable(preference.provider);
    const modelRuntime = await this.modelRuntimePromise;
    this.ensureProviderAvailable(preference.provider);
    // The product registry resolves LOCAL_GROK dynamically (loopback models
    // are allowlisted by the worker) and enforces stored OAuth for the two
    // subscription providers. There is no ambient API-key path.
    const model = await modelRuntime.resolveModel(preference.provider, preference.model);
    this.ensureProviderAvailable(preference.provider);
    return model;
  }

  private async sessionFor(
    capabilityProfile: CapabilityProfile,
    preference: ModelPreference,
    model: RuntimeModel,
    conversationId: string,
    sessionScope: SessionScope,
  ): Promise<{ session: ModelSession; created: boolean; key: string }> {
    this.ensureProviderAvailable(preference.provider);
    const generation = preference.provider === LOCAL_GROK_PROVIDER
      ? 0
      : (this.providerAuthGenerations.get(preference.provider) ?? 0);
    // Exact scope and conversation identity are part of the harness cache key.
    // Otherwise Pi could reuse a session that still contains another scope's
    // prompt history (especially when a private turn reuses a client id).
    const sessionKey = piSessionCacheKey(
      capabilityProfile,
      preference,
      generation,
      conversationId,
      sessionScope,
      this.skillsVersion,
    );
    const existingSession = this.sessions.get(sessionKey);
    if (existingSession) {
      return { session: existingSession, created: false, key: sessionKey };
    }

    const modelRuntime = await this.modelRuntimePromise;
    this.ensureProviderAvailable(preference.provider);

    const toolPolicy = this.sessionToolPolicy(conversationId);
    const { session } = await this.createSession({
      model,
      providerRuntime: modelRuntime,
      systemPrompt: YISHU_SYSTEM_PROMPT,
      // ADR 0015: per-session product context providers; undefined keeps the
      // engine bare (tests / embedded use).
      ...(this.turnContextProviderFactory
        ? { context: this.turnContextProviderFactory(sessionScope.kind, conversationId) }
        : {}),
      customTools: [
        ...(toolPolicy.computerControl
          ? [createComputerControlTool((action, signal) => (
              this.performComputerAction(action, signal)
            )) as unknown as ToolDefinition]
          : []),
        ...[...toolPolicy.extraTools, ...(toolPolicy.registeredExtraTools ?? [])]
          .map((tool) => this.fenceEffectfulExtraTool(tool, sessionKey)),
      ],
    });

    this.ensureProviderAvailable(preference.provider);
    this.sessions.set(sessionKey, session);
    return { session, created: true, key: sessionKey };
  }

  private ensureProviderAvailable(provider: string): void {
    if (provider !== LOCAL_GROK_PROVIDER && this.providerTransitions.has(provider as AuthProviderId)) {
      throw new Error(`Provider transition in progress: ${provider}.`);
    }
  }

  private hasActiveRequest(requestId: string): boolean {
    return this.pendingRequestIds.has(requestId)
      || this.activeProviderTurns.has(requestId)
      || this.activeSessionByRequestId.has(requestId);
  }

  private isRequestCancelled(requestId: string): boolean {
    return this.cancelledRequestIds.has(requestId) || this.disposed;
  }

  private registerProviderTurn(provider: AuthProviderId, requestId: string): ActiveProviderTurn {
    this.ensureProviderAvailable(provider);
    if (
      this.activeProviderTurns.has(requestId)
      || this.activeSessionByRequestId.has(requestId)
    ) {
      throw new DuplicateRequestError();
    }
    let settle!: () => void;
    const turn: ActiveProviderTurn = {
      provider,
      requestId,
      settled: new Promise<void>((resolve) => { settle = resolve; }),
      settle: () => settle(),
      cancel: async () => {
        this.activeSessionByRequestId.delete(requestId);
        this.activeGenerationByRequestId.delete(requestId);
        const sessionKey = this.sessionKeyByRequestId.get(requestId);
        if (sessionKey !== undefined) this.activeGenerationBySessionKey.delete(sessionKey);
        if (turn.session) await turn.session.abort();
      },
    };
    this.activeProviderTurns.set(requestId, turn);
    return turn;
  }

  private settleProviderTurn(turn: ActiveProviderTurn): void {
    if (this.activeProviderTurns.get(turn.requestId) === turn) {
      this.activeProviderTurns.delete(turn.requestId);
    }
    turn.settle();
  }

  private async beginProviderTransition(provider: AuthProviderId): Promise<void> {
    this.providerTransitions.add(provider);
    this.providerAuthGenerations.set(provider, (this.providerAuthGenerations.get(provider) ?? 0) + 1);
    const active = [...this.activeProviderTurns.values()].filter((turn) => turn.provider === provider);
    await Promise.all(active.map((turn) => turn.cancel()));
    await Promise.all(active.map((turn) => turn.settled));
    this.invalidateProviderSessions(provider);
  }

  private endProviderTransition(provider: AuthProviderId, _kind: AuthTransitionKind): void {
    this.invalidateProviderSessions(provider);
    this.providerTransitions.delete(provider);
  }

  private invalidateProviderSessions(provider: AuthProviderId): void {
    for (const [key, session] of this.sessions.entries()) {
      const keyProvider = key.split(":")[1];
      if (keyProvider !== provider) continue;
      session.dispose();
      this.sessions.delete(key);
      this.activeGenerationBySessionKey.delete(key);
    }
    for (const [requestId, session] of this.activeSessionByRequestId.entries()) {
      if ([...this.activeProviderTurns.values()].some((turn) => turn.requestId === requestId && turn.provider === provider)) {
        this.activeSessionByRequestId.delete(requestId);
        this.activeGenerationByRequestId.delete(requestId);
        session.dispose();
      }
    }
  }
}
