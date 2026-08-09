import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { z } from "zod";
import {
  ActionCancelledError,
  clearAuditLog,
  defineYishuAction,
  evaluateAuthority,
  getAuditLog,
  YishuActionRegistry,
} from "../src/action/index.js";

describe("YishuAction authority + registry", () => {
  beforeEach(() => {
    clearAuditLog();
  });

  it("allows automatic low-risk actions without approval", async () => {
    const registry = new YishuActionRegistry();
    registry.register(
      defineYishuAction({
        name: "ping",
        description: "health",
        inputSchema: z.object({ n: z.number().default(1) }),
        authority: "automatic",
        risk: "low",
        run: async (ctx) => ({ n: ctx.input.n }),
      }),
    );

    const receipt = await registry.invoke("ping", {
      caller: "voice",
      input: {},
    });
    assert.equal(receipt.status, "ok");
    assert.deepEqual(receipt.output, { n: 1 });
    assert.equal(getAuditLog().length, 1);
  });

  it("returns needs_approval for explicit_approval actions", async () => {
    const registry = new YishuActionRegistry();
    registry.register(
      defineYishuAction({
        name: "purchase",
        description: "buy something",
        inputSchema: z.object({ sku: z.string() }),
        authority: "explicit_approval",
        risk: "high",
        run: async () => ({ ok: true }),
      }),
    );

    const blocked = await registry.invoke("purchase", {
      caller: "ui",
      input: { sku: "x" },
    });
    assert.equal(blocked.status, "needs_approval");

    const allowed = await registry.invoke("purchase", {
      caller: "ui",
      input: { sku: "x" },
      approved: true,
    });
    assert.equal(allowed.status, "ok");
  });

  it("critical risk always requires approval even if authority is automatic", () => {
    const decision = evaluateAuthority({
      definition: defineYishuAction({
        name: "wipe",
        description: "danger",
        inputSchema: z.object({}),
        authority: "automatic",
        risk: "critical",
        run: async () => null,
      }),
      caller: "cli",
    });
    assert.equal(decision.allowed, false);
    if (!decision.allowed) {
      assert.equal(decision.status, "needs_approval");
    }
  });

  it("standing_mandate allows when scope matches", async () => {
    const registry = new YishuActionRegistry();
    registry.register(
      defineYishuAction({
        name: "send_message",
        description: "external send",
        inputSchema: z.object({ text: z.string() }),
        authority: "standing_mandate",
        risk: "medium",
        run: async (ctx) => ({ sent: ctx.input.text }),
      }),
    );

    const denied = await registry.invoke(
      "send_message",
      { caller: "initiative", input: { text: "hi" } },
      { mandates: [] },
    );
    assert.equal(denied.status, "needs_approval");

    const ok = await registry.invoke(
      "send_message",
      { caller: "initiative", input: { text: "hi" } },
      { mandates: [{ id: "m1", scope: "send_message" }] },
    );
    assert.equal(ok.status, "ok");
  });

  it("same action yields structured receipt from multiple callers", async () => {
    const registry = new YishuActionRegistry();
    registry.register(
      defineYishuAction({
        name: "echo",
        description: "echo",
        inputSchema: z.object({ text: z.string() }),
        authority: "reversible",
        risk: "low",
        run: async (ctx) => ({ text: ctx.input.text }),
      }),
    );

    const callers = ["voice", "ui", "cli", "pi", "mcp"] as const;
    for (const caller of callers) {
      const receipt = await registry.invoke("echo", {
        caller,
        input: { text: "hello" },
      });
      assert.equal(receipt.status, "ok");
      assert.equal(receipt.actionName, "echo");
      assert.equal(receipt.caller, caller);
      assert.ok(receipt.receiptId);
      assert.ok(receipt.auditId);
      assert.ok(receipt.occurredAt);
    }
  });

  it("marks verified when verify passes", async () => {
    const registry = new YishuActionRegistry();
    registry.register(
      defineYishuAction({
        name: "checked",
        description: "with verify",
        inputSchema: z.object({}),
        authority: "automatic",
        risk: "low",
        run: async () => ({ value: 1 }),
        verify: async () => ({ verified: true, message: "seen" }),
      }),
    );
    const receipt = await registry.invoke("checked", {
      caller: "system",
      input: {},
    });
    assert.equal(receipt.status, "verified");
    assert.equal(receipt.verification?.verified, true);
  });

  it("returns a distinct cancellation receipt before run without invoking side effects", async () => {
    const registry = new YishuActionRegistry();
    let runCount = 0;
    let verifyCount = 0;
    registry.register(
      defineYishuAction({
        name: "cancel-before-run",
        description: "cancellable action",
        inputSchema: z.object({}),
        authority: "automatic",
        risk: "low",
        run: async () => {
          runCount += 1;
          return { ok: true };
        },
        verify: async () => {
          verifyCount += 1;
          return { verified: true, message: "verified" };
        },
      }),
    );

    const controller = new AbortController();
    const secretReason = "password=never-write-this-secret";
    controller.abort(secretReason);
    const receipt = await registry.invoke("cancel-before-run", {
      caller: "voice",
      input: {},
      signal: controller.signal,
    });

    assert.equal(receipt.status, "cancelled");
    assert.equal(runCount, 0);
    assert.equal(verifyCount, 0);
    assert.equal(receipt.output, null);
    assert.doesNotMatch(JSON.stringify(receipt), /never-write-this-secret/);
    assert.doesNotMatch(JSON.stringify(getAuditLog()), /never-write-this-secret/);
    assert.equal("signal" in receipt, false);
  });

  it("propagates the signal to run and does not enter verify after run cancellation", async () => {
    const registry = new YishuActionRegistry();
    const controller = new AbortController();
    let runStarted!: () => void;
    let releaseRun!: () => void;
    const started = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let verifyCount = 0;
    let runSignal: AbortSignal | undefined;
    registry.register(
      defineYishuAction({
        name: "cancel-during-run",
        description: "cancellable action",
        inputSchema: z.object({}),
        authority: "automatic",
        risk: "low",
        run: async (ctx) => {
          runSignal = ctx.signal;
          runStarted();
          await released;
          return { ok: true };
        },
        verify: async (ctx) => {
          verifyCount += 1;
          assert.equal(ctx.signal, controller.signal);
          return { verified: true, message: "verified" };
        },
      }),
    );

    const invocation = registry.invoke("cancel-during-run", {
      caller: "voice",
      input: {},
      signal: controller.signal,
    });
    await started;
    assert.equal(runSignal, controller.signal);
    controller.abort("token=never-write-this-secret");
    releaseRun();

    const receipt = await invocation;
    assert.equal(receipt.status, "cancelled");
    assert.equal(verifyCount, 0);
    assert.doesNotMatch(JSON.stringify(getAuditLog()), /never-write-this-secret/);
  });

  it("reports cancellation after commit without erasing the side effect", async () => {
    const registry = new YishuActionRegistry();
    const controller = new AbortController();
    let releaseRun!: () => void;
    let runStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      runStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let sideEffectCount = 0;
    let verifyCount = 0;

    registry.register(
      defineYishuAction({
        name: "post-commit-cancel",
        description: "post-commit cancellation probe",
        inputSchema: z.object({}),
        authority: "automatic",
        risk: "low",
        run: async (ctx) => {
          sideEffectCount += 1;
          ctx.markCommitted();
          runStarted();
          await released;
          return { sideEffectCount };
        },
        verify: async () => {
          verifyCount += 1;
          return { verified: true, message: "verified" };
        },
      }),
    );

    const invocation = registry.invoke("post-commit-cancel", {
      caller: "voice",
      input: {},
      signal: controller.signal,
    });
    await started;
    controller.abort("private post-commit reason");
    releaseRun();

    const receipt = await invocation;
    assert.equal(receipt.status, "cancelled_after_commit");
    assert.equal(receipt.message, 'Action "post-commit-cancel" cancelled after commit');
    assert.equal(sideEffectCount, 1);
    assert.equal(verifyCount, 0);
    assert.equal(getAuditLog().at(-1)?.status, "cancelled_after_commit");
    assert.equal(getAuditLog().at(-1)?.message, "Action cancelled after commit");
    assert.doesNotMatch(JSON.stringify(getAuditLog()), /private post-commit reason/);
  });

  it("recognizes an action's explicit cancellation error", async () => {
    const registry = new YishuActionRegistry();
    registry.register(
      defineYishuAction({
        name: "cancel-error",
        description: "cancellable action",
        inputSchema: z.object({}),
        authority: "automatic",
        risk: "low",
        run: async () => {
          throw new ActionCancelledError();
        },
      }),
    );

    const receipt = await registry.invoke("cancel-error", {
      caller: "system",
      input: {},
    });
    assert.equal(receipt.status, "cancelled");
    assert.equal(receipt.message, 'Action "cancel-error" cancelled');
  });

  it("keeps audit entries content-free for failures, cancellation, and private claims", async () => {
    const registry = new YishuActionRegistry();
    registry.register(
      defineYishuAction({
        name: "private-audit-probe",
        description: "audit safety probe",
        inputSchema: z.object({ claim: z.string() }),
        authority: "automatic",
        risk: "low",
        run: async (ctx) => {
          if (ctx.input.claim === "failed private claim") {
            throw new Error("password=failed-secret-value");
          }
          return { claim: ctx.input.claim };
        },
      }),
    );

    const failed = await registry.invoke("private-audit-probe", {
      caller: "voice",
      input: { claim: "failed private claim" },
    });
    assert.equal(failed.status, "failed");

    const controller = new AbortController();
    controller.abort("token=cancelled-secret-value");
    const cancelled = await registry.invoke("private-audit-probe", {
      caller: "voice",
      input: { claim: "cancelled private claim" },
      signal: controller.signal,
    });
    assert.equal(cancelled.status, "cancelled");

    const normal = await registry.invoke("private-audit-probe", {
      caller: "voice",
      input: { claim: "normal private claim" },
    });
    assert.equal(normal.status, "ok");

    const serializedAudit = JSON.stringify(getAuditLog());
    for (const privateText of [
      "failed-secret-value",
      "cancelled-secret-value",
      "failed private claim",
      "cancelled private claim",
      "normal private claim",
      "password",
      "token",
    ]) {
      assert.doesNotMatch(serializedAudit, new RegExp(privateText));
    }
    assert.deepEqual(getAuditLog().at(-1)?.input, { kind: "object" });
    assert.deepEqual(getAuditLog().at(-1)?.output, { kind: "object" });
    assert.equal("verification" in (getAuditLog().at(-1) ?? {}), false);
  });

  it("bounds the module audit trail to the most recent entries", async () => {
    const registry = new YishuActionRegistry();
    registry.register(
      defineYishuAction({
        name: "audit-bound",
        description: "audit bound probe",
        inputSchema: z.object({ index: z.number() }),
        authority: "automatic",
        risk: "low",
        run: async () => null,
      }),
    );

    const receipts = [];
    for (let index = 0; index < 501; index += 1) {
      receipts.push(
        await registry.invoke("audit-bound", {
          caller: "system",
          input: { index },
        }),
      );
    }

    assert.equal(getAuditLog().length, 500);
    assert.equal(getAuditLog()[0]?.receiptId, receipts[1]?.receiptId);
    assert.equal(getAuditLog().at(-1)?.receiptId, receipts[500]?.receiptId);
  });
});
