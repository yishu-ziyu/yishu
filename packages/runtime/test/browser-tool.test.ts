import assert from "node:assert/strict";
import test from "node:test";
import { createYishuKernel, type ActionReceipt, type BrowserResult } from "@yishu/kernel";
import { createBrowserTool } from "../src/browser-tool.js";
import { BrowserSessionHub, type BrowserDriver } from "../src/browser-session.js";
import { ProductKernelRuntime } from "../src/product-kernel-runtime.js";
import { MockAgentRuntime } from "../src/mock-runtime.js";

function receipt(output: BrowserResult, status: ActionReceipt["status"] = "verified"): ActionReceipt {
  return {
    actionName: "browser",
    receiptId: "r1",
    status,
    caller: "pi",
    input: { op: "observe" },
    output,
    authority: "reversible",
    risk: "medium",
    reversible: true,
    auditId: "a1",
    occurredAt: "2026-08-21T00:00:00.000Z",
    message: output.message,
  };
}

function fakeDriver(state: { url: string; title: string; clicks: string[] }): BrowserDriver {
  return {
    async goto(url) {
      state.url = url;
      state.title = "Example";
      return { url, title: state.title };
    },
    async observe() {
      return {
        url: state.url,
        title: state.title,
        targets: [{ id: "1", role: "link", name: "More information" }],
      };
    },
    async click(targetId) {
      state.clicks.push(targetId);
      state.url = "https://example.com/next";
      return { url: state.url, title: state.title };
    },
    async type() {
      return { url: state.url, title: state.title };
    },
    async close() {},
  };
}

test("browser tool is sequential and wraps observe catalog as untrusted page content", async () => {
  const tool = createBrowserTool(async (request) => {
    assert.equal(request.op, "observe");
    return receipt({
      succeeded: true,
      verified: true,
      message: "Observed 1 targets.",
      url: "https://example.com/",
      title: "Example",
      targets: [{ id: "1", role: "link", name: "More information" }],
    });
  });
  assert.equal(tool.name, "browser");
  assert.equal(tool.executionMode, "sequential");
  const result = await tool.execute("call-1", { op: "observe" });
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /<untrusted source="browser.observe">/);
  assert.match(text, /1\. link — More information/);
  assert.equal(result.details.receiptStatus, "verified");
});

test("browser tool throws on an unverified click so the model cannot treat it as done", async () => {
  const tool = createBrowserTool(async () => receipt({
    succeeded: true,
    verified: false,
    message: "Click was delivered but the page did not confirm.",
  }, "failed"));
  await assert.rejects(
    () => tool.execute("call-1", { op: "click", targetId: "1" }),
    /Click was delivered but the page did not confirm/,
  );
});

test("session hub requires observe before click and isolates conversations", async () => {
  const stateA = { url: "", title: "", clicks: [] as string[] };
  const stateB = { url: "", title: "", clicks: [] as string[] };
  const opened: string[] = [];
  const hub = new BrowserSessionHub(async () => {
    const owner = opened.length === 0 ? "a" : "b";
    opened.push(owner);
    return fakeDriver(owner === "a" ? stateA : stateB);
  });

  const a = hub.bind("conv-a");
  const skipped = await a.perform({ op: "click", targetId: "1" });
  assert.equal(skipped.succeeded, false);
  assert.match(skipped.message, /Observe the page/);

  await a.perform({ op: "goto", url: "https://example.com/" });
  const observed = await a.perform({ op: "observe" });
  assert.equal(observed.targets?.[0]?.id, "1");
  const clicked = await a.perform({ op: "click", targetId: "1" });
  assert.equal(clicked.verified, true);
  assert.deepEqual(stateA.clicks, ["1"]);

  const b = hub.bind("conv-b");
  await b.perform({ op: "goto", url: "https://example.org/" });
  assert.equal(stateB.clicks.length, 0);
  assert.deepEqual(opened, ["a", "b"]);
});

test("product runtime exposes browser next to delegate on main sessions", async (t) => {
  const runtime = new ProductKernelRuntime(
    new MockAgentRuntime(),
    createYishuKernel({ storeBackend: "memory" }),
  );
  t.after(() => runtime.dispose());
  const names = runtime.delegation.sessionToolPolicyFor("conv-main").extraTools.map(
    (tool) => tool.name,
  );
  assert.deepEqual(names, ["web_search", "delegate", "browser"]);
});
