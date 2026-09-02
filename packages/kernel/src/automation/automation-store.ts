/**
 * File-backed routine store, ported from grok-bot 0.18
 * (source/host/automations/automation-store.ts). One folder per routine under
 * ~/Documents/Yishu/routines, each holding automation.json and runs.json, so
 * the user can read and grep their standing orders. No file watcher: every
 * mutation flows through this store and the scheduler rescans per tick.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { automationAnchor, computeNextRunAt, describeTrigger, normalizeSchedule } from "./automation-schedule.js";
import {
  AUTOMATION_MAX_PER_AGENT,
  AUTOMATION_MAX_RUN_DETAIL_LENGTH,
  AUTOMATION_MAX_RUN_HISTORY,
  clampAutomationName,
  cronTrigger,
  normalizeAutomationPrompt,
  slugifyAutomationName,
  triggerCronSchedules,
  triggerFromList,
  triggerList,
  triggerSchedule,
  type AutomationConfig,
  type AutomationRecord,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationRunTrigger,
  type AutomationSpec,
  type AutomationTrigger,
  type AutomationTriggerMember,
} from "./automation-types.js";

export const ROUTINES_DIRNAME = "routines";
export const CONFIG_FILENAME = "automation.json";
export const RUNS_FILENAME = "runs.json";

export function defaultRoutinesRootPath(): string {
  return path.join(homedir(), "Documents", "Yishu", ROUTINES_DIRNAME);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

export function isSafeFolderId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/u.test(id) && id.length <= 64 && !id.includes("..");
}

export function parseStoredMember(value: unknown): AutomationTriggerMember | null {
  if (!object(value)) return null;
  const type = value.type;
  if (type === "cron") {
    const schedule = typeof value.schedule === "string" ? normalizeSchedule(value.schedule) : "";
    return schedule ? cronTrigger(schedule) : null;
  }
  if (type === "app_transition") {
    const app = typeof value.app === "string" ? value.app.trim() : "";
    const transition = value.transition;
    if (!app || (transition !== "foreground" && transition !== "background")) return null;
    return { type: "app_transition", app, transition };
  }
  if (type === "file_change") {
    const watchPath = typeof value.path === "string" ? value.path.trim() : "";
    return watchPath ? { type: "file_change", path: watchPath } : null;
  }
  if (type === "system_resume") return { type: "system_resume" };
  return null;
}

export function parseStoredTrigger(value: unknown): AutomationTrigger | null {
  if (!object(value)) return null;
  if (value.type === "group") {
    if (!Array.isArray(value.listeners)) return null;
    const members = value.listeners.map(parseStoredMember).filter((member): member is AutomationTriggerMember => member != null);
    if (members.length !== value.listeners.length || members.length === 0) return null;
    return triggerFromList(members);
  }
  return parseStoredMember(value);
}

export function serializeStoredTrigger(trigger: AutomationTrigger): Record<string, unknown> {
  if (trigger.type === "cron") return { type: "cron", schedule: trigger.schedule };
  if (trigger.type === "group") return { type: "group", listeners: trigger.listeners.map(serializeStoredTrigger) };
  return { ...trigger } as Record<string, unknown>;
}

export function parseStoredConfig(raw: string, fallbackCreatedAt: number): AutomationConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!object(parsed)) return null;
  const name = typeof parsed.name === "string" ? clampAutomationName(parsed.name) : "";
  const prompt = typeof parsed.prompt === "string" ? normalizeAutomationPrompt(parsed.prompt) : "";
  const trigger = parseStoredConfigTrigger(parsed);
  if (!name || !prompt || trigger == null) return null;
  const authored = typeof parsed.createdAt === "number" && Number.isFinite(parsed.createdAt) ? parsed.createdAt : fallbackCreatedAt;
  return {
    name,
    prompt,
    trigger,
    isEnabled: parsed.enabled !== false,
    createdAt: Math.min(authored, fallbackCreatedAt),
    lastRunAt: typeof parsed.lastRunAt === "number" && Number.isFinite(parsed.lastRunAt) ? parsed.lastRunAt : null,
  };
}

function parseStoredConfigTrigger(parsed: Record<string, unknown>): AutomationTrigger | null {
  if (parsed.trigger != null) {
    const trigger = parseStoredTrigger(parsed.trigger);
    if (trigger != null) return trigger;
  }
  const schedule = typeof parsed.schedule === "string" ? normalizeSchedule(parsed.schedule) : "";
  return schedule ? cronTrigger(schedule) : null;
}

export function serializeConfig(config: AutomationConfig): string {
  const schedule = triggerSchedule(config.trigger);
  return `${JSON.stringify(
    {
      name: config.name,
      prompt: config.prompt,
      ...(schedule != null ? { schedule } : {}),
      ...(config.trigger.type === "cron" ? {} : { trigger: serializeStoredTrigger(config.trigger) }),
      enabled: config.isEnabled,
      createdAt: config.createdAt,
      lastRunAt: config.lastRunAt,
    },
    null,
    2,
  )}\n`;
}

function clampRunDetail(detail: unknown): string | undefined {
  if (typeof detail !== "string") return undefined;
  const value = detail.trim();
  return value ? value.slice(0, AUTOMATION_MAX_RUN_DETAIL_LENGTH) : undefined;
}

export function parseStoredRun(entry: unknown): AutomationRun | null {
  if (!object(entry)) return null;
  const id = typeof entry.id === "string" && entry.id ? entry.id : null;
  const startedAt = typeof entry.startedAt === "number" && Number.isFinite(entry.startedAt) ? entry.startedAt : null;
  if (id == null || startedAt == null) return null;
  const status: AutomationRunStatus = entry.status === "error" || entry.status === "running" ? entry.status : "ok";
  const trigger: AutomationRunTrigger = entry.trigger === "manual" || entry.trigger === "event" ? entry.trigger : "schedule";
  const detail = clampRunDetail(entry.detail);
  const event = clampRunDetail(entry.event);
  return {
    id,
    trigger,
    startedAt,
    finishedAt: typeof entry.finishedAt === "number" && Number.isFinite(entry.finishedAt) ? entry.finishedAt : null,
    status,
    ...(detail ? { detail } : {}),
    ...(event ? { event } : {}),
  };
}

export class FileAutomationStore {
  constructor(
    readonly routinesDir: string,
    readonly resolveUserTimeZone: () => string | undefined = () => undefined,
  ) {}

  configPath(id: string): string {
    return path.join(this.routinesDir, id, CONFIG_FILENAME);
  }

  runsPath(id: string): string {
    return path.join(this.routinesDir, id, RUNS_FILENAME);
  }

  private writeAtomic(filePath: string, content: string): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp-${process.pid}`;
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, filePath);
  }

  toRecord(id: string, config: AutomationConfig, deriveNextRunAt: boolean): AutomationRecord {
    return {
      id,
      ...config,
      schedule: triggerSchedule(config.trigger) ?? "",
      triggerDescription: describeTrigger(config.trigger),
      nextRunAt: deriveNextRunAt && config.isEnabled ? this.earliestNextRunAt(config) : null,
      runs: this.readRuns(id),
      filePath: this.configPath(id),
    };
  }

  earliestNextRunAt(config: AutomationConfig): number | null {
    const anchor = automationAnchor(config);
    const timeZone = this.resolveUserTimeZone();
    let earliest: number | null = null;
    for (const schedule of triggerCronSchedules(config.trigger)) {
      const next = computeNextRunAt(schedule, anchor, timeZone);
      if (next != null && (earliest == null || next < earliest)) earliest = next;
    }
    return earliest;
  }

  readRuns(id: string): AutomationRun[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.runsPath(id), "utf8"));
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed
      .flatMap((entry) => {
        const run = parseStoredRun(entry);
        return run == null ? [] : [run];
      })
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, AUTOMATION_MAX_RUN_HISTORY);
  }

  private writeRuns(id: string, runs: readonly AutomationRun[]): void {
    this.writeAtomic(this.runsPath(id), `${JSON.stringify(runs, null, 2)}\n`);
  }

  readConfig(id: string): AutomationConfig | null {
    const file = this.configPath(id);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    let fallback = Date.now();
    try {
      const stats = statSync(file);
      fallback = Math.floor(stats.birthtimeMs || stats.mtimeMs);
    } catch {
      // keep now
    }
    return parseStoredConfig(raw, fallback);
  }

  writeConfig(id: string, config: AutomationConfig): void {
    this.writeAtomic(this.configPath(id), serializeConfig(config));
  }

  listIds(): string[] {
    let entries: string[];
    try {
      entries = readdirSync(this.routinesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    return entries.filter(isSafeFolderId);
  }

  list(): AutomationRecord[] {
    return this.listDefinitions()
      .map((record) => ({ ...record, nextRunAt: record.isEnabled ? this.earliestNextRunAt(record) : null }))
      .sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.createdAt - b.createdAt);
  }

  listDefinitions(): AutomationRecord[] {
    return this.listIds()
      .flatMap((id) => {
        const config = this.readConfig(id);
        return config == null ? [] : [this.toRecord(id, config, false)];
      })
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): AutomationRecord | null {
    if (!isSafeFolderId(id)) return null;
    const config = this.readConfig(id);
    return config == null ? null : this.toRecord(id, config, true);
  }

  count(): number {
    return this.listIds().filter((id) => this.readConfig(id) != null).length;
  }

  uniqueId(name: string): string {
    const base = slugifyAutomationName(name);
    const existing = new Set(this.listIds());
    if (!existing.has(base)) return base;
    for (let suffix = 2; suffix < 1_000; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!existing.has(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  private normalizeSpecTrigger(trigger: AutomationTrigger): AutomationTrigger | null {
    const members: AutomationTriggerMember[] = [];
    for (const member of triggerList(trigger)) {
      if (member.type !== "cron") members.push(member);
      else {
        const schedule = normalizeSchedule(member.schedule);
        if (!schedule) return null;
        members.push(cronTrigger(schedule));
      }
    }
    const normalized = triggerFromList(members);
    return normalized == null || normalized.type === "cron" ? normalized : parseStoredTrigger(serializeStoredTrigger(normalized));
  }

  upsert(spec: AutomationSpec, createdAt = Date.now()): AutomationRecord | null {
    const name = clampAutomationName(spec.name);
    const prompt = normalizeAutomationPrompt(spec.prompt);
    const trigger = this.normalizeSpecTrigger(spec.trigger);
    if (!name || !prompt || trigger == null || this.count() >= AUTOMATION_MAX_PER_AGENT) return null;
    const id = this.uniqueId(name);
    const config: AutomationConfig = { name, prompt, trigger, isEnabled: spec.isEnabled ?? true, createdAt, lastRunAt: null };
    this.writeConfig(id, config);
    return this.toRecord(id, config, true);
  }

  update(id: string, spec: AutomationSpec): AutomationRecord | null {
    if (!isSafeFolderId(id)) return null;
    const current = this.readConfig(id);
    const name = clampAutomationName(spec.name);
    const prompt = normalizeAutomationPrompt(spec.prompt);
    const trigger = this.normalizeSpecTrigger(spec.trigger);
    if (current == null || !name || !prompt || trigger == null) return null;
    const config: AutomationConfig = { ...current, name, prompt, trigger, isEnabled: spec.isEnabled ?? current.isEnabled };
    this.writeConfig(id, config);
    return this.toRecord(id, config, true);
  }

  setEnabled(id: string, isEnabled: boolean): AutomationRecord | null {
    if (!isSafeFolderId(id)) return null;
    const current = this.readConfig(id);
    if (current == null) return null;
    const config = current.isEnabled === isEnabled ? current : { ...current, isEnabled };
    if (config !== current) this.writeConfig(id, config);
    return this.toRecord(id, config, true);
  }

  recordRun(id: string, at = Date.now()): AutomationRecord | null {
    if (!isSafeFolderId(id)) return null;
    const current = this.readConfig(id);
    if (current == null) return null;
    const config = { ...current, lastRunAt: at };
    this.writeConfig(id, config);
    return this.toRecord(id, config, true);
  }

  beginRun({ id, trigger, at = Date.now(), event, runId = randomUUID() }: { id: string; trigger: AutomationRunTrigger; at?: number; event?: string; runId?: string }): AutomationRun | null {
    if (!isSafeFolderId(id) || this.readConfig(id) == null) return null;
    const runs = this.readRuns(id);
    const existing = runs.find((run) => run.id === runId);
    if (existing != null) return existing;
    const eventSummary = clampRunDetail(event);
    const run: AutomationRun = {
      id: runId,
      trigger,
      startedAt: at,
      finishedAt: null,
      status: "running",
      ...(eventSummary ? { event: eventSummary } : {}),
    };
    this.writeRuns(id, [run, ...runs].slice(0, AUTOMATION_MAX_RUN_HISTORY));
    return run;
  }

  finishRun(id: string, runId: string, status: Exclude<AutomationRunStatus, "running">, at = Date.now(), detail?: string): AutomationRecord | null {
    if (!isSafeFolderId(id)) return null;
    const config = this.readConfig(id);
    if (config == null) return null;
    const runs = this.readRuns(id);
    const index = runs.findIndex((run) => run.id === runId);
    if (index < 0) return this.toRecord(id, config, true);
    const value = runs[index] as AutomationRun;
    const clamped = clampRunDetail(detail);
    runs[index] = { ...value, finishedAt: at, status, ...(clamped ? { detail: clamped } : {}) };
    this.writeRuns(id, runs);
    return this.toRecord(id, config, true);
  }

  remove(id: string): boolean {
    if (!isSafeFolderId(id)) return false;
    const folder = path.join(this.routinesDir, id);
    try {
      if (!statSync(folder).isDirectory()) return false;
    } catch {
      return false;
    }
    rmSync(folder, { recursive: true, force: true });
    return true;
  }
}
