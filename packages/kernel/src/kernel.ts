import { homedir } from "node:os";
import path from "node:path";
import { YishuActionRegistry } from "./action/registry.js";
import type { AnyYishuAction } from "./action/types.js";
import { ContextTrail } from "./context/trail.js";
import type { ContextTrailOptions } from "./context/trail.js";
import {
  createDelegateAction,
  createForgetAction,
  createFinderHistoryBackAction,
  createNoteAction,
  createScheduleTimeReminderAction,
  createLearnMindFromPatternAction,
  createRecordLearningAction,
  createRecordSuggestionAction,
  createRememberAction,
  createRememberHowAction,
  createRunSkillAction,
  createSettleSuggestionAction,
  createShareContextAction,
  createWatchAppReturnAction,
} from "./actions/index.js";
import {
  InMemoryYishuStore,
  YishuStore,
  type YishuStorePort,
} from "./store/yishu-store.js";
import { SqliteYishuStore } from "./store/sqlite-store.js";
import { TaskTruthProjector } from "./task-truth.js";
import { MemoryTruthLayer } from "./memory/truth-layer.js";
import {
  InMemoryExtractionQueue,
  JsonExtractionQueue,
  SqliteExtractionQueue,
  type ExtractionQueuePort,
} from "./memory/extraction-queue.js";

export type YishuStoreBackend = "memory" | "json" | "sqlite";

export interface YishuMemoryLayer {
  readonly truth: MemoryTruthLayer;
  readonly queue: ExtractionQueuePort;
}

export interface CreateYishuKernelOptions {
  /**
   * Store backend. Default: memory for tests; product hosts should pass sqlite.
   * Env YISHU_STORE_BACKEND can override when createDefaultProductKernel is used.
   */
  storeBackend?: YishuStoreBackend;
  /** Directory for json (`yishu-store.json`) or sqlite (`yishu-store.sqlite`). */
  storeDir?: string;
  /** Explicit sqlite file path (wins over storeDir). */
  sqlitePath?: string;
  /**
   * Markdown truth-layer root (ADR 0016 #1). When absent, no memory layer is
   * wired: remember writes the index only (test/embedded hosts).
   */
  memoryDir?: string;
  trail?: ContextTrailOptions;
  /** Extra product actions to register after the defaults. */
  extraActions?: AnyYishuAction[];
}

export interface YishuKernel {
  registry: YishuActionRegistry;
  store: YishuStorePort;
  trail: ContextTrail;
  taskTruth: TaskTruthProjector;
  storeBackend: YishuStoreBackend;
  /** Present only when a memory directory is wired (ADR 0016). */
  memory?: YishuMemoryLayer;
  /** Default product action names registered at create time. */
  defaultActionNames: readonly string[];
}

function resolveStore(options: CreateYishuKernelOptions): {
  store: YishuStorePort;
  backend: YishuStoreBackend;
  sqlitePath?: string;
  storeDir?: string;
} {
  const backend = options.storeBackend ?? "memory";
  if (backend === "memory") {
    return { store: new InMemoryYishuStore(), backend };
  }
  if (backend === "json") {
    const dir = options.storeDir ?? path.join(homedir(), ".yishu");
    return { store: new YishuStore(dir), backend, storeDir: dir };
  }
  const sqlitePath =
    options.sqlitePath ??
    path.join(
      options.storeDir ?? path.join(homedir(), ".yishu"),
      "yishu-store.sqlite",
    );
  return {
    store: new SqliteYishuStore(sqlitePath),
    backend,
    sqlitePath,
    ...(options.storeDir !== undefined ? { storeDir: options.storeDir } : {}),
  };
}

function buildMemoryLayer(
  options: CreateYishuKernelOptions,
  resolved: ReturnType<typeof resolveStore>,
): YishuMemoryLayer | undefined {
  if (options.memoryDir === undefined) return undefined;
  const truth = new MemoryTruthLayer(options.memoryDir);
  let queue: ExtractionQueuePort;
  if (resolved.backend === "sqlite" && resolved.sqlitePath !== undefined) {
    queue = new SqliteExtractionQueue(resolved.sqlitePath);
  } else if (resolved.backend === "json" && resolved.storeDir !== undefined) {
    queue = new JsonExtractionQueue(resolved.storeDir);
  } else {
    queue = new InMemoryExtractionQueue();
  }
  return { truth, queue };
}

/**
 * Wire the product kernel: store + ContextTrail + YishuAction registry.
 * Pi / AgentRuntime remain separate; this is the product capability layer.
 */
export function createYishuKernel(
  options: CreateYishuKernelOptions = {},
): YishuKernel {
  const resolved = resolveStore(options);
  const { store, backend } = resolved;
  const memory = buildMemoryLayer(options, resolved);
  const trail = new ContextTrail(options.trail);
  const taskTruth = new TaskTruthProjector(store);
  const registry = new YishuActionRegistry();

  const defaults: AnyYishuAction[] = [
    createRememberAction(store, memory?.truth),
    createForgetAction(store, memory?.truth),
    createRememberHowAction({ store, trail }),
    createShareContextAction(trail),
    createRecordLearningAction(store),
    createRecordSuggestionAction(store),
    createSettleSuggestionAction(store),
    createLearnMindFromPatternAction(store),
    createRunSkillAction({ store, trail }),
    createFinderHistoryBackAction(),
    createNoteAction(),
    createScheduleTimeReminderAction(),
    createWatchAppReturnAction(store),
    createDelegateAction({ taskTruth }),
  ];

  for (const action of defaults) {
    registry.register(action);
  }
  for (const action of options.extraActions ?? []) {
    registry.register(action);
  }

  return {
    registry,
    store,
    trail,
    taskTruth,
    storeBackend: backend,
    ...(memory !== undefined ? { memory } : {}),
    defaultActionNames: defaults.map((a) => a.name),
  };
}

/**
 * Product host default: SQLite under ~/.yishu (or YISHU_STORE_DIR /
 * YISHU_SQLITE_PATH) and markdown memory under ~/Documents/Yishu/Memory
 * (or YISHU_MEMORY_DIR, ADR 0016 #1).
 */
export function createDefaultProductKernel(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): YishuKernel {
  const backendRaw = environment.YISHU_STORE_BACKEND;
  const backend: YishuStoreBackend =
    backendRaw === "memory" || backendRaw === "json" || backendRaw === "sqlite"
      ? backendRaw
      : "sqlite";

  const options: CreateYishuKernelOptions = { storeBackend: backend };
  if (environment.YISHU_SQLITE_PATH) {
    options.sqlitePath = environment.YISHU_SQLITE_PATH;
  }
  if (environment.YISHU_STORE_DIR) {
    options.storeDir = environment.YISHU_STORE_DIR;
  }
  options.memoryDir = environment.YISHU_MEMORY_DIR
    ?? path.join(homedir(), "Documents", "Yishu", "Memory");
  return createYishuKernel(options);
}
