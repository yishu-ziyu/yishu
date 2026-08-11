// Spike E — Exclusive Desktop Cell.
// Pass criteria E1–E5 are defined in docs/spikes/2026-08-10-delegation-concurrency.md.
// ResourceLease here is minimal spike glue: single coordinator process, in-memory,
// token-guarded. Distributed lease is explicitly out of scope.

import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { describe, it } from "node:test"

interface LeaseGrant {
  granted: true
  token: string
}

type LeaseResult = LeaseGrant | { granted: false }

/**
 * Minimal single-process resource lease. Ownership is matched by token so a
 * late release from a previous owner can never free the new owner's lease.
 */
class ResourceLease {
  private readonly owners = new Map<string, { taskId: string; token: string }>()

  acquire(resource: string, taskId: string): LeaseResult {
    if (this.owners.has(resource)) return { granted: false }
    const token = randomUUID()
    this.owners.set(resource, { taskId, token })
    return { granted: true, token }
  }

  holds(resource: string, token: string): boolean {
    return this.owners.get(resource)?.token === token
  }

  ownerOf(resource: string): string | null {
    return this.owners.get(resource)?.taskId ?? null
  }

  /** Voluntary release by the owner; only the matching token frees the lease. */
  release(resource: string, token: string): boolean {
    const owner = this.owners.get(resource)
    if (!owner || owner.token !== token) return false
    this.owners.delete(resource)
    return true
  }

  /** Coordinator-forced release when the owner reaches a terminal state. */
  forceRelease(resource: string, taskId: string): boolean {
    const owner = this.owners.get(resource)
    if (!owner || owner.taskId !== taskId) return false
    this.owners.delete(resource)
    return true
  }
}

/** Desktop gate: no valid lease, no action. Calls are counted for evidence. */
class GuardedDesktop {
  readonly executed: Array<{ taskId: string; action: string }> = []

  constructor(private readonly lease: ResourceLease) {}

  perform(taskId: string, token: string | null, action: string): void {
    if (token === null || !this.lease.holds("desktop", token)) {
      throw new Error("desktop action rejected: no lease")
    }
    this.executed.push({ taskId, action })
  }
}

const DESKTOP = "desktop"

describe("Spike E — exclusive desktop cell", () => {
  it("E1: at most one desktop owner; the second acquirer is blocked and cannot act", () => {
    const lease = new ResourceLease()
    const desktop = new GuardedDesktop(lease)

    const a = lease.acquire(DESKTOP, "task-A")
    assert.equal(a.granted, true)
    desktop.perform("task-A", a.granted ? a.token : null, "click")

    const b = lease.acquire(DESKTOP, "task-B")
    assert.equal(b.granted, false, "B must be queued/blocked while A owns the desktop")
    assert.equal(lease.ownerOf(DESKTOP), "task-A")
    assert.throws(
      () => desktop.perform("task-B", null, "click"),
      /no lease/,
      "B must not execute a desktop action without ownership",
    )
    assert.deepEqual(desktop.executed, [{ taskId: "task-A", action: "click" }])
  })

  it("E2: cancelling the owner frees the lease for the next task", () => {
    const lease = new ResourceLease()
    const desktop = new GuardedDesktop(lease)

    const a = lease.acquire(DESKTOP, "task-A")
    assert.equal(a.granted, true)
    // task-A is cancelled; the coordinator force-releases on terminal state.
    assert.equal(lease.forceRelease(DESKTOP, "task-A"), true)

    const b = lease.acquire(DESKTOP, "task-B")
    assert.equal(b.granted, true)
    desktop.perform("task-B", b.granted ? b.token : null, "type")
    assert.deepEqual(desktop.executed, [{ taskId: "task-B", action: "type" }])
  })

  it("E3: a failed owner frees the lease", () => {
    const lease = new ResourceLease()
    const a = lease.acquire(DESKTOP, "task-A")
    assert.equal(a.granted, true)
    // task-A failed; terminal state triggers forced release.
    assert.equal(lease.forceRelease(DESKTOP, "task-A"), true)
    assert.equal(lease.ownerOf(DESKTOP), null)
    const b = lease.acquire(DESKTOP, "task-B")
    assert.equal(b.granted, true)
  })

  it("E4: a stale release cannot free the new owner's lease", () => {
    const lease = new ResourceLease()
    const a = lease.acquire(DESKTOP, "task-A")
    assert.equal(a.granted, true)
    const staleToken = a.granted ? a.token : ""

    // Ownership moves to B after A's terminal forced release.
    lease.forceRelease(DESKTOP, "task-A")
    const b = lease.acquire(DESKTOP, "task-B")
    assert.equal(b.granted, true)

    // A's late voluntary release with the old token must not disturb B.
    assert.equal(lease.release(DESKTOP, staleToken), false)
    assert.equal(lease.ownerOf(DESKTOP), "task-B")
    assert.equal(lease.holds(DESKTOP, b.granted ? b.token : ""), true)
  })

  it("E5: a background task holding a non-desktop cell does not block main desktop use", () => {
    const lease = new ResourceLease()
    const desktop = new GuardedDesktop(lease)

    const background = lease.acquire("research", "task-bg")
    assert.equal(background.granted, true)

    const main = lease.acquire(DESKTOP, "main-interaction")
    assert.equal(main.granted, true, "main desktop acquire must not be blocked by the research cell")
    desktop.perform("main-interaction", main.granted ? main.token : null, "click")
    assert.deepEqual(desktop.executed, [{ taskId: "main-interaction", action: "click" }])
    // The background cell is untouched.
    assert.equal(lease.ownerOf("research"), "task-bg")
  })
})
