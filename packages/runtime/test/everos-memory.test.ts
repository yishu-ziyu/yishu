import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  createYishuKernel,
  isVisibleFactSuppressed,
  type EverOSAddInput,
  type EverOSMemoryPort,
  type RecalledMemory,
} from "@yishu/kernel";
import { ProductKernelRuntime } from "../src/product-kernel-runtime.js";
import { MockAgentRuntime } from "../src/mock-runtime.js";
import type { TurnContextProviderFactory } from "../src/model-loop/turn-context.js";
import {
  EverOSSidecar,
  everosEnabled,
  explicitEverOSUrl,
  resolveAttachedEverOSIdentity,
  resolveEverOSBaseUrl,
  resolveEverOSLlmEnv,
  resolveEverOSRoot,
} from "../src/everos-sidecar.js";
import { migrateLegacyEverOSUserMemory } from "../src/everos-migration.js";
import { makeTurnStartCommand } from "./fixtures.js";

class FakeEverOS implements EverOSMemoryPort {
  adds: EverOSAddInput[] = [];
  flushes: Array<{ sessionId: string; scopeKey: string }> = [];
  searchHits: RecalledMemory[] = [];
  profileHits: RecalledMemory[] = [];
  searches: string[] = [];
  profileCalls = 0;

  async add(input: EverOSAddInput): Promise<void> {
    this.adds.push(input);
  }

  async flush(input: { sessionId: string; scopeKey: string }): Promise<void> {
    this.flushes.push(input);
  }

  async search(input: { query: string }): Promise<RecalledMemory[]> {
    this.searches.push(input.query);
    return this.searchHits;
  }

  async profile(): Promise<RecalledMemory[]> {
    this.profileCalls += 1;
    return this.profileHits;
  }
}

class ContextCapturingRuntime extends MockAgentRuntime {
  private turnContextProviderFactory: TurnContextProviderFactory | undefined;
  assembledMemory: string | undefined;

  setTurnContextProviderFactory(factory: TurnContextProviderFactory): void {
    this.turnContextProviderFactory = factory;
  }

  override async startTurn(...args: Parameters<MockAgentRuntime["startTurn"]>): Promise<void> {
    const [command] = args;
    const providers = this.turnContextProviderFactory?.(
      command.payload.sessionScope?.kind ?? "personal",
      command.payload.conversationId ?? command.requestId,
    );
    this.assembledMemory = await providers?.assembleTurnMemory?.(command.payload.utterance);
    await super.startTurn(...args);
  }
}

async function makeRuntime(
  t: TestContext,
  everos?: EverOSMemoryPort,
  inner: MockAgentRuntime = new MockAgentRuntime(),
): Promise<ProductKernelRuntime> {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "yishu-everos-mem-"));
  const storeDir = await mkdtemp(path.join(tmpdir(), "yishu-everos-store-"));
  t.after(async () => {
    await Promise.all([
      rm(memoryDir, { recursive: true, force: true }),
      rm(storeDir, { recursive: true, force: true }),
    ]);
  });
  const kernel = createYishuKernel({
    storeBackend: "sqlite",
    sqlitePath: path.join(storeDir, "s.sqlite"),
    memoryDir,
  });
  const runtime = new ProductKernelRuntime(inner, kernel, undefined, {
    ...(everos !== undefined ? { everos } : {}),
  });
  t.after(() => runtime.dispose());
  return runtime;
}

test("ordinary completed turns are buffered in EverOS without rewriting the visible file", async (t) => {
  const everos = new FakeEverOS();
  everos.searchHits = [{
    id: "ev-1",
    claim: "春天去优胜美地攀岩",
    summary: "春天去优胜美地攀岩",
    source: "conversation",
    capturedAt: "2026-08-18T10:00:00.000Z",
    scope: "personal",
    confidence: 0.8,
  }];
  const runtime = await makeRuntime(t, everos);
  const command = makeTurnStartCommand();
  command.payload.utterance = "我春天都去优胜美地攀岩";
  command.payload.conversationId = "conv-everos-1";
  command.payload.modelPreference = { provider: "openai-codex", model: "gpt-5.4" };
  await runtime.startTurn(command, () => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(everos.adds.length, 1);
  assert.equal(everos.adds[0]?.sessionId, "conv-everos-1");
  assert.equal(everos.adds[0]?.scopeKey, "personal");
  assert.equal(everos.adds[0]?.deferExtraction, true);
  assert.equal(everos.adds[0]?.messages[0]?.content, "我春天都去优胜美地攀岩");
  assert.equal(everos.flushes.length, 0);
  const rows = await runtime.kernel.memory?.queue.listReplayable();
  assert.equal(rows?.length ?? 0, 0);
  const visible = await runtime.kernel.memory?.visible.readText();
  assert.doesNotMatch(visible ?? "", /春天去优胜美地攀岩/);
});

test("fake EverOS results from another scope never reach prompt or memory.used", async (t) => {
  const everos = new FakeEverOS();
  everos.profileHits = [{
    id: "ev-profile-wrong-scope",
    claim: "另一个项目的个人资料",
    summary: "另一个项目的个人资料",
    source: "conversation",
    capturedAt: "2026-08-18T10:00:00.000Z",
    scope: "project:other",
    confidence: 0.8,
  }];
  everos.searchHits = [{
    id: "ev-search-wrong-scope",
    claim: "另一个项目的记忆",
    summary: "另一个项目的记忆",
    source: "conversation",
    capturedAt: "2026-08-18T10:00:00.000Z",
    scope: "project:other",
    confidence: 0.8,
  }, {
    id: "ev-search-missing-scope",
    claim: "缺少范围的记忆",
    summary: "缺少范围的记忆",
    source: "conversation",
    capturedAt: "2026-08-18T10:00:00.000Z",
    scope: undefined,
    confidence: 0.8,
  } as unknown as RecalledMemory];
  const inner = new ContextCapturingRuntime();
  const runtime = await makeRuntime(t, everos, inner);
  const events: Array<{ type: string }> = [];
  const command = makeTurnStartCommand();
  command.payload.utterance = "我希望你怎么回答？";
  command.payload.conversationId = "conv-everos-wrong-scope";
  await runtime.startTurn(command, (event) => events.push(event));

  assert.equal(inner.assembledMemory, undefined);
  assert.ok(!events.some((event) => event.type === "memory.used"));
});

test("private turns never call EverOS", async (t) => {
  const everos = new FakeEverOS();
  const runtime = await makeRuntime(t, everos);
  const command = makeTurnStartCommand();
  command.payload.utterance = "私密问题";
  command.payload.conversationId = "conv-everos-private";
  command.payload.sessionScope = { kind: "private" };
  command.payload.modelPreference = { provider: "openai-codex", model: "gpt-5.4" };
  await runtime.startTurn(command, () => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(everos.adds.length, 0);
  assert.equal(everos.flushes.length, 0);
});

test("a user-deleted visible fact suppresses a semantically similar EverOS candidate", async (t) => {
  const everos = new FakeEverOS();
  everos.searchHits = [{
    id: "ev-similar",
    claim: "我住在深圳市",
    summary: "我住在深圳市",
    source: "conversation",
    capturedAt: "2026-08-18T10:00:00.000Z",
    scope: "personal",
    confidence: 0.8,
  }];
  const runtime = await makeRuntime(t, everos);
  await runtime.initialize();
  const visible = runtime.kernel.memory?.visible;
  assert.ok(visible);
  await visible.appendFacts(["用户现居深圳"]);
  await writeFile(visible.filePath, "# 记忆\n\n", "utf8");

  const events: Array<{ type: string }> = [];
  const command = makeTurnStartCommand();
  command.payload.utterance = "我住在哪里？";
  command.payload.conversationId = "conv-everos-similar-deleted";
  await runtime.startTurn(command, (event) => events.push(event));
  assert.ok(everos.searches.includes("我住在哪里？"));
  assert.ok(!events.some((event) => event.type === "memory.used"));
});

test("a user-deleted visible fact suppresses the same EverOS candidate", async (t) => {
  const everos = new FakeEverOS();
  everos.searchHits = [{
    id: "ev-deleted",
    claim: "用户现居深圳",
    summary: "用户现居深圳",
    source: "conversation",
    capturedAt: "2026-08-18T10:00:00.000Z",
    scope: "personal",
    confidence: 0.8,
  }];
  const runtime = await makeRuntime(t, everos);
  await runtime.initialize();
  const visible = runtime.kernel.memory?.visible;
  assert.ok(visible);
  await visible.appendFacts(["用户现居深圳"]);
  await visible.reconcileAuthority();
  await writeFile(visible.filePath, "# 记忆\n\n", "utf8");

  const events: Array<{ type: string }> = [];
  const command = makeTurnStartCommand();
  command.payload.utterance = "我住在哪里？";
  command.payload.conversationId = "conv-everos-deleted";
  await runtime.startTurn(command, (event) => events.push(event));
  assert.ok(everos.searches.includes("我住在哪里？"));
  assert.ok(!events.some((event) => event.type === "memory.used"));
});

test("panel forget removes the visible fact and records its suppression", async (t) => {
  const runtime = await makeRuntime(t, new FakeEverOS());
  await runtime.initialize();
  const remembered = await runtime.kernel.registry.invoke("remember", {
    caller: "ui",
    input: { claim: "用户喜欢无糖咖啡", scope: "personal" },
  });
  assert.equal(remembered.status, "verified");
  const memoryId = (remembered.output as { id: string }).id;
  const events: Array<{ type: string }> = [];
  await runtime.forgetMemory({
    schemaVersion: 1,
    type: "memory.forget",
    requestId: "11111111-1111-4111-8111-111111111111",
    traceId: "22222222-2222-4222-8222-222222222222",
    sentAt: new Date().toISOString(),
    payload: { memoryId, sessionScope: { kind: "personal" } },
  }, (event) => events.push(event));
  assert.ok(events.some((event) => event.type === "memory.forgotten"));
  const authority = await runtime.kernel.memory!.visible.reconcileAuthority();
  assert.equal(authority.facts.includes("用户喜欢无糖咖啡"), false);
  assert.equal(isVisibleFactSuppressed(authority, "用户喜欢无糖咖啡"), true);
});

test("a corrupt visible authority ledger disables derived EverOS recall", async (t) => {
  const everos = new FakeEverOS();
  everos.searchHits = [{
    id: "ev-derived",
    claim: "用户现居深圳",
    summary: "用户现居深圳",
    source: "conversation",
    capturedAt: "2026-08-18T10:00:00.000Z",
    scope: "personal",
    confidence: 0.8,
  }];
  const runtime = await makeRuntime(t, everos);
  await runtime.initialize();
  const visible = runtime.kernel.memory!.visible;
  await visible.appendFacts(["用户喜欢无糖咖啡"]);
  await writeFile(visible.authorityFilePath, "not-json", "utf8");

  const command = makeTurnStartCommand();
  command.payload.utterance = "我住在哪里？";
  command.payload.conversationId = "conv-everos-corrupt-authority";
  await runtime.startTurn(command, () => undefined);
  assert.equal(everos.profileCalls, 0);
  assert.deepEqual(everos.searches, []);
});

test("EverOS stays off unless explicitly enabled", () => {
  assert.equal(everosEnabled({}), false);
  assert.equal(everosEnabled({ YISHU_EVEROS: "1" }), true);
  assert.equal(everosEnabled({ YISHU_EVEROS: "0", YISHU_EVEROS_URL: "http://127.0.0.1:9" }), false);
  assert.equal(resolveEverOSBaseUrl({}), "http://127.0.0.1:18765");
  assert.equal(
    resolveEverOSRoot({ HOME: "/Users/example" }),
    "/Users/example/Library/Application Support/Yishu/EverOS",
  );
  assert.throws(
    () => resolveEverOSRoot({ HOME: "/Users/example", EVEROS_ROOT: "/" }),
    /everos_root_too_broad/,
  );
});

test("only an explicit URL can attach an existing EverOS", () => {
  assert.equal(explicitEverOSUrl({ YISHU_EVEROS: "1" }), undefined);
  assert.equal(
    explicitEverOSUrl({ YISHU_EVEROS_URL: "http://127.0.0.1:18000/" }),
    "http://127.0.0.1:18000",
  );
  const identity = resolveAttachedEverOSIdentity("http://127.0.0.1:18000", {});
  assert.equal(identity.appId, "yishu");
  assert.equal(identity.userId, "owner");
  assert.equal(identity.personalProjectId, "personal");
});

test("legacy EverOS markdown migrates once into the product-owned identity", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "yishu-everos-migrate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "legacy-user");
  const destination = path.join(dir, "product-root");
  const marker = path.join(dir, "legacy", ".migrated");
  await mkdir(path.join(source, "episodes"), { recursive: true });
  await writeFile(
    path.join(source, "episodes", "episode-2026-08-18.md"),
    "---\nid: episode_log_yishu_2026-08-18\nuser_id: yishu\n---\n\nentry\n",
    "utf8",
  );

  assert.equal(await migrateLegacyEverOSUserMemory({
    sourceUserRoot: source,
    destinationRoot: destination,
    markerPath: marker,
  }), 1);
  const migrated = await readFile(
    path.join(destination, "yishu", "personal", "users", "owner", "episodes", "episode-2026-08-18.md"),
    "utf8",
  );
  assert.match(migrated, /^user_id: owner$/m);
  assert.equal(await migrateLegacyEverOSUserMemory({
    sourceUserRoot: source,
    destinationRoot: destination,
    markerPath: marker,
  }), 0);
});

test("sidecar attaches only to the explicit healthy v1 server", async () => {
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const sidecar = new EverOSSidecar({
    env: {
      YISHU_EVEROS: "1",
      YISHU_EVEROS_URL: "http://127.0.0.1:18000",
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      const body = init?.body === undefined
        ? undefined
        : JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url, ...(body === undefined ? {} : { body }) });
      if (url === "http://127.0.0.1:18000/health") {
        return new Response(JSON.stringify({
          status: "ok",
          version: "1.2.3",
          capabilities: { embed: true },
          cascade: { healthy: true },
        }), { status: 200 });
      }
      if (url === "http://127.0.0.1:18000/api/v2/memory/get") {
        return new Response(JSON.stringify({
          data: {
            profiles: [{
              id: "yishu",
              profile_data: {
                explicit_info: [{ description: "用户现居深圳。" }],
              },
            }],
          },
        }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  const hits = await sidecar.memory().profile({ scopeKey: "personal" });
  assert.ok(calls.some((call) => call.url === "http://127.0.0.1:18000/health"));
  assert.ok(!calls.some((call) => call.url.includes(":18765")));
  const get = calls.find((call) => call.url.endsWith("/api/v2/memory/get"));
  assert.equal(get?.body?.app_id, "yishu");
  assert.equal(get?.body?.user_id, "owner");
  assert.equal(get?.body?.project_id, "personal");
  assert.ok(hits.some((row) => row.claim.includes("现居深圳")));
});

test("sidecar rejects an explicit server without a compatible health contract", async () => {
  const sidecar = new EverOSSidecar({
    env: {
      YISHU_EVEROS: "1",
      YISHU_EVEROS_URL: "http://127.0.0.1:18000",
    },
    fetchImpl: async () => new Response(JSON.stringify({
      status: "ok",
      capabilities: { embed: true },
    }), { status: 200 }),
  });
  await assert.rejects(
    sidecar.memory().profile({ scopeKey: "personal" }),
    /everos_explicit_unhealthy/,
  );
});

test("ordinary weather reads explicit profile facts without announcing them", async (t) => {
  const everos = new FakeEverOS();
  everos.profileHits = [{
    id: "profile:yishu:0",
    claim: "用户现居深圳。",
    summary: "用户在深圳",
    source: "observation",
    capturedAt: "2026-08-18T00:00:00.000Z",
    scope: "personal",
    confidence: 0.9,
  }];
  const runtime = await makeRuntime(t, everos);
  const command = makeTurnStartCommand();
  command.payload.utterance = "明天天气怎么样？";
  command.payload.conversationId = "conv-everos-weather";
  command.payload.modelPreference = { provider: "openai-codex", model: "gpt-5.4" };
  const events: Array<{ type: string }> = [];
  await runtime.startTurn(command, (event) => events.push(event));
  assert.ok(everos.searches.includes("明天天气怎么样？"));
  assert.equal(everos.profileCalls, 1);
  assert.ok(!events.some((event) => event.type === "memory.used"));
});

test("EverOS LLM env prefers explicit keys and does not require a toml file", async () => {
  const llm = await resolveEverOSLlmEnv({
    EVEROS_LLM__API_KEY: "test-key",
    EVEROS_LLM__BASE_URL: "https://example.test/v1",
    EVEROS_LLM__MODEL: "demo-model",
  });
  assert.equal(llm?.baseUrl, "https://example.test/v1");
  assert.equal(llm?.model, "demo-model");
  assert.equal(llm?.apiKey, "test-key");
});

test("EverOS can reuse the product-owned model gateway without another account", async () => {
  const llm = await resolveEverOSLlmEnv({}, async () => ({
    apiKey: "loopback-capability",
    baseUrl: "http://127.0.0.1:8787/v1",
    model: "grok-4.6",
  }));
  assert.deepEqual(llm, {
    apiKey: "loopback-capability",
    baseUrl: "http://127.0.0.1:8787/v1",
    model: "grok-4.6",
  });
});

test("a configured product gateway failure never falls through to ambient credentials", async () => {
  const llm = await resolveEverOSLlmEnv({
    OPENAI_API_KEY: "ambient-test-key",
  }, async () => undefined);
  assert.equal(llm, undefined);
});
