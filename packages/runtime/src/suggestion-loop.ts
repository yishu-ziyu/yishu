import {
  normalizeSessionScope,
  type SuggestionRecord,
  type YishuKernel,
} from "@yishu/kernel";
import type { RuntimeEvent, TurnStartCommand } from "./protocol.js";

function safeMetadata(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value
    .replace(/[^a-zA-Z0-9._-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 80);
  return compact.length > 0 ? compact : undefined;
}

function clipSummary(text: string, max = 160): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

/**
 * Runtime bridge for the product mind loop:
 * first executable act → record_suggestion
 * terminal event → settle_suggestion
 * then best-effort learn_mind_from_pattern (writes only when bar is met)
 *
 * Terminal outcome boundary:
 * - "succeeded": response.completed AND payload.verified === true
 *   (explicit positive verification)
 * - "failed": response.completed AND payload.verified === false
 *   (explicit negative verification), turn.failed, or runtime.error
 * - "unknown": response.completed with verified === undefined
 *   (no verification ran — recorded as a terminal outcome, but never
 *   counted as learning evidence)
 * - "ignored": turn.cancelled (neutral)
 *
 * Private sessions never touch durable suggestion history.
 */
export class RuntimeSuggestionTracker {
  private executionStarted = false;
  private turnEnded = false;
  private suggestion: SuggestionRecord | undefined;
  private tail: Promise<void> = Promise.resolve();
  private persistenceError: unknown;

  constructor(
    private readonly kernel: YishuKernel,
    private readonly command: TurnStartCommand,
  ) {}

  observe(event: RuntimeEvent): void {
    if (this.turnEnded) return;
    const scope = normalizeSessionScope(this.command.payload.sessionScope);
    if (scope.kind === "private") return;

    if (event.type === "tool.started" || event.type === "computer.action.requested") {
      if (this.executionStarted) return;
      this.executionStarted = true;
      const toolName = safeMetadata(event.payload.toolName);
      const action = safeMetadata(event.payload.action);
      const patternKey = toolName
        ? `tool:${toolName}`
        : action
          ? `action:${action}`
          : "tool:unknown";
      const summary = clipSummary(this.command.payload.utterance);
      this.tail = this.tail.then(async () => {
        try {
          const receipt = await this.kernel.registry.invoke("record_suggestion", {
            caller: "system",
            input: {
              patternKey,
              summary,
              conversationId: this.command.payload.conversationId,
              turnId: this.command.requestId,
              taskId: this.command.requestId,
            },
          });
          if (
            (receipt.status === "ok" || receipt.status === "verified")
            && receipt.output
            && typeof receipt.output === "object"
          ) {
            this.suggestion = receipt.output as SuggestionRecord;
          }
        } catch (error) {
          this.persistenceError ??= error;
        }
      });
      return;
    }

    if (event.type === "response.completed") {
      this.turnEnded = true;
      if (!this.executionStarted) return;
      const status =
        event.payload.verified === true
          ? "succeeded"
          : event.payload.verified === false
            ? "failed"
            : "unknown";
      this.queueSettle(status);
      return;
    }

    if (event.type === "turn.cancelled") {
      this.turnEnded = true;
      if (!this.executionStarted) return;
      this.queueSettle("ignored");
      return;
    }

    if (event.type === "turn.failed" || event.type === "runtime.error") {
      this.turnEnded = true;
      if (!this.executionStarted) return;
      this.queueSettle("failed");
    }
  }

  async flush(): Promise<void> {
    // Best-effort: mind-loop failures must not fail an otherwise healthy turn.
    try {
      await this.tail;
    } catch {
      // swallowed
    }
  }

  private queueSettle(status: "succeeded" | "failed" | "ignored" | "unknown"): void {
    this.tail = this.tail.then(async () => {
      try {
        // Wait for the create path if the terminal event races the first tool event.
        if (!this.suggestion) {
          await Promise.resolve();
        }
        if (!this.suggestion) return;
        const settle = await this.kernel.registry.invoke("settle_suggestion", {
          caller: "system",
          input: {
            suggestionId: this.suggestion.id,
            status,
            taskId: this.command.requestId,
          },
        });
        if (settle.status !== "ok" && settle.status !== "verified") return;

        const patternKey = this.suggestion.patternKey;
        await this.kernel.registry.invoke("learn_mind_from_pattern", {
          caller: "system",
          input: { patternKey },
        });
      } catch (error) {
        this.persistenceError ??= error;
      }
    });
  }
}
