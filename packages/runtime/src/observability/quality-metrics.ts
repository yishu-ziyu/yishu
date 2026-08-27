import { percentile } from "./quality-span.js";
import type { QualityEvent } from "./quality-event.js";

export interface QualityMetrics {
  eventCount: number;
  verifiedRate: number;
  unknownRate: number;
  falseCompletionCount: number;
  p50DurationMs?: number;
  p95DurationMs?: number;
}

export function computeQualityMetrics(events: readonly QualityEvent[]): QualityMetrics {
  const terminals = events.filter((event) => event.name === "task.terminal");
  const verified = terminals.filter((event) => (
    event.attributes.verified === true || event.attributes.taskTerminal === "verified"
  ));
  const unknown = events.filter((event) => event.status === "unknown");
  const falseCompletionCount = events.filter((event) => event.name === "false_completion_detected").length;
  const durations = events
    .map((event) => event.durationMs)
    .filter((value): value is number => typeof value === "number");
  const metrics: QualityMetrics = {
    eventCount: events.length,
    verifiedRate: terminals.length === 0 ? 0 : verified.length / terminals.length,
    unknownRate: events.length === 0 ? 0 : unknown.length / events.length,
    falseCompletionCount,
  };
  const p50 = percentile(durations, 50);
  const p95 = percentile(durations, 95);
  if (p50 !== undefined) metrics.p50DurationMs = p50;
  if (p95 !== undefined) metrics.p95DurationMs = p95;
  return metrics;
}
