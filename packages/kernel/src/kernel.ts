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
  createLearnMindFromPatternAction,
  createRecordLearningAction,
  createRecordSuggestionAction,
  createRememberAction,
  createRememberHowAction,
  createRunSkillAction,
  createSettleSuggestionAction,
  createShareContextAction,
} from "./actions/index.js";
import {
  InMemoryYishuStore,
  YishuStore,
  type YishuStorePort,
} from "./store/yishu-store.js";
import { SqliteYishuStore } from "./store/sqlite-store.js";
import { TaskTruthProjector } from "./task-truth.js";

export type YishuStoreBackend = "memory" | "json" | "sqlite";

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
  /** Default product action names registered at create time. */
  defaultActionNames: readonly string[];
}

function resolveStore(options: CreateYishuKernelOptions): {
  store: YishuStorePort;
  backend: YishuStoreBackend;
} {
  const backend = options.storeBackend ?? "memory";
  if (backend === "memory") {
    return { store: new InMemoryYishuStore(), backend };
  }
  if (backend === "json") {
    const dir = options.storeDir ?? path.join(homedir(), ".yishu");
    return { store: new YishuStore(dir), backend };
  }
  const sqlitePath =
    options.sqlitePath ??
    path.join(
      options.storeDir ?? path.join(homedir(), ".yishu"),
      "yishu-store.sqlite",
    );
  return { store: new SqliteYishuStore(sqlitePath), backend };
}

/**
 * Wire the product kernel: store + ContextTrail + YishuAction registry.
 * Pi / AgentRuntime remain separate; this is the product capability layer.
 */
export function createYishuKernel(
  options: CreateYishuKernelOptions = {},
): YishuKernel {
  const { store, backend } = resolveStore(options);
  const trail = new ContextTrail(options.trail);
  const taskTruth = new TaskTruthProjector(store);
  const registry = new YishuActionRegistry();

  const defaults: AnyYishuAction[] = [
    createRememberAction(store),
    createForgetAction(store),
    createRememberHowAction({ store, trail }),
    createShareContextAction(trail),
    createRecordLearningAction(store),
    createRecordSuggestionAction(store),
    createSettleSuggestionAction(store),
    createLearnMindFromPatternAction(store),
    createRunSkillAction({ store, trail }),
    createFinderHistoryBackAction(),
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
    defaultActionNames: defaults.map((a) => a.name),
  };
}

/**
 * Product host default: SQLite under ~/.yishu (or YISHU_STORE_DIR / YISHU_SQLITE_PATH).
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
  return createYishuKernel(options);
}
