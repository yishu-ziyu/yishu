/**
 * Routine trigger model, ported from grok-bot 0.18 (source/shared/automations.ts).
 * Cloud-backed listeners (Slack/GitHub/Teams/Linear/Sentry/PagerDuty) are not
 * ported; local event triggers replace them.
 */

export const AUTOMATION_WAKE_CUE = "[routine]";

export type CronTrigger = { type: "cron"; schedule: string };

export type LocalEventTrigger =
  | { type: "app_transition"; app: string; transition: "foreground" | "background" }
  | { type: "file_change"; path: string }
  | { type: "system_resume" };

export type AutomationTriggerMember = CronTrigger | LocalEventTrigger;

export type AutomationTrigger =
  | AutomationTriggerMember
  | { type: "group"; listeners: [AutomationTriggerMember, AutomationTriggerMember, ...AutomationTriggerMember[]] };

export function cronTrigger(schedule: string): CronTrigger {
  return { type: "cron", schedule };
}

export function triggerList(trigger: AutomationTrigger): AutomationTriggerMember[] {
  return trigger.type === "group" ? trigger.listeners : [trigger];
}

export function triggerFromList(members: readonly AutomationTriggerMember[]): AutomationTrigger | null {
  const first = members[0];
  const second = members[1];
  return first == null ? null : second == null ? first : { type: "group", listeners: [first, second, ...members.slice(2)] };
}

export function triggerCronSchedules(trigger: AutomationTrigger): string[] {
  return triggerList(trigger).flatMap((member) => (member.type === "cron" ? [member.schedule] : []));
}

export function triggerSchedule(trigger: AutomationTrigger): string | null {
  return triggerCronSchedules(trigger)[0] ?? null;
}

export function triggerEventTriggers(trigger: AutomationTrigger): LocalEventTrigger[] {
  return triggerList(trigger).filter((member): member is LocalEventTrigger => member.type !== "cron");
}

function joinWithOr(parts: readonly string[]): string {
  return parts.length <= 1
    ? parts[0] ?? ""
    : parts.length === 2
      ? `${parts[0]} or ${parts[1]}`
      : `${parts.slice(0, -1).join(", ")}, or ${parts.at(-1)}`;
}

export function describeLocalListener(listener: LocalEventTrigger): string {
  if (listener.type === "app_transition") {
    return listener.transition === "foreground"
      ? `When ${listener.app} comes to the front`
      : `When ${listener.app} goes to the background`;
  }
  if (listener.type === "file_change") return `When ${listener.path} changes`;
  return "When the Mac wakes or unlocks";
}

export function describeListener(listener: AutomationTriggerMember): string {
  return listener.type === "cron" ? listener.schedule : describeLocalListener(listener);
}

export type AutomationRunTrigger = "schedule" | "manual" | "event";
export type AutomationRunStatus = "running" | "ok" | "error";

export interface AutomationRun {
  id: string;
  trigger: AutomationRunTrigger;
  startedAt: number;
  finishedAt: number | null;
  status: AutomationRunStatus;
  detail?: string;
  event?: string;
}

export interface AutomationConfig {
  name: string;
  prompt: string;
  trigger: AutomationTrigger;
  isEnabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
}

export interface AutomationRecord extends AutomationConfig {
  id: string;
  schedule: string;
  triggerDescription: string;
  nextRunAt: number | null;
  runs: AutomationRun[];
  filePath: string;
}

export interface AutomationSpec {
  name: string;
  prompt: string;
  trigger: AutomationTrigger;
  isEnabled?: boolean;
}

export const AUTOMATION_MAX_NAME_LENGTH = 80;
export const AUTOMATION_MAX_PER_AGENT = 50;
export const AUTOMATION_MAX_RUN_HISTORY = 20;
export const AUTOMATION_MAX_RUN_DETAIL_LENGTH = 300;

export function clampAutomationName(name: string): string {
  return name.replace(/\s+/gu, " ").trim().slice(0, AUTOMATION_MAX_NAME_LENGTH);
}

export function normalizeAutomationPrompt(prompt: string): string {
  return prompt.trim();
}

export function slugifyAutomationName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "automation";
}
