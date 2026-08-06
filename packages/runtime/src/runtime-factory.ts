import { AgentCoreRuntime } from "./agent-core-runtime.js";
import { MockAgentRuntime } from "./mock-runtime.js";
import { PiRuntimeAdapter } from "./pi-runtime-adapter.js";
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
}

export function createAgentRuntime(
  mode: RuntimeMode = selectedRuntimeMode(),
  ports: RuntimePorts = {},
): AgentRuntime {
  if (mode === "mock") return new MockAgentRuntime();
  if (mode === "agent-core") return new AgentCoreRuntime();
  return new PiRuntimeAdapter(process.cwd(), ports.computerUse);
}
