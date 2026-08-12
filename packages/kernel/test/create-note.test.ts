import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  clearAuditLog,
  createYishuKernel,
  formatProductActionSpeech,
  getAuditLog,
} from "../src/index.js";

const input = {
  content: "周五演示只讲插话和主动回访",
  title: "周五演示",
  targetBundleId: "com.apple.Notes" as const,
  intentId: randomUUID(),
  attemptId: randomUUID(),
  basisFrameId: randomUUID(),
};

test("create_note requires an explicit product approval", async () => {
  const { registry } = createYishuKernel();
  let dispatches = 0;
  const receipt = await registry.invoke("create_note", {
    caller: "voice",
    input,
  }, {
    createNote: {
      async perform() {
        dispatches += 1;
        throw new Error("must not dispatch without approval");
      },
    },
  });
  assert.equal(receipt.status, "needs_approval");
  assert.equal(dispatches, 0);
});

test("create_note dispatches once and completes only after exact read-back", async () => {
  clearAuditLog();
  const { registry } = createYishuKernel();
  let dispatches = 0;
  const receipt = await registry.invoke("create_note", {
    caller: "voice",
    input,
    approved: true,
  }, {
    createNote: {
      async perform(request) {
        dispatches += 1;
        assert.deepEqual(request, input);
        return {
          succeeded: true,
          verified: true,
          status: "verified",
          code: "verified_accessibility",
          method: "native_command",
          message: "read back",
        };
      },
    },
  });

  assert.equal(dispatches, 1);
  assert.equal(receipt.status, "verified");
  assert.equal(getAuditLog().some((entry) => JSON.stringify(entry).includes(input.content)), false);
});

test("create_note never retries an unverified committed result", async () => {
  const { registry } = createYishuKernel();
  let dispatches = 0;
  const receipt = await registry.invoke("create_note", {
    caller: "voice",
    input,
    approved: true,
  }, {
    createNote: {
      async perform() {
        dispatches += 1;
        return {
          succeeded: true,
          verified: false,
          status: "unverified",
          code: "runtime_error",
          method: "native_command",
          message: "result unknown",
        };
      },
    },
  });

  assert.equal(dispatches, 1);
  assert.equal(receipt.status, "failed");
  assert.equal((receipt.output as { succeeded: boolean }).succeeded, true);
});

test("create_note rejects incomplete or forged verification combinations", async () => {
  const invalidResults = [
    { succeeded: false, verified: true, status: "verified", code: "verified_accessibility", method: "native_command" },
    { succeeded: true, verified: true, status: "delivered", code: "verified_accessibility", method: "native_command" },
    { succeeded: true, verified: true, status: "verified", code: "runtime_error", method: "native_command" },
    { succeeded: true, verified: true, status: "verified", code: "verified_accessibility", method: "unknown" },
  ];

  for (const result of invalidResults) {
    const { registry } = createYishuKernel();
    const receipt = await registry.invoke("create_note", {
      caller: "voice",
      input,
      approved: true,
    }, {
      createNote: {
        async perform() {
          return { ...result, message: "untrusted executor result" };
        },
      },
    });

    assert.equal(receipt.status, "failed");
    assert.equal(receipt.verification?.verified, false);
    assert.equal((receipt.output as { verified: boolean }).verified, false);
    assert.notEqual(
      formatProductActionSpeech("create_note", receipt.status, receipt.output),
      "已新建并确认一条备忘录。",
    );
  }
});
