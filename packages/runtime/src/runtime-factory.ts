import { CodexRuntime } from "./providers/codex-runtime.js";
import { MockAgentRuntime } from "./mock-runtime.js";
import {
  createDefaultProviderRuntime,
  YishuLoopRuntimeAdapter,
} from "./loop-adapter.js";
import { ProductKernelRuntime } from "./product-kernel-runtime.js";
import { createCompletionsExtractionModel } from "./memory-extraction-model.js";
import { createSpeechExcerptModel } from "./speech-excerpt-model.js";
import {
  createProductEverOS,
  resolveEverOSPendingSessionsPath,
} from "./everos-sidecar.js";
import type { ComputerUsePort } from "./computer-use-port.js";
import type { AgentRuntime } from "./runtime-port.js";
import { LOCAL_GROK_DEFAULT_MODEL, LOCAL_GROK_PROVIDER } from "./protocol.js";
import { FileEverOSPendingSessionStore } from "./everos-pending-sessions.js";
import { createQualityRecorder } from "./observability/quality-recorder.js";
import os from "node:os";
import path from "node:path";

/**
 * Pi is the only production agent loop. Mock is a deterministic protocol test
 * double, not an alternative product harness.
 */
export type RuntimeMode = "mock" | "pi";

export function selectedRuntimeMode(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): RuntimeMode {
  const configuredMode = environment.YISHU_RUNTIME_MODE ?? environment.HANAKO_RUNTIME_MODE;
  if (configuredMode === "mock") return "mock";
  return "pi";
}

export interface RuntimePorts {
  computerUse?: ComputerUsePort;
  /**
   * When true (default), wrap the execution runtime with product kernel
   * (ContextTrail + YishuAction routing). Set YISHU_PRODUCT_KERNEL=0 to disable.
   */
  productKernel?: boolean;
}

export function productKernelEnabled(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  explicit?: boolean,
): boolean {
  if (explicit !== undefined) return explicit;
  const flag = environment.YISHU_PRODUCT_KERNEL;
  if (flag === "0" || flag === "false" || flag === "off") return false;
  return true;
}

function createInnerRuntime(
  mode: RuntimeMode,
  ports: RuntimePorts,
): {
  inner: AgentRuntime;
  providerRuntime?: ReturnType<typeof createDefaultProviderRuntime>;
  qualityRecorder?: ReturnType<typeof createQualityRecorder>;
} {
  if (mode === "mock") return { inner: new MockAgentRuntime() };
  // One provider runtime instance feeds both the loop adapter and the memory
  // extraction model (ADR 0016 #4) so extraction follows the turn's provider.
  const providerRuntime = createDefaultProviderRuntime();
  const qualityRecorder = createQualityRecorder({
    storePath: path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Yishu",
      "Diagnostics",
      "quality.jsonl",
    ),
  });
  return {
    inner: new YishuLoopRuntimeAdapter(process.cwd(), ports.computerUse, {
      modelRuntimePromise: Promise.resolve(providerRuntime),
      codexRuntime: new CodexRuntime(),
      qualityRecorder,
    }),
    providerRuntime,
    qualityRecorder,
  };
}

export function createAgentRuntime(
  mode: RuntimeMode = selectedRuntimeMode(),
  ports: RuntimePorts = {},
): AgentRuntime {
  const { inner, providerRuntime, qualityRecorder } = createInnerRuntime(mode, ports);
  if (!productKernelEnabled(process.env, ports.productKernel)) {
    return inner;
  }
  const everos = mode === "pi" && providerRuntime !== undefined
    ? createProductEverOS(process.env, {
        llmEnvResolver: async () => {
          const model = await providerRuntime.resolveModel(
            LOCAL_GROK_PROVIDER,
            LOCAL_GROK_DEFAULT_MODEL,
          );
          return {
            apiKey: await providerRuntime.bearer(LOCAL_GROK_PROVIDER),
            baseUrl: model.baseUrl,
            model: model.id,
          };
        },
      })
    : undefined;
  const excerpt = providerRuntime ? createSpeechExcerptModel(providerRuntime) : undefined;
  const extraction = providerRuntime ? createCompletionsExtractionModel(providerRuntime) : undefined;
  // Codex owns its login; short spoken excerpts and memory extraction use the existing fast route.
  const auxiliaryPreference = (input: { providerId: string; modelId: string }) => input.providerId === "openai-codex"
    ? { providerId: LOCAL_GROK_PROVIDER, modelId: LOCAL_GROK_DEFAULT_MODEL }
    : { providerId: input.providerId, modelId: input.modelId };
  return new ProductKernelRuntime(inner, undefined, ports.computerUse, {
    ...(providerRuntime !== undefined
      ? {
          speechExcerptModel: { excerpt: (input) => excerpt!.excerpt({ ...input, ...auxiliaryPreference(input) }) },
          ...(everos === undefined
            ? { memoryExtractionModel: { extract: (input) => extraction!.extract({ ...input, ...auxiliaryPreference(input) }) } }
            : {}),
        }
      : {}),
    ...(everos !== undefined ? { everos } : {}),
    ...(everos !== undefined
      ? {
          everosPendingStore: new FileEverOSPendingSessionStore(
            resolveEverOSPendingSessionsPath(process.env),
          ),
        }
      : {}),
    ...(qualityRecorder === undefined ? {} : { qualityRecorder }),
  });
}
