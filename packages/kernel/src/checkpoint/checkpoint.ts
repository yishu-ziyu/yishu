export type CheckpointStatus = "open" | "resumed" | "consumed" | "abandoned";

export interface CheckpointStep {
  stepId: string;
  idempotencyKey: string;
  committed: boolean;
  receiptId?: string;
  recordedAt: string;
}

export interface TaskCheckpoint {
  checkpointId: string;
  taskId: string;
  requestId: string;
  status: CheckpointStatus;
  steps: CheckpointStep[];
  createdAt: string;
  updatedAt: string;
}

export interface CheckpointLedger {
  create(input: { taskId: string; requestId: string }, now?: Date): TaskCheckpoint;
  get(checkpointId: string): TaskCheckpoint | undefined;
  recordStep(input: {
    checkpointId: string;
    stepId: string;
    idempotencyKey: string;
    committed: boolean;
    receiptId?: string;
  }, now?: Date): TaskCheckpoint;
  resume(checkpointId: string, now?: Date): TaskCheckpoint;
  consume(checkpointId: string, now?: Date): TaskCheckpoint;
  snapshot(): TaskCheckpoint[];
}

export function createCheckpointLedger(seed: readonly TaskCheckpoint[] = []): CheckpointLedger {
  const rows = new Map<string, TaskCheckpoint>(
    seed.map((checkpoint) => [checkpoint.checkpointId, {
      ...checkpoint,
      steps: checkpoint.steps.map((step) => ({ ...step })),
    }]),
  );
  return {
    create(input, now = new Date()) {
      const checkpoint: TaskCheckpoint = {
        checkpointId: crypto.randomUUID(),
        taskId: input.taskId,
        requestId: input.requestId,
        status: "open",
        steps: [],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      rows.set(checkpoint.checkpointId, checkpoint);
      return checkpoint;
    },
    get(checkpointId) {
      return rows.get(checkpointId);
    },
    recordStep(input, now = new Date()) {
      const current = requireCheckpoint(rows, input.checkpointId);
      const existing = current.steps.find((step) => step.idempotencyKey === input.idempotencyKey);
      if (existing !== undefined) return current;
      const step: CheckpointStep = {
        stepId: input.stepId,
        idempotencyKey: input.idempotencyKey,
        committed: input.committed,
        recordedAt: now.toISOString(),
      };
      if (input.receiptId !== undefined) step.receiptId = input.receiptId;
      const next: TaskCheckpoint = {
        ...current,
        steps: [...current.steps, step],
        updatedAt: now.toISOString(),
      };
      rows.set(current.checkpointId, next);
      return next;
    },
    resume(checkpointId, now = new Date()) {
      const current = requireCheckpoint(rows, checkpointId);
      if (current.status === "consumed") {
        throw new Error("Consumed checkpoints cannot be resumed.");
      }
      const next: TaskCheckpoint = { ...current, status: "resumed", updatedAt: now.toISOString() };
      rows.set(checkpointId, next);
      return next;
    },
    consume(checkpointId, now = new Date()) {
      const current = requireCheckpoint(rows, checkpointId);
      const next: TaskCheckpoint = { ...current, status: "consumed", updatedAt: now.toISOString() };
      rows.set(checkpointId, next);
      return next;
    },
    snapshot() {
      return [...rows.values()].map((checkpoint) => ({
        ...checkpoint,
        steps: checkpoint.steps.map((step) => ({ ...step })),
      }));
    },
  };
}

function requireCheckpoint(rows: Map<string, TaskCheckpoint>, id: string): TaskCheckpoint {
  const current = rows.get(id);
  if (current === undefined) throw new Error("Unknown checkpoint.");
  return current;
}
