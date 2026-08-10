import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatProductActionSpeech,
  routeProductUtterance,
} from "../src/utterance-router.js";

describe("routeProductUtterance", () => {
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
