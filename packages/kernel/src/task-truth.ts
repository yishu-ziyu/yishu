import type { TaskTruth } from "./store/types.js"
import type { YishuStorePort } from "./store/yishu-store.js"
import type { SessionScope } from "./session-scope.js"
import { PERSONAL_SESSION_SCOPE, normalizeSessionScope, sessionScopesEqual } from "./session-scope.js"

export type TaskProgressKind =
  | "start"
  | "progress"
  | "verified"
  | "unverified"
  | "failed"
  | "cancelled"

export interface TaskProgressSignal {
  taskId: string
  title: string
  kind: TaskProgressKind
  observedAt: string
  /** Bounded, non-sensitive provenance such as an event id or safe tool name. */
  evidence: string
  parentId?: string
  sessionScope?: SessionScope
}

export interface TaskTruthProjectorOptions {
  maxEvidenceEntries?: number
  maxEvidenceLength?: number
  maxTitleLength?: number
}

const TERMINAL_TASK_STATUSES = new Set<TaskTruth["status"]>([
  "done",
  "failed",
  "cancelled",
])

const REDACTED_TASK_TITLE = "敏感任务（标题已隐藏）"
const REDACTED_EVIDENCE = "runtime:evidence:redacted"

const SENSITIVE_MATERIAL_PATTERNS = [
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/iu,
  /\b(?:bearer|basic)[\s._:=~-]+[a-z0-9+/_.~-]{8,}/iu,
  /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}(?:\.[a-z0-9_-]{8,})?\b/iu,
  /\b(?:sk|xai|gh[pousr]|glpat|pat|ya29|AIza)[-_][a-z0-9._-]{8,}\b/iu,
  /(?:api[\s._-]*key|access[\s._-]*token|refresh[\s._-]*token|auth(?:orization)?|token|password|passwd|pwd|secret|credential|private[\s._-]*key|密码|密钥|令牌|凭据)[\s._-]*(?:[:=：]|is\b|是|为)?[\s._:=~-]+\S{4,}/iu,
]

function normalizeSingleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim()
}

function compactSingleLine(value: string, maxLength: number): string {
  return normalizeSingleLine(value).slice(0, maxLength)
}

function containsSensitiveMaterial(value: string): boolean {
  return SENSITIVE_MATERIAL_PATTERNS.some((pattern) => pattern.test(value))
}

function safeTaskTitle(value: string, maxLength: number): string {
  const normalized = normalizeSingleLine(value)
  return containsSensitiveMaterial(normalized)
    ? REDACTED_TASK_TITLE
    : normalized.slice(0, maxLength)
}

function safeEvidence(value: string, maxLength: number): string {
  const normalized = normalizeSingleLine(value)
  return containsSensitiveMaterial(normalized)
    ? REDACTED_EVIDENCE
    : normalized.slice(0, maxLength)
}

function statusFor(kind: TaskProgressKind): TaskTruth["status"] {
  switch (kind) {
    case "start":
    case "progress":
      return "running"
    case "verified":
      return "done"
    case "unverified":
      return "blocked"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
  }
}

/**
 * Product-owned projection of execution observations into durable TaskTruth.
 *
 * Runtime/Pi may report observations, but only this kernel policy decides the
 * persisted status. Per-task queues make concurrent cancel/failure events
 * deterministic, and terminal truth cannot be overwritten by a late event.
 */
export class TaskTruthProjector {
  private readonly maxEvidenceEntries: number
  private readonly maxEvidenceLength: number
  private readonly maxTitleLength: number
  private readonly queues = new Map<string, Promise<void>>()

  constructor(
    private readonly store: YishuStorePort,
    options: TaskTruthProjectorOptions = {},
  ) {
    this.maxEvidenceEntries = options.maxEvidenceEntries ?? 64
    this.maxEvidenceLength = options.maxEvidenceLength ?? 240
    this.maxTitleLength = options.maxTitleLength ?? 160
  }

  record(signal: TaskProgressSignal): Promise<TaskTruth | null> {
    const taskId = compactSingleLine(signal.taskId, 160)
    const title = safeTaskTitle(signal.title, this.maxTitleLength)
    const evidence = safeEvidence(signal.evidence, this.maxEvidenceLength)
    const observedAt = signal.observedAt.trim()

    if (taskId.length === 0) throw new Error("Task progress requires a task id")
    if (title.length === 0) throw new Error("Task progress requires a title")
    if (evidence.length === 0) throw new Error("Task progress requires evidence")
    if (!Number.isFinite(Date.parse(observedAt))) {
      throw new Error("Task progress requires a valid observedAt timestamp")
    }

    const normalized: TaskProgressSignal = {
      ...signal,
      taskId,
      title,
      observedAt,
      evidence,
      sessionScope: normalizeSessionScope(signal.sessionScope ?? PERSONAL_SESSION_SCOPE),
    }
    if (signal.parentId !== undefined) {
      normalized.parentId = compactSingleLine(signal.parentId, 160)
    }

    const previous = this.queues.get(taskId) ?? Promise.resolve()
    const result = previous.then(() => this.apply(normalized))
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.queues.set(taskId, tail)
    void tail.then(() => {
      if (this.queues.get(taskId) === tail) this.queues.delete(taskId)
    })
    return result
  }

  async flush(taskId?: string): Promise<void> {
    if (taskId !== undefined) {
      await this.queues.get(compactSingleLine(taskId, 160))
      return
    }
    await Promise.all(this.queues.values())
  }

  private async apply(signal: TaskProgressSignal): Promise<TaskTruth | null> {
    const existing = (await this.store.listTasks()).find(
      (task) => task.id === signal.taskId,
    )

    const sessionScope = normalizeSessionScope(signal.sessionScope ?? PERSONAL_SESSION_SCOPE)
    if (existing && !sessionScopesEqual(existing.sessionScope, sessionScope)) {
      throw new Error(`task_scope_conflict:${signal.taskId}`)
    }

    // Pure conversation completions must never manufacture a task. The first
    // persisted observation must explicitly establish that execution started.
    if (!existing && signal.kind !== "start") return null

    if (existing && TERMINAL_TASK_STATUSES.has(existing.status)) {
      return existing
    }

    const allEvidence = [
      ...(existing?.evidence ?? []),
      signal.evidence,
    ]
      .filter((item, index, all) => all.indexOf(item) === index)
    const evidence = allEvidence.length <= this.maxEvidenceEntries
      ? allEvidence
      : this.maxEvidenceEntries === 1
        ? allEvidence.slice(-1)
        : [
            allEvidence[0]!,
            ...allEvidence.slice(-(this.maxEvidenceEntries - 1)),
          ]

    return this.store.upsertTask({
      id: signal.taskId,
      title: existing?.title ?? signal.title,
      status: statusFor(signal.kind),
      createdAt: existing?.createdAt ?? signal.observedAt,
      updatedAt: signal.observedAt,
      evidence,
      sessionScope,
      ...(signal.parentId !== undefined
        ? { parentId: signal.parentId }
        : existing?.parentId !== undefined
          ? { parentId: existing.parentId }
          : {}),
    })
  }
}
