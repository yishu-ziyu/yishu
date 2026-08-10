import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createYishuKernel,
  formatProductActionSpeech,
  routeProductUtterance,
} from "../src/index.js";

function finderFrame(pid = 4242): unknown {
  return {
    frontmostApplication: {
      value: {
        bundleIdentifier: "com.apple.finder",
        processIdentifier: pid,
      },
    },
  };
}

test("Finder Back routes only a direct imperative with an observed Finder target", () => {
  const route = routeProductUtterance("点击左上角的返回按钮", finderFrame());
  assert.equal(route?.action, "finder_history_back");
  assert.deepEqual(route?.input, {
    targetBundleId: "com.apple.finder",
    targetPid: 4242,
  });
  assert.equal(routeProductUtterance("点击左上角的返回按钮"), null);
  assert.equal(routeProductUtterance("点击上一级按钮", finderFrame()), null);
  assert.equal(routeProductUtterance("返回按钮为什么是灰色的？", finderFrame()), null);
  assert.equal(routeProductUtterance("点击返回按钮", {
    frontmostApplication: { value: { bundleIdentifier: "com.apple.Safari", processIdentifier: 99 } },
  }), null);
});

test("Finder Back action sends exactly one typed request and keeps an unverified receipt honest", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  let calls = 0;
  const input = {
    targetBundleId: "com.apple.finder" as const,
    targetPid: 4242,
    intentId: randomUUID(),
    attemptId: randomUUID(),
    basisFrameId: randomUUID(),
  };
  const receipt = await kernel.registry.invoke("finder_history_back", {
    caller: "voice",
    input,
  }, {
    finderHistoryBack: {
      async perform(request) {
        calls += 1;
        assert.deepEqual(request, input);
        return {
          succeeded: true,
          verified: false,
          status: "unverified",
          code: "ax_press_unverified",
          method: "ax_press",
          message: "Finder Back was delivered but not verified.",
          evidence: "target_app=Finder;press_count=1",
        };
      },
    },
  });

  assert.equal(calls, 1);
  assert.equal(receipt.status, "failed");
  assert.equal((receipt.output as { succeeded?: boolean }).succeeded, true);
  assert.equal(receipt.verification?.verified, false);
  assert.equal(
    formatProductActionSpeech("finder_history_back", receipt.status, receipt.output),
    "已经按下返回，但没有确认到原窗口的结果；我不会重复点击。",
  );
});

test("Finder Back reports completion only after the executor verifies the exact result", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const receipt = await kernel.registry.invoke("finder_history_back", {
    caller: "voice",
    input: {
      targetBundleId: "com.apple.finder",
      targetPid: 4242,
      intentId: randomUUID(),
      attemptId: randomUUID(),
      basisFrameId: randomUUID(),
    },
  }, {
    finderHistoryBack: {
      async perform() {
        return {
          succeeded: true,
          verified: true,
          status: "verified",
          code: "verified_accessibility",
          method: "ax_press",
          message: "Finder returned to the expected location.",
        };
      },
    },
  });

  assert.equal(receipt.status, "verified");
  assert.equal(
    formatProductActionSpeech("finder_history_back", receipt.status, receipt.output),
    "已经回到刚才的位置。",
  );
});
