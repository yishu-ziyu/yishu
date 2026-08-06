import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AsyncAgent } from "../src/events/async-agent.js";
import { EventBus } from "../src/events/bus.js";
import { YishuAgent } from "../src/harness.js";
import { DeterministicLlm } from "../src/llm.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function withTempLoop(
  fn: (loop: AsyncAgent, bus: EventBus, agent: YishuAgent) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "yishu-async-"));
  const agent = new YishuAgent({
    workspaceDir: join(root, "workspace"),
    skillsDir: join(packageRoot, "skills"),
    memoryPath: join(root, "memory.json"),
    trajectoriesDir: join(root, "trajectories"),
    enableReview: true,
    llm: new DeterministicLlm(),
  });
  const bus = new EventBus();
  const loop = new AsyncAgent({ agent, bus });
  try {
    await agent.init();
    loop.start();
    await fn(loop, bus, agent);
  } finally {
    loop.stop();
    await rm(root, { recursive: true, force: true });
  }
}

test("user.message drains into agent.run and collects summary", async () => {
  await withTempLoop(async (loop, bus) => {
    bus.emit("user.message", { text: "计算 2+3" }, "normal");
    const n = await bus.drain();
    assert.equal(n, 1);
    assert.equal(loop.results.length, 1);
    const r = loop.lastResult!;
    assert.equal(r.eventType, "user.message");
    assert.equal(r.task, "计算 2+3");
    assert.match(r.finalText, /5/);
    assert.equal(r.toolsUsed.includes("code_exec"), true);
    assert.equal(r.accepted, true);
    assert.ok(r.trajectoryId.length > 0);
  });
});

test("task.request also runs agent", async () => {
  await withTempLoop(async (loop, bus) => {
    bus.emit("task.request", { task: "计算 10+5" }, "high");
    await bus.drain();
    assert.equal(loop.results.length, 1);
    assert.equal(loop.results[0]!.eventType, "task.request");
    assert.match(loop.results[0]!.finalText, /15/);
  });
});

test("timer.tick records heartbeat without LLM run", async () => {
  await withTempLoop(async (loop, bus) => {
    bus.emit("timer.tick", { n: 1 }, "low");
    await bus.drain();
    assert.equal(loop.results.length, 0);
    assert.equal(loop.heartbeats.length, 1);
    assert.equal(loop.heartbeats[0]!.resultsCount, 0);
    assert.deepEqual(loop.heartbeats[0]!.payload, { n: 1 });
  });
});

test("stop unsubscribes so further drains do not run agent", async () => {
  await withTempLoop(async (loop, bus) => {
    loop.stop();
    assert.equal(loop.isRunning, false);
    bus.emit("user.message", { text: "计算 1+1" }, "normal");
    await bus.drain();
    assert.equal(loop.results.length, 0);
  });
});

test("handle emits then drains until idle", async () => {
  await withTempLoop(async (loop) => {
    const n = await loop.handle("user.message", { text: "计算 2+3" });
    assert.equal(n, 1);
    assert.equal(loop.results.length, 1);
    assert.match(loop.lastResult!.finalText, /5/);
  });
});

test("heartbeat-demo flow: timer.tick + two user messages", async () => {
  await withTempLoop(async (loop) => {
    await loop.handle("timer.tick", { n: 1, source: "heartbeat-demo" }, "low");
    assert.equal(loop.heartbeats.length, 1);
    assert.equal(loop.results.length, 0);

    await loop.handle("user.message", { text: "计算 2+3" });
    await loop.handle("user.message", { text: "计算 10+5" });
    assert.equal(loop.results.length, 2);
    assert.match(loop.results[0]!.finalText, /5/);
    assert.match(loop.results[1]!.finalText, /15/);
    assert.equal(loop.lastResult!.task, "计算 10+5");
  });
});

test("resultLimit keeps only last N summaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "yishu-async-limit-"));
  try {
    const agent = new YishuAgent({
      workspaceDir: join(root, "workspace"),
      skillsDir: join(packageRoot, "skills"),
      memoryPath: join(root, "memory.json"),
      trajectoriesDir: join(root, "trajectories"),
      enableReview: false,
      llm: new DeterministicLlm(),
    });
    await agent.init();
    const bus = new EventBus();
    const loop = new AsyncAgent({ agent, bus, resultLimit: 2 });
    loop.start();
    await loop.handle("user.message", { text: "计算 1+1" });
    await loop.handle("user.message", { text: "计算 2+2" });
    await loop.handle("user.message", { text: "计算 3+3" });
    assert.equal(loop.results.length, 2);
    assert.equal(loop.results[0]!.task, "计算 2+2");
    assert.equal(loop.results[1]!.task, "计算 3+3");
    loop.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
