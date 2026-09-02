import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatProductActionSpeech,
  looksLikeRelativeTimeReminder,
  classifyRelativeTimeReminder,
  routeProductUtterance,
} from "../src/utterance-router.js";

describe("routeProductUtterance", () => {
  it("routes a natural request to open the user's email", () => {
    assert.deepEqual(routeProductUtterance("帮我打开邮箱"), {
      action: "open_email",
      input: {},
      confidence: 0.99,
    });
    assert.equal(routeProductUtterance("打开我的邮箱")?.action, "open_email");
    assert.equal(routeProductUtterance("你能帮我打开邮箱吗？"), null);
    assert.equal(routeProductUtterance("不要打开邮箱"), null);
  });

  it("routes remember_how phrases", () => {
    const r = routeProductUtterance("记住我刚才是怎么做的");
    assert.equal(r?.action, "remember_how");
    assert.equal(r?.input.autoVerify, true);

    assert.equal(
      routeProductUtterance("记住刚才这个流程")?.action,
      "remember_how",
    );
    assert.equal(
      routeProductUtterance("Remember how I just did that")?.action,
      "remember_how",
    );
  });

  it("routes handoff / codex phrases to run_skill", () => {
    const r = routeProductUtterance("这个交给 Codex");
    assert.equal(r?.action, "run_skill");
    assert.equal(r?.input.fallbackShareContext, true);
  });

  it("routes remember fact", () => {
    const r = routeProductUtterance("记住：这个项目准备基于 Pi");
    assert.equal(r?.action, "remember");
    assert.equal(r?.input.claim, "这个项目准备基于 Pi");
  });

  it("routes learning corrections", () => {
    const r = routeProductUtterance("以后不要在没有证据时自动写入长期记忆");
    assert.equal(r?.action, "record_learning");
  });

  it("routes only explicit create-only Notes commands", () => {
    const content = "周五演示只讲插话和主动回访";
    const route = routeProductUtterance(`奕枢，把「${content}」写进备忘录。`);
    assert.equal(route?.action, "create_note");
    assert.deepEqual(route?.input, {
      content,
      title: content,
      targetBundleId: "com.apple.Notes",
    });
    assert.equal(routeProductUtterance(`不要把「${content}」写进备忘录。`), null);
    assert.equal(routeProductUtterance(`能把「${content}」写进备忘录吗？`), null);
    assert.equal(routeProductUtterance("把刚才那段写进备忘录。"), null);
    assert.equal(routeProductUtterance(`把「${content}」追加到备忘录。`), null);
    assert.equal(
      routeProductUtterance("把「不要忘记删除旧草稿」写进备忘录。")?.action,
      "create_note",
    );
    assert.equal(
      routeProductUtterance(`奕枢，把${content}写进备忘录。`)?.input.content,
      content,
    );
  });

  it("routes the spoken reminder the user actually says, including near variants", () => {
    assert.deepEqual(routeProductUtterance("20分钟后提醒我喝一口水")?.input, {
      delaySeconds: 1_200,
      body: "喝一口水",
    });
    assert.deepEqual(routeProductUtterance("20分钟后提醒我喝水")?.input, {
      delaySeconds: 1_200,
      body: "喝水",
    });
    assert.equal(routeProductUtterance("2小时后提醒我开会")?.action, "schedule_time_reminder");
    assert.equal(routeProductUtterance("帮我20分钟后提醒我喝水")?.action, "schedule_time_reminder");
    assert.equal(routeProductUtterance("过20分钟提醒我喝水")?.input.delaySeconds, 1_200);
    assert.equal(routeProductUtterance("再过20分钟提醒我喝水")?.input.delaySeconds, 1_200);
    assert.equal(routeProductUtterance("20分钟以后提醒我喝水")?.action, "schedule_time_reminder");
    assert.equal(routeProductUtterance("提醒我20分钟后喝水")?.input.body, "喝水");
    assert.equal(routeProductUtterance("20分钟后叫我喝一口水")?.input.body, "喝一口水");
    assert.equal(routeProductUtterance("请你20分钟后提醒我喝一口水")?.action, "schedule_time_reminder");
    assert.equal(routeProductUtterance("设个20分钟后的提醒，喝一口水")?.input.body, "喝一口水");
    assert.equal(routeProductUtterance("帮我设个20分钟后喝水的提醒")?.input.body, "喝水");
    assert.equal(routeProductUtterance("半小时后提醒我喝水")?.input.delaySeconds, 1_800);
    assert.equal(routeProductUtterance("一个小时后提醒我开会")?.input.delaySeconds, 3_600);
    assert.deepEqual(routeProductUtterance("remind me in 20 minutes to drink water")?.input, {
      delaySeconds: 1_200,
      body: "drink water",
    });
    assert.equal(
      routeProductUtterance("20分钟后提醒用户喝一口水( 约07:34)")?.input.body,
      "喝一口水",
    );
  });

  it("does not treat reminder questions or incomplete lines as commands", () => {
    assert.equal(routeProductUtterance("20分钟后提醒我喝水吗？"), null);
    assert.equal(routeProductUtterance("20分钟后提醒我喝水吗"), null);
    assert.equal(routeProductUtterance("20分钟后提醒我喝水好吗"), null);
    assert.equal(routeProductUtterance("20分钟后提醒我喝水呢"), null);
    assert.equal(routeProductUtterance("20分钟后提醒我喝水好不好"), null);
    assert.equal(routeProductUtterance("能不能20分钟后提醒我喝水"), null);
    assert.equal(routeProductUtterance("can you remind me in 20 minutes to drink water"), null);
    assert.equal(routeProductUtterance("20分钟后提醒我"), null);
    assert.equal(routeProductUtterance("0分钟后提醒我喝水"), null);
    assert.equal(routeProductUtterance("25小时后提醒我开会"), null);
    assert.equal(routeProductUtterance("明天提醒我开会"), null);
    assert.equal(routeProductUtterance("20分钟后别提醒我喝水"), null);
    assert.equal(classifyRelativeTimeReminder("能不能20分钟后提醒我喝水")?.kind, "question");
    assert.equal(classifyRelativeTimeReminder("20分钟后提醒我喝水呢")?.kind, "question");
    assert.equal(classifyRelativeTimeReminder("20分钟后提醒我")?.kind, "incomplete");
    assert.equal(classifyRelativeTimeReminder("明天提醒我开会"), null);
  });

  it("keeps looksLike aligned with parse so reminder-shaped lines never fall to Pi", () => {
    const commands = [
      "20分钟后提醒我喝一口水",
      "半小时后提醒我喝水",
      "remind me in 20 minutes to drink water",
      "20分钟后提醒用户喝一口水( 约07:34)",
    ];
    for (const utterance of commands) {
      assert.equal(classifyRelativeTimeReminder(utterance)?.kind, "schedule");
      assert.equal(looksLikeRelativeTimeReminder(utterance), true);
      assert.equal(routeProductUtterance(utterance)?.action, "schedule_time_reminder");
    }
    const blocked = [
      "能不能20分钟后提醒我喝水",
      "20分钟后提醒我喝水呢",
      "20分钟后提醒我喝水好不好",
    ];
    for (const utterance of blocked) {
      assert.equal(looksLikeRelativeTimeReminder(utterance), true);
      assert.equal(routeProductUtterance(utterance), null);
      assert.notEqual(classifyRelativeTimeReminder(utterance)?.kind, "schedule");
    }
    assert.equal(looksLikeRelativeTimeReminder("整理研究结论"), false);
  });

  it("speaks a verified reminder with the Mac clock label, not a Node-local guess", () => {
    assert.equal(
      formatProductActionSpeech("schedule_time_reminder", "verified", {
        succeeded: true,
        verified: true,
        clockLabel: "07:34",
      }),
      "已经设好提醒，大约 07:34。",
    );
    assert.equal(
      formatProductActionSpeech("schedule_time_reminder", "verified", {
        succeeded: true,
        verified: true,
        delaySeconds: 1_200,
      }),
      "已经设好提醒。",
    );
    assert.equal(
      formatProductActionSpeech("schedule_time_reminder", "verified", {
        succeeded: true,
        verified: true,
      }),
      "已经设好提醒。",
    );
    assert.equal(
      formatProductActionSpeech("schedule_time_reminder", "failed", {
        succeeded: false,
        verified: false,
      }),
      "这次没有设置提醒。",
    );
  });

  it("leaves ordinary questions for Pi", () => {
    assert.equal(routeProductUtterance("这个按钮为什么是灰色的？"), null);
    assert.equal(routeProductUtterance("刚才那个可以给 Agent 读视频链接的东西在哪？"), null);
  });

  it("speaks cancellation as a stop, including after-commit cancellation", () => {
    assert.equal(
      formatProductActionSpeech("remember", "cancelled", null),
      "好的，我已经停下，没有继续执行。",
    );
    assert.equal(
      formatProductActionSpeech("remember", "cancelled_after_commit", null),
      "好的，我已经停下；刚才已经落地的结果保留，不再继续。",
    );
  });
});
