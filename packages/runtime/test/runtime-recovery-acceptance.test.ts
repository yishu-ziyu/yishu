import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "../src/protocol.js";
import { selectedRuntimeMode } from "../src/runtime-factory.js";
import { makeTurnStartCommand } from "./fixtures.js";

const runtimeDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type RuntimeEvent = {
  type?: string;
  requestId?: string;
  traceId?: string;
  payload?: Record<string, unknown>;
};

function startRuntime(): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--import", "tsx", "src/stdio-server.ts"], {
    cwd: runtimeDirectory,
    env: {
      ...process.env,
      YISHU_RUNTIME_MODE: "mock",
      YISHU_PRODUCT_KERNEL: "0",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
}

function observeRuntime(child: ChildProcessWithoutNullStreams): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line) as RuntimeEvent);
    }
  });
  return events;
}

async function waitFor(
  events: RuntimeEvent[],
  predicate: (event: RuntimeEvent) => boolean,
  message: string,
): Promise<RuntimeEvent> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = events.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function stopRuntime(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

test("acceptance: runtime can be terminated mid-turn and recovered without receipt replay", async () => {
  const utterance = "验收：Runtime 中途退出后要重试这句话";
  const first = startRuntime();
  const firstEvents = observeRuntime(first);

  await waitFor(firstEvents, (event) => event.type === "runtime.ready", "first runtime did not become ready");
  const firstTurn = makeTurnStartCommand();
  firstTurn.payload.utterance = utterance;
  first.stdin.write(`${JSON.stringify(firstTurn)}\n`);

  await waitFor(
    firstEvents,
    (event) => event.type === "response.delta" && event.requestId === firstTurn.requestId,
    "first runtime did not enter the turn before termination",
  );
  await stopRuntime(first);

  assert.ok(
    firstEvents.some((event) => event.type === "turn.started" && event.requestId === firstTurn.requestId),
    "the first utterance reached the runtime before termination",
  );
  assert.ok(
    !firstEvents.some((event) => event.type === "response.completed" && event.requestId === firstTurn.requestId),
    "the first turn must not complete after the controlled mid-turn termination",
  );

  const second = startRuntime();
  const secondEvents = observeRuntime(second);
  try {
    await waitFor(secondEvents, (event) => event.type === "runtime.ready", "second runtime did not become ready");
    const retry = makeTurnStartCommand();
    retry.payload.utterance = utterance;
    second.stdin.write(`${JSON.stringify(retry)}\n`);

    const completed = await waitFor(
      secondEvents,
      (event) => event.type === "response.completed" && event.requestId === retry.requestId,
      "retried utterance did not complete on restarted runtime",
    );
    assert.match(String(completed.payload?.text), new RegExp(utterance));
    assert.ok(
      !secondEvents.some((event) => event.type === "computer.action.requested"),
      "conversation retry must not replay a computer action request",
    );

    const staleReceiptRequestId = randomUUID();
    second.stdin.write(`${JSON.stringify({
      schemaVersion: PROTOCOL_VERSION,
      type: "computer.action.result",
      requestId: staleReceiptRequestId,
      traceId: randomUUID(),
      sentAt: new Date().toISOString(),
      payload: {
        actionId: randomUUID(),
        succeeded: true,
        verified: true,
        message: "synthetic stale receipt",
        evidence: "synthetic stale receipt rejected after restart",
        status: "verified",
        code: "verified_accessibility",
        method: "ax_press",
        receiptId: "synthetic-stale-receipt",
      },
    })}\n`);

    const staleReceiptResponse = await waitFor(
      secondEvents,
      (event) => event.type === "runtime.error" && event.requestId === staleReceiptRequestId,
      "stale action receipt was not rejected by the restarted runtime",
    );
    assert.equal(staleReceiptResponse.payload?.code, "computer_action_not_pending");
    assert.equal(selectedRuntimeMode({ YISHU_RUNTIME_MODE: "mock", HANAKO_RUNTIME_MODE: "agent-core" }), "mock");
    assert.equal(selectedRuntimeMode({ YISHU_RUNTIME_MODE: "agent-core" }), "pi");
    assert.equal(selectedRuntimeMode({ HANAKO_RUNTIME_MODE: "agent-core" }), "pi");
    assert.equal(selectedRuntimeMode({}), "pi");
  } finally {
    await stopRuntime(second);
  }
});
