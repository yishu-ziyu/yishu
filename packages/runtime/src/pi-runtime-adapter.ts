import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ProviderModelConfig,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { PI_CAPABILITY_PROFILES } from "./capability-profiles.js";
import {
  AssistantOutputStreamProjector,
  isDirectComputerActionUtterance,
} from "./assistant-output.js";
import { createComputerControlTool } from "./computer-control-tool.js";
import {
  ComputerActionError,
  UnavailableComputerUsePort,
  type ComputerActionResult,
  type ComputerUsePort,
} from "./computer-use-port.js";
import { buildGroundedPrompt } from "./context-prompt.js";
import { YISHU_SYSTEM_PROMPT } from "./persona.js";
import {
  installProductOAuthProviderPolicy,
  requireOAuthSubscriptionAuth,
  safeRuntimeErrorMessage,
  YishuAuthService,
  type AuthTransitionKind,
} from "./auth-service.js";
import { createYishuCredentialStore } from "./auth-store.js";
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
  type TurnStartCommand,
  type TurnSteerCommand,
} from "./protocol.js";
import type { AgentRuntime, RuntimeEventSink } from "./runtime-port.js";
import { evaluateActionBoundary, taskExecutionContractFromCommand } from "./task-contract.js";
import type { TaskExecutionContract } from "@yishu/kernel";
import { markTrustedExternalReceipt } from "./trusted-task-receipt.js";

type RuntimeModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

interface ActiveComputerTurn {
  requestId: string;
  traceId: string;
  intentId: string;
  basisFrameId: string;
  directComputerAction: boolean;
  contract?: TaskExecutionContract;
  emit: RuntimeEventSink;
  actionCount: number;
  allActionsVerified: boolean;
  lastResult?: ComputerActionResult;
}

interface ActiveProviderTurn {
  provider: AuthProviderId;
  requestId: string;
  session?: AgentSession;
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

/**
 * Keep the user-facing completion gate on the legacy `verified` bit.  A
 * delivered or unverified receipt must never be promoted to “点好了” merely
 * because a platform accepted an input event.
 */
export function computerActionCompletionText(result: ComputerActionResult | undefined): string {
  if (result?.verified) return "点好了。";
  if (result?.succeeded || result?.status === "delivered" || result?.status === "unverified") {
    return "已经点击，但界面结果还没确认。";
  }
  return "这次没点成功。";
}

/** Compatibility POINT replay is a single fallback, never a second dispatch. */
export function shouldRunCompatibilityComputerAction(
  directComputerAction: boolean,
  actionCount: number,
  hasCompatibilityAction: boolean,
): boolean {
  return directComputerAction && actionCount === 0 && hasCompatibilityAction;
}

// This is deliberately not an API credential. The Clicky-owned loopback
// gateway terminates auth and forwards the request to the existing proxy.
// Supplying a stable non-secret value only satisfies pi-ai's OpenAI client
// requirement that a client key be present; no environment key is read here.
const LOCAL_PROXY_AUTH_SENTINEL = "yishu-local-proxy";

export function piSessionCacheKey(
  capabilityProfile: CapabilityProfile,
  preference: ModelPreference,
  generation: number,
  conversationId: string,
): string {
  return `${capabilityProfile}:${preference.provider}:${generation}:${preference.model}:${conversationId}`;
}

/**
 * Optional injection seam for tests.  Both members default to the exact
 * production wiring: a product-owned local `ModelRuntime` and Pi's
 * `createAgentSession`.  Callers that inject a model runtime still pass
 * through the OAuth provider policy install below.
 */
export interface PiRuntimeAdapterOptions {
  modelRuntimePromise?: Promise<ModelRuntime>;
  createSession?: typeof createAgentSession;
}

/**
 * Per-conversation tool surface decided at the createSession boundary
 * (delegation V1, ADR 0009). Main sessions keep computer control and may
 * receive extra product tools (delegate); delegated child sessions receive
 * neither, so recursion and Desktop access are structurally excluded.
 */
export interface SessionToolPolicy {
  readonly computerControl: boolean;
  readonly extraTools: ToolDefinition[];
}

export const DEFAULT_SESSION_TOOL_POLICY: SessionToolPolicy = {
  computerControl: true,
  extraTools: [],
};

export class PiRuntimeAdapter implements AgentRuntime {
  private readonly workingDirectory: string;
  private readonly modelRuntimePromise: Promise<ModelRuntime>;
  private readonly createSession: typeof createAgentSession;
  readonly authService: YishuAuthService;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly activeSessionByRequestId = new Map<string, AgentSession>();
  private readonly activeProviderTurns = new Map<string, ActiveProviderTurn>();
  private readonly pendingRequestIds = new Set<string>();
  private readonly cancelledRequestIds = new Set<string>();
  private readonly activeTurnOperations = new Set<Promise<void>>();
  private readonly providerTransitions = new Set<AuthProviderId>();
  private readonly providerAuthGenerations = new Map<AuthProviderId, number>();
  private readonly localGrokModelIds = new Set<string>();
  private readonly activeComputerTurn = new AsyncLocalStorage<ActiveComputerTurn>();
  // Additive product seam: per-conversation session tool policy, decided at
  // the createSession boundary. Delegated child conversations receive neither
  // computer_control nor delegate; the default keeps every session unchanged.
  private sessionToolPolicy: (conversationId: string) => SessionToolPolicy =
    () => DEFAULT_SESSION_TOOL_POLICY;
  private disposed = false;

  constructor(
    workingDirectory = process.cwd(),
    private readonly computerUsePort: ComputerUsePort = new UnavailableComputerUsePort(),
    options: PiRuntimeAdapterOptions = {},
  ) {
    this.workingDirectory = workingDirectory;
    this.createSession = options.createSession ?? createAgentSession;
    // Keep provider/model state in this process. In particular, do not read or
    // write the user's global ~/.pi/agent models.json/auth.json. OAuth state is
    // product-owned under Yishu/Auth/auth.json instead.
    const modelRuntimePromise = options.modelRuntimePromise ?? ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
      credentials: createYishuCredentialStore(),
    });
    this.modelRuntimePromise = modelRuntimePromise.then((modelRuntime) => {
      // Pi's xAI provider also advertises XAI_API_KEY.  Replace both
      // subscription providers with OAuth-only native providers so ambient
      // environment keys cannot bypass the product store.
      installProductOAuthProviderPolicy(modelRuntime);
      return modelRuntime;
    });
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

  /** Release only sessions whose cache key belongs to this conversation. */
  releaseConversationSession(conversationId: string): void {
    const suffix = `:${conversationId}`;
    for (const [key, session] of this.sessions.entries()) {
      if (!key.endsWith(suffix)) continue;
      session.dispose();
      this.sessions.delete(key);
    }
  }

  async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
    if (this.disposed) {
      emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
        code: "runtime_disposed",
        message: "PiRuntimeAdapter has been disposed.",
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
    let session: AgentSession;
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
      session = await this.sessionFor(
        command.payload.capabilityProfile,
        preference,
        model,
        command.payload.conversationId ?? command.requestId,
      );
      if (this.isRequestCancelled(command.requestId)) {
        await session.abort().catch(() => undefined);
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
    if (this.isRequestCancelled(command.requestId)) {
      await session.abort().catch(() => undefined);
      this.activeSessionByRequestId.delete(command.requestId);
      if (providerTurn) this.settleProviderTurn(providerTurn);
      return;
    }

    let streamedText = "";
    const directComputerAction = isDirectComputerActionUtterance(command.payload.utterance);
    const outputProjector = new AssistantOutputStreamProjector();
    const emitVisibleDelta = (text: string): void => {
      if (text.length === 0) return;
      streamedText += text;
      emit(runtimeEvent("response.delta", command.requestId, command.traceId, { text }));
    };
    const unsubscribe = session.subscribe((event) => {
      if (this.isRequestCancelled(command.requestId)) return;
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        emitVisibleDelta(outputProjector.push(
          event.assistantMessageEvent.delta,
          directComputerAction,
        ));
      }

      if (event.type === "tool_execution_start") {
        emit(runtimeEvent("tool.started", command.requestId, command.traceId, {
          toolName: event.toolName,
        }));
      }

      if (event.type === "tool_execution_end") {
        emit(runtimeEvent("tool.completed", command.requestId, command.traceId, {
          toolName: event.toolName,
          isError: event.isError,
        }));
      }
    });

    emit(runtimeEvent("turn.started", command.requestId, command.traceId, {
      runtime: "pi",
      capabilityProfile: command.payload.capabilityProfile,
      sessionId: session.sessionId,
      provider: preference.provider,
      model: preference.model,
      ...(preference.provider === LOCAL_GROK_PROVIDER ? { baseUrl: LOCAL_GROK_BASE_URL } : {}),
    }));

    const taskContract = taskExecutionContractFromCommand(command);
    const computerTurn: ActiveComputerTurn = {
      requestId: command.requestId,
      traceId: command.traceId,
      intentId: randomUUID(),
      basisFrameId: command.payload.contextFrame.frameId,
      directComputerAction,
      ...(taskContract !== undefined
        ? { contract: taskContract }
        : {}),
      emit,
      actionCount: 0,
      allActionsVerified: true,
    };

    try {
      await this.activeComputerTurn.run(computerTurn, async () => {
        await session.prompt(buildGroundedPrompt(command), {
          images: command.payload.contextFrame.screenshots.map((screenshot) => ({
            type: "image" as const,
            data: screenshot.base64Data,
            mimeType: screenshot.mediaType,
          })),
        });

        if (this.isRequestCancelled(command.requestId)) return;

        if (session.agent.state.errorMessage) {
          throw new Error(session.agent.state.errorMessage);
        }

        const completedOutput = outputProjector.complete();
        const compatibilityAction = completedOutput.computerActions.at(0);
        if (shouldRunCompatibilityComputerAction(
          directComputerAction,
          computerTurn.actionCount,
          compatibilityAction !== undefined,
        ) && compatibilityAction) {
          emit(runtimeEvent("tool.started", command.requestId, command.traceId, {
            toolName: "computer_control",
            compatibilityMode: true,
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
          }));
        }

        if (directComputerAction && computerTurn.actionCount > 0) {
          emitVisibleDelta(this.conciseActionResult(computerTurn.lastResult));
        } else {
          emitVisibleDelta(completedOutput.visibleDelta);
        }

        if (streamedText.trim().length === 0) {
          throw new Error("Pi completed the turn without a user-visible response.");
        }

        const completion = runtimeEvent("response.completed", command.requestId, command.traceId, {
          text: streamedText,
          verified: computerTurn.actionCount > 0 && computerTurn.allActionsVerified,
          verifier: computerTurn.actionCount > 0
            ? "macos-accessibility-result"
            : "conversation-response-only",
        });
        emit(computerTurn.actionCount > 0
          ? markTrustedExternalReceipt(completion, computerTurn.allActionsVerified)
          : completion);
      });
    } catch (error) {
      if (this.isRequestCancelled(command.requestId)) return;
      if (preference.provider !== LOCAL_GROK_PROVIDER) reloginProvider = preference.provider;
      emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
        code: "pi_turn_failed",
        message: safeRuntimeErrorMessage(error),
      }));
    } finally {
      unsubscribe();
      this.activeSessionByRequestId.delete(command.requestId);
      if (providerTurn) this.settleProviderTurn(providerTurn);
    }
    if (reloginProvider) {
      await this.authService.reloginRequired(reloginProvider).catch(() => undefined);
    }
  }

  async steerTurn(command: TurnSteerCommand, emit: RuntimeEventSink): Promise<void> {
    const session = this.activeSessionByRequestId.get(command.requestId);
    if (!session) {
      emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
        code: "turn_not_active",
        message: "No active Pi turn matches this request.",
      }));
      return;
    }

    await session.steer(command.payload.message);
    emit(runtimeEvent("runtime.status", command.requestId, command.traceId, {
      status: "steering_received",
    }));
  }

  async cancelTurn(command: TurnCancelCommand, emit: RuntimeEventSink): Promise<void> {
    if (this.hasActiveRequest(command.requestId)) {
      this.cancelledRequestIds.add(command.requestId);
    }
    this.computerUsePort.cancelRequest(command.requestId, command.payload.reason);
    const session = this.activeSessionByRequestId.get(command.requestId);
    if (session) {
      await session.abort();
      this.activeSessionByRequestId.delete(command.requestId);
    }

    emit(runtimeEvent("turn.cancelled", command.requestId, command.traceId, {
      reason: command.payload.reason ?? "user_cancelled",
    }));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const requestId of this.pendingRequestIds) {
      this.cancelledRequestIds.add(requestId);
      this.computerUsePort.cancelRequest(requestId, "runtime_disposed");
    }
    const active = [...this.activeProviderTurns.values()];
    await Promise.all(active.map((turn) => turn.cancel()));
    await Promise.all(active.map((turn) => turn.settled));
    for (const session of this.activeSessionByRequestId.values()) {
      await session.abort().catch(() => undefined);
    }
    await Promise.allSettled([...this.activeTurnOperations]);
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.activeSessionByRequestId.clear();
    this.activeProviderTurns.clear();
    this.pendingRequestIds.clear();
    this.cancelledRequestIds.clear();
    this.activeTurnOperations.clear();
    this.providerTransitions.clear();
    this.computerUsePort.dispose();
  }

  private async performComputerAction(
    action: ComputerAction,
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
    if (activeTurn.directComputerAction && activeTurn.actionCount >= 1) {
      const refusal: ComputerActionResult = {
        succeeded: false,
        verified: false,
        status: "blocked",
        code: "direct_action_already_attempted",
        method: "unknown",
        attemptId,
        message: "This direct-click turn already attempted one computer action; a second dispatch was blocked.",
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
      const result = await this.computerUsePort.perform(action, {
        requestId: activeTurn.requestId,
        traceId: activeTurn.traceId,
        intentId: activeTurn.intentId,
        attemptId,
        basisFrameId: activeTurn.basisFrameId,
        effectClass: "write",
      }, signal);
      activeTurn.lastResult = result;
      activeTurn.allActionsVerified &&= result.verified === true;
      return result;
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
    if (preference.provider === LOCAL_GROK_PROVIDER && !this.localGrokModelIds.has(preference.model)) {
      this.localGrokModelIds.add(preference.model);
      const models: ProviderModelConfig[] = [...this.localGrokModelIds].map((id) => ({
        id,
        name: id,
        api: "openai-completions",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      }));

      modelRuntime.registerProvider(LOCAL_GROK_PROVIDER, {
        name: "Yishu Local Grok",
        baseUrl: LOCAL_GROK_BASE_URL,
        api: "openai-completions",
        apiKey: LOCAL_PROXY_AUTH_SENTINEL,
        authHeader: false,
        models,
      });
    }

    const model = modelRuntime.getModel(preference.provider, preference.model);
    if (!model) {
      throw new Error(`Model is unavailable: ${preference.provider}/${preference.model}`);
    }
    if (preference.provider !== LOCAL_GROK_PROVIDER) {
      await requireOAuthSubscriptionAuth(modelRuntime, preference.provider);
    }
    this.ensureProviderAvailable(preference.provider);
    return model;
  }

  private async sessionFor(
    capabilityProfile: CapabilityProfile,
    preference: ModelPreference,
    model: RuntimeModel,
    conversationId: string,
  ): Promise<AgentSession> {
    this.ensureProviderAvailable(preference.provider);
    const generation = preference.provider === LOCAL_GROK_PROVIDER
      ? 0
      : (this.providerAuthGenerations.get(preference.provider) ?? 0);
    // Conversation identity is part of the harness cache key. Project/private
    // isolation would otherwise be defeated by Pi reusing a model session that
    // still contains another conversation's prompt history.
    const sessionKey = piSessionCacheKey(
      capabilityProfile,
      preference,
      generation,
      conversationId,
    );
    const existingSession = this.sessions.get(sessionKey);
    if (existingSession) {
      return existingSession;
    }

    const modelRuntime = await this.modelRuntimePromise;
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.workingDirectory,
      agentDir: path.join(this.workingDirectory, ".yishu", "pi"),
      settingsManager,
      systemPromptOverride: () => YISHU_SYSTEM_PROMPT,
    });
    await resourceLoader.reload();
    this.ensureProviderAvailable(preference.provider);

    const capabilityConfiguration = PI_CAPABILITY_PROFILES[capabilityProfile];
    const toolPolicy = this.sessionToolPolicy(conversationId);
    const { session } = await this.createSession({
      cwd: this.workingDirectory,
      modelRuntime,
      model,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(this.workingDirectory),
      customTools: [
        ...(toolPolicy.computerControl
          ? [createComputerControlTool((action, signal) => (
              this.performComputerAction(action, signal)
            )) as unknown as ToolDefinition]
          : []),
        ...toolPolicy.extraTools,
      ],
      ...capabilityConfiguration,
    });

    this.ensureProviderAvailable(preference.provider);
    this.sessions.set(sessionKey, session);
    return session;
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
    }
    for (const [requestId, session] of this.activeSessionByRequestId.entries()) {
      if ([...this.activeProviderTurns.values()].some((turn) => turn.requestId === requestId && turn.provider === provider)) {
        this.activeSessionByRequestId.delete(requestId);
        session.dispose();
      }
    }
  }
}
