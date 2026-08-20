import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createYishuKernel } from "../src/kernel.js";
import {
  deriveTurnIntentFrame,
  productActionIntentPolicy,
  resolveTurnIntentCandidate,
  taskExecutionContractForIntent,
} from "../src/intent-frame.js";
import type { ProductActionName } from "../src/utterance-router.js";
import { INTENT_CORPUS } from "./fixtures/intent-corpus.js";

describe("deriveTurnIntentFrame", () => {
  it("matches the frozen safety and routing corpus", () => {
    for (const item of INTENT_CORPUS) {
      const frame = deriveTurnIntentFrame(item.utterance, item.options);
      assert.equal(frame.effect, item.expected.effect, item.name);
      assert.equal(frame.route.kind, item.expected.route, item.name);
      assert.equal(frame.steerable, item.expected.steerable, item.name);
      if (item.expected.speechAct !== undefined) {
        assert.equal(frame.speechAct, item.expected.speechAct, item.name);
      }
      if (item.expected.authority !== undefined) {
        assert.equal(frame.authority, item.expected.authority, item.name);
      }
      if (item.expected.action !== undefined) {
        assert.equal(frame.route.kind, "product_action", item.name);
        if (frame.route.kind === "product_action") {
          assert.equal(frame.route.value.action, item.expected.action, item.name);
        }
      }
      assert.equal(
        taskExecutionContractForIntent(frame).successMode,
        item.expected.effect === "none" ? "read_only_delivery" : "external_effect",
        item.name,
      );
    }
  });

  it("carries one product route and one clarification decision", () => {
    const note = deriveTurnIntentFrame("把「周五演示」写进备忘录");
    assert.equal(note.route.kind, "product_action");
    if (note.route.kind === "product_action") {
      assert.equal(note.route.value.action, "create_note");
    }
    assert.equal(note.effect, "external");
    assert.equal(note.authority, "explicit_approval");

    const correction = deriveTurnIntentFrame("以后不要在没有证据时宣布完成");
    assert.equal(correction.route.kind, "product_action");
    assert.equal(correction.effect, "product_state");
    assert.equal(correction.authority, "reversible");

    const scheduled = deriveTurnIntentFrame("20分钟后提醒我喝水");
    assert.equal(scheduled.route.kind, "product_action");
    if (scheduled.route.kind === "product_action") {
      assert.equal(scheduled.route.value.action, "schedule_time_reminder");
      assert.deepEqual(scheduled.route.value.input, {
        delaySeconds: 1_200,
        body: "喝水",
      });
    }
    assert.equal(scheduled.authority, "explicit_approval");

    const reminderQuestion = deriveTurnIntentFrame("20分钟后提醒我喝水吗？");
    assert.deepEqual(reminderQuestion.route, {
      kind: "clarify",
      topic: "relative_time_reminder",
    });
    assert.equal(reminderQuestion.effect, "none");
    assert.equal(reminderQuestion.steerable, false);
  });

  it("lets the composed current-page note intent tighten authority before execution", () => {
    const frame = deriveTurnIntentFrame(
      "把当前页面需要我做的三件事整理成一条备忘录",
      { currentPageNote: true },
    );
    assert.equal(frame.effect, "external");
    assert.equal(frame.route.kind, "model");
    const contract = taskExecutionContractForIntent(frame);
    assert.equal(contract.successMode, "external_effect");
    assert.equal(contract.authority, "explicit_approval");
    assert.equal(contract.risk, "medium");
  });

  it("keeps future model parsing behind the same product policy seam", () => {
    const frame = resolveTurnIntentCandidate({
      objective: "打开当前文件",
      speechAct: "command",
      effect: "external",
      route: { kind: "model" },
      source: "model",
    });
    assert.equal(frame.source, "model");
    assert.equal(frame.authority, "reversible");
    assert.equal(frame.risk, "medium");
    assert.equal(frame.steerable, false);
    assert.equal(taskExecutionContractForIntent(frame).successMode, "external_effect");
  });

  it("keeps routed action authority and risk aligned with registry definitions", () => {
    const kernel = createYishuKernel({ storeBackend: "memory" });
    const actions: ProductActionName[] = [
      "remember",
      "forget",
      "remember_how",
      "share_context",
      "record_learning",
      "run_skill",
      "watch_app_return",
      "finder_history_back",
      "create_note",
      "schedule_time_reminder",
    ];
    for (const action of actions) {
      const definition = kernel.registry.get(action);
      const policy = productActionIntentPolicy(action);
      assert.equal(policy.authority, definition?.authority, action);
      assert.equal(policy.risk, definition?.risk, action);
    }
  });
});
