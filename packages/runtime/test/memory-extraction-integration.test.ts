/**
 * PKR write-side extraction integration (ADR 0016 #3/#5/#7): completed model
 * turns enqueue fire-and-forget; product-action and private turns never do.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createYishuKernel } from "@yishu/kernel";
import { ProductKernelRuntime } from "../src/product-kernel-runtime.js";
import { MockAgentRuntime } from "../src/mock-runtime.js";
import { makeTurnStartCommand } from "./fixtures.js";
import type { TurnStartCommand } from "../src/protocol.js";

function commandWith(pick: {
  utterance?: string;
  conversationId?: string;
  sessionScope?: { kind: "personal" | "private" };
}): TurnStartCommand {
  const command = makeTurnStartCommand();
  if (pick.utterance !== undefined) command.payload.utterance = pick.utterance;
  if (pick.conversationId !== undefined) command.payload.conversationId = pick.conversationId;
  if (pick.sessionScope !== undefined) command.payload.sessionScope = pick.sessionScope;
  command.payload.modelPreference = { provider: "openai-codex", model: "gpt-5.4" };
  return command;
}

async function makeRuntime(t: TestContext, withModel: boolean): Promise<ProductKernelRuntime> {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "yishu-pkr-extraction-"));
  const storeDir = await mkdtemp(path.join(tmpdir(), "yishu-pkr-store-"));
  t.after(async () => {
    await Promise.all([
      rm(memoryDir, { recursive: true, force: true }),
      rm(storeDir, { recursive: true, force: true }),
    ]);
  });
  const kernel = createYishuKernel({ storeBackend: "sqlite", sqlitePath: path.join(storeDir, "s.sqlite"), memoryDir });
  const runtime = new ProductKernelRuntime(new MockAgentRuntime(), kernel, undefined, {
    ...(withModel
      ? {
          memoryExtractionModel: {
            async extract() {
              return { newFacts: [], confirmedFactIds: [] };
            },
          },
        }
      : {}),
  });
  t.after(() => runtime.dispose());
  return runtime;
}

test("completed model turns enqueue extraction and settle without waiting", async (t) => {
  const runtime = await makeRuntime(t, false);
  const kernel = runtime.kernel;
  assert.ok(kernel.memory !== undefined);
  const conversationId = "conv-extract-1";
  await runtime.startTurn(
    commandWith({ utterance: "跟我聊聊天，我今天有点累", conversationId }),
    () => undefined,
  );
  // The turn has settled; the fire-and-forget enqueue lands within a tick.
  await new Promise((resolve) => setImmediate(resolve));
  const rows = await kernel.memory.queue.listReplayable();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "pending");
  assert.equal(rows[0]!.payload.utterance, "跟我聊聊天，我今天有点累");
  assert.equal(rows[0]!.payload.providerId, "openai-codex");
  assert.equal(rows[0]!.payload.modelId, "gpt-5.4");
});

test("private scope turns never enqueue", async (t) => {
  const runtime = await makeRuntime(t, false);
  assert.ok(runtime.kernel.memory !== undefined);
  await runtime.startTurn(
    commandWith({
      utterance: "私密问题",
      conversationId: "conv-private-1",
      sessionScope: { kind: "private" },
    }),
    () => undefined,
  );
  assert.equal((await runtime.kernel.memory.queue.listReplayable()).length, 0);
});

test("product-action turns never enqueue", async (t) => {
  const runtime = await makeRuntime(t, false);
  assert.ok(runtime.kernel.memory !== undefined);
  await runtime.startTurn(
    commandWith({
      utterance: "记住：验收回答先给结论",
      conversationId: "conv-action-1",
    }),
    () => undefined,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await runtime.kernel.memory.queue.listReplayable()).length, 0);
});
