// Spike B — Asynchronous Delegation (deterministic fake worker, no real Pi).
// Pass criteria B1–B7 are defined in docs/spikes/2026-08-10-delegation-concurrency.md.
// The fake scheduler/worker/inbox here are spike-only glue; production would need
// a real design. TaskTruth/store semantics under test are the production ones.

import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { describe, it } from "node:test"
import { InMemoryYishuStore } from "../src/store/index.js"
import { TaskTruthProjector } from "../src/task-truth.js"
import type { TaskTruth } from "../src/store/types.js"

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(error: unknown): void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function now(): string {
  return new Date().toISOString()
}

/**
 * Minimal Result Inbox: stores result payloads only. It deliberately has no
 * status field — TaskTruth in the store remains the single status truth.
 */
class ResultInbox {
  private readonly results = new Map<string, unknown>()

  put(taskId: string, result: unknown): void {
    this.results.set(taskId, result)
  }

  take(taskId: string): unknown {
    const result = this.results.get(taskId)
    this.results.delete(taskId)
    return result
  }

  get size(): number {
    return this.results.size
  }
}

/** Fake worker: holds execution open until its gate settles. */
class FakeWorker {
  readonly gate = deferred<{ result: string }>()
  settled = false

  run(): Promise<{ result: string }> {
    return this.gate.promise.then((value) => {
      this.settled = true
      return value
    })
  }
}

/**
 * Minimal fake scheduler: registers child TaskTruth, starts the worker in the
 * background, and translates the worker outcome into TaskTruth signals.
 * Returns immediately after registration — this is the delegate() semantics
 * under test.
 */
async function delegate(
  projector: TaskTruthProjector,
  inbox: ResultInbox,
  registry: FakeWorker[],
  parentId: string,
  title: string,
): Promise<{ accepted: true; taskId: string }> {
  const taskId = randomUUID()
  await projector.record({
    taskId,
    title,
    kind: "start",
    observedAt: now(),
    evidence: `delegate:accepted:${taskId}`,
    parentId,
  })
  const worker = new FakeWorker()
  registry.push(worker)
  const outcome = worker.run()
  // Background completion path; not awaited by the caller.
  void outcome.then(
    async ({ result }) => {
      await projector.record({
        taskId,
        title,
        kind: "verified",
        observedAt: now(),
        evidence: `delegate:verified:${taskId}`,
      })
      inbox.put(taskId, result)
    },
    async (error: unknown) => {
      await projector.record({
        taskId,
        title,
        kind: "failed",
        observedAt: now(),
        evidence: `delegate:failed:${String(error).slice(0, 80)}`,
      })
    },
  )
  return { accepted: true, taskId }
}

async function taskById(store: InMemoryYishuStore, id: string): Promise<TaskTruth | undefined> {
  return (await store.listTasks()).find((task) => task.id === id)
}

describe("Spike B — asynchronous delegation", () => {
  it("B1/B2/B3/B6/B7: delegate returns accepted while child runs; main continues; result lands in inbox", async () => {
    const store = new InMemoryYishuStore()
    const projector = new TaskTruthProjector(store)
    const inbox = new ResultInbox()
    const workers: FakeWorker[] = []

    // Main task running.
    const mainId = randomUUID()
    await projector.record({
      taskId: mainId,
      title: "main task",
      kind: "start",
      observedAt: now(),
      evidence: "main:start",
    })

    // Main Turn 1: delegate("research X").
    const receipt = await delegate(projector, inbox, workers, mainId, "research X")
    assert.equal(receipt.accepted, true)
    assert.ok(receipt.taskId)

    // B2: child TaskTruth exists, running, linked to parent.
    const childAfterAccept = await taskById(store, receipt.taskId)
    assert.ok(childAfterAccept)
    assert.equal(childAfterAccept.status, "running")
    assert.equal(childAfterAccept.parentId, mainId)

    // B1: the worker has not settled yet, but the receipt already returned —
    // direct ordering evidence that delegate did not wait for the result.
    assert.equal(workers.length, 1)
    assert.equal(workers[0]!.settled, false)

    // Main Turn 2 while child is still running: main progresses to done.
    await projector.record({
      taskId: mainId,
      title: "main task",
      kind: "verified",
      observedAt: now(),
      evidence: "main:verified",
    })
    const mainAfterTurn2 = await taskById(store, mainId)
    assert.equal(mainAfterTurn2?.status, "done")
    // B3: child unaffected by main completing.
    const childDuringTurn2 = await taskById(store, receipt.taskId)
    assert.equal(childDuringTurn2?.status, "running")

    // Worker finishes in the background; scheduler settles the child.
    workers[0]!.gate.resolve({ result: "X findings" })
    await projector.flush()
    await new Promise((resolve) => setImmediate(resolve))
    await projector.flush()
    const childDone = await taskById(store, receipt.taskId)
    assert.equal(childDone?.status, "done")

    // B6: result retrievable from inbox; inbox holds payload only, no status.
    const result = inbox.take(receipt.taskId)
    assert.equal(result, "X findings")
    assert.equal(inbox.size, 0)
    assert.ok(!("status" in Object(result)))

    // B7: a late signal cannot overwrite the terminal state.
    await projector.record({
      taskId: receipt.taskId,
      title: "research X",
      kind: "failed",
      observedAt: now(),
      evidence: "delegate:late-failure",
    })
    const childAfterLateSignal = await taskById(store, receipt.taskId)
    assert.equal(childAfterLateSignal?.status, "done")
  })

  it("B4: child failure does not fail the main task", async () => {
    const store = new InMemoryYishuStore()
    const projector = new TaskTruthProjector(store)
    const inbox = new ResultInbox()
    const workers: FakeWorker[] = []

    const mainId = randomUUID()
    await projector.record({
      taskId: mainId,
      title: "main task",
      kind: "start",
      observedAt: now(),
      evidence: "main:start",
    })
    const receipt = await delegate(projector, inbox, workers, mainId, "research Y")
    workers[0]!.gate.reject(new Error("worker blew up"))
    await projector.flush()
    await new Promise((resolve) => setImmediate(resolve))
    await projector.flush()

    const child = await taskById(store, receipt.taskId)
    assert.equal(child?.status, "failed")
    const main = await taskById(store, mainId)
    assert.equal(main?.status, "running", "main must keep its own state")
    assert.equal(inbox.size, 0, "failed child must not produce an inbox result")
  })

  it("B5: cancelling a child does not affect the main task", async () => {
    const store = new InMemoryYishuStore()
    const projector = new TaskTruthProjector(store)
    const inbox = new ResultInbox()
    const workers: FakeWorker[] = []

    const mainId = randomUUID()
    await projector.record({
      taskId: mainId,
      title: "main task",
      kind: "start",
      observedAt: now(),
      evidence: "main:start",
    })
    const receipt = await delegate(projector, inbox, workers, mainId, "research Z")
    await projector.record({
      taskId: receipt.taskId,
      title: "research Z",
      kind: "cancelled",
      observedAt: now(),
      evidence: "delegate:cancelled",
    })

    const child = await taskById(store, receipt.taskId)
    assert.equal(child?.status, "cancelled")
    const main = await taskById(store, mainId)
    assert.equal(main?.status, "running")

    // Main can still finish on its own afterwards.
    await projector.record({
      taskId: mainId,
      title: "main task",
      kind: "verified",
      observedAt: now(),
      evidence: "main:verified",
    })
    assert.equal((await taskById(store, mainId))?.status, "done")
  })
})
