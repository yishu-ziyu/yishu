import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AuthServiceError,
  safeAuthUrl,
  YishuAuthService,
  type AuthModelRuntime,
  type AuthServiceEvent,
} from "../src/auth-service.js";
import { InMemoryCredentialStore, ProductCredentialStore, resolveYishuAuthPath } from "../src/auth-store.js";
import { runAuthWatchdog } from "../src/auth-watchdog.js";
import { authPublicStatusSchema } from "../src/auth-protocol.js";

class FakeOAuthRuntime implements AuthModelRuntime {
  configured = false;
  interaction?: Parameters<AuthModelRuntime["login"]>[2];

  getProvider(providerId: string) {
    return { id: providerId, auth: { oauth: {} } };
  }

  async getAvailable(providerId: string) {
    if (!this.configured) return [];
    return providerId === "xai"
      ? [
          { id: "grok-4.3", name: "Grok 4.3", provider: "xai" },
          { id: "grok-4.5", name: "Grok 4.5", provider: "xai" },
          { id: "grok-build-0.1", name: "Grok Build", provider: "xai" },
        ]
      : [{ id: "gpt-5.4", name: "GPT-5.4", provider: "openai-codex" }];
  }

  async checkAuth() {
    return this.configured ? { type: "oauth" as const } : undefined;
  }

  async getAuth() {
    return this.configured ? { auth: { headers: { "x-test": "discard" } } } : undefined;
  }

  async login(_providerId: string, _type: "oauth", interaction: Parameters<AuthModelRuntime["login"]>[2]) {
    this.interaction = interaction;
    interaction.notify({ type: "auth_url", url: "https://auth.example.test/authorize?code_challenge=public" });
    const code = await interaction.prompt({ type: "manual_code", message: "Paste the one-time code." });
    assert.equal(code, "one-time-code");
    this.configured = true;
    // Deliberately return credential-shaped data; AuthService must never copy
    // any of these fields into a public event.
    return {
      type: "oauth",
      access: "ACCESS_VALUE_SHOULD_NOT_CROSS_WIRE",
      refresh: "REFRESH_VALUE_SHOULD_NOT_CROSS_WIRE",
      expires: Date.now() + 60_000,
      accountId: "ACCOUNT_ID_SHOULD_NOT_CROSS_WIRE",
    };
  }

  async logout() {
    this.configured = false;
  }
}

function waitForEvent(events: AuthServiceEvent[], type: AuthServiceEvent["type"]): Promise<AuthServiceEvent> {
  const existing = events.find((event) => event.type === type);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const event = events.find((candidate) => candidate.type === type);
      if (!event) return;
      clearInterval(timer);
      resolve(event);
    }, 1);
  });
}

test("OpenAI browser authorization URL crosses the product boundary", () => {
  const url = "https://auth.openai.com/oauth/authorize"
    + "?response_type=code"
    + "&client_id=public-client"
    + "&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback"
    + "&code_challenge=public-challenge"
    + "&id_token_add_organizations=true"
    + "&state=public-state";

  assert.equal(safeAuthUrl(url), url);
});

test("OAuth callback results and credentials never cross the product boundary", () => {
  assert.equal(safeAuthUrl("https://example.test/callback?code=secret-code"), undefined);
  assert.equal(safeAuthUrl("https://example.test/callback#access_token=secret-token"), undefined);
  assert.equal(
    safeAuthUrl("https://example.test/authorize?value=eyJaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbb.cccccccccc"),
    undefined,
  );
});

test("OAuth status exposes only controlled models and marks xAI experimental", async () => {
  const runtime = new FakeOAuthRuntime();
  runtime.configured = true;
  const service = new YishuAuthService(Promise.resolve(runtime));

  const [status] = await service.status("xai");
  assert.ok(status);
  assert.deepEqual(status.models.map((model) => model.id), ["grok-4.3", "grok-4.5", "grok-build-0.1"]);
  assert.equal(status.experimental, "experimental_local_subscription");
  assert.equal(status.authType, "oauth");
  assert.equal(status.configured, true);
  assert.doesNotMatch(JSON.stringify(status), /ACCESS_VALUE|REFRESH_VALUE|ACCOUNT_ID/);
  assert.deepEqual(authPublicStatusSchema.parse(status), status);
});

test("ambient API-key-only state is not reported as subscription OAuth", async () => {
  const runtime = new FakeOAuthRuntime();
  runtime.getProvider = (providerId: string) => ({ id: providerId, auth: { apiKey: {} } });
  runtime.checkAuth = async () => ({ type: "api_key" as const });
  const service = new YishuAuthService(Promise.resolve(runtime));

  const [status] = await service.status("xai");
  assert.equal(status?.configured, false);
  assert.deepEqual(status?.models, []);
});

test("login interaction emits prompt/completion without credential material", async () => {
  const runtime = new FakeOAuthRuntime();
  const service = new YishuAuthService(Promise.resolve(runtime));
  const events: AuthServiceEvent[] = [];
  const login = service.startLogin(
    { requestId: "b3a7a0f4-68bf-4d05-b9a5-2b08dc8b7ea1", traceId: "3b73e4d1-0c48-4936-b4c4-b7a4a770cd61" },
    "xai",
    (event) => events.push(event),
  );

  const promptEvent = await waitForEvent(events, "auth.prompt");
  assert.equal(promptEvent.type, "auth.prompt");
  if (promptEvent.type !== "auth.prompt") throw new Error("prompt event missing");
  assert.equal(service.replyPrompt(
    "b3a7a0f4-68bf-4d05-b9a5-2b08dc8b7ea1",
    "xai",
    promptEvent.payload.promptId,
    "one-time-code",
  ), true);
  await login;

  assert.ok(events.some((event) => event.type === "auth.url"));
  const completed = events.find((event) => event.type === "auth.completed");
  assert.ok(completed);
  const wire = JSON.stringify(events);
  assert.doesNotMatch(wire, /ACCESS_VALUE|REFRESH_VALUE|ACCOUNT_ID/);
  assert.match(wire, /grok-4\.3/);
});

test("Pi auth info, progress, and instructions redact account and token markers", async () => {
  const runtime = new FakeOAuthRuntime();
  runtime.login = async (_providerId, _type, interaction) => {
    interaction.notify({
      type: "info",
      message: "account_id=acct-secret credential=credential-secret token=plain-secret secret=plain-secret",
    });
    interaction.notify({ type: "progress", message: "Authorization: Bearer bearer-secret" });
    interaction.notify({
      type: "auth_url",
      url: "https://auth.example.test/authorize?code_challenge=public",
      instructions: "client_secret=client-secret",
    });
    const code = await interaction.prompt({ type: "manual_code", message: "Paste the one-time code." });
    assert.equal(code, "one-time-code");
    runtime.configured = true;
  };
  const service = new YishuAuthService(Promise.resolve(runtime));
  const events: AuthServiceEvent[] = [];
  const login = service.startLogin(
    { requestId: "5cc3c4c1-68f8-4b2f-9a2d-94b1d9b0e0c2", traceId: "6ca7e3ad-9e6b-4cc9-a5e7-5d58b9cc75cd" },
    "xai",
    (event) => events.push(event),
  );
  const promptEvent = await waitForEvent(events, "auth.prompt");
  if (promptEvent.type !== "auth.prompt") throw new Error("prompt event missing");
  assert.equal(service.replyPrompt(
    "5cc3c4c1-68f8-4b2f-9a2d-94b1d9b0e0c2",
    "xai",
    promptEvent.payload.promptId,
    "one-time-code",
  ), true);
  await login;
  const wire = JSON.stringify(events);
  assert.doesNotMatch(wire, /acct-secret|credential-secret|plain-secret|bearer-secret|client-secret/);
  assert.match(wire, /请按提示完成登录|正在完成登录/);
});

test("cancel aborts the pending OAuth prompt and emits a typed failure", async () => {
  const runtime = new FakeOAuthRuntime();
  const service = new YishuAuthService(Promise.resolve(runtime));
  const events: AuthServiceEvent[] = [];
  const login = service.startLogin(
    { requestId: "f1eeb04e-1fa0-42a0-a4d5-8a7d2dbf0cdf", traceId: "0f8d74e4-9f15-42cf-86d7-e9f1b5d91f2f" },
    "openai-codex",
    (event) => events.push(event),
  );
  await waitForEvent(events, "auth.prompt");
  assert.equal(service.cancelLogin("f1eeb04e-1fa0-42a0-a4d5-8a7d2dbf0cdf", "openai-codex"), true);
  await login;
  const failed = events.find((event) => event.type === "auth.failed");
  assert.ok(failed);
  if (failed?.type === "auth.failed") assert.equal(failed.payload.code, "cancelled");
});

test("an existing usable OAuth account requires logout before account switching", async () => {
  const runtime = new FakeOAuthRuntime();
  runtime.configured = true;
  const service = new YishuAuthService(Promise.resolve(runtime));
  const events: AuthServiceEvent[] = [];
  await service.startLogin(
    { requestId: "56f79091-4f08-4640-8ce2-d28b625e6e2e", traceId: "0c27f1d4-8c9b-4b7c-8791-6f6e0b3c47d6" },
    "xai",
    (event) => events.push(event),
  );
  const failed = events.find((event) => event.type === "auth.failed");
  assert.equal(failed?.payload.code, "invalid_request");
  assert.equal(runtime.configured, true, "A must remain configured until explicit logout");
});

test("cancel after a provider ignores AbortSignal cannot emit completed or retain its credential", async () => {
  const runtime = new FakeOAuthRuntime();
  runtime.login = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    runtime.configured = true;
    return {
      type: "oauth",
      access: "CANCELLED_ACCESS_VALUE",
      refresh: "CANCELLED_REFRESH_VALUE",
      expires: Date.now() + 60_000,
    };
  };
  const service = new YishuAuthService(Promise.resolve(runtime));
  const events: AuthServiceEvent[] = [];
  const login = service.startLogin(
    { requestId: "89d4e7b2-43ae-49f7-b38c-042711a4b1b2", traceId: "d1e87198-23e8-4709-bc94-bf3b80cec29a" },
    "xai",
    (event) => events.push(event),
  );
  assert.equal(service.cancelLogin("89d4e7b2-43ae-49f7-b38c-042711a4b1b2", "xai"), true);
  await login;
  assert.equal(events.some((event) => event.type === "auth.completed"), false);
  assert.equal(events.find((event) => event.type === "auth.failed")?.payload.code, "cancelled");
  assert.equal(runtime.configured, false);
});

test("one provider cannot run two OAuth logins concurrently", async () => {
  const runtime = new FakeOAuthRuntime();
  const service = new YishuAuthService(Promise.resolve(runtime));
  const firstEvents: AuthServiceEvent[] = [];
  const secondEvents: AuthServiceEvent[] = [];
  const first = service.startLogin(
    { requestId: "aafcc8e9-f70e-4b43-a6e6-e7d15f35a10a", traceId: "7b980fab-5f98-4daa-b7d3-eab468bd4d5f" },
    "xai",
    (event) => firstEvents.push(event),
  );
  const second = service.startLogin(
    { requestId: "da53cdb4-e3be-41f6-9758-b4c9b5f8bca5", traceId: "a1ac8c88-0af6-4382-9a2e-fae83204f64c" },
    "xai",
    (event) => secondEvents.push(event),
  );
  await second;
  assert.equal(secondEvents.find((event) => event.type === "auth.failed")?.payload.code, "invalid_request");
  assert.equal(service.cancelLogin("aafcc8e9-f70e-4b43-a6e6-e7d15f35a10a", "xai"), true);
  await first;
  assert.ok(firstEvents.some((event) => event.type === "auth.failed"));
});

test("logout waits for a late login completion before removing credentials", async () => {
  const runtime = new FakeOAuthRuntime();
  runtime.login = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    // Simulate a provider that finishes one final poll after cancellation.
    runtime.configured = true;
    return {
      type: "oauth",
      access: "LATE_ACCESS_VALUE",
      refresh: "LATE_REFRESH_VALUE",
      expires: Date.now() + 60_000,
    };
  };
  const service = new YishuAuthService(Promise.resolve(runtime));
  const loginEvents: AuthServiceEvent[] = [];
  const logoutEvents: AuthServiceEvent[] = [];
  const login = service.startLogin(
    { requestId: "4b3fb063-20ee-4a4d-ab55-0e6e9e65f51d", traceId: "49ca857b-8f25-43c4-8ba7-31dba2750d49" },
    "xai",
    (event) => loginEvents.push(event),
  );
  const logout = service.logout(
    { requestId: "dcb5207d-815d-4265-923c-37fba1fcc7aa", traceId: "63f8f4af-5dbe-4562-8faf-8a3df2dc779a" },
    "xai",
    (event) => logoutEvents.push(event),
  );
  await Promise.all([login, logout]);
  assert.equal(loginEvents.some((event) => event.type === "auth.completed"), false);
  assert.equal(runtime.configured, false, "late login must not revive credentials after logout");
  assert.ok(logoutEvents.some((event) => event.type === "auth.logged_out"));
  assert.doesNotMatch(JSON.stringify(logoutEvents), /LATE_ACCESS|LATE_REFRESH/);
});

test("status reports credential storage failures as typed terminal errors", async () => {
  const runtime = new FakeOAuthRuntime();
  runtime.checkAuth = async () => {
    throw new Error("credential store permission denied");
  };
  const service = new YishuAuthService(Promise.resolve(runtime));
  await assert.rejects(service.status("xai"), (error: unknown) => {
    assert.ok(error instanceof AuthServiceError);
    assert.equal(error.code, "storage_failed");
    assert.doesNotMatch(error.message, /auth\.json|permission/);
    return true;
  });
});

test("product credential store uses Yishu path and restrictive permissions", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "yishu-auth-test-"));
  const authPath = path.join(tempDirectory, "Auth", "auth.json");
  try {
    const store = new ProductCredentialStore(authPath);
    await store.modify("xai", async () => ({
      type: "oauth",
      access: "ACCESS_TEST_ONLY",
      refresh: "REFRESH_TEST_ONLY",
      expires: Date.now() + 60_000,
    }));
    const directoryMode = (await stat(path.dirname(authPath))).mode & 0o777;
    const fileMode = (await stat(authPath)).mode & 0o777;
    assert.equal(directoryMode, 0o700);
    assert.equal(fileMode, 0o600);
    assert.deepEqual(await store.list(), [{ providerId: "xai", type: "oauth" }]);
    assert.match(await readFile(authPath, "utf8"), /"type": "oauth"/);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
  assert.match(resolveYishuAuthPath("/tmp/yishu-home"), /Library\/Application Support\/Yishu\/Auth\/auth\.json$/);
  const memory = new InMemoryCredentialStore();
  assert.deepEqual(await memory.list(), []);
});

test("product credential store removes only old restrictive auth temp files after locking", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "yishu-auth-temp-test-"));
  const authPath = path.join(tempDirectory, "Auth", "auth.json");
  try {
    const store = new ProductCredentialStore({
      authPath,
      lockStaleMs: 30,
      lockWaitMs: 500,
      lockHeartbeatMs: 10,
    });
    await store.modify("xai", async () => ({
      type: "oauth",
      access: "ACCESS_TEMP_TEST",
      refresh: "REFRESH_TEMP_TEST",
      expires: Date.now() + 60_000,
    }));

    const staleTempPath = `${authPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(staleTempPath, "credential-shaped temp content", { mode: 0o600 });
    await chmod(staleTempPath, 0o600);
    const old = new Date(Date.now() - 500);
    await utimes(staleTempPath, old, old);
    await store.modify("xai", async (current) => current);

    const entries = await readdir(path.dirname(authPath));
    assert.equal(entries.includes(path.basename(staleTempPath)), false);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("active auth lock heartbeat prevents a slow refresh from being reclaimed", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "yishu-auth-lock-test-"));
  const authPath = path.join(tempDirectory, "Auth", "auth.json");
  let releaseCallback!: () => void;
  const callbackReleased = new Promise<void>((resolve) => { releaseCallback = resolve; });
  let lockHeld!: () => void;
  const lockStarted = new Promise<void>((resolve) => { lockHeld = resolve; });
  try {
    const options = { authPath, lockStaleMs: 30, lockWaitMs: 90, lockHeartbeatMs: 8 };
    const firstStore = new ProductCredentialStore(options);
    const secondStore = new ProductCredentialStore(options);
    const first = firstStore.modify("xai", async () => {
      lockHeld();
      await callbackReleased;
      return {
        type: "oauth" as const,
        access: "ACCESS_LOCK_TEST",
        refresh: "REFRESH_LOCK_TEST",
        expires: Date.now() + 60_000,
      };
    });
    await lockStarted;

    const lockPath = `${authPath}.lock`;
    const before = (await stat(lockPath)).mtimeMs;
    await new Promise<void>((resolve) => setTimeout(resolve, 55));
    const after = (await stat(lockPath)).mtimeMs;
    assert.ok(after > before, "the lock mtime should be refreshed while callback is running");

    await assert.rejects(
      secondStore.modify("xai", async () => ({
        type: "oauth",
        access: "SHOULD_NOT_WRITE",
        refresh: "SHOULD_NOT_WRITE",
        expires: Date.now() + 60_000,
      })),
      /Auth storage is busy/,
    );
    releaseCallback();
    await first;
  } finally {
    releaseCallback?.();
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("auth status watchdog emits one timeout and consumes a late result", async () => {
  let resolveStatus!: () => void;
  const statusOperation = new Promise<void>((resolve) => { resolveStatus = resolve; });
  const events: string[] = [];
  const result = await runAuthWatchdog(statusOperation, 10, () => events.push("timeout"));
  assert.deepEqual(result, { timedOut: true });
  resolveStatus();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["timeout"]);
});

test("logout watchdog keeps the provider transition until late cleanup settles", async () => {
  const runtime = new FakeOAuthRuntime();
  runtime.configured = true;
  let resolveLogout!: () => void;
  runtime.logout = async () => {
    await new Promise<void>((resolve) => { resolveLogout = resolve; });
    runtime.configured = false;
  };
  const service = new YishuAuthService(Promise.resolve(runtime));
  let emitAllowed = true;
  const visibleEvents: AuthServiceEvent[] = [];
  const logout = service.logout(
    { requestId: "bde20c5a-1c4f-4d20-a889-5470514d55ee", traceId: "630f026b-9e4a-4fd7-9e34-73c1d2377fa8" },
    "xai",
    (event) => {
      if (emitAllowed) visibleEvents.push(event);
    },
  );
  const result = await runAuthWatchdog(logout, 10, () => { emitAllowed = false; });
  assert.deepEqual(result, { timedOut: true });

  const loginEvents: AuthServiceEvent[] = [];
  await service.startLogin(
    { requestId: "5b90357d-1e9e-4c64-99f3-4ecaf2df2c5a", traceId: "edbbf211-a5b5-4599-80af-ae976b26d94e" },
    "xai",
    (event) => loginEvents.push(event),
  );
  assert.equal(loginEvents.find((event) => event.type === "auth.failed")?.payload.code, "invalid_request");

  resolveLogout();
  await logout;
  assert.equal(visibleEvents.some((event) => event.type === "auth.logged_out"), false);
});
