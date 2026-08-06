import assert from "node:assert/strict";
import test from "node:test";
import { EventBus, type AgentEvent } from "../src/events/bus.js";

test("emit enqueues; pending counts; drain clears", async () => {
  const bus = new EventBus();
  assert.equal(bus.pending, 0);

  const e = bus.emit("timer.tick", { n: 1 }, "low");
  assert.equal(typeof e.id, "string");
  assert.ok(e.id.length > 0);
  assert.equal(e.type, "timer.tick");
  assert.equal(e.priority, "low");
  assert.deepEqual(e.payload, { n: 1 });
  assert.equal(typeof e.at, "string");
  assert.equal(bus.pending, 1);

  const n = await bus.drain();
  assert.equal(n, 1);
  assert.equal(bus.pending, 0);
});

test("drain dispatches by priority critical > high > normal > low", async () => {
  const bus = new EventBus();
  const seen: string[] = [];

  bus.on("user.message", (ev) => {
    seen.push(`user:${ev.priority}`);
  });
  bus.on("github.webhook", (ev) => {
    seen.push(`gh:${ev.priority}`);
  });
  bus.on("timer.tick", (ev) => {
    seen.push(`tick:${ev.priority}`);
  });

  bus.emit("timer.tick", {}, "low");
  bus.emit("user.message", { text: "hi" }, "normal");
  bus.emit("github.webhook", { repo: "x" }, "high");
  bus.emit("user.message", { text: "urgent" }, "critical");

  assert.equal(bus.pending, 4);
  const n = await bus.drain();
  assert.equal(n, 4);
  assert.deepEqual(seen, [
    "user:critical",
    "gh:high",
    "user:normal",
    "tick:low",
  ]);
  assert.equal(bus.pending, 0);
});

test("once fires only on first matching drain", async () => {
  const bus = new EventBus();
  let count = 0;
  bus.once("github.webhook", () => {
    count += 1;
  });

  bus.emit("github.webhook", { a: 1 }, "normal");
  bus.emit("github.webhook", { a: 2 }, "normal");
  await bus.drain();
  assert.equal(count, 1);

  bus.emit("github.webhook", { a: 3 }, "normal");
  await bus.drain();
  assert.equal(count, 1);
});

test("on unsubscribe stops delivery", async () => {
  const bus = new EventBus();
  const got: AgentEvent[] = [];
  const off = bus.on("timer.tick", (ev) => {
    got.push(ev);
  });

  bus.emit("timer.tick", 1);
  await bus.drain();
  assert.equal(got.length, 1);

  off();
  bus.emit("timer.tick", 2);
  await bus.drain();
  assert.equal(got.length, 1);
});

test("handlers may be async", async () => {
  const bus = new EventBus();
  const order: string[] = [];
  bus.on("user.message", async (ev) => {
    await new Promise((r) => setTimeout(r, 5));
    order.push(String((ev.payload as { t: string }).t));
  });
  bus.emit("user.message", { t: "a" }, "normal");
  await bus.drain();
  assert.deepEqual(order, ["a"]);
});
