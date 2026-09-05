import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { CodexRuntime, type CodexClientPort } from "../src/providers/codex-runtime.js";
import { CodexApprovalPort } from "../src/providers/codex-approval.js";
import { processResourceLease } from "../src/resource-lease.js";
import { makeTurnStartCommand } from "./fixtures.js";
import { clientCommandSchema, type RuntimeEvent } from "../src/protocol.js";
import { sanitizeClientEvent } from "../src/product-kernel-runtime.helpers.js";
import type { CodexMessage } from "../src/providers/codex-app-server-client.js";

class FakeCodex implements CodexClientPort {
  listener: (message: CodexMessage) => void = () => {};
  calls: string[] = [];
  closed = false;
  complete = true;
  async initialize() {}
  subscribe(listener: typeof this.listener) { this.listener = listener; return () => {}; }
  send() {}
  async close() { this.closed = true; this.listener({ method: "yishu/closed" }); }
  async request(method: string) {
    this.calls.push(method);
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "thread/start") return { thread: { id: "thread" } };
    if (method === "turn/start") {
      if (this.complete) setTimeout(() => {
        for (const [method, params] of [
          ["item/started", { item: { id: "tool", type: "mcpToolCall", server: "cua_repl", tool: "js" } }],
          ["item/completed", { item: { id: "tool", type: "mcpToolCall", server: "cua_repl", tool: "js", status: "completed" } }],
          ["item/completed", { item: { type: "agentMessage", text: "显示 391。" } }],
          ["turn/completed", { turn: { status: "completed" } }],
        ] as const) this.listener({ method, params: { threadId: "thread", turnId: "turn", ...params } });
      }, 1);
      return { turn: { id: "turn" } };
    }
    return {};
  }
}

test("Codex events survive the product boundary, without minting verified action receipts", async () => {
  const fake = new FakeCodex();
  const runtime = new CodexRuntime(() => fake);
  const events: RuntimeEvent[] = [];
  const command = makeTurnStartCommand();
  command.payload.modelPreference = { provider: "openai-codex", model: "gpt-6-astra" };
  assert.ok(clientCommandSchema.safeParse(command).success);
  await runtime.start(command, (event) => { const safe = sanitizeClientEvent(event); if (safe) events.push(safe); });
  assert.deepEqual(events.map((event) => event.type), ["turn.started", "tool.started", "tool.completed", "response.completed"]);
  assert.equal(events.at(-1)?.payload.text, "显示 391。");
  assert.equal(events.at(-1)?.payload.verified, false);
  assert.equal(fake.closed, true);
  assert.equal(processResourceLease.ownerOf("desktop"), null);
});

test("desktop busy never launches Codex, cancellation closes the process before releasing the lease", async () => {
  const fake = new FakeCodex(); fake.complete = false;
  let spawns = 0;
  const runtime = new CodexRuntime(() => { spawns++; return fake; });
  const grant = processResourceLease.acquire("desktop", "native-action");
  assert.ok(grant.granted);
  const blocked: RuntimeEvent[] = [];
  await runtime.start(makeTurnStartCommand(), (event) => blocked.push(event));
  assert.equal(spawns, 0);
  assert.equal(blocked[0]?.payload.code, "desktop_busy");
  processResourceLease.release("desktop", grant.token, grant.epoch);
  const command = makeTurnStartCommand();
  const events: RuntimeEvent[] = [];
  const running = runtime.start(command, (event) => events.push(event));
  while (!fake.calls.includes("turn/start")) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(processResourceLease.ownerOf("desktop"), command.requestId);
  await runtime.cancel(command.requestId);
  await running;
  assert.equal(fake.closed, true);
  assert.equal(processResourceLease.ownerOf("desktop"), null);
  assert.equal(events.some((event) => event.type === "response.completed"), false);
});

test("approval is live-only, bound to turn/trace, consumed once and denied on cancellation", async () => {
  const approvals = new CodexApprovalPort();
  const command = makeTurnStartCommand();
  const abort = new AbortController();
  let approvalId = "";
  const waiting = approvals.request(command, "允许使用计算器？", (event) => {
    const safe = sanitizeClientEvent(event);
    assert.ok(safe);
    approvalId = String(safe.payload.approvalId);
  }, abort.signal);
  const reply = { ...command, type: "codex.approval.reply" as const, payload: { approvalId, accept: true } };
  assert.ok(clientCommandSchema.safeParse(reply).success);
  assert.equal(approvals.reply({ ...reply, traceId: randomUUID() }), false);
  assert.equal(approvals.reply(reply), true);
  assert.equal(await waiting, true);
  assert.equal(approvals.reply(reply), false);
  const cancelled = approvals.request(command, "允许？", () => {}, abort.signal);
  abort.abort();
  assert.equal(await cancelled, false);
});
