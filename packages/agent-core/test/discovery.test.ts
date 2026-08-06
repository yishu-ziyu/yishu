import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCatalog,
  formatCatalogForPrompt,
  selectToolsForTask,
  createDiscoverToolsTool,
} from "../src/tools/discovery.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolDefinition, ToolResult } from "../src/types.js";

function stub(
  name: string,
  category: ToolDefinition["category"] = "execution",
  description = `${name} stub`,
): ToolDefinition {
  return {
    name,
    description,
    category,
    parameters: { type: "object", properties: {} },
    async execute(): Promise<ToolResult> {
      return { ok: true, content: name };
    },
  };
}

const ALL_NAMES = [
  "web_search",
  "list_dir",
  "read_file",
  "write_file",
  "code_exec",
  "memory_write",
  "memory_search",
  "ask_user",
  "delegate",
] as const;

function makeAllTools(): ToolDefinition[] {
  return ALL_NAMES.map((name) => {
    if (name === "web_search" || name === "list_dir" || name === "read_file") {
      return stub(name, "perception");
    }
    if (name === "ask_user") return stub(name, "communication");
    if (name === "delegate") return stub(name, "collaboration");
    if (name === "memory_search") return stub(name, "perception");
    return stub(name, "execution");
  });
}

describe("tool discovery", () => {
  it("buildCatalog maps tools to name/description/category/tags", () => {
    const tools = makeAllTools();
    const catalog = buildCatalog(tools);
    assert.equal(catalog.length, tools.length);
    for (const entry of catalog) {
      assert.ok(entry.name.length > 0);
      assert.ok(entry.description.length > 0);
      assert.ok(entry.category);
      assert.ok(Array.isArray(entry.tags));
      assert.ok(entry.tags.includes(entry.name));
    }
    const code = catalog.find((c) => c.name === "code_exec");
    assert.ok(code?.tags.includes("math") || code?.tags.includes("calc"));
  });

  it("math task selects code_exec (and ask_user)", () => {
    const tools = makeAllTools();
    const catalog = buildCatalog(tools);
    const selected = selectToolsForTask("计算 12 * 7", catalog, tools);
    const names = selected.map((t) => t.name);
    assert.ok(names.includes("code_exec"), `got ${names.join(",")}`);
    assert.ok(names.includes("ask_user"));
    assert.ok(!names.includes("web_search"));
    assert.ok(!names.includes("memory_write"));
    assert.ok(selected.length < tools.length);
  });

  it("memory task selects memory tools", () => {
    const tools = makeAllTools();
    const catalog = buildCatalog(tools);
    const selected = selectToolsForTask("记住我的偏好：喜欢简洁", catalog, tools);
    const names = selected.map((t) => t.name);
    assert.ok(names.includes("memory_write"));
    assert.ok(names.includes("memory_search"));
    assert.ok(names.includes("ask_user"));
    assert.ok(!names.includes("code_exec"));
    assert.ok(selected.length < tools.length);
  });

  it("unknown task gets all tools (safe default)", () => {
    const tools = makeAllTools();
    const catalog = buildCatalog(tools);
    const selected = selectToolsForTask(
      "今天天气怎么样随便聊聊",
      catalog,
      tools,
    );
    assert.equal(selected.length, tools.length);
    assert.deepEqual(
      selected.map((t) => t.name).sort(),
      tools.map((t) => t.name).sort(),
    );
  });

  it("formatCatalogForPrompt is short listing", () => {
    const catalog = buildCatalog(makeAllTools());
    const text = formatCatalogForPrompt(catalog);
    assert.ok(text.includes("Available tools"));
    assert.ok(text.includes("code_exec"));
    assert.ok(text.includes("web_search"));
    // no full parameter schemas dumped
    assert.ok(!text.includes('"properties"'));
  });

  it("discover_tools meta tool returns catalog text", async () => {
    const tools = makeAllTools();
    const catalog = buildCatalog(tools);
    const meta = createDiscoverToolsTool(() => catalog);
    const all = await meta.execute({});
    assert.equal(all.ok, true);
    assert.ok(all.content.includes("code_exec"));
    const filtered = await meta.execute({ filter: "memory" });
    assert.equal(filtered.ok, true);
    assert.ok(filtered.content.includes("memory_write"));
    assert.ok(!filtered.content.includes("code_exec"));
  });

  it("ToolRegistry.subset returns filtered view", async () => {
    const reg = new ToolRegistry();
    reg.registerAll(makeAllTools());
    const sub = reg.subset(["code_exec", "ask_user"]);
    assert.deepEqual(
      sub.list().map((t) => t.name).sort(),
      ["ask_user", "code_exec"],
    );
    const r = await sub.execute("code_exec", {});
    assert.equal(r.ok, true);
    const missing = await sub.execute("web_search", {});
    assert.equal(missing.ok, false);
  });
});
