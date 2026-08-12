import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import {
  InMemoryYishuStore,
  SqliteYishuStore,
  sanitizeVisibleText,
  StoreOperationCancelledError,
  YishuStore,
  type YishuStorePort,
} from "../src/store/index.js"

async function exerciseLedger(store: YishuStorePort): Promise<void> {
  const conversation = await store.upsertConversation({
    id: "conversation-1",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    title: "产品对话",
  })
  assert.equal(conversation.status, "active")

  const started = await store.upsertConversationTurn({
    id: "request-1",
    conversationId: conversation.id,
    traceId: "trace-1",
    userInput: "记住我的项目偏好",
    status: "open",
    createdAt: "2026-08-08T00:00:01.000Z",
    updatedAt: "2026-08-08T00:00:01.000Z",
  })
  assert.equal(started.sequence, 0)
  assert.equal(started.traceId, "trace-1")
  assert.deepEqual(await store.getConversationTurn(started.id), started)
  assert.equal(await store.getConversationTurn("missing-turn"), null)

  assert.equal(await store.replaceOpenConversationTurnInput({
    conversationId: "CONVERSATION-1",
    turnId: started.id,
    traceId: "trace-1",
    userInput: "不应跨 identity 写入",
  }), false)
  assert.equal(await store.replaceOpenConversationTurnInput({
    conversationId: conversation.id,
    turnId: "wrong-turn",
    traceId: "trace-1",
    userInput: "不应写入错误 turn",
  }), false)
  assert.equal(await store.replaceOpenConversationTurnInput({
    conversationId: conversation.id,
    turnId: started.id,
    traceId: "wrong-trace",
    userInput: "不应写入错误 trace",
  }), false)
  assert.equal(await store.replaceOpenConversationTurnInput({
    conversationId: conversation.id,
    turnId: started.id,
    traceId: "trace-1",
    userInput: "记住我的项目偏好，并且只用于这个项目",
  }), true)
  assert.equal(
    (await store.getConversationTurn(started.id))?.userInput,
    "记住我的项目偏好，并且只用于这个项目",
  )

  const firstEvent = await store.appendConversationEvent({
    id: "event-1",
    conversationId: conversation.id,
    turnId: started.id,
    type: "turn.started",
    occurredAt: "2026-08-08T00:00:01.000Z",
    payload: { requestId: started.id, status: "running" },
  })
  assert.equal(firstEvent.sequence, 0)
  assert.deepEqual(
    await store.appendConversationEvent({
      id: "event-1",
      conversationId: conversation.id,
      turnId: started.id,
      type: "turn.started",
      occurredAt: "2026-08-08T00:00:01.000Z",
      payload: { requestId: started.id, status: "running" },
    }),
    firstEvent,
  )

  await assert.rejects(
    () => store.appendConversationEvent({
      id: "event-1",
      conversationId: conversation.id,
      turnId: started.id,
      type: "tool.started",
      payload: { requestId: started.id },
    }),
    /event_id_conflict/,
  )

  const secondEvent = await store.appendConversationEvent({
    id: "event-2",
    conversationId: conversation.id,
    turnId: started.id,
    type: "turn.completed",
    payload: { message: "password=not-stored" },
  })
  assert.equal(secondEvent.sequence, 1)
  assert.equal(secondEvent.payload.message, "[redacted]")

  const completed = await store.upsertConversationTurn({
    id: started.id,
    conversationId: conversation.id,
    traceId: "trace-1",
    status: "completed",
    assistantOutput: "已记住。",
    updatedAt: "2026-08-08T00:00:02.000Z",
  })
  assert.equal(completed.status, "completed")
  assert.equal(completed.assistantOutput, "已记住。")
  assert.equal(await store.replaceOpenConversationTurnInput({
    conversationId: conversation.id,
    turnId: started.id,
    traceId: "trace-1",
    userInput: "终态后不得重写",
  }), false)
  assert.deepEqual(
    await store.upsertConversationTurn({
      id: started.id,
      conversationId: conversation.id,
      traceId: "trace-1",
      status: "completed",
      assistantOutput: "已记住。",
    }),
    completed,
  )
  await assert.rejects(
    () => store.upsertConversationTurn({
      id: started.id,
      conversationId: conversation.id,
      status: "open",
    }),
    /turn_terminal_conflict/,
  )
  await assert.rejects(
    () => store.upsertConversationTurn({
      id: started.id,
      conversationId: conversation.id,
      status: "completed",
      assistantOutput: "篡改输出",
    }),
    /turn_output_conflict/,
  )
  await assert.rejects(
    () => store.upsertConversationTurn({
      id: started.id,
      conversationId: conversation.id,
      status: "completed",
      traceId: "different-trace",
    }),
    /turn_trace_conflict/,
  )
  await assert.rejects(
    () => store.appendConversationEvent({
      id: "event-late",
      conversationId: conversation.id,
      turnId: started.id,
      type: "tool.completed",
      payload: { status: "late" },
    }),
    /late_event_rejected/,
  )
  assert.deepEqual(
    await store.appendConversationEvent({
      id: secondEvent.id,
      conversationId: conversation.id,
      turnId: started.id,
      type: secondEvent.type,
      payload: secondEvent.payload,
    }),
    secondEvent,
  )

  const turns = await store.listConversationTurns(conversation.id)
  const events = await store.listConversationEvents(conversation.id)
  assert.deepEqual(turns.map((turn) => turn.sequence), [0])
  assert.deepEqual(events.map((event) => event.sequence), [0, 1])
}

function cancelled(error: unknown): boolean {
  return (
    error instanceof StoreOperationCancelledError &&
    error.code === "store_operation_cancelled"
  )
}

async function exerciseCancelledMutations(store: YishuStorePort): Promise<void> {
  const now = "2026-08-08T00:10:00.000Z"
  const memory = await store.addMemory({
    claim: "cancellation seed",
    source: "system",
    capturedAt: now,
    scope: "global",
    confidence: 0.8,
    lastConfirmedAt: now,
    supersedes: null,
    tags: [],
  })
  const candidate = await store.addSkillCandidate({
    name: "cancellation-seed-skill",
    steps: [{ id: "step-1", description: "verify", kind: "verify" }],
    conditions: {},
    verification: ["test"],
    sourceTrailFrom: now,
    sourceTrailTo: now,
  })

  const abort = () => {
    const controller = new AbortController()
    controller.abort()
    return controller.signal
  }
  const memoryInput = {
    claim: "cancelled memory must not persist",
    source: "system" as const,
    capturedAt: now,
    scope: "global",
    confidence: 0.8,
    lastConfirmedAt: now,
    supersedes: null,
    tags: [],
  }
  await assert.rejects(
    () => store.addMemory(memoryInput, { signal: abort() }),
    cancelled,
  )
  await assert.rejects(
    () => store.addLearning({ rule: "cancelled learning", scope: "global", confidence: 0.8 }, { signal: abort() }),
    cancelled,
  )
  await assert.rejects(
    () => store.retireMemory(memory.id, { signal: abort() }),
    cancelled,
  )
  await assert.rejects(
    () => store.addSkillCandidate({
      name: "cancelled-skill",
      steps: candidate.steps,
      conditions: {},
      verification: ["test"],
      sourceTrailFrom: now,
      sourceTrailTo: now,
    }, { signal: abort() }),
    cancelled,
  )
  await assert.rejects(
    () => store.promoteSkill(candidate.id, { signal: abort() }),
    cancelled,
  )

  assert.equal((await store.searchMemory("cancellation seed")).length, 1)
  assert.equal((await store.searchMemory("cancelled memory")).length, 0)
  assert.equal((await store.listLearnings()).length, 0)
  assert.equal((await store.listSkillCandidates()).length, 1)
  assert.equal((await store.listVerifiedSkills()).length, 0)
}

describe("conversation ledger", () => {
  it("keeps the in-memory contract and rejects unsafe payloads", async () => {
    const store = new InMemoryYishuStore()
    await exerciseLedger(store)

    await assert.rejects(
      () => store.appendConversationEvent({
        conversationId: "conversation-1",
        type: "tool.started",
        payload: { details: { nested: true } } as never,
      }),
      /flat object|scalar/,
    )
    await assert.rejects(
      () => store.appendConversationEvent({
        conversationId: "conversation-1",
        type: "response.delta" as never,
        payload: { text: "transient" },
      }),
      /response\.delta/,
    )
    assert.equal(
      sanitizeVisibleText(
        "password=one token=two refresh_token=three Authorization: Bearer four 密码：五",
        "visible text",
      ),
      "[redacted] [redacted] [redacted] [redacted] [redacted]",
    )
    assert.equal(
      sanitizeVisibleText(
        "password_SUPERSECRET123 Authorization_Bearer_SUPERSECRET123 password.SUPERSECRET123 api-key-SUPERSECRET123",
        "metadata value",
      ),
      "[redacted] [redacted] [redacted] [redacted]",
    )
    assert.equal(sanitizeVisibleText("打开 Secret Manager", "ordinary text"), "打开 Secret Manager")
    await assert.rejects(
      () => store.appendConversationEvent({
        conversationId: "conversation-1",
        type: "tool.completed",
        payload: { text: "prefix data:image/png;base64,AAAA" },
      }),
      /base64 data URI/,
    )
    await assert.rejects(
      () => store.appendConversationEvent({
        conversationId: "conversation-1",
        type: "tool.completed",
        payload: { text: `prefix ${"A".repeat(128)} suffix` },
      }),
      /base64-like/,
    )
  })

  it("persists the same ledger through JSON restart", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-ledger-json-"))
    const store = new YishuStore(dir)
    await exerciseLedger(store)
    const reopened = new YishuStore(dir)
    assert.equal((await reopened.getConversation("conversation-1"))?.id, "conversation-1")
    assert.equal((await reopened.getConversationTurn("request-1"))?.traceId, "trace-1")
    assert.equal(
      (await reopened.getConversationTurn("request-1"))?.userInput,
      "记住我的项目偏好，并且只用于这个项目",
    )
    assert.equal((await reopened.listConversationTurns("conversation-1"))[0]?.traceId, "trace-1")
    assert.equal((await reopened.listConversationEvents("conversation-1")).length, 2)
  })

  it("persists the same ledger through SQLite restart and migration", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-ledger-sqlite-"))
    const dbPath = path.join(dir, "yishu.sqlite")
    const store = new SqliteYishuStore(dbPath)
    await exerciseLedger(store)
    store.close()

    const reopened = new SqliteYishuStore(dbPath)
    assert.equal((await reopened.getConversation("conversation-1"))?.id, "conversation-1")
    assert.equal((await reopened.getConversationTurn("request-1"))?.traceId, "trace-1")
    assert.equal(
      (await reopened.getConversationTurn("request-1"))?.userInput,
      "记住我的项目偏好，并且只用于这个项目",
    )
    assert.equal((await reopened.listConversationTurns("conversation-1"))[0]?.traceId, "trace-1")
    assert.equal((await reopened.listConversationEvents("conversation-1")).length, 2)
    reopened.close()
  })

  it("migrates a real pre-ledger SQLite database without losing evidence", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-ledger-old-sqlite-"))
    const dbPath = path.join(dir, "legacy.sqlite")
    const legacy = new DatabaseSync(dbPath)
    legacy.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        claim TEXT NOT NULL,
        source TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        scope TEXT NOT NULL,
        confidence REAL NOT NULL,
        last_confirmed_at TEXT NOT NULL,
        supersedes TEXT,
        tags_json TEXT NOT NULL,
        retired_at TEXT
      );
      INSERT INTO memories (
        id, claim, source, captured_at, scope, confidence,
        last_confirmed_at, supersedes, tags_json, retired_at
      ) VALUES (
        'legacy-memory', 'old evidence survives', 'system',
        '2026-08-08T00:00:00.000Z', 'global', 0.8,
        '2026-08-08T00:00:00.000Z', NULL, '[]', NULL
      );
      PRAGMA user_version = 0;
    `)
    legacy.close()

    const migrated = new SqliteYishuStore(dbPath)
    const oldMemory = await migrated.searchMemory("old evidence")
    assert.equal(oldMemory.length, 1)
    await migrated.upsertConversation({
      id: "legacy-conversation",
      createdAt: "2026-08-08T00:00:01.000Z",
      updatedAt: "2026-08-08T00:00:01.000Z",
    })
    await migrated.upsertConversationTurn({
      id: "legacy-turn",
      conversationId: "legacy-conversation",
      traceId: "legacy-trace",
      userInput: "继续旧会话",
    })
    await migrated.appendConversationEvent({
      id: "legacy-event",
      conversationId: "legacy-conversation",
      turnId: "legacy-turn",
      type: "turn.started",
      payload: { status: "running" },
    })
    migrated.close()

    const versionCheck = new DatabaseSync(dbPath)
    const versionRow = versionCheck
      .prepare("PRAGMA user_version")
      .get() as { user_version?: number }
    assert.equal(Number(versionRow.user_version), 6)
    const tableNames = versionCheck
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'conversation_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
    assert.deepEqual(
      tableNames.map((row) => row.name),
      ["conversation_events", "conversation_turns", "conversations"],
    )
    versionCheck.close()

    const reopened = new SqliteYishuStore(dbPath)
    assert.equal((await reopened.searchMemory("old evidence")).length, 1)
    assert.equal((await reopened.listConversationEvents("legacy-conversation")).length, 1)
    reopened.close()
  })

  it("loads an old JSON snapshot without ledger arrays", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-ledger-old-json-"))
    await writeFile(
      path.join(dir, "yishu-store.json"),
      JSON.stringify({
        memories: [
          {
            id: "legacy-json-memory",
            claim: "old JSON evidence survives",
            source: "system",
            capturedAt: "2026-08-08T00:00:00.000Z",
            scope: "global",
            confidence: 0.75,
            lastConfirmedAt: "2026-08-08T00:00:00.000Z",
            supersedes: null,
            tags: [],
          },
        ],
        learnings: [],
        skillCandidates: [],
        verifiedSkills: [],
        mandates: [],
        tasks: [],
      }),
      "utf8",
    )

    const store = new YishuStore(dir)
    await store.load()
    assert.equal((await store.searchMemory("old JSON evidence")).length, 1)
    const snapshot = store.getSnapshot()
    assert.deepEqual(snapshot.conversations, [])
    assert.deepEqual(snapshot.turns, [])
    assert.deepEqual(snapshot.events, [])
  })

  it("keeps project conversation scopes immutable and refuses private persistence", async () => {
    const store = new InMemoryYishuStore()
    const projectA = {
      kind: "project" as const,
      projectId: "11111111-1111-4111-8111-111111111111",
      projectLabel: "项目 A",
    }
    const projectB = {
      kind: "project" as const,
      projectId: "22222222-2222-4222-8222-222222222222",
      projectLabel: "项目 B",
    }

    const conversation = await store.upsertConversation({
      id: "scoped-conversation",
      sessionScope: projectA,
    })
    const turn = await store.upsertConversationTurn({
      id: "scoped-turn",
      conversationId: conversation.id,
      status: "open",
    })
    assert.deepEqual(conversation.sessionScope, projectA)
    assert.deepEqual(turn.sessionScope, projectA)

    await assert.rejects(
      () => store.upsertConversation({ id: conversation.id, sessionScope: projectB }),
      /conversation_scope_conflict/,
    )
    await assert.rejects(
      () => store.upsertConversationTurn({
        id: turn.id,
        conversationId: conversation.id,
        sessionScope: projectB,
      }),
      /conversation_turn_scope_conflict/,
    )
    await assert.rejects(
      () => store.upsertConversation({
        id: "private-conversation",
        sessionScope: { kind: "private" },
      }),
      /private_session_not_persistable/,
    )
  })

  it("cancels durable mutations atomically in memory", async () => {
    await exerciseCancelledMutations(new InMemoryYishuStore())
  })

  it("cancels durable mutations atomically across a JSON restart", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-ledger-cancel-json-"))
    const store = new YishuStore(dir)
    await exerciseCancelledMutations(store)
    const reopened = new YishuStore(dir)
    assert.equal((await reopened.searchMemory("cancellation seed")).length, 1)
    assert.equal((await reopened.listLearnings()).length, 0)
    assert.equal((await reopened.listSkillCandidates()).length, 1)
    assert.equal((await reopened.listVerifiedSkills()).length, 0)
  })

  it("cancels durable mutations atomically across a SQLite restart", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-ledger-cancel-sqlite-"))
    const dbPath = path.join(dir, "yishu.sqlite")
    const store = new SqliteYishuStore(dbPath)
    await exerciseCancelledMutations(store)
    store.close()
    const reopened = new SqliteYishuStore(dbPath)
    assert.equal((await reopened.searchMemory("cancellation seed")).length, 1)
    assert.equal((await reopened.listLearnings()).length, 0)
    assert.equal((await reopened.listSkillCandidates()).length, 1)
    assert.equal((await reopened.listVerifiedSkills()).length, 0)
    reopened.close()
  })

  it("cancels a queued JSON mutation before it reaches the disk boundary", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-ledger-cancel-queue-"))
    const store = new YishuStore(dir)
    const now = "2026-08-08T00:11:00.000Z"
    const first = store.addMemory({
      claim: "first mutation",
      source: "system",
      capturedAt: now,
      scope: "global",
      confidence: 0.8,
      lastConfirmedAt: now,
      supersedes: null,
      tags: [],
    })
    const controller = new AbortController()
    const second = store.addLearning(
      { rule: "queued cancellation", scope: "global", confidence: 0.8 },
      { signal: controller.signal },
    )
    controller.abort()
    await first
    await assert.rejects(second, cancelled)
    const reopened = new YishuStore(dir)
    assert.equal((await reopened.searchMemory("first mutation")).length, 1)
    assert.equal((await reopened.listLearnings()).length, 0)
  })

  async function exercisePersonalHistoryList(store: YishuStorePort): Promise<void> {
    const projectId = "11111111-1111-4111-8111-111111111111"
    await store.upsertConversation({
      id: "older-personal",
      createdAt: "2026-08-08T01:00:00.000Z",
      updatedAt: "2026-08-08T01:00:00.000Z",
      sessionScope: { kind: "personal" },
      title: "旧的个人对话",
    })
    await store.upsertConversationTurn({
      id: "older-turn",
      conversationId: "older-personal",
      userInput: "先聊天气",
      assistantOutput: "今天多云。",
      status: "completed",
      sessionScope: { kind: "personal" },
      createdAt: "2026-08-08T01:00:01.000Z",
      updatedAt: "2026-08-08T01:00:02.000Z",
    })
    // Touch conversation updatedAt via a later turn stamp through upsertConversation.
    await store.upsertConversation({
      id: "older-personal",
      updatedAt: "2026-08-08T01:00:02.000Z",
      sessionScope: { kind: "personal" },
    })

    await store.upsertConversation({
      id: "newer-personal",
      createdAt: "2026-08-08T02:00:00.000Z",
      updatedAt: "2026-08-08T02:05:00.000Z",
      sessionScope: { kind: "personal" },
    })
    await store.upsertConversationTurn({
      id: "newer-turn",
      conversationId: "newer-personal",
      userInput: "密码=should-not-leak 帮我总结昨天的工作",
      assistantOutput: "你昨天完成了验收。",
      status: "completed",
      sessionScope: { kind: "personal" },
      createdAt: "2026-08-08T02:00:01.000Z",
      updatedAt: "2026-08-08T02:05:00.000Z",
    })

    await store.upsertConversation({
      id: "project-only",
      createdAt: "2026-08-08T03:00:00.000Z",
      updatedAt: "2026-08-08T03:00:00.000Z",
      sessionScope: { kind: "project", projectId, projectLabel: "侧项目" },
      title: "项目对话",
    })
    await store.upsertConversationTurn({
      id: "project-turn",
      conversationId: "project-only",
      userInput: "只属于项目",
      assistantOutput: "项目内回复",
      status: "completed",
      sessionScope: { kind: "project", projectId, projectLabel: "侧项目" },
    })

    const empty = await store.listConversations({
      sessionScope: { kind: "personal" },
      limit: 10,
    })
    // Filter to the conversations created in this exercise only.
    const personal = empty.filter((item) =>
      item.id === "older-personal" || item.id === "newer-personal",
    )
    assert.equal(personal.length, 2)
    assert.deepEqual(personal.map((item) => item.id), ["newer-personal", "older-personal"])
    assert.equal(personal[0]?.title.includes("密码"), false)
    assert.match(personal[0]?.title ?? "", /总结昨天的工作|帮我总结/)
    assert.ok((personal[0]?.summary.length ?? 0) <= 120)
    assert.ok((personal[0]?.title.length ?? 0) <= 40)
    assert.equal(personal.every((item) => item.sessionScope.kind === "personal"), true)

    const privateList = await store.listConversations({ sessionScope: { kind: "private" } })
    assert.deepEqual(privateList, [])

    const projectList = await store.listConversations({
      sessionScope: { kind: "project", projectId },
    })
    assert.equal(projectList.some((item) => item.id === "project-only"), true)
    assert.equal(projectList.some((item) => item.id === "newer-personal"), false)

    const capped = await store.listConversations({
      sessionScope: { kind: "personal" },
      limit: 1,
    })
    assert.equal(capped.length, 1)
    assert.equal(capped[0]?.id, "newer-personal")

    const overCap = await store.listConversations({
      sessionScope: { kind: "personal" },
      limit: 999,
    })
    assert.ok(overCap.length <= 50)
  }

  it("lists personal history newest-first with caps and scope isolation (memory)", async () => {
    await exercisePersonalHistoryList(new InMemoryYishuStore())
  })

  it("lists personal history newest-first with caps and scope isolation (sqlite)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-history-sqlite-"))
    const store = new SqliteYishuStore(path.join(dir, "yishu.sqlite"))
    await exercisePersonalHistoryList(store)
    store.close()
  })

  async function exerciseArchiveConversation(store: {
    upsertConversation: (input: {
      id: string
      sessionScope: { kind: "personal" } | { kind: "project"; projectId: string; projectLabel: string }
      title?: string
    }) => Promise<{ id: string; status: string }>
    upsertConversationTurn: (input: {
      id: string
      conversationId: string
      userInput?: string
      assistantOutput?: string
      status?: "completed"
      sessionScope: { kind: "personal" }
    }) => Promise<unknown>
    archiveConversation: (
      id: string,
      options?: { expectedScope?: { kind: "personal" } },
    ) => Promise<{ id: string; status: string } | null>
    listConversations: (options?: {
      sessionScope?: { kind: "personal" }
      includeArchived?: boolean
    }) => Promise<Array<{ id: string; status: string }>>
    getConversation: (id: string) => Promise<{ id: string; status: string } | null>
    listConversationTurns: (id: string) => Promise<unknown[]>
    close?: () => void
  }) {
    const activeId = "active-personal"
    const archivedId = "to-archive-personal"
    await store.upsertConversation({
      id: activeId,
      sessionScope: { kind: "personal" },
      title: "仍可见",
    })
    await store.upsertConversation({
      id: archivedId,
      sessionScope: { kind: "personal" },
      title: "将被归档",
    })
    await store.upsertConversationTurn({
      id: "arch-turn",
      conversationId: archivedId,
      userInput: "归档前可见",
      assistantOutput: "归档后仍在库里",
      status: "completed",
      sessionScope: { kind: "personal" },
    })

    const archived = await store.archiveConversation(archivedId, {
      expectedScope: { kind: "personal" },
    })
    assert.equal(archived?.status, "archived")
    assert.equal((await store.getConversation(archivedId))?.status, "archived")
    assert.equal((await store.listConversationTurns(archivedId)).length, 1)

    const listed = await store.listConversations({ sessionScope: { kind: "personal" } })
    assert.equal(listed.some((row) => row.id === archivedId), false)
    assert.equal(listed.some((row) => row.id === activeId), true)

    const withArchived = await store.listConversations({
      sessionScope: { kind: "personal" },
      includeArchived: true,
    })
    assert.equal(withArchived.some((row) => row.id === archivedId), true)

    // Idempotent
    const again = await store.archiveConversation(archivedId, {
      expectedScope: { kind: "personal" },
    })
    assert.equal(again?.status, "archived")
  }

  it("archives conversation as recoverable soft-delete (memory)", async () => {
    await exerciseArchiveConversation(new InMemoryYishuStore())
  })

  it("archives conversation as recoverable soft-delete (sqlite)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-archive-sqlite-"))
    const store = new SqliteYishuStore(path.join(dir, "yishu.sqlite"))
    await exerciseArchiveConversation(store)
    store.close()
  })

  it("resolves conversation ids case-insensitively for Swift UUID wire form", async () => {
    const store = new InMemoryYishuStore()
    const lower = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    await store.upsertConversation({
      id: lower,
      sessionScope: { kind: "personal" },
      title: "大小写",
    })
    await store.upsertConversationTurn({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      conversationId: lower,
      userInput: "hello",
      assistantOutput: "world",
      status: "completed",
      sessionScope: { kind: "personal" },
    })
    const upper = lower.toUpperCase()
    assert.equal((await store.getConversation(upper))?.id, lower)
    assert.equal((await store.listConversationTurns(upper)).length, 1)
  })
})
