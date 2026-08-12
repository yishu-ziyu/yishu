import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { clientCommandSchema, PROTOCOL_VERSION, runtimeEvent } from "./protocol.js";
import { StdioComputerUsePort } from "./computer-use-port.js";
import { createAgentRuntime, selectedRuntimeMode } from "./runtime-factory.js";
import { ProductKernelRuntime } from "./product-kernel-runtime.js";
import {
  AuthServiceError,
  safeRuntimeErrorMessage,
  type AuthServiceEvent,
  type YishuAuthService,
} from "./auth-service.js";
import { runAuthWatchdog, resolveAuthWatchdogTimeoutMs } from "./auth-watchdog.js";
import type { AgentRuntime } from "./runtime-port.js";

const runtimeMode = selectedRuntimeMode();
const authWatchdogTimeoutMs = resolveAuthWatchdogTimeoutMs();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function reuseValidUuid(value: unknown): string {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : randomUUID();
}

function emit(event: unknown): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const computerUsePort = new StdioComputerUsePort(emit);
const runtime = createAgentRuntime(runtimeMode, { computerUse: computerUsePort });
const authService = (runtime as AgentRuntime & { authService?: YishuAuthService }).authService;

if (runtime instanceof ProductKernelRuntime) {
  runtime.delegation.setPresenceSink((update) => {
    emit(runtimeEvent(
      "task.presence.updated",
      reuseValidUuid(update.parentId),
      randomUUID(),
      update,
      update.mainConversationId,
    ));
  });
}

const processRequestId = randomUUID();
const processTraceId = randomUUID();
emit(runtimeEvent("runtime.ready", processRequestId, processTraceId, {
  mode: runtimeMode,
  protocolVersion: PROTOCOL_VERSION,
  processIdentifier: process.pid,
  productKernel: runtime instanceof ProductKernelRuntime,
  storeBackend:
    runtime instanceof ProductKernelRuntime
      ? runtime.kernel.storeBackend
      : null,
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
      ? reuseValidUuid(rawCommand.requestId)
      : randomUUID();
    const traceId = typeof rawCommand === "object" && rawCommand && "traceId" in rawCommand
      ? reuseValidUuid(rawCommand.traceId)
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

  const emitAuthServiceEvent = (
    context: { requestId: string; traceId: string },
    event: AuthServiceEvent,
  ): void => {
    emit(runtimeEvent(event.type, context.requestId, context.traceId, event.payload));
  };

  if (command.type === "auth.status") {
    if (!authService) {
      emit(runtimeEvent("auth.failed", command.requestId, command.traceId, {
        provider: command.payload.provider ?? "xai",
        code: "unavailable",
        message: "当前运行模式未启用 OAuth。",
      }));
      return;
    }
    void runAuthWatchdog(
      Promise.resolve().then(() => authService.status(command.payload.provider)),
      authWatchdogTimeoutMs,
      () => emit(runtimeEvent("auth.failed", command.requestId, command.traceId, {
        provider: command.payload.provider ?? "xai",
        code: "timeout",
        message: "OAuth 状态查询超时，请重试。",
      })),
    ).then((result) => {
      if (result.timedOut) return;
      for (const status of result.value) {
        emit(runtimeEvent("auth.status", command.requestId, command.traceId, status));
      }
    }).catch((error) => {
      const failure = error instanceof AuthServiceError
        ? { code: error.code, message: error.message }
        : { code: "unavailable" as const, message: safeRuntimeErrorMessage(error, "OAuth 状态暂时不可用。") };
      emit(runtimeEvent("auth.failed", command.requestId, command.traceId, {
        provider: command.payload.provider ?? "xai",
        ...failure,
      }));
    });
    return;
  }

  if (command.type === "auth.login.start") {
    if (!authService) {
      emit(runtimeEvent("auth.failed", command.requestId, command.traceId, {
        provider: command.payload.provider,
        code: "unavailable",
        message: "当前运行模式未启用 OAuth。",
      }));
      return;
    }
    void authService.startLogin(
      { requestId: command.requestId, traceId: command.traceId },
      command.payload.provider,
      (event) => emitAuthServiceEvent(command, event),
    );
    return;
  }

  if (command.type === "auth.prompt.reply") {
    if (!authService || !authService.replyPrompt(
      command.requestId,
      command.payload.provider,
      command.payload.promptId,
      command.payload.value,
    )) {
      emit(runtimeEvent("auth.failed", command.requestId, command.traceId, {
        provider: command.payload.provider,
        code: "invalid_request",
        message: "没有匹配的登录提示。",
      }));
    }
    return;
  }

  if (command.type === "auth.login.cancel") {
    if (!authService || !authService.cancelLogin(command.requestId, command.payload.provider)) {
      emit(runtimeEvent("auth.failed", command.requestId, command.traceId, {
        provider: command.payload.provider,
        code: "invalid_request",
        message: "没有匹配的登录流程。",
      }));
    }
    return;
  }

  if (command.type === "auth.logout") {
    if (!authService) {
      emit(runtimeEvent("auth.failed", command.requestId, command.traceId, {
        provider: command.payload.provider,
        code: "unavailable",
        message: "当前运行模式未启用 OAuth。",
      }));
      return;
    }
    let emitAllowed = true;
    let terminalEventEmitted = false;
    void runAuthWatchdog(
      Promise.resolve().then(() => authService.logout(
        { requestId: command.requestId, traceId: command.traceId },
        command.payload.provider,
        (event) => {
          if (!emitAllowed || terminalEventEmitted) return;
          terminalEventEmitted = event.type === "auth.logged_out" || event.type === "auth.failed";
          emitAuthServiceEvent(command, event);
        },
      )),
      authWatchdogTimeoutMs,
      () => {
        // The underlying AuthService logout is intentionally not aborted. Its
        // provider transition remains active until the real finally block,
        // preventing a late credential delete from racing a new login.
        emitAllowed = false;
        if (terminalEventEmitted) return;
        terminalEventEmitted = true;
        emit(runtimeEvent("auth.failed", command.requestId, command.traceId, {
          provider: command.payload.provider,
          code: "timeout",
          message: "退出登录超时，后台仍在完成清理。",
        }));
      },
    ).catch((error) => {
      if (!emitAllowed || terminalEventEmitted) return;
      terminalEventEmitted = true;
      const failure = error instanceof AuthServiceError
        ? { code: error.code, message: error.message }
        : { code: "unavailable" as const, message: safeRuntimeErrorMessage(error, "OAuth 退出登录暂时不可用。") };
      emit(runtimeEvent("auth.failed", command.requestId, command.traceId, {
        provider: command.payload.provider,
        ...failure,
      }));
    });
    return;
  }

  if (command.type === "runtime.ping") {
    emit(runtimeEvent("runtime.pong", command.requestId, command.traceId, {
      mode: runtimeMode,
      trailSize:
        runtime instanceof ProductKernelRuntime
          ? runtime.kernel.trail.size()
          : 0,
    }));
    return;
  }

  if (command.type === "trail.observe") {
    if (runtime instanceof ProductKernelRuntime) {
      runtime.observeTrail(command, emit);
    } else {
      emit(runtimeEvent("runtime.error", command.requestId, command.traceId, {
        code: "product_kernel_disabled",
        message: "trail.observe requires product kernel (YISHU_PRODUCT_KERNEL not off).",
      }));
    }
    return;
  }

  if (command.type === "history.list") {
    if (runtime instanceof ProductKernelRuntime) {
      void runtime.listHistory(command, emit).catch((error) => {
        emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
          code: "history_list_failed",
          message: safeRuntimeErrorMessage(error, "暂时无法读取历史对话。"),
        }));
      });
    } else {
      emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
        code: "product_kernel_disabled",
        message: "history.list requires product kernel (YISHU_PRODUCT_KERNEL not off).",
      }));
    }
    return;
  }

  if (command.type === "history.open") {
    if (runtime instanceof ProductKernelRuntime) {
      void runtime.openHistory(command, emit).catch((error) => {
        emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
          code: "history_open_failed",
          message: safeRuntimeErrorMessage(error, "暂时无法打开这段对话。"),
        }));
      });
    } else {
      emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
        code: "product_kernel_disabled",
        message: "history.open requires product kernel (YISHU_PRODUCT_KERNEL not off).",
      }));
    }
    return;
  }

  if (command.type === "history.delete") {
    if (runtime instanceof ProductKernelRuntime) {
      void runtime.deleteHistory(command, emit).catch((error) => {
        emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
          code: "history_delete_failed",
          message: safeRuntimeErrorMessage(error, "删除失败，原对话仍保留。"),
        }));
      });
    } else {
      emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
        code: "product_kernel_disabled",
        message: "history.delete requires product kernel (YISHU_PRODUCT_KERNEL not off).",
      }));
    }
    return;
  }

  if (command.type === "memory.list") {
    if (runtime instanceof ProductKernelRuntime) {
      void runtime.listMemories(command, emit).catch((error) => {
        emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
          code: "memory_list_failed",
          message: safeRuntimeErrorMessage(error, "暂时无法读取已保存的记忆。"),
        }));
      });
    } else {
      emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
        code: "product_kernel_disabled",
        message: "memory.list requires product kernel (YISHU_PRODUCT_KERNEL not off).",
      }));
    }
    return;
  }

  if (command.type === "memory.forget") {
    if (runtime instanceof ProductKernelRuntime) {
      void runtime.forgetMemory(command, emit).catch((error) => {
        emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
          code: "memory_forget_failed",
          message: safeRuntimeErrorMessage(error, "忘记失败，原记忆仍保留。"),
        }));
      });
    } else {
      emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
        code: "product_kernel_disabled",
        message: "memory.forget requires product kernel (YISHU_PRODUCT_KERNEL not off).",
      }));
    }
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

  if (command.type === "task.cancel") {
    if (!(runtime instanceof ProductKernelRuntime)) {
      emit(runtimeEvent("runtime.error", command.requestId, command.traceId, {
        code: "product_kernel_disabled",
        message: "task.cancel requires product kernel (YISHU_PRODUCT_KERNEL not off).",
      }));
      return;
    }
    void runtime.cancelDelegatedTask(command).then((accepted) => {
      if (!accepted) {
        emit(runtimeEvent("runtime.error", command.requestId, command.traceId, {
          code: "delegated_task_not_running",
          message: "The delegated task is no longer running in this conversation.",
        }));
      } else {
        emit(runtimeEvent("task.cancel.accepted", command.requestId, command.traceId, {
          taskId: command.payload.taskId,
          mainConversationId: command.payload.mainConversationId,
        }, command.payload.mainConversationId));
      }
    }).catch((error) => {
      emit(runtimeEvent("runtime.error", command.requestId, command.traceId, {
        code: "delegated_task_cancel_failed",
        message: safeRuntimeErrorMessage(error, "Unable to stop the delegated task."),
      }));
    });
    return;
  }

  if (command.type === "task.list") {
    if (!(runtime instanceof ProductKernelRuntime)) {
      emit(runtimeEvent("runtime.error", command.requestId, command.traceId, {
        code: "product_kernel_disabled",
        message: "task.list requires product kernel (YISHU_PRODUCT_KERNEL not off).",
      }));
      return;
    }
    void runtime.listDelegatedTasks(command.payload.mainConversationId).then((tasks) => {
      emit(runtimeEvent("task.listed", command.requestId, command.traceId, { tasks },
        command.payload.mainConversationId));
    }).catch((error) => {
      emit(runtimeEvent("runtime.error", command.requestId, command.traceId, {
        code: "delegated_task_list_failed",
        message: safeRuntimeErrorMessage(error, "Unable to restore delegated tasks."),
      }));
    });
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
      message: safeRuntimeErrorMessage(error),
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
