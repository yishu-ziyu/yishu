import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentCoreRuntime,
  buildAgentCoreTask,
  summarizeContextFrame,
} from "../src/agent-core-runtime.js";
import { createAgentRuntime, selectedRuntimeMode } from "../src/runtime-factory.js";
import { makeTurnStartCommand } from "./fixtures.js";

test("summarizeContextFrame includes app, window, element from fixtures", () => {
  const command = makeTurnStartCommand();
  const summary = summarizeContextFrame(command.payload.contextFrame);
  assert.match(summary, /Preview/);
  assert.match(summary, /Draft\.pdf/);
  assert.match(summary, /Markup/);
});

test("buildAgentCoreTask embeds utterance and context summary", () => {
  const base = makeTurnStartCommand();
  const command = {
    ...base,
    payload: {
      ...base.payload,
      utterance: "计算 17*19+3",
    },
  };
  const task = buildAgentCoreTask(command);
  assert.match(task, /计算 17\*19\+3/);
  assert.match(task, /\[context:.*Preview.*Markup/);
});

test("agent-core runtime math turn returns 326-ish response and verified true", async () => {
  const runtime = new AgentCoreRuntime();
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

  const base = makeTurnStartCommand();
  const command = {
    ...base,
    payload: {
      ...base.payload,
      utterance: "计算 17*19+3",
    },
  };

  await runtime.startTurn(command, (event) => {
    events.push({
      type: event.type,
      payload: event.payload as Record<string, unknown>,
    });
  });

  assert.ok(events.some((e) => e.type === "turn.started"));
  assert.ok(events.some((e) => e.type === "response.delta"));

  const completed = events.find((e) => e.type === "response.completed");
  assert.ok(completed, "expected response.completed");
  assert.match(String(completed.payload.text ?? ""), /326/);
  assert.equal(completed.payload.verified, true);

  const status = events.find(
    (e) => e.type === "runtime.status" && e.payload.status === "trajectory_summary",
  );
  assert.ok(status, "expected trajectory_summary status");
  assert.ok(Array.isArray(status.payload.toolsUsed));
  assert.ok(
    (status.payload.toolsUsed as string[]).includes("code_exec"),
    "math path should use code_exec",
  );

  await runtime.dispose();
});

test("selectedRuntimeMode and createAgentRuntime support agent-core", () => {
  assert.equal(
    selectedRuntimeMode({ YISHU_RUNTIME_MODE: "agent-core" }),
    "agent-core",
  );
  assert.equal(
    selectedRuntimeMode({ YISHU_RUNTIME_MODE: "mock" }),
    "mock",
  );
  const runtime = createAgentRuntime("agent-core");
  assert.ok(runtime instanceof AgentCoreRuntime);
});
