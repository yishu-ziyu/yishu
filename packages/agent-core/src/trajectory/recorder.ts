import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  Trajectory,
  TrajectoryStatus,
  TrajectoryStep,
  TrajectoryStepKind,
} from "../types.js";

export class TrajectoryRecorder {
  readonly trajectory: Trajectory;

  constructor(task: string, id?: string) {
    this.trajectory = {
      id: id ?? randomUUID(),
      task,
      startedAt: new Date().toISOString(),
      steps: [],
      status: "running",
    };
  }

  step(kind: TrajectoryStepKind, data: unknown): TrajectoryStep {
    const s: TrajectoryStep = {
      kind,
      at: new Date().toISOString(),
      data,
    };
    this.trajectory.steps.push(s);
    return s;
  }

  finish(status: TrajectoryStatus, result?: string): Trajectory {
    this.trajectory.status = status;
    this.trajectory.endedAt = new Date().toISOString();
    if (result !== undefined) {
      this.trajectory.result = result;
    }
    return this.trajectory;
  }

  async writeJson(dir: string): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${this.trajectory.id}.json`);
    await fs.writeFile(file, JSON.stringify(this.trajectory, null, 2), "utf8");
    return file;
  }
}
