/**
 * Turn-terminal memory extraction snapshot shape.
 *
 * Extracted from extraction.ts to break the extraction <-> extraction-queue
 * dependency cycle (dependency-cruiser no-circular). Pure type, no runtime
 * value.
 */

export interface ExtractionSnapshot {
  readonly turnId: string;
  readonly conversationId: string;
  /** Durable memory namespace (never private). */
  readonly scopeKey: string;
  readonly utterance: string;
  readonly replyText: string;
  /** Provider/model of the completed turn; extraction follows it (ADR 0016 #4). */
  readonly providerId: string;
  readonly modelId: string;
  readonly capturedAt: string;
}
