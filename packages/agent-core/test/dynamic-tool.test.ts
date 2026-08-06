import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  applyTemplate,
  buildDynamicTool,
  createCreateToolTool,
  DynamicToolStore,
  loadAndRegisterDynamicTools,
  registerDynamicTool,
  validateDynamicToolName,
  DYNAMIC_TOOL_NAME_RE,
} from "../src/tools/dynamic.js";
import { ToolRegistry } from "../src/tools/registry.js";
import {
  buildCatalog,
  selectToolsForTask,
} from "../src/tools/discovery.js";
import { DeterministicLlm, resetLlmSeq } from "../src/llm.js";
import { YishuAgent } from "../src/harness.js";
import type { ToolDefinition } from "../src/types.js";

describe("dynamic tools (ch5 meta-bootstrap)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "yishu-dyn-"));
    resetLlmSeq();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("validates tool names", () => {
    assert.ok(DYNAMIC_TOOL_NAME_RE.test("foo"));
    assert.ok(DYNAMIC_TOOL_NAME_RE.test("greet_user"));
    assert.throws(() => validateDynamicToolName("A"), /Invalid/);
    assert.throws(() => validateDynamicToolName("x"), /Invalid/); // too short: need 2+
    assert.throws(() => validateDynamicToolName("mcp_echo"), /reserved|mcp_/);
    assert.throws(() => validateDynamicToolName("create_tool"), /builtin/);
    assert.throws(() => validateDynamicToolName("1bad"), /Invalid/);
  });

  it("echo kind returns args as JSON", async () => {
    const reg = new ToolRegistry();
    const tool = registerDynamicTool(reg, {
      name: "echo_me",
      description: "echo args",
      kind: "echo",
      body: "",
    });
    assert.equal(tool.name, "echo_me");
    const r = await reg.execute("echo_me", { a: 1, b: "hi" });
    assert.equal(r.ok, true);
    assert.match(r.content, /"a": 1/);
    assert.match(r.content, /"b": "hi"/);
    assert.equal(r.evidence?.dynamic, true);
  });

  it("const kind returns fixed body", async () => {
    const reg = new ToolRegistry();
    registerDynamicTool(reg, {
      name: "say_hi",
      description: "fixed greeting",
      kind: "const",
      body: "hello-yishu",
    });
    const r = await reg.execute("say_hi", { ignored: true });
    assert.equal(r.ok, true);
    assert.equal(r.content, "hello-yishu");
  });

  it("template kind substitutes {{key}} from args", async () => {
    assert.equal(applyTemplate("Hi {{name}}!", { name: "奕枢" }), "Hi 奕枢!");
    assert.equal(applyTemplate("{{a}}-{{b}}", { a: "1" }), "1-");

    const reg = new ToolRegistry();
    registerDynamicTool(reg, {
      name: "greet",
      description: "greet template",
      kind: "template",
      body: "Hello {{who}} from {{where}}",
    });
    const r = await reg.execute("greet", { who: "user", where: "offline" });
    assert.equal(r.ok, true);
    assert.equal(r.content, "Hello user from offline");
  });

  it("DynamicToolStore persists and reloads", async () => {
    const storePath = join(tmp, "dynamic-tools.json");
    const store = new DynamicToolStore(storePath);
    await store.upsert({
      name: "persist_me",
      description: "persisted",
      kind: "const",
      body: "stored-value",
    });
    const raw = await readFile(storePath, "utf8");
    assert.match(raw, /persist_me/);

    const store2 = new DynamicToolStore(storePath);
    const loaded = await store2.load();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.name, "persist_me");
    assert.equal(loaded[0]?.body, "stored-value");
  });

  it("create_tool registers, persists, and is callable", async () => {
    const storePath = join(tmp, "dynamic-tools.json");
    const store = new DynamicToolStore(storePath);
    const reg = new ToolRegistry();
    reg.register(createCreateToolTool({ registry: reg, store }));

    const created = await reg.execute("create_tool", {
      name: "my_const",
      description: "a const tool",
      kind: "const",
      body: "payload-42",
    });
    assert.equal(created.ok, true);
    assert.match(created.content, /"created"\s*:\s*true/);
    assert.ok(reg.get("my_const"));

    const run = await reg.execute("my_const", {});
    assert.equal(run.ok, true);
    assert.equal(run.content, "payload-42");

    const disk = JSON.parse(await readFile(storePath, "utf8")) as unknown[];
    assert.equal(disk.length, 1);
  });

  it("create_tool rejects reserved / invalid names", async () => {
    const store = new DynamicToolStore(join(tmp, "dynamic-tools.json"));
    const reg = new ToolRegistry();
    reg.register(createCreateToolTool({ registry: reg, store }));

    const bad = await reg.execute("create_tool", {
      name: "mcp_hack",
      description: "nope",
      kind: "const",
      body: "x",
    });
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? "", /reserved|mcp_/);

    const badKind = await reg.execute("create_tool", {
      name: "ok_name",
      description: "nope",
      kind: "eval",
      body: "x",
    });
    assert.equal(badKind.ok, false);
    assert.match(badKind.error ?? "", /kind/i);
  });

  it("loadAndRegisterDynamicTools restores from disk", async () => {
    const storePath = join(tmp, "dynamic-tools.json");
    await writeFile(
      storePath,
      JSON.stringify(
        [
          {
            name: "restored",
            description: "from disk",
            kind: "template",
            body: "n={{n}}",
          },
        ],
        null,
        2,
      ),
      "utf8",
    );
    const store = new DynamicToolStore(storePath);
    const reg = new ToolRegistry();
    const names = await loadAndRegisterDynamicTools(reg, store);
    assert.deepEqual(names, ["restored"]);
    const r = await reg.execute("restored", { n: "9" });
    assert.equal(r.content, "n=9");
  });

  it("discovery maps 创建工具|create_tool|自定义工具 to create_tool", () => {
    const tools: ToolDefinition[] = [
      {
        name: "create_tool",
        description: "create dynamic tool",
        category: "execution",
        parameters: { type: "object", properties: {} },
        async execute() {
          return { ok: true, content: "ok" };
        },
      },
      {
        name: "code_exec",
        description: "math",
        category: "execution",
        parameters: { type: "object", properties: {} },
        async execute() {
          return { ok: true, content: "ok" };
        },
      },
      {
        name: "ask_user",
        description: "ask",
        category: "communication",
        parameters: { type: "object", properties: {} },
        async execute() {
          return { ok: true, content: "ok" };
        },
      },
    ];
    const catalog = buildCatalog(tools);
    const createEntry = catalog.find((c) => c.name === "create_tool");
    assert.ok(createEntry?.tags.includes("create_tool"));
    assert.ok(createEntry?.tags.includes("meta"));

    for (const task of ["创建工具 foo", "create_tool name=bar", "自定义工具 baz"]) {
      const selected = selectToolsForTask(task, catalog, tools);
      const names = selected.map((t) => t.name);
      assert.ok(names.includes("create_tool"), `task=${task} got ${names}`);
    }
  });

  it("DeterministicLlm routes 创建工具 / create_tool", async () => {
    const llm = new DeterministicLlm();
    const createTool: ToolDefinition = {
      name: "create_tool",
      description: "meta",
      category: "execution",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { ok: true, content: "ok" };
      },
    };

    const r1 = await llm.complete(
      [{ role: "user", content: "创建工具 greet kind=const body=hello" }],
      [createTool],
    );
    assert.equal(r1.type, "tool_calls");
    if (r1.type === "tool_calls") {
      assert.equal(r1.toolCalls[0]?.name, "create_tool");
      assert.equal(r1.toolCalls[0]?.arguments.name, "greet");
      assert.equal(r1.toolCalls[0]?.arguments.kind, "const");
      assert.equal(r1.toolCalls[0]?.arguments.body, "hello");
    }

    resetLlmSeq();
    const llm2 = new DeterministicLlm();
    const r2 = await llm2.complete(
      [
        {
          role: "user",
          content: "create_tool name=echo_it kind=echo body= description=d",
        },
      ],
      [createTool],
    );
    assert.equal(r2.type, "tool_calls");
    if (r2.type === "tool_calls") {
      assert.equal(r2.toolCalls[0]?.name, "create_tool");
      assert.equal(r2.toolCalls[0]?.arguments.name, "echo_it");
      assert.equal(r2.toolCalls[0]?.arguments.kind, "echo");
    }
  });

  it("YishuAgent init loads dynamic tools and create_tool works end-to-end", async () => {
    const workspaceDir = join(tmp, "ws");
    const skillsDir = join(tmp, "skills");
    const dataDir = join(tmp, "data");
    const memoryPath = join(dataDir, "memory.json");
    await mkdir(dataDir, { recursive: true });
    // Pre-seed a dynamic tool on disk
    const dynPath = join(dataDir, "dynamic-tools.json");
    await writeFile(
      dynPath,
      JSON.stringify(
        [
          {
            name: "preloaded",
            description: "seed",
            kind: "const",
            body: "from-disk",
          },
        ],
        null,
        2,
      ),
      "utf8",
    );

    const agent = new YishuAgent({
      workspaceDir,
      skillsDir,
      memoryPath,
      enableReview: false,
      enableAutoSkillDraft: false,
      enableTrajectoryVerify: false,
      maxIterations: 4,
    });
    await agent.init();
    assert.ok(agent.tools.get("create_tool"));
    assert.ok(agent.tools.get("preloaded"));
    assert.ok(agent.dynamicToolNames.includes("preloaded"));

    const r = await agent.tools.execute("preloaded", {});
    assert.equal(r.content, "from-disk");

    const run = await agent.run(
      "创建工具 hello_const kind=const body=你好奕枢",
    );
    assert.ok(run.toolsUsed.includes("create_tool"));
    assert.ok(agent.tools.get("hello_const"));
    const called = await agent.tools.execute("hello_const", {});
    assert.equal(called.content, "你好奕枢");

    // Persisted next to memory
    const saved = JSON.parse(
      await readFile(agent.dynamicToolsPath(), "utf8"),
    ) as Array<{ name: string }>;
    const names = saved.map((d) => d.name);
    assert.ok(names.includes("hello_const"));
    assert.ok(names.includes("preloaded"));
  });

  it("buildDynamicTool rejects invalid kind / name without eval", () => {
    assert.throws(
      () =>
        buildDynamicTool({
          name: "ok_tool",
          description: "x",
          kind: "js" as "const",
          body: "1+1",
        }),
      /kind/,
    );
  });
});
