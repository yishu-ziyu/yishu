import { randomUUID } from "node:crypto";
import type { QualityEventName, QualityEventStatus, QualityAttributes } from "./quality-event.js";
import type { QualityRecorder } from "./quality-recorder.js";

export interface QualitySpan {
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: QualityEventName;
  end(status?: QualityEventStatus, attributes?: QualityAttributes): Promise<void>;
}

export interface StartQualitySpanInput {
  recorder: QualityRecorder;
  name: QualityEventName;
  sessionId: string;
  requestId?: string;
  traceId?: string;
  parentSpanId?: string;
  attributes?: QualityAttributes;
  now?: () => Date;
}

export function startQualitySpan(input: StartQualitySpanInput): QualitySpan {
  const spanId = randomUUID();
  const startedAt = (input.now ?? (() => new Date()))().getTime();
  let ended = false;
  void input.recorder.record({
    name: input.name,
    sessionId: input.sessionId,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    spanId,
    ...(input.parentSpanId === undefined ? {} : { parentSpanId: input.parentSpanId }),
    attributes: { spanKind: "start", ...input.attributes },
  });
  return {
    spanId,
    ...(input.parentSpanId === undefined ? {} : { parentSpanId: input.parentSpanId }),
    name: input.name,
    async end(status?: QualityEventStatus, attributes?: QualityAttributes) {
      if (ended) return;
      ended = true;
      const durationMs = Math.max(0, (input.now ?? (() => new Date()))().getTime() - startedAt);
      await input.recorder.record({
        name: input.name,
        sessionId: input.sessionId,
        durationMs,
        ...(status === undefined ? {} : { status }),
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
        spanId,
        ...(input.parentSpanId === undefined ? {} : { parentSpanId: input.parentSpanId }),
        attributes: { spanKind: "end", ...input.attributes, ...attributes },
      });
    },
  };
}

export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const ranked = [...values].sort((a, b) => a - b);
  const index = Math.min(ranked.length - 1, Math.max(0, Math.ceil((p / 100) * ranked.length) - 1));
  return ranked[index];
}
