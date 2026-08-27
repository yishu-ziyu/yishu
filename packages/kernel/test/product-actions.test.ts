import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { clearAuditLog } from "../src/action/index.js";
import { createYishuKernel } from "../src/kernel.js";
import type { RememberHowResult } from "../src/actions/remember-how.js";
import type { ShareContextResult } from "../src/actions/share-context.js";
import type { MemoryClaim } from "../src/store/types.js";
import { makeFrame } from "./fixtures.js";

const PERSONAL = { kind: "personal" } as const;

describe("product actions via createYishuKernel", () => {
  beforeEach(() => {
    clearAuditLog();
  });

  it("remember stores evidence memory and verifies", async () => {
    const { registry } = createYishuKernel();
    const receipt = await registry.invoke("remember", {
      caller: "voice",
      input: {
        claim: "用户在这个项目中偏好 React",
        scope: "project:yishu",
        confidence: 0.91,
      },
    });
    assert.equal(receipt.status, "verified");
    const memory = receipt.output as MemoryClaim;
    assert.equal(memory.claim, "用户在这个项目中偏好 React");
    assert.equal(memory.source, "conversation");
    assert.ok(memory.capturedAt);
    assert.equal(memory.confidence, 0.91);
  });

  it("empty or whitespace remember does not persist; personal note is listable", async () => {
    const { registry, store } = createYishuKernel();
    const empty = await registry.invoke("remember", {
      caller: "ui",
      input: { claim: "   ", scope: "personal" },
    });
    assert.equal(empty.status, "failed");
    assert.equal((await store.listMemories({ scope: "personal" })).length, 0);

    const saved = await registry.invoke("remember", {
      caller: "ui",
      input: { claim: "周四把钥匙放在抽屉第二格", scope: "personal" },
    });
    assert.equal(saved.status, "verified");
    const listed = await store.listMemories({ scope: "personal" });
    assert.equal(listed.length, 1);
    assert.match(listed[0]?.summary ?? "", /钥匙放在抽屉/);
  });

  it("does not persist a memory when its store mutation is cancelled", async () => {
    const { registry, store } = createYishuKernel();
    const controller = new AbortController();
    const originalAddMemory = store.addMemory.bind(store);
    store.addMemory = async (input, options) => {
      controller.abort("private claim cancellation");
      return originalAddMemory(input, options);
    };

    const receipt = await registry.invoke("remember", {
      caller: "voice",
      input: { claim: "cancelled memory must not persist" },
      signal: controller.signal,
    });

    assert.equal(receipt.status, "cancelled");
    assert.equal(
      (await store.searchMemory("cancelled memory must not persist")).length,
      0,
    );
  });

  it("reports memory cancellation after the store commit", async () => {
    const { registry, store } = createYishuKernel();
    const controller = new AbortController();
    const originalAddMemory = store.addMemory.bind(store);
    store.addMemory = async (input, options) => {
      const memory = await originalAddMemory(input, options);
      controller.abort("private post-commit cancellation");
      return memory;
    };

    const receipt = await registry.invoke("remember", {
      caller: "voice",
      input: { claim: "committed memory remains durable" },
      signal: controller.signal,
    });

    assert.equal(receipt.status, "cancelled_after_commit");
    assert.equal(
      (await store.searchMemory("committed memory remains durable")).length,
      1,
    );
  });

  it("forget retires a memory", async () => {
    const { registry } = createYishuKernel();
    const remembered = await registry.invoke("remember", {
      caller: "ui",
      input: { claim: "temp note" },
    });
    const id = (remembered.output as MemoryClaim).id;

    const forgot = await registry.invoke("forget", {
      caller: "ui",
      input: { memoryId: id },
    });
    assert.equal(forgot.status, "verified");
  });

  it("does not retire a memory when its store mutation is cancelled", async () => {
    const { registry, store } = createYishuKernel();
    const remembered = await registry.invoke("remember", {
      caller: "ui",
      input: { claim: "keep this memory active" },
    });
    const memoryId = (remembered.output as MemoryClaim).id;
    const controller = new AbortController();
    const originalRetireMemory = store.retireMemory.bind(store);
    store.retireMemory = async (id, options) => {
      controller.abort("private forget cancellation");
      return originalRetireMemory(id, options);
    };

    const forgot = await registry.invoke("forget", {
      caller: "ui",
      input: { memoryId },
      signal: controller.signal,
    });

    assert.equal(forgot.status, "cancelled");
    assert.equal(
      store.getSnapshot().memories.find((memory) => memory.id === memoryId)
        ?.retiredAt,
      undefined,
    );
  });

  it("reports forget cancellation after the retirement commit", async () => {
    const { registry, store } = createYishuKernel();
    const remembered = await registry.invoke("remember", {
      caller: "ui",
      input: { claim: "retire then cancel" },
    });
    const memoryId = (remembered.output as MemoryClaim).id;
    const controller = new AbortController();
    const originalRetireMemory = store.retireMemory.bind(store);
    store.retireMemory = async (id, options) => {
      const ok = await originalRetireMemory(id, options);
      controller.abort("private post-commit forget cancellation");
      return ok;
    };

    const receipt = await registry.invoke("forget", {
      caller: "ui",
      input: { memoryId },
      signal: controller.signal,
    });

    assert.equal(receipt.status, "cancelled_after_commit");
    assert.ok(
      store.getSnapshot().memories.find((memory) => memory.id === memoryId)
        ?.retiredAt,
    );
  });

  it("remember_how extracts skill from trail (the product-shaped capability)", async () => {
    const { registry, trail, store } = createYishuKernel();
    const t0 = Date.parse("2026-08-07T12:40:00.000Z");
    trail.append(
      makeFrame({
        capturedAt: new Date(t0).toISOString(),
        appName: "Chrome",
        windowTitle: "github.com/yishu-ziyu/yishu",
      }),
      PERSONAL,
      new Date(t0),
    );
    trail.append(
      makeFrame({
        capturedAt: new Date(t0 + 30_000).toISOString(),
        appName: "Chrome",
        windowTitle: "Switch branch",
      }),
      PERSONAL,
      new Date(t0 + 30_000),
    );
    trail.append(
      makeFrame({
        capturedAt: new Date(t0 + 60_000).toISOString(),
        appName: "Codex",
        windowTitle: "yishu session",
      }),
      PERSONAL,
      new Date(t0 + 60_000),
    );

    const receipt = await registry.invoke("remember_how", {
      caller: "voice",
      input: {
        minutes: 5,
        triggerPhrase: "把这个仓库交给 Codex",
        name: "hand_repo_to_codex",
        autoVerify: true,
        verifyThreshold: 0.55,
      },
      sessionScope: PERSONAL,
      now: new Date(t0 + 90_000),
    });

    assert.ok(
      receipt.status === "verified" || receipt.status === "ok",
      receipt.message,
    );
    const result = receipt.output as RememberHowResult;
    assert.equal(result.candidate.name, "hand_repo_to_codex");
    assert.ok(result.entryCount >= 3);
    assert.ok(result.candidate.steps.length >= 2);
    assert.ok(result.verifyReport);
    assert.equal(result.skill, null, "autoVerify must not promote a verified skill");
    assert.equal((await store.listVerifiedSkills()).length, 0);
  });

  it("does not persist remember_how when its skill mutation is cancelled", async () => {
    const { registry, trail, store } = createYishuKernel();
    const now = new Date("2026-08-07T12:40:00.000Z");
    trail.append(makeFrame({ capturedAt: now.toISOString() }), PERSONAL, now);
    const controller = new AbortController();
    const originalAddSkill = store.addSkillCandidate.bind(store);
    store.addSkillCandidate = async (input, options) => {
      controller.abort("private skill cancellation");
      return originalAddSkill(input, options);
    };

    const receipt = await registry.invoke("remember_how", {
      caller: "voice",
      input: { minutes: 5, autoVerify: false },
      sessionScope: PERSONAL,
      signal: controller.signal,
      now,
    });

    assert.equal(receipt.status, "cancelled");
    assert.equal((await store.listSkillCandidates()).length, 0);
  });

  it("reports remember_how cancellation after the candidate commit", async () => {
    const { registry, trail, store } = createYishuKernel();
    const now = new Date("2026-08-07T12:40:00.000Z");
    trail.append(makeFrame({ capturedAt: now.toISOString() }), PERSONAL, now);
    const controller = new AbortController();
    const originalAddSkill = store.addSkillCandidate.bind(store);
    store.addSkillCandidate = async (input, options) => {
      const candidate = await originalAddSkill(input, options);
      controller.abort("private post-commit skill cancellation");
      return candidate;
    };

    const receipt = await registry.invoke("remember_how", {
      caller: "voice",
      input: { minutes: 5, autoVerify: false },
      sessionScope: PERSONAL,
      signal: controller.signal,
      now,
    });

    assert.equal(receipt.status, "cancelled_after_commit");
    assert.equal((await store.listSkillCandidates()).length, 1);
  });

  it("share_context builds a capsule for multi-agent handoff", async () => {
    const { registry, trail } = createYishuKernel();
    const now = new Date("2026-08-07T13:00:00.000Z");
    const frame = makeFrame({
      capturedAt: now.toISOString(),
      appName: "Chrome",
      withScreenshot: true,
    });
    trail.append(frame, PERSONAL, now);

    const receipt = await registry.invoke(
      "share_context",
      {
        caller: "cli",
        input: {
          userIntent: "把我现在看到的东西交给 Codex",
          projectHint: "project:yishu",
        },
        contextFrame: frame,
        sessionScope: PERSONAL,
        now,
      },
    );

    assert.equal(receipt.status, "verified");
    const result = receipt.output as ShareContextResult;
    assert.equal(result.capsule.schemaVersion, 1);
    assert.equal(result.capsule.userIntent, "把我现在看到的东西交给 Codex");
    assert.equal(result.json.includes("base64Data"), false);
  });

  it("record_learning stores a user correction rule", async () => {
    const { registry, store } = createYishuKernel();
    const receipt = await registry.invoke("record_learning", {
      caller: "voice",
      input: {
        rule: "不要在可逆操作上反复打断我",
        scope: "global",
      },
    });
    assert.equal(receipt.status, "ok");
    const list = await store.listLearnings();
    assert.equal(list.length, 1);
    assert.match(list[0]!.rule, /可逆/);
  });

  it("does not persist a learning when its store mutation is cancelled", async () => {
    const { registry, store } = createYishuKernel();
    const controller = new AbortController();
    const originalAddLearning = store.addLearning.bind(store);
    store.addLearning = async (input, options) => {
      controller.abort("private learning cancellation");
      return originalAddLearning(input, options);
    };

    const receipt = await registry.invoke("record_learning", {
      caller: "voice",
      input: { rule: "cancelled learning must not persist" },
      signal: controller.signal,
    });

    assert.equal(receipt.status, "cancelled");
    assert.equal(
      (await store.listLearnings()).some((item) =>
        item.rule.includes("cancelled learning must not persist"),
      ),
      false,
    );
  });

  it("reports learning cancellation after the store commit", async () => {
    const { registry, store } = createYishuKernel();
    const controller = new AbortController();
    const originalAddLearning = store.addLearning.bind(store);
    store.addLearning = async (input, options) => {
      const learning = await originalAddLearning(input, options);
      controller.abort("private post-commit learning cancellation");
      return learning;
    };

    const receipt = await registry.invoke("record_learning", {
      caller: "voice",
      input: { rule: "committed learning remains durable" },
      signal: controller.signal,
    });

    assert.equal(receipt.status, "cancelled_after_commit");
    assert.equal((await store.listLearnings()).length, 1);
  });

  it("registers the default product actions including Notes, system reminders, Finder Back and delegate", () => {
    const { defaultActionNames } = createYishuKernel();
    assert.deepEqual(
      [...defaultActionNames].sort(),
      [
        "browser",
        "delegate",
        "create_note",
        "finder_history_back",
        "forget",
        "learn_mind_from_pattern",
        "record_learning",
        "record_suggestion",
        "remember",
        "remember_how",
        "run_skill",
        "schedule_time_reminder",
        "settle_suggestion",
        "share_context",
        "watch_app_return",
      ].sort(),
    );
  });

  it("run_skill falls back to capsule when no verified skill", async () => {
    const { registry, trail } = createYishuKernel();
    const now = new Date();
    trail.append(makeFrame({ capturedAt: now.toISOString() }), PERSONAL, now);
    const receipt = await registry.invoke("run_skill", {
      caller: "voice",
      input: {
        phrase: "这个交给 Codex",
        fallbackShareContext: true,
      },
      contextFrame: makeFrame({ capturedAt: now.toISOString() }),
      sessionScope: PERSONAL,
      now,
    });
    assert.equal(receipt.status, "verified");
    const out = receipt.output as { mode: string; capsuleReady: boolean };
    assert.equal(out.mode, "capsule_fallback");
    assert.equal(out.capsuleReady, true);
  });
});
