import { z } from "zod";
import { defineYishuAction } from "../action/define.js";
import { ActionCancelledError } from "../action/types.js";
import type { YishuStorePort } from "../store/yishu-store.js";
import type { MemoryTruthLayer } from "../memory/truth-layer.js";
import type { VisibleMemoryFile } from "../memory/visible-file.js";
import {
  forgetMemoryClaim,
  inspectMemoryForget,
  type MemoryForgetOutcome,
} from "../memory/forget.js";

const forgetInputSchema = z.object({
  memoryId: z.string().uuid(),
});

export type ForgetInput = z.infer<typeof forgetInputSchema>;

/**
 * User-confirmed forget. Target resolution, missing-id / alreadyGone
 * semantics, retries, and verification live in forgetMemoryClaim — the
 * same boundary MemoryLedger uses. This action never treats a missing
 * store row as success on its own.
 */
export function createForgetAction(
  store: YishuStorePort,
  truth?: MemoryTruthLayer,
  visible?: VisibleMemoryFile,
) {
  const ports = {
    store,
    ...(truth !== undefined ? { truth } : {}),
    ...(visible !== undefined ? { visible } : {}),
  };
  return defineYishuAction({
    name: "forget",
    description:
      "Forget a memory claim across applicable authority layers. Reversible only by remembering again.",
    inputSchema: forgetInputSchema,
    authority: "reversible",
    risk: "medium",
    context: "none",
    run: async (ctx) => {
      throwIfAborted(ctx.signal);
      const outcome = await forgetMemoryClaim(ports, {
        id: ctx.input.memoryId,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      if (outcome === null) {
        throw new Error(`Memory not found: ${ctx.input.memoryId}`);
      }
      ctx.markCommitted();
      return outcome;
    },
    verify: async (ctx) => {
      throwIfAborted(ctx.signal);
      const output = ctx.output as MemoryForgetOutcome;
      const inspection = await inspectMemoryForget(ports, {
        id: ctx.input.memoryId,
        scope: output.scope,
        requireVisibleSuppression: output.visibleFingerprint !== undefined,
        ...(output.visibleFingerprint !== undefined
          ? { visibleFingerprint: output.visibleFingerprint }
          : {}),
        ...(output.truthFactId !== undefined ? { truthFactId: output.truthFactId } : {}),
      });
      throwIfAborted(ctx.signal);
      return {
        verified: inspection.complete,
        message: inspection.complete
          ? "Memory is forgotten across applicable authority layers"
          : `Memory forget incomplete: ${inspection.residue.join(",")}`,
        evidence: { id: ctx.input.memoryId, residue: inspection.residue },
      };
    },
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ActionCancelledError();
}
