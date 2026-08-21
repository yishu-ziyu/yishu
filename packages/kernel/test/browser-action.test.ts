import assert from "node:assert/strict";
import test from "node:test";
import {
  createYishuKernel,
  isAllowedBrowserUrl,
  type BrowserRequest,
  type BrowserResult,
} from "../src/index.js";

test("default kernel registers the browser action", () => {
  const { registry } = createYishuKernel({ storeBackend: "memory" });
  assert.equal(registry.get("browser")?.name, "browser");
});

test("browser rejects file and credential URLs before the executor runs", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  let calls = 0;
  const receipt = await kernel.registry.invoke("browser", {
    caller: "pi",
    input: { op: "goto", url: "file:///etc/passwd" },
  }, {
    browser: {
      async perform() {
        calls += 1;
        return { succeeded: true, verified: true, message: "should not run" };
      },
    },
  });
  assert.equal(calls, 0);
  assert.equal(receipt.status, "failed");
  assert.equal((receipt.output as BrowserResult).message, "Only http and https URLs are allowed.");
  assert.equal(isAllowedBrowserUrl("https://example.com/path"), true);
  assert.equal(isAllowedBrowserUrl("http://127.0.0.1:8080"), true);
  assert.equal(isAllowedBrowserUrl("javascript:alert(1)"), false);
  assert.equal(isAllowedBrowserUrl("https://user:pass@example.com"), false);
});

test("observe returns numbered targets and does not mark a side effect committed", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const receipt = await kernel.registry.invoke("browser", {
    caller: "pi",
    input: { op: "observe" },
  }, {
    browser: {
      async perform(request: BrowserRequest) {
        assert.equal(request.op, "observe");
        return {
          succeeded: true,
          verified: true,
          message: "Observed 2 targets.",
          url: "https://example.com/",
          title: "Example",
          targets: [
            { id: "1", role: "link", name: "More information" },
            { id: "2", role: "button", name: "OK" },
          ],
        };
      },
    },
  });
  assert.equal(receipt.status, "verified");
  assert.deepEqual((receipt.output as BrowserResult).targets?.map((target) => target.id), ["1", "2"]);
});

test("click by id goes through the executor and keeps an unverified receipt honest", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const receipt = await kernel.registry.invoke("browser", {
    caller: "pi",
    input: { op: "click", targetId: "1" },
  }, {
    browser: {
      async perform(request: BrowserRequest) {
        assert.deepEqual(request, { op: "click", targetId: "1" });
        return {
          succeeded: true,
          verified: false,
          message: "Click was delivered but the page did not confirm.",
          url: "https://example.com/",
        };
      },
    },
  });
  assert.equal(receipt.status, "failed");
  assert.equal((receipt.output as BrowserResult).succeeded, true);
  assert.equal(receipt.verification?.verified, false);
});

test("click without a browser executor fails closed", async () => {
  const kernel = createYishuKernel({ storeBackend: "memory" });
  const receipt = await kernel.registry.invoke("browser", {
    caller: "pi",
    input: { op: "click", targetId: "1" },
  });
  assert.equal(receipt.status, "failed");
  assert.equal((receipt.output as BrowserResult).message, "The browser action bridge is unavailable.");
});
