import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { clientCommandSchema, PROTOCOL_VERSION, runtimeEvent } from "./protocol.js";
import { StdioComputerUsePort } from "./computer-use-port.js";
import { createAgentRuntime, selectedRuntimeMode } from "./runtime-factory.js";

const runtimeMode = selectedRuntimeMode();

function emit(event: unknown): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const computerUsePort = new StdioComputerUsePort(emit);
const runtime = createAgentRuntime(runtimeMode, { computerUse: computerUsePort });

const processRequestId = randomUUID();
const processTraceId = randomUUID();
emit(runtimeEvent("runtime.ready", processRequestId, processTraceId, {
  mode: runtimeMode,
  protocolVersion: PROTOCOL_VERSION,
  processIdentifier: process.pid,
}));

const lineReader = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

lineReader.on("line", (line) => {
  if (line.trim().length === 0) return;

  let rawCommand: unknown;
  try {
    rawCommand = JSON.parse(line);
  } catch (error) {
    emit(runtimeEvent("runtime.error", randomUUID(), randomUUID(), {
      code: "invalid_json",
      message: error instanceof Error ? error.message : String(error),
    }));
    return;
  }

  const parsedCommand = clientCommandSchema.safeParse(rawCommand);
  if (!parsedCommand.success) {
    const requestId = typeof rawCommand === "object" && rawCommand && "requestId" in rawCommand
      ? String(rawCommand.requestId)
      : randomUUID();
    const traceId = typeof rawCommand === "object" && rawCommand && "traceId" in rawCommand
      ? String(rawCommand.traceId)
      : randomUUID();
    emit(runtimeEvent("runtime.error", requestId, traceId, {
      code: "invalid_command",
      message: parsedCommand.error.issues
        .map((issue) => `${issue.path.join(".") || "command"}: ${issue.message}`)
        .join("; "),
    }));
    return;
  }

  const command = parsedCommand.data;
  if (command.type === "runtime.ping") {
    emit(runtimeEvent("runtime.pong", command.requestId, command.traceId, { mode: runtimeMode }));
    return;
  }

  if (command.type === "computer.action.result") {
    if (!computerUsePort.resolve(command)) {
      emit(runtimeEvent("runtime.error", command.requestId, command.traceId, {
        code: "computer_action_not_pending",
        message: "No pending computer action matches this result.",
      }));
    }
    return;
  }

  const operation = command.type === "turn.start"
    ? runtime.startTurn(command, emit)
    : command.type === "turn.steer"
      ? runtime.steerTurn(command, emit)
      : runtime.cancelTurn(command, emit);

  void operation.catch((error) => {
    emit(runtimeEvent("turn.failed", command.requestId, command.traceId, {
      code: "runtime_operation_failed",
      message: error instanceof Error ? error.message : String(error),
    }));
  });
});

async function shutdown(): Promise<void> {
  lineReader.close();
  computerUsePort.dispose();
  await runtime.dispose();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
