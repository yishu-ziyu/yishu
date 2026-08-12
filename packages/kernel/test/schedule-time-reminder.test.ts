import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { clearAuditLog, createYishuKernel, getAuditLog } from "../src/index.js";

const input = {
  reminderId: randomUUID(),
  delaySeconds: 1_200,
  body: "喝水",
  intentId: randomUUID(),
  attemptId: randomUUID(),
  basisFrameId: randomUUID(),
};

test("schedule_time_reminder dispatches once, requires system read-back, and keeps body out of audit", async () => {
  clearAuditLog();
  const { registry } = createYishuKernel();
  let dispatches = 0;
  const receipt = await registry.invoke("schedule_time_reminder", {
    caller: "voice",
    input,
    approved: true,
  }, {
    scheduleTimeReminder: {
      async perform(request) {
        dispatches += 1;
        assert.deepEqual(request, input);
        return {
          succeeded: true,
          verified: true,
          status: "verified",
          code: "verified_system_notification",
          method: "native_command",
          message: "System reminder was read back.",
        };
      },
    },
  });
  assert.equal(dispatches, 1);
  assert.equal(receipt.status, "verified");
  assert.equal(JSON.stringify(getAuditLog()).includes(input.body), false);
});
