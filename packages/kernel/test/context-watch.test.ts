import assert from "node:assert/strict"
import { mkdtemp, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { createYishuKernel } from "../src/kernel.js"
import {
  InMemoryYishuStore,
  SqliteYishuStore,
  YishuStore,
} from "../src/store/index.js"
import { routeProductUtterance } from "../src/utterance-router.js"
import { makeFrame } from "./fixtures.js"

const PERSONAL = { kind: "personal" } as const
const PROJECT = {
  kind: "project",
  projectId: "019ff5be-62fd-7350-89f8-6b3cbfa5f2fb",
  projectLabel: "Yishu",
} as const
const CREATED_AT = "2026-08-12T10:00:00.000Z"

function creationInput(sessionScope = PERSONAL) {
  return {
    mainConversationId: "019ff5be-62fd-7350-89f8-6b3cbfa5f201",
    sessionScope,
    targetBundleId: "com.google.Chrome",
    reminder: "提交报销",
    sourceFrameId: "019ff5be-62fd-7350-89f8-6b3cbfa5f202",
    createdAt: CREATED_AT,
  }
}

describe("one-shot application return watch", () => {
  it("routes only the explicit grounded command", () => {
    const frame = makeFrame({ capturedAt: CREATED_AT })
    const route = routeProductUtterance(
      "我下次切回这个应用时，提醒我提交报销。",
      frame,
    )
    assert.equal(route?.action, "watch_app_return")
    assert.equal(route?.input.reminder, "提交报销")
    assert.equal(route?.input.targetBundleId, "com.google.Chrome")
    assert.equal(route?.input.sourceFrameId, frame.frameId)

    assert.notEqual(
      routeProductUtterance("我下次切回这个应用时，不要提醒我提交报销。", frame)?.action,
      "watch_app_return",
    )
    assert.equal(
      routeProductUtterance("能不能在我切回这个应用时提醒我？", frame),
      null,
    )
    assert.equal(
      routeProductUtterance("我下次切回这个应用时，提醒我提交报销吗", frame),
      null,
    )
    assert.equal(
      routeProductUtterance("我下次切回这个应用时，提醒我一下。", frame),
      null,
    )
    assert.equal(
      routeProductUtterance("我下次切回这个应用时，提醒我提交报销。"),
      null,
    )
  })

  it("rejects private scope before any durable truth is created", async () => {
    const now = new Date(CREATED_AT)
    const frame = makeFrame({ capturedAt: CREATED_AT })
    const kernel = createYishuKernel()
    const receipt = await kernel.registry.invoke("watch_app_return", {
      caller: "voice",
      input: {
        reminder: "提交报销",
        mainConversationId: creationInput().mainConversationId,
        targetBundleId: "com.google.Chrome",
        sourceFrameId: frame.frameId,
      },
      sessionScope: { kind: "private" },
      contextFrame: frame,
      now,
    })

    assert.equal(receipt.status, "failed")
    assert.equal(kernel.store.getSnapshot().contextWatches.length, 0)
    assert.equal((await kernel.store.listTasks()).length, 0)
    assert.equal((await kernel.store.listMandates()).length, 0)
  })

  it("recovers active truth from both durable backends", async () => {
    const jsonDir = await mkdtemp(path.join(tmpdir(), "yishu-context-watch-json-"))
    const json = new YishuStore(jsonDir)
    const jsonCreated = await json.createContextWatch(creationInput())
    const reopenedJson = new YishuStore(jsonDir)
    assert.deepEqual(
      (await reopenedJson.listActiveContextWatches(PERSONAL)).map((watch) => watch.id),
      [jsonCreated.watch.id],
    )
    assert.equal(await reopenedJson.transitionContextWatch({
      id: jsonCreated.watch.id,
      sessionScope: PERSONAL,
      expectedState: "waiting_for_departure",
      nextState: "armed",
      occurredAt: "2026-08-12T09:59:59.000Z",
      observationFrameId: "json-observation-before-create",
    }), null)
    await reopenedJson.transitionContextWatch({
      id: jsonCreated.watch.id,
      sessionScope: PERSONAL,
      expectedState: "waiting_for_departure",
      nextState: "armed",
      occurredAt: "2026-08-12T10:01:00.000Z",
      observationFrameId: "json-left",
    })
    await reopenedJson.transitionContextWatch({
      id: jsonCreated.watch.id,
      sessionScope: PERSONAL,
      expectedState: "armed",
      nextState: "fired",
      occurredAt: "2026-08-12T10:02:00.000Z",
      observationFrameId: "json-returned",
    })
    const firedJson = new YishuStore(jsonDir)
    assert.equal((await firedJson.listDelegatedResults({ taskId: jsonCreated.task.id })).length, 1)
    assert.equal((await firedJson.listTasks())[0]?.status, "done")

    const sqliteDir = await mkdtemp(path.join(tmpdir(), "yishu-context-watch-sqlite-"))
    const dbPath = path.join(sqliteDir, "watch.sqlite")
    const sqlite = new SqliteYishuStore(dbPath)
    const sqliteCreated = await sqlite.createContextWatch(creationInput())
    sqlite.close()
    const reopenedSqlite = new SqliteYishuStore(dbPath)
    assert.deepEqual(
      (await reopenedSqlite.listActiveContextWatches(PERSONAL)).map((watch) => watch.id),
      [sqliteCreated.watch.id],
    )
    assert.equal(await reopenedSqlite.transitionContextWatch({
      id: sqliteCreated.watch.id,
      sessionScope: PERSONAL,
      expectedState: "waiting_for_departure",
      nextState: "armed",
      occurredAt: "2026-08-12T09:59:59.000Z",
      observationFrameId: "sqlite-observation-before-create",
    }), null)
    await reopenedSqlite.transitionContextWatch({
      id: sqliteCreated.watch.id,
      sessionScope: PERSONAL,
      expectedState: "waiting_for_departure",
      nextState: "armed",
      occurredAt: "2026-08-12T10:01:00.000Z",
      observationFrameId: "sqlite-left",
    })
    await reopenedSqlite.transitionContextWatch({
      id: sqliteCreated.watch.id,
      sessionScope: PERSONAL,
      expectedState: "armed",
      nextState: "fired",
      occurredAt: "2026-08-12T10:02:00.000Z",
      observationFrameId: "sqlite-returned",
    })
    assert.equal(
      (await reopenedSqlite.listDelegatedResults({ taskId: sqliteCreated.task.id })).length,
      1,
    )
    reopenedSqlite.close()
    await unlink(dbPath).catch(() => undefined)
  })

  it("rolls back every SQLite entity when atomic creation conflicts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-context-watch-conflict-"))
    const dbPath = path.join(dir, "watch.sqlite")
    const store = new SqliteYishuStore(dbPath)
    const taskId = "019ff5be-62fd-7350-89f8-6b3cbfa5f210"
    await store.upsertTask({
      id: taskId,
      title: "pre-existing task",
      status: "running",
      evidence: ["pre-existing"],
      sessionScope: PERSONAL,
    })

    await assert.rejects(
      () => store.createContextWatch({ ...creationInput(), taskId }),
      /context_watch_id_conflict/,
    )
    assert.equal(store.getSnapshot().contextWatches.length, 0)
    assert.equal((await store.listMandates()).length, 0)
    const tasks = await store.listTasks()
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0]?.title, "pre-existing task")
    store.close()
    await unlink(dbPath).catch(() => undefined)
  })

  it("CAS transitions once and never crosses exact scope", async () => {
    const store = new InMemoryYishuStore()
    const created = await store.createContextWatch(creationInput(PROJECT))
    assert.equal(created.task.parentId, created.mandate.id)
    const id = created.watch.id

    assert.equal(await store.transitionContextWatch({
      id,
      sessionScope: PERSONAL,
      expectedState: "waiting_for_departure",
      nextState: "armed",
      occurredAt: "2026-08-12T10:01:00.000Z",
      observationFrameId: "frame-wrong-scope",
    }), null)
    const armed = await store.transitionContextWatch({
      id,
      sessionScope: PROJECT,
      expectedState: "waiting_for_departure",
      nextState: "armed",
      occurredAt: "2026-08-12T10:01:01.000Z",
      observationFrameId: "frame-left-app",
    })
    assert.equal(armed?.state, "armed")
    assert.equal(await store.transitionContextWatch({
      id,
      sessionScope: PROJECT,
      expectedState: "armed",
      nextState: "fired",
      occurredAt: "2026-08-12T10:01:01.000Z",
      observationFrameId: "same-observation-cannot-return",
    }), null)
    assert.equal(await store.transitionContextWatch({
      id,
      sessionScope: PROJECT,
      expectedState: "waiting_for_departure",
      nextState: "armed",
      occurredAt: "2026-08-12T10:01:02.000Z",
      observationFrameId: "frame-left-app-again",
    }), null)

    const fired = await store.transitionContextWatch({
      id,
      sessionScope: PROJECT,
      expectedState: "armed",
      nextState: "fired",
      occurredAt: "2026-08-12T10:02:00.000Z",
      observationFrameId: "frame-returned",
    })
    assert.equal(fired?.state, "fired")
    assert.equal(await store.transitionContextWatch({
      id,
      sessionScope: PROJECT,
      expectedState: "armed",
      nextState: "fired",
      occurredAt: "2026-08-12T10:02:01.000Z",
      observationFrameId: "frame-returned-again",
    }), null)
    assert.deepEqual(await store.listActiveContextWatches(PROJECT), [])
    assert.equal((await store.listTasks({ sessionScope: PROJECT }))[0]?.status, "done")
    const results = await store.listDelegatedResults({ taskId: created.task.id })
    assert.equal(results.length, 1)
    assert.equal(results[0]?.summary, "提醒：提交报销")
    assert.equal((await store.listMandates()).length, 0)
  })

  it("cancellation permanently disarms the watch", async () => {
    const store = new InMemoryYishuStore()
    const created = await store.createContextWatch(creationInput())
    const cancelled = await store.cancelContextWatch(
      created.watch.id,
      PERSONAL,
      "2026-08-12T10:01:00.000Z",
    )
    assert.equal(cancelled?.state, "cancelled")
    assert.deepEqual(await store.listActiveContextWatches(PERSONAL), [])
    assert.equal(await store.transitionContextWatch({
      id: created.watch.id,
      sessionScope: PERSONAL,
      expectedState: "waiting_for_departure",
      nextState: "armed",
      occurredAt: "2026-08-12T10:02:00.000Z",
      observationFrameId: "frame-after-cancel",
    }), null)
    assert.equal((await store.listTasks())[0]?.status, "cancelled")
    assert.equal((await store.listMandates()).length, 0)
  })
})
