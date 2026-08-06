import type { AgentRuntime, RuntimeEventSink } from "./runtime-port.js";
import { runtimeEvent, type TurnCancelCommand, type TurnStartCommand, type TurnSteerCommand } from "./protocol.js";

export class MockAgentRuntime implements AgentRuntime {
  async startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void> {
    emit(runtimeEvent("turn.started", command.requestId, command.traceId, { runtime: "mock" }));

    const applicationName = command.payload.contextFrame.frontmostApplication?.value.name ?? "当前应用";
    const windowTitle = command.payload.contextFrame.activeWindow?.value.title;
    const elementTitle = command.payload.contextFrame.elementUnderCursor?.value.title
      ?? command.payload.contextFrame.elementUnderCursor?.value.description;
    const groundedTarget = elementTitle ? `光标下的“${elementTitle}”` : "光标所在的位置";
    const place = windowTitle ? `${applicationName} 的“${windowTitle}”窗口` : applicationName;
    const response = `我看到你正在 ${place}，指向的是${groundedTarget}。你刚才说：“${command.payload.utterance}”。上下文已经对齐；下一步我会先确认目标，再行动。`;

    const chunks = response.match(/.{1,18}/gu) ?? [response];
    for (const chunk of chunks) {
      emit(runtimeEvent("response.delta", command.requestId, command.traceId, { text: chunk }));
      await new Promise((resolve) => setTimeout(resolve, 24));
    }

    emit(runtimeEvent("response.completed", command.requestId, command.traceId, {
      text: response,
      verified: true,
      verifier: "deterministic-context-echo",
    }));
  }

  async steerTurn(command: TurnSteerCommand, emit: RuntimeEventSink): Promise<void> {
    emit(runtimeEvent("runtime.status", command.requestId, command.traceId, {
      status: "steering_received",
      message: command.payload.message,
    }));
  }

  async cancelTurn(command: TurnCancelCommand, emit: RuntimeEventSink): Promise<void> {
    emit(runtimeEvent("turn.cancelled", command.requestId, command.traceId, {
      reason: command.payload.reason ?? "user_cancelled",
    }));
  }

  async dispose(): Promise<void> {}
}

