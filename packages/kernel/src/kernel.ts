import { homedir } from "node:os";
import path from "node:path";
import { YishuActionRegistry } from "./action/registry.js";
import type { AnyYishuAction } from "./action/types.js";
import {
  createConversationLedger,
  type ConversationLedger,
} from "./conversation/ledger.js";
import { ContextTrail } from "./context/trail.js";
import type { ContextTrailOptions } from "./context/trail.js";
import {
  createBrowserAction,
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
import { VisibleMemoryFile } from "./memory/visible-file.js";
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
  /** The one user-visible file. Agent writes; user edits. */
  readonly visible: VisibleMemoryFile;
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
  /**
   * User-visible memory file (ADR 0018). Product default is
   * ~/Documents/Yishu/记忆.md. Tests that pass memoryDir without this
   * get `<memoryDir>/记忆.md` so they never touch the user's file.
   */
  visibleMemoryPath?: string;
  trail?: ContextTrailOptions;
  /** Extra product actions to register after the defaults. */
  extraActions?: AnyYishuAction[];
}

export interface YishuKernel {
  registry: YishuActionRegistry;
  /**
   * Transitional full store. History list/open/archive already go through
   * `conversations`. Remaining runtime callers (PKR turn/memory/watch paths,
   * delegation.ts store + YishuStorePort, suggestion-loop via registry) still
   * use this until later PRs migrate them onto narrow ports.
   */
  store: YishuStorePort;
  conversations: ConversationLedger;
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
  const visiblePath = options.visibleMemoryPath
    ?? path.join(options.memoryDir, "记忆.md");
  const visible = new VisibleMemoryFile(visiblePath);
  let queue: ExtractionQueuePort;
  if (resolved.backend === "sqlite" && resolved.sqlitePath !== undefined) {
    queue = new SqliteExtractionQueue(resolved.sqlitePath);
  } else if (resolved.backend === "json" && resolved.storeDir !== undefined) {
    queue = new JsonExtractionQueue(resolved.storeDir);
  } else {
    queue = new InMemoryExtractionQueue();
  }
  return { truth, queue, visible };
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
  const conversations = createConversationLedger(store);
  const registry = new YishuActionRegistry();

  const defaults: AnyYishuAction[] = [
    createRememberAction(store, memory?.truth, memory?.visible),
    createForgetAction(store, memory?.truth, memory?.visible),
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
    createBrowserAction(),
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
    conversations,
    trail,
    taskTruth,
    storeBackend: backend,
    ...(memory !== undefined ? { memory } : {}),
    defaultActionNames: defaults.map((a) => a.name),
  };
}

/**
 * Product host default: SQLite under ~/.yishu (or YISHU_STORE_DIR /
 * YISHU_SQLITE_PATH), the legacy fallback truth layer under
 * ~/Documents/Yishu/Memory (or YISHU_MEMORY_DIR), and the one user-visible file
 * ~/Documents/Yishu/记忆.md (or YISHU_VISIBLE_MEMORY_FILE, ADR 0018).
 * EverOS engine storage is owned by the runtime sidecar (ADR 0017).
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
  options.visibleMemoryPath = environment.YISHU_VISIBLE_MEMORY_FILE
    ?? path.join(homedir(), "Documents", "Yishu", "记忆.md");
  return createYishuKernel(options);
}
