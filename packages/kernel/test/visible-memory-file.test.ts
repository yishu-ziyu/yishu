import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createYishuKernel } from "../src/kernel.js";
import {
  VISIBLE_MEMORY_HEADER,
  VisibleMemoryFile,
  factsSemanticallyMatch,
  hydrateVisibleMemoryIfNew,
  isVisibleFactSuppressed,
  mergeVisibleMemoryEdit,
  parseVisibleFacts,
  recallFromVisibleFacts,
  readLegacyFactClaims,
} from "../src/memory/index.js";
import { runExtractionPass, type MemoryExtractionModel } from "../src/memory/index.js";
import { InMemoryExtractionQueue } from "../src/memory/index.js";

const PROJECT_SCOPE = "project:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function tempVisible(prefix: string): Promise<{ file: VisibleMemoryFile; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return { dir, file: new VisibleMemoryFile(path.join(dir, "记忆.md")) };
}

test("append writes bullets and does not rewrite a user-edited line", async (t) => {
  const { dir, file } = await tempVisible("yishu-vis-");
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.equal(await file.appendFacts(["喜欢要点列表", "喜欢要点列表"]), 1);
  const first = await file.readText();
  assert.match(first, /^# 记忆/m);
  assert.match(first, /^- 喜欢要点列表$/m);
  assert.equal(parseVisibleFacts(first).length, 1);

  const edited = first.replace("- 喜欢要点列表", "- 喜欢编号列表");
  await writeFile(file.filePath, edited, "utf8");

  assert.equal(await file.appendFacts(["喜欢要点列表", "周末去优胜美地"]), 2);
  const after = await file.readText();
  assert.match(after, /^- 喜欢编号列表$/m);
  assert.match(after, /^- 喜欢要点列表$/m);
  assert.match(after, /^- 周末去优胜美地$/m);
  assert.doesNotMatch(after, /喜欢编号列表.*喜欢编号列表/s);
});

test("user-deleted line is not resurrected by a different new fact", async (t) => {
  const { dir, file } = await tempVisible("yishu-vis-del-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await file.appendFacts(["邮箱是 a@b.com", "喜欢爬山"]);
  const current = await file.readText();
  await writeFile(file.filePath, current.replace("- 邮箱是 a@b.com\n", ""), "utf8");
  assert.equal(await file.appendFacts(["喜欢游泳"]), 1);
  const after = await file.readText();
  assert.doesNotMatch(after, /邮箱是/);
  assert.match(after, /喜欢爬山/);
  assert.match(after, /喜欢游泳/);
});

test("a deleted visible fact suppresses the same derived memory until the user re-adds it", async (t) => {
  const { dir, file } = await tempVisible("yishu-vis-authority-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await file.appendFacts(["用户现居深圳"]);
  await file.reconcileAuthority();

  await writeFile(file.filePath, VISIBLE_MEMORY_HEADER, "utf8");
  const deleted = await file.reconcileAuthority();
  assert.equal(isVisibleFactSuppressed(deleted, "用户现居深圳"), true);

  await writeFile(file.filePath, `${VISIBLE_MEMORY_HEADER}- 用户现居深圳\n`, "utf8");
  const restored = await file.reconcileAuthority();
  assert.equal(isVisibleFactSuppressed(restored, "用户现居深圳"), false);
});

test("a corrupt authority ledger fails closed instead of clearing suppressions", async (t) => {
  const { dir, file } = await tempVisible("yishu-vis-authority-corrupt-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await file.appendFacts(["用户现居深圳"]);
  await writeFile(file.authorityFilePath, "not-json", "utf8");
  await assert.rejects(file.reconcileAuthority(), /visible_memory_authority_invalid/);
});

test("recall reads user-authored bullets and ignores the header", async (t) => {
  const { dir, file } = await tempVisible("yishu-vis-recall-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    file.filePath,
    `${VISIBLE_MEMORY_HEADER}- 验收回答先给结论\n- 周末去优胜美地攀岩\n`,
    "utf8",
  );
  const hits = recallFromVisibleFacts(await file.listFacts(), "我希望你怎么回答？", {
    scope: "personal",
  });
  assert.equal(hits.length, 1);
  assert.match(hits[0]?.claim ?? "", /验收回答先给结论/);
});

test("hydrate copies leftover facts only when the visible file is new", async (t) => {
  const { dir, file } = await tempVisible("yishu-vis-seed-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const leftover = path.join(dir, "preferences.md");
  await writeFile(
    leftover,
    "# Preferences\n\n- [mem:fx-1|2026-08-16|extraction] 用户的邮箱是 a@b.com。\n",
    "utf8",
  );
  const claims = await readLegacyFactClaims(leftover);
  assert.deepEqual(claims, ["用户的邮箱是 a@b.com。"]);
  assert.equal(await hydrateVisibleMemoryIfNew(file, claims), 1);
  assert.equal(await hydrateVisibleMemoryIfNew(file, ["另一条不该写进去"]), 0);
  const text = await file.readText();
  assert.match(text, /用户的邮箱是 a@b.com/);
  assert.doesNotMatch(text, /另一条不该写进去/);
});

test("remember and extract write the visible file; forget removes the bullet", async (t) => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "yishu-vis-kernel-"));
  t.after(() => rm(memoryDir, { recursive: true, force: true }));
  const kernel = createYishuKernel({ storeBackend: "memory", memoryDir });
  const visible = kernel.memory?.visible;
  assert.ok(visible);

  const remembered = await kernel.registry.invoke("remember", {
    caller: "voice",
    input: { claim: "周四把钥匙放在抽屉", scope: "personal" },
  });
  assert.equal(remembered.status, "verified");
  assert.match(await visible.readText(), /周四把钥匙放在抽屉/);

  const queue = new InMemoryExtractionQueue();
  await queue.enqueue({
    turnId: "11111111-1111-1111-1111-111111111111",
    conversationId: "conv-1",
    scopeKey: "personal",
    utterance: "我以后都用要点列表回答我。",
    replyText: "好的。",
    providerId: "openai",
    modelId: "gpt-test",
    capturedAt: "2026-08-18T10:00:00.000Z",
  });
  const model: MemoryExtractionModel = {
    async extract() {
      return { newFacts: ["用户偏好要点列表"], confirmedFactIds: [] };
    },
  };
  await runExtractionPass({
    queue,
    truth: kernel.memory!.truth,
    store: kernel.memory!.extraction,
    model,
    visible,
  });
  assert.match(await visible.readText(), /用户偏好要点列表/);

  const id = (remembered.output as { id: string }).id;
  const forgotten = await kernel.registry.invoke("forget", {
    caller: "voice",
    input: { memoryId: id },
  });
  assert.equal(forgotten.status, "verified");
  assert.doesNotMatch(await visible.readText(), /周四把钥匙放在抽屉/);
  assert.match(await visible.readText(), /用户偏好要点列表/);
});

test("the single visible file keeps project-scoped memories out", async (t) => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "yishu-vis-scope-"));
  t.after(() => rm(memoryDir, { recursive: true, force: true }));
  const kernel = createYishuKernel({ storeBackend: "memory", memoryDir });
  const visible = kernel.memory?.visible;
  assert.ok(visible);

  const projectRemembered = await kernel.registry.invoke("remember", {
    caller: "voice",
    input: { claim: "项目记忆不应进入个人可见文件", scope: PROJECT_SCOPE },
  });
  assert.equal(projectRemembered.status, "verified");

  const queue = new InMemoryExtractionQueue();
  await queue.enqueue({
    turnId: "22222222-2222-2222-2222-222222222222",
    conversationId: "project-conversation",
    scopeKey: PROJECT_SCOPE,
    utterance: "项目偏好也不应投影",
    replyText: "收到。",
    providerId: "openai",
    modelId: "gpt-test",
    capturedAt: "2026-08-18T11:00:00.000Z",
  });
  const model: MemoryExtractionModel = {
    async extract() {
      return { newFacts: ["项目抽取记忆不应进入个人可见文件"], confirmedFactIds: [] };
    },
  };
  await runExtractionPass({
    queue,
    truth: kernel.memory!.truth,
    store: kernel.memory!.extraction,
    model,
    visible,
  });

  const personalRemembered = await kernel.registry.invoke("remember", {
    caller: "voice",
    input: { claim: "个人记忆仍可进入可见文件", scope: "personal" },
  });
  assert.equal(personalRemembered.status, "verified");

  const text = await visible.readText();
  assert.doesNotMatch(text, /项目记忆不应进入个人可见文件/u);
  assert.doesNotMatch(text, /项目抽取记忆不应进入个人可见文件/u);
  assert.match(text, /个人记忆仍可进入可见文件/u);
});

test("deleted visible facts suppress semantically similar restatements, not unrelated ones", async (t) => {
  const { dir, file } = await tempVisible("yishu-vis-semantic-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await file.appendFacts(["用户现居深圳", "用户喜欢无糖咖啡"]);
  await writeFile(file.filePath, `${VISIBLE_MEMORY_HEADER}- 用户喜欢无糖咖啡\n`, "utf8");
  const deleted = await file.reconcileAuthority();

  assert.equal(isVisibleFactSuppressed(deleted, "用户现居深圳"), true);
  assert.equal(isVisibleFactSuppressed(deleted, "我住在深圳市"), true);
  assert.equal(isVisibleFactSuppressed(deleted, "现居深圳"), true);
  assert.equal(isVisibleFactSuppressed(deleted, "用户喜欢无糖咖啡"), false);
  assert.equal(factsSemanticallyMatch("喜欢无糖咖啡", "用户爱喝无糖咖啡"), true);
  assert.equal(factsSemanticallyMatch("用户现居深圳", "深圳天气怎么样今天出门"), false);
  const ledger = await readFile(file.authorityFilePath, "utf8");
  assert.doesNotMatch(ledger, /用户现居深圳/);
});

test("re-adding a deleted bullet clears its semantic suppression", async (t) => {
  const { dir, file } = await tempVisible("yishu-vis-semantic-restore-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await file.appendFacts(["用户现居深圳"]);
  await writeFile(file.filePath, VISIBLE_MEMORY_HEADER, "utf8");
  const deleted = await file.reconcileAuthority();
  assert.equal(isVisibleFactSuppressed(deleted, "我住在深圳市"), true);

  await writeFile(file.filePath, `${VISIBLE_MEMORY_HEADER}- 用户现居深圳\n`, "utf8");
  const restored = await file.reconcileAuthority();
  assert.equal(isVisibleFactSuppressed(restored, "我住在深圳市"), false);
});

test("a stale user edit keeps agent-appended bullets and honors user deletions", () => {
  const header = VISIBLE_MEMORY_HEADER;
  const baseText = `${header}- 邮箱是 a@b.com\n- 喜欢爬山\n`;
  const currentText = `${header}- 邮箱是 a@b.com\n- 喜欢爬山\n- 周四把钥匙放在抽屉\n`;
  const nextText = `${header}- 喜欢爬山\n`;
  const merged = mergeVisibleMemoryEdit({ baseText, currentText, nextText });
  assert.match(merged, /喜欢爬山/);
  assert.match(merged, /周四把钥匙放在抽屉/);
  assert.doesNotMatch(merged, /邮箱是/);
});

test("an unconflicted user save keeps the exact next text", () => {
  const baseText = "- 邮箱是 a@b.com\n";
  assert.equal(
    mergeVisibleMemoryEdit({
      baseText,
      currentText: baseText,
      nextText: "- 喜欢编号列表\n",
    }),
    "- 喜欢编号列表\n",
  );
});
