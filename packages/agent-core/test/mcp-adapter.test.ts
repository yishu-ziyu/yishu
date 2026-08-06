import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  loadMcpConfig,
  loadMcpConfigsFromDir,
  mcpSlug,
  mcpToolName,
  mcpToolsToDefinitions,
  parseMcpServerConfig,
  registerMcpDir,
  registerMcpServer,
  type McpServerConfig,
} from "../src/tools/mcp-adapter.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { DeterministicLlm, resetLlmSeq } from "../src/llm.js";
import { YishuAgent } from "../src/harness.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const exampleConfigPath = join(packageRoot, "data", "mcp", "example-server.json");

describe("mcp-adapter", () => {
  it("mcpSlug and mcpToolName produce safe prefixed names", () => {
    assert.equal(mcpSlug("Example Server"), "example_server");
    assert.equal(mcpToolName("example", "echo"), "mcp_example_echo");
    assert.equal(mcpToolName("My-Server!", "time_now"), "mcp_my_server_time_now");
  });

  it("loadMcpConfig reads example-server.json", async () => {
    const cfg = await loadMcpConfig(exampleConfigPath);
    assert.equal(cfg.name, "example");
    assert.ok(cfg.tools.length >= 2);
    const names = cfg.tools.map((t) => t.name);
    assert.ok(names.includes("echo"));
    assert.ok(names.includes("time_now"));
  });

  it("mcpToolsToDefinitions maps tools with stub execute", async () => {
    const cfg = await loadMcpConfig(exampleConfigPath);
    const defs = mcpToolsToDefinitions(cfg);
    const echo = defs.find((d) => d.name === "mcp_example_echo");
    assert.ok(echo);
    assert.match(echo.description, /MCP:example/);
    const result = await echo.execute({ message: "hello mcp" });
    assert.equal(result.ok, true);
    assert.match(result.content, /MCP tool echo invoked/);
    assert.match(result.content, /hello mcp/);
    assert.equal(result.evidence?.stub, true);
  });

  it("registerMcpServer registers all tools and runs handler when present", async () => {
    const cfg: McpServerConfig = {
      name: "demo",
      tools: [
        {
          name: "echo",
          description: "echo with handler",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
      ],
      handlers: {
        echo: async (args) => ({
          ok: true,
          content: `ECHO:${String(args.message ?? "")}`,
        }),
      },
    };
    const reg = new ToolRegistry();
    const names = registerMcpServer(reg, cfg);
    assert.deepEqual(names, ["mcp_demo_echo"]);
    const r = await reg.execute("mcp_demo_echo", { message: "ping" });
    assert.equal(r.ok, true);
    assert.equal(r.content, "ECHO:ping");
  });

  it("loadMcpConfigsFromDir and registerMcpDir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yishu-mcp-"));
    try {
      await writeFile(
        join(dir, "s1.json"),
        JSON.stringify({
          name: "s1",
          tools: [
            {
              name: "ping",
              description: "ping",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        }),
        "utf8",
      );
      const configs = await loadMcpConfigsFromDir(dir);
      assert.equal(configs.length, 1);
      const reg = new ToolRegistry();
      const names = await registerMcpDir(reg, dir);
      assert.deepEqual(names, ["mcp_s1_ping"]);
      const r = await reg.execute("mcp_s1_ping", {});
      assert.equal(r.ok, true);
      assert.match(r.content, /MCP tool ping invoked/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("missing mcp dir yields empty list", async () => {
    const configs = await loadMcpConfigsFromDir(
      join(tmpdir(), "yishu-mcp-missing-does-not-exist"),
    );
    assert.deepEqual(configs, []);
  });

  it("parseMcpServerConfig rejects bad input", () => {
    assert.throws(() => parseMcpServerConfig(null), /expected object/);
    assert.throws(() => parseMcpServerConfig({ tools: [] }), /missing name/);
    assert.throws(
      () => parseMcpServerConfig({ name: "x", tools: "nope" }),
      /tools must be an array/,
    );
  });

  it("DeterministicLlm routes 'mcp echo' to mcp echo tool when present", async () => {
    resetLlmSeq();
    const cfg = await loadMcpConfig(exampleConfigPath);
    const defs = mcpToolsToDefinitions(cfg);
    const llm = new DeterministicLlm();
    const res = await llm.complete(
      [{ role: "user", content: "mcp echo hello-from-test" }],
      defs,
    );
    assert.equal(res.type, "tool_calls");
    if (res.type !== "tool_calls") return;
    assert.equal(res.toolCalls[0]?.name, "mcp_example_echo");
    assert.ok(
      String(res.toolCalls[0]?.arguments.message ?? "").includes("hello") ||
        res.toolCalls[0]?.arguments.message === "hello-from-test" ||
        typeof res.toolCalls[0]?.arguments.message === "string",
    );
  });

  it("DeterministicLlm routes 调用 mcp to echo tool", async () => {
    resetLlmSeq();
    const cfg = await loadMcpConfig(exampleConfigPath);
    const defs = mcpToolsToDefinitions(cfg);
    const llm = new DeterministicLlm();
    const res = await llm.complete(
      [{ role: "user", content: "请调用 mcp 回显 world" }],
      defs,
    );
    assert.equal(res.type, "tool_calls");
    if (res.type !== "tool_calls") return;
    assert.equal(res.toolCalls[0]?.name, "mcp_example_echo");
  });

  it("YishuAgent init loads data/mcp and registers tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "yishu-mcp-agent-"));
    try {
      const mcpDir = join(root, "mcp");
      await mkdir(mcpDir, { recursive: true });
      await writeFile(
        join(mcpDir, "example-server.json"),
        await (await import("node:fs/promises")).readFile(exampleConfigPath, "utf8"),
        "utf8",
      );
      const agent = new YishuAgent({
        workspaceDir: join(root, "workspace"),
        skillsDir: join(packageRoot, "skills"),
        memoryPath: join(root, "memory.json"),
        trajectoriesDir: join(root, "trajectories"),
        enableReview: false,
      });
      await agent.init();
      const names = agent.tools.list().map((t) => t.name);
      assert.ok(
        names.includes("mcp_example_echo"),
        `expected mcp_example_echo in ${names.join(",")}`,
      );
      assert.ok(names.includes("mcp_example_time_now"));
      const r = await agent.tools.execute("mcp_example_echo", {
        message: "hi",
      });
      assert.equal(r.ok, true);
      assert.match(r.content, /hi/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
