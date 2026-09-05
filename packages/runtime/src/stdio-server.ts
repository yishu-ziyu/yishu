import { processCodexApprovals } from "./providers/codex-approval.js";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { clientCommandSchema, PROTOCOL_VERSION, runtimeEvent } from "./protocol.js";
import { probeModels, reachableProbedModels } from "./model-config.js";
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

if (process.env.YISHU_EVEROS === undefined) {
  process.env.YISHU_EVEROS = "1";
}

const runtimeMode = selectedRuntimeMode();
const authWatchdogTimeoutMs = resolveAuthWatchdogTimeoutMs();
const RUNTIME_INITIALIZATION_TIMEOUT_MS = 10_000;
const RUNTIME_DISPOSE_TIMEOUT_MS = 2_250;
const STDOUT_DRAIN_TIMEOUT_MS = 250;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type BoundedOutcome =
  | { status: "completed" }
  | { status: "failed"; error: unknown }
  | { status: "timed_out" };

async function settleAtMost(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<BoundedOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(
        (): BoundedOutcome => ({ status: "completed" }),
        (error: unknown): BoundedOutcome => ({ status: "failed", error }),
      ),
      new Promise<BoundedOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timed_out" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function drainStdoutAtMost(): Promise<void> {
  const flush = new Promise<void>((resolve) => {
    try {
      process.stdout.write("", () => resolve());
    } catch {
      resolve();
    }
  });
  await settleAtMost(flush, STDOUT_DRAIN_TIMEOUT_MS);
}

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
  // Attach before initialize so the scheduler's first tick cannot emit into a
  // missing sink.
  runtime.setAutomationEmitSink((event) => emit(event));
  // Recovery owns durable task/result reconciliation. Do not accept commands
  // or claim readiness while that state is still ambiguous. A blocked store
  // must not leave an immortal process that never becomes ready.
  const initialization = await settleAtMost(
    runtime.initialize(),
    RUNTIME_INITIALIZATION_TIMEOUT_MS,
  );
  if (initialization.status !== "completed") {
    const timedOut = initialization.status === "timed_out";
    const error = initialization.status === "failed" ? initialization.error : undefined;
    emit(runtimeEvent("runtime.error", randomUUID(), randomUUID(), {
      code: timedOut ? "initialization_timeout" : "initialization_failed",
      message: timedOut
        ? "Runtime initialization timed out."
        : safeRuntimeErrorMessage(error, "Runtime initialization failed."),
    }));
    computerUsePort.dispose();
    await settleAtMost(runtime.dispose(), RUNTIME_DISPOSE_TIMEOUT_MS);
    await drainStdoutAtMost();
    process.exit(1);
  }
}

if (runtime instanceof ProductKernelRuntime) {
  runtime.setTaskPresenceSink((update) => {
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
  if (command.type === "codex.approval.reply") {
    processCodexApprovals.reply(command);
    return;
  }

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
    }));
    return;
  }

  if (command.type === "models.probe") {
    void probeModels().then((results) => {
      const reachable = reachableProbedModels(results);
      emit(runtimeEvent("models.probed", command.requestId, command.traceId, {
        models: reachable.map((row) => ({
          providerId: row.providerId,
          id: row.id,
          name: row.name,
          reachable: true,
          baseUrlHost: row.baseUrlHost,
        })),
        probed: results.map((row) => ({
          providerId: row.providerId,
          id: row.id,
          name: row.name,
          reachable: row.reachable,
          baseUrlHost: row.baseUrlHost,
          ...(row.error === undefined ? {} : { error: row.error }),
        })),
      }));
    }).catch((error) => {
      emit(runtimeEvent("runtime.error", command.requestId, command.traceId, {
        code: "models_probe_failed",
        message: safeRuntimeErrorMessage(error, "Unable to probe models."),
      }));
    });
    return;
  }

  if (command.type === "trail.observe") {
    if (runtime instanceof ProductKernelRuntime) {
      void runtime.observeTrail(command, emit).catch((error) => {
        emit(runtimeEvent("runtime.error", command.requestId, command.traceId, {
          code: "context_watch_evaluation_failed",
          message: safeRuntimeErrorMessage(error, "Unable to evaluate context reminders."),
        }));
      });
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

  if (command.type === "history.restore") {
    if (runtime instanceof ProductKernelRuntime) {
      void runtime.restoreHistory(command, emit).catch((error) => {
        emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
          code: "history_restore_failed",
          message: safeRuntimeErrorMessage(error, "恢复失败，对话仍保持归档。"),
        }));
      });
    } else {
      emit(runtimeEvent("history.failed", command.requestId, command.traceId, {
        code: "product_kernel_disabled",
        message: "history.restore requires product kernel (YISHU_PRODUCT_KERNEL not off).",
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

  if (command.type === "memory.remember") {
    if (runtime instanceof ProductKernelRuntime) {
      void runtime.rememberMemory(command, emit).catch((error) => {
        emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
          code: "memory_remember_failed",
          message: safeRuntimeErrorMessage(error, "这次没有记下。"),
        }));
      });
    } else {
      emit(runtimeEvent("memory.failed", command.requestId, command.traceId, {
        code: "product_kernel_disabled",
        message: "这次没有记下。",
      }));
    }
    return;
  }

  if (command.type === "workspace.grant") {
    if (runtime instanceof ProductKernelRuntime) {
      void runtime.delegation.workspace.grant(command, emit).catch((error) => {
        emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
          code: "workspace_grant_failed",
          message: safeRuntimeErrorMessage(error, "这次没有加上这个文件夹。"),
        }));
      });
    } else {
      emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
        code: "product_kernel_disabled",
        message: "这次没有加上这个文件夹。",
      }));
    }
    return;
  }

  if (command.type === "workspace.revoke") {
    if (runtime instanceof ProductKernelRuntime) {
      void runtime.delegation.workspace.revoke(command, emit).catch((error) => {
        emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
          code: "workspace_revoke_failed",
          message: safeRuntimeErrorMessage(error, "这次没有撤销。"),
        }));
      });
    } else {
      emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
        code: "product_kernel_disabled",
        message: "这次没有撤销。",
      }));
    }
    return;
  }

  if (command.type === "workspace.list") {
    if (runtime instanceof ProductKernelRuntime) {
      void runtime.delegation.workspace.list(command, emit).catch((error) => {
        emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
          code: "workspace_list_failed",
          message: safeRuntimeErrorMessage(error, "暂时无法读取文件夹工作区。"),
        }));
      });
    } else {
      emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
        code: "product_kernel_disabled",
        message: "暂时无法读取文件夹工作区。",
      }));
    }
    return;
  }

  if (command.type === "workspace.approve") {
    if (runtime instanceof ProductKernelRuntime) {
      void runtime.delegation.workspace.approve(command, emit).catch((error) => {
        emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
          code: "workspace_approve_failed",
          message: safeRuntimeErrorMessage(error, "这次没有改废纸篓许可。"),
        }));
      });
    } else {
      emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
        code: "product_kernel_disabled",
        message: "这次没有改废纸篓许可。",
      }));
    }
    return;
  }

  if (command.type === "automation.list") {
    if (runtime instanceof ProductKernelRuntime) {
      void runtime.listAutomations(command, emit).catch((error) => {
        emit(runtimeEvent("automation.failed", command.requestId, command.traceId, {
          code: "automation_list_failed",
          message: safeRuntimeErrorMessage(error, "暂时无法读取例程。"),
        }));
      });
    } else {
      emit(runtimeEvent("automation.failed", command.requestId, command.traceId, {
        code: "product_kernel_disabled",
        message: "automation.list requires product kernel.",
      }));
    }
    return;
  }

  if (command.type === "automation.create") {
    if (runtime instanceof ProductKernelRuntime) {
      void runtime.createAutomation(command, emit).catch((error) => {
        emit(runtimeEvent("automation.failed", command.requestId, command.traceId, {
          code: "automation_create_failed",
          message: safeRuntimeErrorMessage(error, "这次没有建好例程。"),
        }));
      });
    } else {
      emit(runtimeEvent("automation.failed", command.requestId, command.traceId, {
        code: "product_kernel_disabled",
        message: "automation.create requires product kernel.",
      }));
    }
    return;
  }

  if (command.type === "automation.update") {
    if (runtime instanceof ProductKernelRuntime) {
      void runtime.updateAutomation(command, emit).catch((error) => {
        emit(runtimeEvent("automation.failed", command.requestId, command.traceId, {
          code: "automation_update_failed",
          message: safeRuntimeErrorMessage(error, "这次没有改好例程。"),
        }));
      });
    } else {
      emit(runtimeEvent("automation.failed", command.requestId, command.traceId, {
        code: "product_kernel_disabled",
        message: "automation.update requires product kernel.",
      }));
    }
    return;
  }

  if (command.type === "automation.setEnabled") {
    if (runtime instanceof ProductKernelRuntime) {
      void runtime.setAutomationEnabled(command, emit).catch((error) => {
        emit(runtimeEvent("automation.failed", command.requestId, command.traceId, {
          code: "automation_set_enabled_failed",
          message: safeRuntimeErrorMessage(error, "这次没有切换例程状态。"),
        }));
      });
    } else {
      emit(runtimeEvent("automation.failed", command.requestId, command.traceId, {
        code: "product_kernel_disabled",
        message: "automation.setEnabled requires product kernel.",
      }));
    }
    return;
  }

  if (command.type === "automation.runNow") {
    if (runtime instanceof ProductKernelRuntime) {
      void runtime.runAutomationNow(command, emit).catch((error) => {
        emit(runtimeEvent("automation.failed", command.requestId, command.traceId, {
          code: "automation_run_failed",
          message: safeRuntimeErrorMessage(error, "这次没有运行例程。"),
        }));
      });
    } else {
      emit(runtimeEvent("automation.failed", command.requestId, command.traceId, {
        code: "product_kernel_disabled",
        message: "automation.runNow requires product kernel.",
      }));
    }
    return;
  }

  if (command.type === "automation.delete") {
    if (runtime instanceof ProductKernelRuntime) {
      void runtime.deleteAutomation(command, emit).catch((error) => {
        emit(runtimeEvent("automation.failed", command.requestId, command.traceId, {
          code: "automation_delete_failed",
          message: safeRuntimeErrorMessage(error, "这次没有删掉例程。"),
        }));
      });
    } else {
      emit(runtimeEvent("automation.failed", command.requestId, command.traceId, {
        code: "product_kernel_disabled",
        message: "automation.delete requires product kernel.",
      }));
    }
    return;
  }

  if (command.type === "speech.excerpt") {
    if (runtime instanceof ProductKernelRuntime) {
      void runtime.excerptSpeech(command, emit).catch((error) => {
        emit(runtimeEvent("speech.failed", command.requestId, command.traceId, {
          code: "excerpt_failed",
          message: safeRuntimeErrorMessage(error, "暂时无法抽出口播。"),
        }));
      });
    } else {
      emit(runtimeEvent("speech.failed", command.requestId, command.traceId, {
        code: "product_kernel_disabled",
        message: "speech.excerpt requires product kernel (YISHU_PRODUCT_KERNEL not off).",
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
    void runtime.cancelTask(command).then((accepted) => {
      if (!accepted) {
        emit(runtimeEvent("runtime.error", command.requestId, command.traceId, {
          code: "task_not_running",
          message: "The background task is no longer running in this conversation.",
        }));
      } else {
        emit(runtimeEvent("task.cancel.accepted", command.requestId, command.traceId, {
          taskId: command.payload.taskId,
          mainConversationId: command.payload.mainConversationId,
        }, command.payload.mainConversationId));
      }
    }).catch((error) => {
      emit(runtimeEvent("runtime.error", command.requestId, command.traceId, {
        code: "task_cancel_failed",
        message: safeRuntimeErrorMessage(error, "Unable to stop the background task."),
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
    void runtime.listTasks(command.payload.mainConversationId).then((tasks) => {
      emit(runtimeEvent("task.listed", command.requestId, command.traceId, { tasks },
        command.payload.mainConversationId));
    }).catch((error) => {
      emit(runtimeEvent("runtime.error", command.requestId, command.traceId, {
        code: "task_list_failed",
        message: safeRuntimeErrorMessage(error, "Unable to restore background tasks."),
      }));
    });
    return;
  }

  const operation = command.type === "turn.start"
    ? runtime.startTurn(command, emit)
    : command.type === "turn.interrupt"
      ? runtime.interruptTurn?.(command, emit) ?? Promise.resolve(emit(runtimeEvent(
          "turn.interrupt.rejected",
          command.requestId,
          command.traceId,
          { generation: command.payload.expectedGeneration, code: "unsupported" },
        )))
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

let shutdownStarted = false;

async function shutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  lineReader.close();
  computerUsePort.dispose();
  const disposal = await settleAtMost(runtime.dispose(), RUNTIME_DISPOSE_TIMEOUT_MS);
  if (disposal.status !== "completed") {
    process.exitCode = 1;
  }
  // Terminal events are emitted after durable settlement. Give those complete
  // lines a small bounded flush window before force-exit so shutdown itself
  // does not turn a committed outcome into a silent UI loss.
  await drainStdoutAtMost();
  // The durable runtime has finished its bounded shutdown. Force this sidecar
  // process to stop so a provider timer or broken test double cannot keep an
  // orphan alive or publish a late completion after SIGTERM/stdin EOF.
  process.exit(process.exitCode ?? 0);
}

lineReader.once("close", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
