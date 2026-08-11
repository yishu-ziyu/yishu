// Spike F — Result Re-entry.
// Pass criteria F1–F7 are defined in docs/spikes/2026-08-10-delegation-concurrency.md.
// The inbox/envelope here is spike glue; TaskTruth remains the only status truth.

import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { describe, it } from "node:test"
import { InMemoryYishuStore } from "../src/store/index.js"
import { TaskTruthProjector } from "../src/task-truth.js"

type ResultEnvelope =
  | { kind: "succeeded"; payload: unknown }
  | { kind: "failed"; error: string }
  | { kind: "cancelled" }

interface InboxEntry {
  taskId: string
  parentId: string
  completedAt: string
  envelope: ResultEnvelope
  // Deliberately no `status` field: TaskTruth in the store is the only
  // task-status truth; the envelope describes the result, not the task.
}

/** Payload-only result inbox with single-consume semantics. */
class ResultInbox {
  private readonly entries = new Map<string, InboxEntry>()

  put(entry: InboxEntry): void {
    this.entries.set(entry.taskId, entry)
  }

  peek(taskId: string): InboxEntry | undefined {
    return this.entries.get(taskId)
  }

  /** Explicit, one-shot consumption at a presentation point. */
  consume(taskId: string): InboxEntry | undefined {
    const entry = this.entries.get(taskId)
    this.entries.delete(taskId)
    return entry
  }

  get size(): number {
    return this.entries.size
  }
}

function now(): string {
  return new Date().toISOString()
}

interface Delegation {
  taskId: string
  settle(result: ResultEnvelope): Promise<void>
}

/** Spike glue: register child TaskTruth, return a settle handle (fake worker). */
async function delegate(
  projector: TaskTruthProjector,
  inbox: ResultInbox,
  parentId: string,
  title: string,
): Promise<Delegation> {
  const taskId = randomUUID()
  await projector.record({
    taskId,
    title,
    kind: "start",
    observedAt: now(),
    evidence: `delegate:accepted:${taskId}`,
    parentId,
  })
  return {
    taskId,
    settle: async (envelope) => {
      if (envelope.kind === "succeeded") {
        await projector.record({
          taskId, title, kind: "verified", observedAt: now(), evidence: "child:verified",
        })
      } else if (envelope.kind === "failed") {
        await projector.record({
          taskId, title, kind: "failed", observedAt: now(), evidence: "child:failed",
        })
      } else {
        await projector.record({
          taskId, title, kind: "cancelled", observedAt: now(), evidence: "child:cancelled",
        })
      }
      // Re-entry path: write to the inbox only. No mutation of any main-turn state.
      inbox.put({ taskId, parentId, completedAt: now(), envelope })
    },
  }
}

/** Simulated main agent with an active turn context it must not lose. */
function makeMainTurn() {
  return {
    turnId: randomUUID(),
    draft: "half-written reply to the user",
    pendingToolCalls: ["lookup-1"],
    consumePointOpen: false,
  }
}

describe("Spike F — result re-entry", () => {
  it("F1/F3/F4/F6: child completion during an active main turn writes the inbox only", async () => {
    const store = new InMemoryYishuStore()
    const projector = new TaskTruthProjector(store)
    const inbox = new ResultInbox()

    const mainTaskId = randomUUID()
    await projector.record({
      taskId: mainTaskId, title: "main", kind: "start", observedAt: now(), evidence: "main:start",
    })
    const delegation = await delegate(projector, inbox, mainTaskId, "research X")

    // Main is in the middle of another turn.
    const mainTurn = makeMainTurn()
    const turnSnapshot = structuredClone(mainTurn)

    // Child finishes while the main turn is active.
    await delegation.settle({ kind: "succeeded", payload: "X findings" })
    await projector.flush()

    // F6/F3: the active turn was neither interrupted nor mutated.
    assert.deepEqual(mainTurn, turnSnapshot)
    // F4: result waits in the inbox; nothing pushed it into the turn.
    assert.equal(inbox.size, 1)
    // F1: entry is keyed by taskId and carries parentId.
    const entry = inbox.peek(delegation.taskId)
    assert.ok(entry)
    assert.equal(entry.taskId, delegation.taskId)
    assert.equal(entry.parentId, mainTaskId)
    // F2: no task status is duplicated in the inbox entry.
    assert.ok(!("status" in entry))
    // TaskTruth itself is correct.
    const child = (await store.listTasks()).find((task) => task.id === delegation.taskId)
    assert.equal(child?.status, "done")

    // Presentation point opens after the turn; main consumes explicitly.
    mainTurn.consumePointOpen = true
    const consumed = inbox.consume(delegation.taskId)
    assert.deepEqual(consumed?.envelope, { kind: "succeeded", payload: "X findings" })
    // F5: a second consume returns nothing.
    assert.equal(inbox.consume(delegation.taskId), undefined)
  })

  it("F7: failed and cancelled children produce explicit, consumable envelopes", async () => {
    const store = new InMemoryYishuStore()
    const projector = new TaskTruthProjector(store)
    const inbox = new ResultInbox()
    const mainTaskId = randomUUID()
    await projector.record({
      taskId: mainTaskId, title: "main", kind: "start", observedAt: now(), evidence: "main:start",
    })

    const failedChild = await delegate(projector, inbox, mainTaskId, "research Y")
    await failedChild.settle({ kind: "failed", error: "worker blew up" })
    const cancelledChild = await delegate(projector, inbox, mainTaskId, "research Z")
    await cancelledChild.settle({ kind: "cancelled" })
    await projector.flush()

    const failedEntry = inbox.consume(failedChild.taskId)
    assert.deepEqual(failedEntry?.envelope, { kind: "failed", error: "worker blew up" })
    const cancelledEntry = inbox.consume(cancelledChild.taskId)
    assert.deepEqual(cancelledEntry?.envelope, { kind: "cancelled" })

    // TaskTruth (the only status truth) reflects the same outcomes.
    const tasks = await store.listTasks()
    assert.equal(tasks.find((task) => task.id === failedChild.taskId)?.status, "failed")
    assert.equal(tasks.find((task) => task.id === cancelledChild.taskId)?.status, "cancelled")
    // Main is untouched by either outcome.
    assert.equal(tasks.find((task) => task.id === mainTaskId)?.status, "running")
  })
})
