import assert from "node:assert/strict";
import test from "node:test";
import { ResourceLease } from "../src/resource-lease.js";

test("resource lease grants one owner and returns busy without queueing", () => {
  const lease = new ResourceLease();
  const first = lease.acquire("desktop", "task-a");
  const second = lease.acquire("desktop", "task-b");

  assert.equal(first.granted, true);
  assert.deepEqual(second, { granted: false, reason: "busy" });
  assert.equal(lease.ownerOf("desktop"), "task-a");
});

test("resource lease rejects stale token and epoch releases after ownership changes", () => {
  const lease = new ResourceLease();
  const first = lease.acquire("desktop", "task-a");
  assert.equal(first.granted, true);
  if (!first.granted) return;

  assert.equal(lease.release("desktop", first.token, first.epoch), true);
  const second = lease.acquire("desktop", "task-b");
  assert.equal(second.granted, true);
  if (!second.granted) return;

  assert.ok(second.epoch > first.epoch);
  assert.equal(lease.release("desktop", first.token, first.epoch), false);
  assert.equal(lease.release("desktop", first.token, second.epoch), false);
  assert.equal(lease.release("desktop", second.token, first.epoch), false);
  assert.equal(lease.holds("desktop", second.token, second.epoch), true);
  assert.equal(lease.ownerOf("desktop"), "task-b");
});

test("forced release is scoped to the terminal owner epoch", () => {
  const lease = new ResourceLease();
  const first = lease.acquire("desktop", "task-a");
  assert.equal(first.granted, true);
  if (!first.granted) return;

  assert.equal(lease.forceRelease("desktop", "task-a", first.epoch), true);
  const second = lease.acquire("desktop", "task-a");
  assert.equal(second.granted, true);
  if (!second.granted) return;

  assert.equal(lease.forceRelease("desktop", "task-a", first.epoch), false);
  assert.equal(lease.holds("desktop", second.token, second.epoch), true);
});

test("leases for other execution cells do not block desktop", () => {
  const lease = new ResourceLease();
  const research = lease.acquire("research", "task-background");
  const desktop = lease.acquire("desktop", "main-interaction");

  assert.equal(research.granted, true);
  assert.equal(desktop.granted, true);
  assert.equal(lease.ownerOf("research"), "task-background");
  assert.equal(lease.ownerOf("desktop"), "main-interaction");
});
