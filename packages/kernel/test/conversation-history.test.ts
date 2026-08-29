import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createConversationLedger,
  createYishuKernel,
  InMemoryYishuStore,
  SqliteYishuStore,
  type ConversationLedger,
  type YishuStorePort,
} from "../src/index.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_SCOPE = {
  kind: "project" as const,
  projectId: PROJECT_ID,
  projectLabel: "侧项目",
};

async function exerciseConversationLedger(store: YishuStorePort): Promise<void> {
  const ledger = createConversationLedger(store);

  await store.upsertConversation({
    id: "personal-active",
    createdAt: "2026-08-08T01:00:00.000Z",
    updatedAt: "2026-08-08T01:10:00.000Z",
    sessionScope: { kind: "personal" },
  });
  await store.upsertConversationTurn({
    id: "personal-turn",
    conversationId: "personal-active",
    userInput: "密码=should-not-leak 帮我总结昨天的工作",
    assistantOutput: "你昨天完成了验收。",
    status: "completed",
    sessionScope: { kind: "personal" },
    createdAt: "2026-08-08T01:00:01.000Z",
    updatedAt: "2026-08-08T01:10:00.000Z",
  });

  await store.upsertConversation({
    id: "personal-archived",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:10:00.000Z",
    sessionScope: { kind: "personal" },
    title: "已归档",
  });
  await store.upsertConversationTurn({
    id: "archived-turn",
    conversationId: "personal-archived",
    userInput: "旧内容",
    assistantOutput: "旧回复",
    status: "completed",
    sessionScope: { kind: "personal" },
  });
  await store.archiveConversation("personal-archived", {
    expectedScope: { kind: "personal" },
  });

  await store.upsertConversation({
    id: "project-only",
    createdAt: "2026-08-08T02:00:00.000Z",
    updatedAt: "2026-08-08T02:00:00.000Z",
    sessionScope: PROJECT_SCOPE,
    title: "项目对话",
  });
  await store.upsertConversationTurn({
    id: "project-turn",
    conversationId: "project-only",
    userInput: "只属于项目",
    assistantOutput: "项目内回复",
    status: "completed",
    sessionScope: PROJECT_SCOPE,
  });

  await store.upsertConversation({
    id: "capped-personal",
    createdAt: "2026-08-08T03:00:00.000Z",
    updatedAt: "2026-08-08T03:30:00.000Z",
    sessionScope: { kind: "personal" },
    title: "长对话",
  });
  await store.upsertConversationTurn({
    id: "empty-turn",
    conversationId: "capped-personal",
    status: "open",
    sessionScope: { kind: "personal" },
  });
  for (let index = 0; index < 25; index += 1) {
    await store.upsertConversationTurn({
      id: `capped-turn-${index}`,
      conversationId: "capped-personal",
      userInput: `用户句 ${index}`,
      assistantOutput: `回复 ${index}`,
      status: "completed",
      sessionScope: { kind: "personal" },
    });
  }
  for (let index = 0; index < 5; index += 1) {
    await store.upsertConversationTurn({
      id: `capped-failed-${index}`,
      conversationId: "capped-personal",
      userInput: `失败轮 ${index}`,
      status: "failed",
      sessionScope: { kind: "personal" },
    });
  }

  const privateList = await ledger.list({ sessionScope: { kind: "private" } });
  assert.deepEqual(privateList, []);

  const personal = await ledger.list({ sessionScope: { kind: "personal" } });
  assert.equal(personal.some((item) => item.id === "project-only"), false);
  assert.equal(personal.some((item) => item.id === "personal-archived"), false);
  const activeRow = personal.find((item) => item.id === "personal-active");
  assert.ok(activeRow);
  assert.equal(activeRow?.title.includes("密码"), false);
  assert.match(activeRow?.title ?? "", /redacted|总结昨天的工作/);

  const limited = await ledger.list({ sessionScope: { kind: "personal" }, limit: 1 });
  assert.equal(limited.length, 1);

  const projectList = await ledger.list({ sessionScope: PROJECT_SCOPE });
  assert.equal(projectList.some((item) => item.id === "project-only"), true);
  assert.equal(projectList.some((item) => item.id === "personal-active"), false);

  assert.deepEqual(
    await ledger.open({
      conversationId: "personal-active",
      expectedScope: { kind: "private" },
    }),
    { ok: false, reason: "private" },
  );
  assert.deepEqual(
    await ledger.open({
      conversationId: "missing",
      expectedScope: { kind: "personal" },
    }),
    { ok: false, reason: "not_found" },
  );
  assert.deepEqual(
    await ledger.open({
      conversationId: "project-only",
      expectedScope: { kind: "personal" },
    }),
    { ok: false, reason: "scope_mismatch" },
  );
  assert.deepEqual(
    await ledger.open({
      conversationId: "personal-archived",
      expectedScope: { kind: "personal" },
    }),
    { ok: false, reason: "archived" },
  );

  const opened = await ledger.open({
    conversationId: "personal-active",
    expectedScope: { kind: "personal" },
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(opened.conversation.id, "personal-active");
  assert.equal(opened.turns.length, 1);
  assert.equal(opened.turns[0]?.userInput?.includes("密码"), false);
  assert.match(opened.turns[0]?.userInput ?? "", /\[redacted\]|总结昨天的工作/);
  assert.equal("events" in opened, false);
  assert.equal("traceId" in opened.turns[0]!, false);
  assert.equal("conversationId" in opened.turns[0]!, false);
  assert.equal("sessionScope" in opened.turns[0]!, false);

  const capped = await ledger.open({
    conversationId: "capped-personal",
    expectedScope: { kind: "personal" },
    completedOnly: true,
  });
  assert.equal(capped.ok, true);
  if (!capped.ok) return;
  assert.equal(capped.turns.length, 20);
  assert.equal(capped.turns[0]?.userInput, "用户句 5");
  assert.equal(capped.turns[19]?.userInput, "用户句 24");
  assert.equal(capped.turns.every((turn) => turn.status === "completed"), true);
  assert.equal(capped.turns.some((turn) => turn.id === "empty-turn"), false);

  assert.deepEqual(
    await ledger.archivePersonal({
      conversationId: "personal-active",
      expectedScope: { kind: "private" },
    }),
    { ok: false, reason: "private" },
  );
  assert.equal((await store.getConversation("personal-active"))?.status, "active");

  assert.deepEqual(
    await ledger.archivePersonal({
      conversationId: "personal-active",
      expectedScope: PROJECT_SCOPE,
    }),
    { ok: false, reason: "scope_not_supported" },
  );
  assert.equal((await store.getConversation("personal-active"))?.status, "active");

  assert.deepEqual(
    await ledger.archivePersonal({
      conversationId: "missing",
      expectedScope: { kind: "personal" },
    }),
    { ok: false, reason: "not_found" },
  );
  assert.deepEqual(
    await ledger.archivePersonal({
      conversationId: "project-only",
      expectedScope: { kind: "personal" },
    }),
    { ok: false, reason: "scope_mismatch" },
  );
  assert.equal((await store.getConversation("project-only"))?.status, "active");

  const archived = await ledger.archivePersonal({
    conversationId: "personal-active",
    expectedScope: { kind: "personal" },
  });
  assert.deepEqual(
    {
      ok: archived.ok,
      ...(archived.ok
        ? {
            conversationId: archived.conversationId,
            status: archived.status,
            alreadyArchived: archived.alreadyArchived,
            sessionKind: archived.sessionScope.kind,
          }
        : {}),
    },
    {
      ok: true,
      conversationId: "personal-active",
      status: "archived",
      alreadyArchived: false,
      sessionKind: "personal",
    },
  );

  const again = await ledger.archivePersonal({
    conversationId: "personal-active",
    expectedScope: { kind: "personal" },
  });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.alreadyArchived, true);
  assert.equal(again.status, "archived");

  const afterArchive = await ledger.list({ sessionScope: { kind: "personal" } });
  assert.equal(afterArchive.some((item) => item.id === "personal-active"), false);
  assert.equal((await store.listConversationTurns("personal-active")).length, 1);
}

describe("ConversationLedger", () => {
  it("enforces history policy on the memory backend", async () => {
    await exerciseConversationLedger(new InMemoryYishuStore());
  });

  it("enforces history policy on the sqlite backend", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yishu-conversation-ledger-"));
    const store = new SqliteYishuStore(path.join(dir, "yishu.sqlite"));
    try {
      await exerciseConversationLedger(store);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is exposed on createYishuKernel", async () => {
    const kernel = createYishuKernel({ storeBackend: "memory" });
    const listed = await kernel.conversations.list({
      sessionScope: { kind: "personal" },
    });
    assert.deepEqual(listed, []);
    const conversations: ConversationLedger = kernel.conversations;
    assert.equal(typeof conversations.open, "function");
    assert.equal(typeof conversations.archivePersonal, "function");
  });
});
