import type {
  RuntimeEvent,
  TurnCancelCommand,
  TurnInterruptCommand,
  TurnStartCommand,
  TurnSteerCommand,
} from "./protocol.js";

export type RuntimeEventSink = (event: RuntimeEvent) => void;

export interface AgentRuntime {
  startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void>;
  interruptTurn?(command: TurnInterruptCommand, emit: RuntimeEventSink): Promise<void>;
  steerTurn(command: TurnSteerCommand, emit: RuntimeEventSink): Promise<void>;
  cancelTurn(command: TurnCancelCommand, emit: RuntimeEventSink): Promise<void>;
  dispose(): Promise<void>;
}
