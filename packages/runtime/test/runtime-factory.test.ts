import assert from "node:assert/strict";
import test from "node:test";
import { MockAgentRuntime } from "../src/mock-runtime.js";
import { YishuLoopRuntimeAdapter } from "../src/loop-adapter.js";
import {
  createAgentRuntime,
  selectedRuntimeMode,
} from "../src/runtime-factory.js";

test("Pi is the only selectable agent loop", async () => {
  assert.equal(selectedRuntimeMode({}), "pi");
  assert.equal(selectedRuntimeMode({ YISHU_RUNTIME_MODE: "pi" }), "pi");
  assert.equal(selectedRuntimeMode({ YISHU_RUNTIME_MODE: "agent-core" }), "pi");
  assert.equal(selectedRuntimeMode({ HANAKO_RUNTIME_MODE: "agent-core" }), "pi");

  const runtime = createAgentRuntime("pi", { productKernel: false });
  assert.ok(runtime instanceof YishuLoopRuntimeAdapter);
  await runtime.dispose();
});

test("mock remains a protocol test double", async () => {
  assert.equal(selectedRuntimeMode({ YISHU_RUNTIME_MODE: "mock" }), "mock");
  const runtime = createAgentRuntime("mock", { productKernel: false });
  assert.ok(runtime instanceof MockAgentRuntime);
  await runtime.dispose();
});
