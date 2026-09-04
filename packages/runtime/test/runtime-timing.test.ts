import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createYishuKernel, type EverOSMemoryPort, type RecalledMemory } from "@yishu/kernel";
import { MockAgentRuntime } from "../src/mock-runtime.js";
import {
  beginRuntimeTiming,
  endRuntimeTiming,
  runtimeTimingEnabled,
  runtimeTimingErrorPath,
  runtimeTimingPath,
  yishuDiagnosticsDir,
} from "../src/observability/runtime-timing.js";
import { ProductKernelRuntime } from "../src/product-kernel-runtime.js";
import { DEFAULT_RECALL_BUDGET_MS } from "../src/everos-sidecar.js";
import { makeTurnStartCommand } from "./fixtures.js";

test("runtime timing defaults on and writes the product diagnostics path", () => {
  assert.equal(runtimeTimingEnabled({}), true);
  assert.equal(runtimeTimingEnabled({ YISHU_RUNTIME_TIMING: "1" }), true);
  assert.equal(runtimeTimingEnabled({ YISHU_RUNTIME_TIMING: "0" }), false);
  assert.equal(
    runtimeTimingPath({}),
    path.join(os.homedir(), "Library", "Application Support", "Yishu", "Diagnostics", "runtime-timing.jsonl"),
  );
  assert.equal(
    yishuDiagnosticsDir({ cwd: "/tmp/Yishu/RuntimeWorkspace" }),
    path.join("/tmp/Yishu", "Diagnostics"),
  );
});

test("timing path resolves with an empty env", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal(env.HOME, undefined);
  assert.equal(env.YISHU_HOME, undefined);
  assert.equal(
    runtimeTimingPath(env),
    path.join(os.homedir(), "Library", "Application Support", "Yishu", "Diagnostics", "runtime-timing.jsonl"),
  );
});

test("runtime timing writes stage lines without prompt text", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "yishu-timing-"));
  const filePath = path.join(dir, "runtime-timing.jsonl");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {
    YISHU_RUNTIME_TIMING: "1",
    YISHU_RUNTIME_TIMING_PATH: filePath,
  };
  const timing = beginRuntimeTiming("turn-1", env);
  timing.mark("recall.done", { source: "visible_only", durationMs: 12 });
  timing.mark("history.done");
  timing.mark("prompt.built", { imageCount: 0, imageBytes: 0, promptChars: 42 });
  timing.mark("model.request_sent");
  await timing.track(
    "slow-prep",
    new Promise((resolve) => setTimeout(resolve, 220)),
  );
  timing.mark("model.sse_first_byte");
  timing.mark("model.first_reasoning");
  timing.mark("model.first_byte", { reasoningChars: 12 });
  timing.mark("model.done");
  endRuntimeTiming("turn-1");
  const lines = (await readFile(filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0]?.name, "turn_received");
  assert.ok(lines.some((row) =>
    row.name === "recall.done" && row.source === "visible_only" && row.durationMs === 12
  ));
  assert.ok(lines.some((row) => row.name === "history.done"));
  assert.ok(lines.some((row) =>
    row.name === "prompt.built"
    && row.imageCount === 0
    && row.imageBytes === 0
    && row.promptChars === 42
  ));
  assert.ok(lines.some((row) => row.name === "model.request_sent"));
  assert.ok(lines.some((row) => row.name === "model.sse_first_byte"));
  assert.ok(lines.some((row) => row.name === "model.first_reasoning"));
  assert.ok(lines.some((row) => row.name === "model.first_byte" && row.reasoningChars === 12));
  assert.ok(lines.some((row) => row.name === "model.done"));
  assert.ok(lines.some((row) => row.name === "slow_await" && row.label === "slow-prep" && row.durationMs >= 200));
  for (const row of lines) {
    assert.equal(row.turnId, "turn-1");
    assert.equal(typeof row.ms, "number");
    assert.equal(JSON.stringify(row).includes("在吗"), false);
  }
});

test("first product turn creates the timing file", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "yishu-timing-turn-"));
  const filePath = path.join(dir, "runtime-timing.jsonl");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previousPath = process.env.YISHU_RUNTIME_TIMING_PATH;
  process.env.YISHU_RUNTIME_TIMING = "1";
  process.env.YISHU_RUNTIME_TIMING_PATH = filePath;
  t.after(() => {
    if (previousPath === undefined) delete process.env.YISHU_RUNTIME_TIMING_PATH;
    else process.env.YISHU_RUNTIME_TIMING_PATH = previousPath;
  });
  class HangingEverOS implements EverOSMemoryPort {
    async add(): Promise<void> {}
    async flush(): Promise<void> {}
    search(): Promise<RecalledMemory[]> {
      return new Promise(() => undefined);
    }
    profile(): Promise<RecalledMemory[]> {
      return new Promise(() => undefined);
    }
  }
  const storeDir = await mkdtemp(path.join(tmpdir(), "yishu-timing-store-"));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  const runtime = new ProductKernelRuntime(
    new MockAgentRuntime(),
    createYishuKernel({ storeBackend: "sqlite", sqlitePath: path.join(storeDir, "s.sqlite") }),
    undefined,
    { everos: new HangingEverOS() },
  );
  t.after(() => runtime.dispose());
  const command = makeTurnStartCommand();
  command.payload.utterance = "在吗";
  command.payload.conversationId = command.requestId;
  await runtime.startTurn(command, () => undefined);
  const lines = (await readFile(filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
    name?: string;
    source?: string;
    durationMs?: number;
  });
  assert.ok(lines.some((row) => row.name === "turn_received"));
  const recall = lines.find((row) => row.name === "recall.done");
  assert.equal(recall?.source, "visible_only");
  assert.ok(typeof recall?.durationMs === "number");
  // setTimeout(budget) routinely fires 1–50 ms late; the hang must still be budget-capped.
  assert.ok(recall.durationMs <= DEFAULT_RECALL_BUDGET_MS + 50);
});

test("write failure logs once to stderr", (t: TestContext) => {
  const blocked = path.join(tmpdir(), `yishu-timing-blocked-${Date.now()}`);
  writeFileSync(blocked, "not-a-directory");
  t.after(() => rm(blocked, { force: true }));
  const writes: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = original;
  });
  const timing = beginRuntimeTiming(`turn-fail-${Date.now()}`, {
    YISHU_RUNTIME_TIMING: "1",
    YISHU_RUNTIME_TIMING_PATH: path.join(blocked, "runtime-timing.jsonl"),
  });
  timing.mark("recall.done");
  timing.mark("history.done");
  endRuntimeTiming(timing.turnId);
  assert.equal(writes.filter((line) => line.includes("yishu runtime-timing:")).length, 1);
  const errorPath = runtimeTimingErrorPath();
  t.after(() => {
    try { unlinkSync(errorPath); } catch { /* ignore */ }
  });
  assert.match(readFileSync(errorPath, "utf8"), /failed to write|ENOTDIR|EEXIST|ENOENT/);
});

