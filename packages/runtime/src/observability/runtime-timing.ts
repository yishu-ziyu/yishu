import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SLOW_AWAIT_MS = 200;

export interface YishuPathOptions {
  cwd?: string;
  home?: string;
}

/**
 * Same Diagnostics folder as `last-turn-error.json`.
 * Swift sets cwd to `…/Yishu/RuntimeWorkspace` and does not pass HOME.
 * Do not read HOME / YISHU_HOME.
 */
export function yishuDiagnosticsDir(options: YishuPathOptions = {}): string {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const parent = path.dirname(cwd);
  if (path.basename(cwd) === "RuntimeWorkspace" && path.basename(parent) === "Yishu") {
    return path.join(parent, "Diagnostics");
  }
  return path.join(
    options.home ?? os.homedir(),
    "Library",
    "Application Support",
    "Yishu",
    "Diagnostics",
  );
}

export function lastTurnErrorPath(options: YishuPathOptions = {}): string {
  return path.join(yishuDiagnosticsDir(options), "last-turn-error.json");
}

export function runtimeTimingErrorPath(options: YishuPathOptions = {}): string {
  return path.join(yishuDiagnosticsDir(options), "runtime-timing.error.json");
}

export function runtimeTimingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.YISHU_RUNTIME_TIMING?.trim();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  // Tests must not append to the product diagnostics file unless they opt in.
  if (env.NODE_TEST_CONTEXT && !env.YISHU_RUNTIME_TIMING_PATH) return false;
  return true;
}

export function runtimeTimingPath(
  env: NodeJS.ProcessEnv = process.env,
  options: YishuPathOptions = {},
): string {
  const override = env.YISHU_RUNTIME_TIMING_PATH?.trim();
  if (override) return override;
  return path.join(yishuDiagnosticsDir(options), "runtime-timing.jsonl");
}

export interface RuntimeTimingFields {
  source?: string;
  imageCount?: number;
  imageBytes?: number;
  promptChars?: number;
  historyChars?: number;
  memoryChars?: number;
  trailChars?: number;
  mindChars?: number;
  rulesChars?: number;
  delegatedChars?: number;
  label?: string;
  durationMs?: number;
  /** Reasoning characters received before the first visible character. */
  reasoningChars?: number;
}

const active = new Map<string, RuntimeTurnTiming>();
let writeFailureLogged = false;

export class RuntimeTurnTiming {
  readonly turnId: string;
  private readonly t0: number;
  private readonly filePath: string;
  private readonly enabled: boolean;

  constructor(turnId: string, env: NodeJS.ProcessEnv = process.env) {
    this.turnId = turnId;
    this.t0 = Date.now();
    this.filePath = runtimeTimingPath(env);
    this.enabled = runtimeTimingEnabled(env);
  }

  ms(): number {
    return Date.now() - this.t0;
  }

  mark(name: string, extra: RuntimeTimingFields = {}): void {
    this.write({
      turnId: this.turnId,
      name,
      ms: this.ms(),
      ...pickTimingFields(extra),
    });
  }

  async track<T>(label: string, work: Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await work;
    } finally {
      const durationMs = Date.now() - started;
      if (durationMs > SLOW_AWAIT_MS) {
        this.write({
          turnId: this.turnId,
          name: "slow_await",
          label,
          ms: this.ms(),
          durationMs,
        });
      }
    }
  }

  private write(row: Record<string, string | number>): void {
    if (!this.enabled) return;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(row)}\n`, "utf8");
    } catch (error) {
      if (writeFailureLogged) return;
      writeFailureLogged = true;
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`yishu runtime-timing: failed to write ${this.filePath}: ${detail}\n`);
      try {
        const errorPath = runtimeTimingErrorPath();
        mkdirSync(path.dirname(errorPath), { recursive: true });
        writeFileSync(
          errorPath,
          `${JSON.stringify({
            at: new Date().toISOString(),
            path: this.filePath,
            message: detail,
          })}\n`,
          "utf8",
        );
      } catch {
        // App discards stderr; this file is the fallback. Never throw.
      }
    }
  }
}

function pickTimingFields(extra: RuntimeTimingFields): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (extra.source !== undefined) out.source = extra.source;
  if (extra.imageCount !== undefined) out.imageCount = extra.imageCount;
  if (extra.imageBytes !== undefined) out.imageBytes = extra.imageBytes;
  if (extra.promptChars !== undefined) out.promptChars = extra.promptChars;
  if (extra.historyChars !== undefined) out.historyChars = extra.historyChars;
  if (extra.memoryChars !== undefined) out.memoryChars = extra.memoryChars;
  if (extra.trailChars !== undefined) out.trailChars = extra.trailChars;
  if (extra.mindChars !== undefined) out.mindChars = extra.mindChars;
  if (extra.rulesChars !== undefined) out.rulesChars = extra.rulesChars;
  if (extra.delegatedChars !== undefined) out.delegatedChars = extra.delegatedChars;
  if (extra.label !== undefined) out.label = extra.label;
  if (extra.durationMs !== undefined) out.durationMs = extra.durationMs;
  if (extra.reasoningChars !== undefined) out.reasoningChars = extra.reasoningChars;
  return out;
}

export function beginRuntimeTiming(
  turnId: string,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeTurnTiming {
  const existing = active.get(turnId);
  if (existing) return existing;
  const created = new RuntimeTurnTiming(turnId, env);
  active.set(turnId, created);
  created.mark("turn_received");
  return created;
}

export function runtimeTimingFor(turnId: string): RuntimeTurnTiming | undefined {
  return active.get(turnId);
}

export function endRuntimeTiming(turnId: string): void {
  active.delete(turnId);
}
