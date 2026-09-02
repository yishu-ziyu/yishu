import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { computeNextRunAt, describeSchedule, dueAutomations, parseCron, parseEveryIntervalMs } from "../src/automation/automation-schedule.js";
import { FileAutomationStore } from "../src/automation/automation-store.js";
import { buildAutomationWakePrompt, summarizeSchedule } from "../src/automation/automation-wake.js";
import { AUTOMATION_WAKE_CUE, cronTrigger, type AutomationRecord } from "../src/automation/automation-types.js";

const MINUTE = 60_000;

describe("cron engine", () => {
  it("parses standard 5-field cron", () => {
    const matcher = parseCron("30 9 * * 1");
    assert.ok(matcher);
    assert.deepEqual([...matcher.minute], [30]);
    assert.deepEqual([...matcher.hour], [9]);
    assert.deepEqual([...matcher.dayOfWeek], [1]);
    assert.equal(parseCron("bad"), null);
    assert.equal(parseCron("61 * * * *"), null);
  });

  it("computes next run for a daily schedule", () => {
    const base = new Date(2026, 8, 2, 6, 0, 0).getTime();
    const next = computeNextRunAt("0 7 * * *", base);
    assert.equal(next, new Date(2026, 8, 2, 7, 0, 0).getTime());
    const afterFire = new Date(2026, 8, 2, 7, 0, 0).getTime();
    assert.equal(computeNextRunAt("0 7 * * *", afterFire), new Date(2026, 8, 3, 7, 0, 0).getTime());
  });

  it("supports @every intervals and aliases", () => {
    assert.equal(parseEveryIntervalMs("@every 30m"), 30 * MINUTE);
    assert.equal(parseEveryIntervalMs("@every 2h"), 2 * 3_600_000);
    assert.equal(parseEveryIntervalMs("@every 0s"), null);
    const base = 1_000_000;
    assert.equal(computeNextRunAt("@every 5m", base), base + 5 * MINUTE);
    assert.equal(describeSchedule("@every 1h"), "Every hour");
    assert.equal(describeSchedule("0 7 * * *"), "Every day at 7:00 AM");
  });

  it("respects CRON_TZ time zones", () => {
    const base = Date.UTC(2026, 8, 2, 0, 0, 0);
    const utcNext = computeNextRunAt("CRON_TZ=UTC 0 12 * * *", base);
    assert.equal(utcNext, Date.UTC(2026, 8, 2, 12, 0, 0));
  });

  it("detects due routines", () => {
    const records = [
      { isEnabled: true, nextRunAt: 100 },
      { isEnabled: false, nextRunAt: 100 },
      { isEnabled: true, nextRunAt: null },
      { isEnabled: true, nextRunAt: 200 },
    ];
    assert.deepEqual(dueAutomations(records, 150), [0]);
  });
});

describe("FileAutomationStore", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "yishu-routines-"));
  const store = new FileAutomationStore(tempRoot);

  it("upserts, lists and round-trips a routine", () => {
    const record = store.upsert({ name: "早报", prompt: "汇总今天的新闻", trigger: cronTrigger("0 8 * * 1-5") });
    assert.ok(record);
    assert.equal(record.name, "早报");
    assert.ok(record.nextRunAt != null && record.nextRunAt > Date.now() - MINUTE);
    assert.match(record.triggerDescription, /Weekdays/);
    const listed = store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, record.id);
    const reloaded = store.get(record.id);
    assert.equal(reloaded?.prompt, "汇总今天的新闻");
  });

  it("records runs with history capped and status transitions", () => {
    const record = store.upsert({ name: "watch", prompt: "check", trigger: cronTrigger("@every 1h") });
    assert.ok(record);
    for (let i = 0; i < 25; i += 1) {
      const run = store.beginRun({ id: record.id, trigger: "schedule", at: 1000 + i });
      assert.ok(run);
      store.finishRun(record.id, run.id, i % 2 === 0 ? "ok" : "error", 1100 + i, i % 2 === 0 ? "done" : "boom");
    }
    const after = store.get(record.id);
    assert.ok(after);
    assert.equal(after.runs.length, 20);
    assert.equal(after.runs[0]?.status, "ok");
    assert.equal(after.runs[0]?.detail, "done");
    store.recordRun(record.id, 1124);
    assert.equal(store.get(record.id)?.lastRunAt, 1124);
  });

  it("toggles enabled and removes", () => {
    const record = store.upsert({ name: "temp", prompt: "x", trigger: cronTrigger("0 9 * * *") });
    assert.ok(record);
    const paused = store.setEnabled(record.id, false);
    assert.equal(paused?.isEnabled, false);
    assert.equal(paused?.nextRunAt, null);
    assert.equal(store.remove(record.id), true);
    assert.equal(store.get(record.id), null);
  });

  it("serializes local event triggers", () => {
    const record = store.upsert({
      name: "app watch",
      prompt: "when back",
      trigger: { type: "app_transition", app: "Safari", transition: "foreground" },
    });
    assert.ok(record);
    const reloaded = store.get(record.id);
    assert.deepEqual(reloaded?.trigger, { type: "app_transition", app: "Safari", transition: "foreground" });
    assert.equal(reloaded?.nextRunAt, null);

    rmSync(tempRoot, { recursive: true, force: true });
  });
});

describe("wake prompt and budget", () => {
  const record: AutomationRecord = {
    id: "daily-digest",
    name: "早报",
    prompt: "汇总未读消息",
    trigger: cronTrigger("0 8 * * 1-5"),
    isEnabled: true,
    createdAt: 0,
    lastRunAt: null,
    schedule: "0 8 * * 1-5",
    triggerDescription: "Weekdays at 8:00 AM",
    nextRunAt: null,
    runs: [],
    filePath: "/tmp/x",
  };

  it("builds a schedule wake prompt with the cue", () => {
    const wake = buildAutomationWakePrompt(record);
    assert.ok(wake.startsWith(AUTOMATION_WAKE_CUE));
    assert.ok(wake.includes("汇总未读消息"));
    assert.ok(wake.includes("不是用户刚说的话"));
  });

  it("summarizes a 7-day budget", () => {
    const summary = summarizeSchedule("0 8 * * 1-5", undefined, Date.now());
    assert.equal(summary.scheduledFiresNext7Days, 5);
    assert.equal(summary.firesOnWeekend, false);
    assert.equal(summary.firesOvernight, false);
    const nightly = summarizeSchedule("0 3 * * *", undefined, Date.now());
    assert.equal(nightly.firesOvernight, true);
  });
});
