import { AgentCoreRuntime } from "./agent-core-runtime.js";
import { MockAgentRuntime } from "./mock-runtime.js";
import { PiRuntimeAdapter } from "./pi-runtime-adapter.js";
import { ProductKernelRuntime } from "./product-kernel-runtime.js";
import type { ComputerUsePort } from "./computer-use-port.js";
import type { AgentRuntime } from "./runtime-port.js";

export type RuntimeMode = "mock" | "pi" | "agent-core";

export function selectedRuntimeMode(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): RuntimeMode {
  const configuredMode = environment.YISHU_RUNTIME_MODE ?? environment.HANAKO_RUNTIME_MODE;
  if (configuredMode === "mock") return "mock";
  if (configuredMode === "agent-core") return "agent-core";
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
): AgentRuntime {
  if (mode === "mock") return new MockAgentRuntime();
  if (mode === "agent-core") return new AgentCoreRuntime();
  return new PiRuntimeAdapter(process.cwd(), ports.computerUse);
}

export function createAgentRuntime(
  mode: RuntimeMode = selectedRuntimeMode(),
  ports: RuntimePorts = {},
): AgentRuntime {
  const inner = createInnerRuntime(mode, ports);
  if (!productKernelEnabled(process.env, ports.productKernel)) {
    return inner;
  }
  return new ProductKernelRuntime(inner, undefined, ports.computerUse);
}
