import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { cronTrigger, FileAutomationStore } from "@yishu/kernel";
import { AutomationScheduler } from "../src/automation-scheduler.js";
import { runtimeEvent, type RuntimeEvent, type TurnStartCommand } from "../src/protocol.js";

describe("AutomationScheduler", () => {
  it("fires a due routine as a hidden wake turn and records the run", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "yishu-scheduler-"));
    try {
      const store = new FileAutomationStore(root);
      const record = store.upsert({
        name: "probe",
        prompt: "say hi",
        trigger: cronTrigger("@every 1m"),
      }, Date.now() - 120_000);
      assert.ok(record);

      const events: RuntimeEvent[] = [];
      let startedCommand: TurnStartCommand | undefined;
      const scheduler = new AutomationScheduler(
        store,
        async (command, emit) => {
          startedCommand = command;
          emit(runtimeEvent("response.completed", command.requestId, command.traceId, { text: "hi back", verified: false }));
        },
        (event) => events.push(event),
      );

      await scheduler.tick(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.ok(startedCommand);
      assert.ok(startedCommand.payload.utterance.startsWith("[routine]"));
      assert.equal(startedCommand.payload.sessionScope?.kind, "private");
      assert.ok(startedCommand.payload.conversationId?.startsWith("yishu-routine-"));

      const started = events.find((event) => event.type === "automation.run.started");
      const finished = events.find((event) => event.type === "automation.run.finished");
      assert.ok(started);
      assert.ok(finished);
      assert.equal((finished?.payload as { status?: string }).status, "ok");

      const after = store.get(record.id);
      assert.ok(after);
      assert.equal(after.runs.length, 1);
      assert.equal(after.runs[0]?.status, "ok");
      assert.ok(after.lastRunAt != null);
      assert.ok((after.nextRunAt ?? 0) > Date.now());
      scheduler.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runNow rejects unknown routines and accepts known ones", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "yishu-scheduler-"));
    try {
      const store = new FileAutomationStore(root);
      const scheduler = new AutomationScheduler(store, async () => {}, () => {});
      assert.deepEqual(await scheduler.runNow("missing"), { accepted: false, code: "automation_not_found" });
      const record = store.upsert({ name: "manual", prompt: "x", trigger: cronTrigger("0 0 1 1 *") });
      assert.ok(record);
      const accepted = await scheduler.runNow(record.id);
      assert.equal(accepted.accepted, true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(store.get(record.id)?.runs[0]?.trigger, "manual");
      scheduler.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
