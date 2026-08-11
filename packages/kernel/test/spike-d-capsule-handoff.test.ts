// Spike D — ContextCapsule Handoff.
// Pass criteria D1–D8 are defined in docs/spikes/2026-08-10-delegation-concurrency.md.
// The handoff-boundary check (expiry + scope envelope) is spike glue; it exists
// because the kernel has no built-in expiry enforcement point (recorded in the
// experiment doc as a finding).

import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { describe, it } from "node:test"
import {
  buildContextCapsule,
  parseContextCapsule,
  serializeContextCapsule,
  type ContextCapsule,
} from "../src/context/capsule.js"
import { ContextTrail } from "../src/context/trail.js"
import type { TrailSourceFrame } from "../src/context/sanitize.js"
import { InMemoryYishuStore } from "../src/store/index.js"
import { TaskTruthProjector } from "../src/task-truth.js"
import type { SessionScope } from "../src/session-scope.js"

const NOW = new Date("2026-08-11T12:00:00.000Z")

function observed<T>(value: T) {
  return { value, source: "spike", capturedAt: NOW.toISOString(), confidence: 1 }
}

function makeFrame(minutesAgo: number, appName: string): TrailSourceFrame {
  const capturedAt = new Date(NOW.getTime() - minutesAgo * 60_000).toISOString()
  return {
    frameId: randomUUID(),
    capturedAt,
    expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
    frontmostApplication: observed({
      name: appName,
      bundleIdentifier: "com.example.App",
      processIdentifier: 100,
    }),
    activeWindow: observed({
      title: `${appName} window`,
      ownerName: appName,
      processIdentifier: 100,
      bounds: null,
    }),
    elementUnderCursor: observed({
      role: "AXButton",
      subrole: null,
      title: "Export",
      description: null,
      valuePreview: "row 1: revenue up 12%",
    }),
    screenshots: [{ label: "display", base64Data: "c2NyZWVuc2hvdC1ieXRlcw==" }],
    warnings: [],
  }
}

/** Spike glue: the handoff boundary the kernel does not yet provide. */
function handoffReceive(
  json: string,
  options: { now: Date; sessionScope: SessionScope },
): { capsule: ContextCapsule; sessionScope: SessionScope } {
  const capsule = parseContextCapsule(json)
  if (Date.parse(capsule.expiresAt) <= options.now.getTime()) {
    throw new Error("handoff rejected: capsule expired")
  }
  return { capsule, sessionScope: options.sessionScope }
}

function buildMainSide() {
  const trail = new ContextTrail({ retentionMs: 24 * 60 * 60_000 })
  // One hour of activity; only the last 5 minutes should enter the capsule.
  for (const minutesAgo of [60, 45, 30, 12, 4, 1]) {
    trail.append(makeFrame(minutesAgo, `App-${minutesAgo}`), NOW)
  }
  const frame = makeFrame(0, "App-0")
  const capsule = buildContextCapsule({
    frame,
    trail,
    userIntent: "Summarize why the Export button is disabled",
    projectHint: "yishu",
    recentMinutes: 5,
    ttlMs: 15 * 60_000,
    now: NOW,
  })
  return { trail, frame, capsule }
}

describe("Spike D — ContextCapsule handoff", () => {
  it("D1/D2/D3: child receives a minimal windowed context without screenshots or full history", () => {
    const { capsule } = buildMainSide()

    // Handoff across the serialization boundary.
    const { capsule: received } = handoffReceive(serializeContextCapsule(capsule), {
      now: NOW,
      sessionScope: { kind: "personal" },
    })

    // D1: a deterministic child task can be completed from capsule fields alone.
    const childAnswer = `intent=${received.userIntent} app=${received.frontmostApp?.name} ax=${received.axElement?.title}`
    assert.equal(
      childAnswer,
      "intent=Summarize why the Export button is disabled app=App-0 ax=Export",
    )
    assert.equal(received.selectedText, "row 1: revenue up 12%")
    assert.equal(received.projectHint, "yishu")

    // D2: only the 5-minute window crosses the boundary; no conversation turns exist.
    const appNames = received.recentTrail.map((entry) => entry.appName)
    assert.deepEqual(appNames, ["App-4", "App-1"])
    assert.ok(!("turns" in received) && !("conversation" in received))

    // D3: no screenshot bytes anywhere in the serialized handoff.
    const blob = serializeContextCapsule(received)
    assert.ok(!blob.includes("c2NyZWVuc2hvdC1ieXRlcw=="))
    assert.ok(!blob.includes('"base64Data"'))
  })

  it("D3/D4/D5: parse hard-rejects smuggled screenshots, credentials, and hidden reasoning", () => {
    const { capsule } = buildMainSide()
    for (const key of [
      "base64Data",
      "apiKey",
      "accessToken",
      "password",
      "chainOfThought",
      "systemPrompt",
    ]) {
      const smuggled = JSON.stringify({ ...capsule, [key]: "x" })
      assert.throws(() => parseContextCapsule(smuggled), undefined, `${key} must be rejected`)
    }
    // serializeContextCapsule drops unknown fields from hand-built objects.
    const withExtra = JSON.parse(
      serializeContextCapsule({ ...capsule, internalNotes: "raw reasoning" } as unknown as ContextCapsule),
    ) as Record<string, unknown>
    assert.ok(!("internalNotes" in withExtra))
  })

  it("D6: session scope crosses the handoff envelope; foreign scope writes are rejected", async () => {
    const store = new InMemoryYishuStore()
    const projector = new TaskTruthProjector(store)
    const parentScope: SessionScope = { kind: "project", projectId: randomUUID(), projectLabel: "Yishu" }
    const taskId = randomUUID()

    // Parent (main) starts the task under its scope.
    await projector.record({
      taskId,
      title: "delegated task",
      kind: "start",
      observedAt: NOW.toISOString(),
      evidence: "main:start",
      sessionScope: parentScope,
    })

    // Child inherits scope through the handoff envelope and reports progress.
    const { sessionScope: childScope } = handoffReceive(
      serializeContextCapsule(buildMainSide().capsule),
      { now: NOW, sessionScope: parentScope },
    )
    await projector.record({
      taskId,
      title: "delegated task",
      kind: "progress",
      observedAt: NOW.toISOString(),
      evidence: "child:progress",
      sessionScope: childScope,
    })
    const task = (await store.listTasks()).find((entry) => entry.id === taskId)
    assert.equal(task?.status, "running")

    // A different scope writing the same task is rejected.
    await assert.rejects(
      projector.record({
        taskId,
        title: "delegated task",
        kind: "progress",
        observedAt: NOW.toISOString(),
        evidence: "foreign:progress",
        sessionScope: { kind: "project", projectId: randomUUID() },
      }),
      /task_scope_conflict/,
    )
  })

  it("D7: an expired capsule is rejected at the handoff boundary", () => {
    const { capsule } = buildMainSide()
    const json = serializeContextCapsule(capsule)
    const afterExpiry = new Date(Date.parse(capsule.expiresAt) + 1)
    assert.throws(
      () => handoffReceive(json, { now: afterExpiry, sessionScope: { kind: "personal" } }),
      /capsule expired/,
    )
    // And parseContextCapsule alone does NOT enforce expiry (kernel gap, recorded).
    const parsed = parseContextCapsule(json)
    assert.ok(Date.parse(parsed.expiresAt) < afterExpiry.getTime())
  })

  it("D8: child mutations on its own copy never reach the main trail or frame", () => {
    const { trail, frame, capsule } = buildMainSide()
    const { capsule: childCopy } = handoffReceive(serializeContextCapsule(capsule), {
      now: NOW,
      sessionScope: { kind: "personal" },
    })

    // Child mutates its own copy aggressively.
    childCopy.userIntent = "child rewrote the intent"
    childCopy.recentTrail.length = 0
    if (childCopy.frontmostApp) childCopy.frontmostApp.name = "EVIL"

    // Main's trail and frame are untouched.
    const mainEntries = trail.recentMinutes(5, NOW)
    assert.equal(mainEntries.length, 2)
    assert.deepEqual(mainEntries.map((entry) => entry.appName), ["App-4", "App-1"])
    assert.equal(frame.frontmostApplication?.value.name, "App-0")
    // Main's own capsule object is a different instance, also untouched.
    assert.equal(capsule.userIntent, "Summarize why the Export button is disabled")
    assert.equal(capsule.recentTrail.length, 2)
  })
})
