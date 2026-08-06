import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateModelRuntimeOptions,
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
  UnavailableComputerUsePort,
  type ComputerActionResult,
  type ComputerUsePort,
} from "./computer-use-port.js";
import { buildGroundedPrompt } from "./context-prompt.js";
import { YISHU_SYSTEM_PROMPT } from "./persona.js";
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

type RuntimeModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

interface ActiveComputerTurn {
  requestId: string;
  traceId: string;
  emit: RuntimeEventSink;
  actionCount: number;
  lastResult?: ComputerActionResult;
}

// This is deliberately not an API credential. The Clicky-owned loopback
// gateway terminates auth and forwards the request to the existing proxy.
// Supplying a stable non-secret value only satisfies pi-ai's OpenAI client
// requirement that a client key be present; no environment key is read here.
const LOCAL_PROXY_AUTH_SENTINEL = "yishu-local-proxy";

const localCredentialStore: NonNullable<CreateModelRuntimeOptions["credentials"]> = {
  async read() {
    return undefined;
  },
  async list() {
    return [];
  },
  async modify(_providerId, _fn) {
    return undefined;
  },
  async delete() {},
};

export class PiRuntimeAdapter implements AgentRuntime {
  private readonly workingDirectory: string;
  private readonly modelRuntimePromise: Promise<ModelRuntime>;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly activeSessionByRequestId = new Map<string, AgentSession>();
  private readonly localGrokModelIds = new Set<string>();
  private readonly activeComputerTurn = new AsyncLocalStorage<ActiveComputerTurn>();

  constructor(
    workingDirectory = process.cwd(),
    private readonly computerUsePort: ComputerUsePort = new UnavailableComputerUsePort(),
  ) {
    this.workingDirectory = workingDirectory;
    // Keep provider/model state in this process. In particular, do not read or
    // write the user's global ~/.pi/agent models.json/auth.json.
    this.modelRuntimePromise = ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
      credentials: localCredentialStore,
    });
  }

  async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
    let preference: ModelPreference;
    let model: RuntimeModel;
    let session: AgentSession;
    try {
      preference = this.resolveModelPreference(command.payload.modelPreference);
      model = await this.modelFor(preference);
      session = await this.sessionFor(command.payload.capabilityProfile, preference, model);
    } catch (error) {
      emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
        code: "invalid_model_preference",
        message: error instanceof Error ? error.message : String(error),
      }));
      return;
    }

    this.activeSessionByRequestId.set(command.requestId, session);

    let streamedText = "";
    const directComputerAction = isDirectComputerActionUtterance(command.payload.utterance);
    const outputProjector = new AssistantOutputStreamProjector();
    const emitVisibleDelta = (text: string): void => {
      if (text.length === 0) return;
      streamedText += text;
      emit(runtimeEvent("response.delta", command.requestId, command.traceId, { text }));
    };
    const unsubscribe = session.subscribe((event) => {
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
      baseUrl: LOCAL_GROK_BASE_URL,
    }));

    const computerTurn: ActiveComputerTurn = {
      requestId: command.requestId,
      traceId: command.traceId,
      emit,
      actionCount: 0,
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

        if (session.agent.state.errorMessage) {
          throw new Error(session.agent.state.errorMessage);
        }

        const completedOutput = outputProjector.complete();
        const compatibilityAction = completedOutput.computerActions.at(0);
        if (directComputerAction && computerTurn.actionCount === 0 && compatibilityAction) {
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

        emit(runtimeEvent("response.completed", command.requestId, command.traceId, {
          text: streamedText,
          verified: computerTurn.lastResult?.verified ?? false,
          verifier: computerTurn.actionCount > 0
            ? "macos-accessibility-result"
            : "conversation-response-only",
        }));
      });
    } catch (error) {
      emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
        code: "pi_turn_failed",
        message: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      unsubscribe();
      this.activeSessionByRequestId.delete(command.requestId);
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
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.activeSessionByRequestId.clear();
    this.computerUsePort.dispose();
  }

  private async performComputerAction(
    action: ComputerAction,
    signal?: AbortSignal,
  ): Promise<ComputerActionResult> {
    const activeTurn = this.activeComputerTurn.getStore();
    if (!activeTurn) throw new Error("Computer action has no active turn context.");

    activeTurn.actionCount += 1;
    try {
      const result = await this.computerUsePort.perform(action, {
        requestId: activeTurn.requestId,
        traceId: activeTurn.traceId,
      }, signal);
      activeTurn.lastResult = result;
      return result;
    } catch (error) {
      activeTurn.lastResult = {
        succeeded: false,
        verified: false,
        message: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  private conciseActionResult(result: ComputerActionResult | undefined): string {
    if (result?.verified) return "点好了。";
    if (result?.succeeded) return "已经点击，但界面结果还没确认。";
    return "这次没点成功。";
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
    const modelRuntime = await this.modelRuntimePromise;
    if (!this.localGrokModelIds.has(preference.model)) {
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
      throw new Error(`Local Grok model is unavailable: ${preference.model}`);
    }
    return model;
  }

  private async sessionFor(
    capabilityProfile: CapabilityProfile,
    preference: ModelPreference,
    model: RuntimeModel,
  ): Promise<AgentSession> {
    const sessionKey = `${capabilityProfile}:${preference.provider}:${preference.model}`;
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

    const capabilityConfiguration = PI_CAPABILITY_PROFILES[capabilityProfile];
    const { session } = await createAgentSession({
      cwd: this.workingDirectory,
      modelRuntime,
      model,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(this.workingDirectory),
      customTools: [createComputerControlTool((action, signal) => (
        this.performComputerAction(action, signal)
      )) as unknown as ToolDefinition],
      ...capabilityConfiguration,
    });

    this.sessions.set(sessionKey, session);
    return session;
  }
}
