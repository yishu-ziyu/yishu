import type { ToolDefinition, ToolResult } from "../types.js";

/** Lightweight catalog row - name + short metadata, no full schema. */
export interface ToolCatalogEntry {
  name: string;
  description: string;
  category: ToolDefinition["category"];
  tags: string[];
}

const FS_TOOLS = new Set(["list_dir", "read_file", "write_file"]);
const MEMORY_TOOLS = new Set([
  "memory_write",
  "memory_search",
  "memory_promote",
]);
const KNOWLEDGE_TOOLS = new Set(["knowledge_search", "knowledge_ingest"]);

/** Derive search tags from tool name / description / category. */
function tagsFor(tool: ToolDefinition): string[] {
  const tags = new Set<string>([tool.category, tool.name]);
  const blob = `${tool.name} ${tool.description}`.toLowerCase();
  if (tool.name === "code_exec" || /math|arithmetic|calc/.test(blob)) {
    tags.add("math");
    tags.add("calc");
  }
  if (MEMORY_TOOLS.has(tool.name) || /memory|remember/.test(blob)) {
    tags.add("memory");
    tags.add("remember");
  }
  if (
    KNOWLEDGE_TOOLS.has(tool.name) ||
    /knowledge|rag|知识/.test(blob)
  ) {
    tags.add("knowledge");
    tags.add("rag");
  }
  if (tool.name === "web_search" || /search/.test(blob)) {
    tags.add("search");
  }
  if (FS_TOOLS.has(tool.name) || /file|dir|list|read|write/.test(blob)) {
    tags.add("file");
    tags.add("fs");
  }
  if (tool.name === "delegate" || /multi|handoff|delegate/.test(blob)) {
    tags.add("multi");
    tags.add("delegate");
  }
  if (tool.name === "ask_user") {
    tags.add("user");
    tags.add("clarify");
  }
  if (tool.name === "discover_tools") {
    tags.add("meta");
    tags.add("discovery");
  }
  if (
    tool.name === "create_tool" ||
    /create_tool|dynamic|自定义工具|创建工具/.test(blob)
  ) {
    tags.add("meta");
    tags.add("create_tool");
    tags.add("dynamic");
  }
  if (tool.name.startsWith("mcp_") || /\bmcp\b/.test(blob)) {
    tags.add("mcp");
  }
  return [...tags];
}

export function buildCatalog(tools: ToolDefinition[]): ToolCatalogEntry[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    category: t.category,
    tags: tagsFor(t),
  }));
}

/**
 * Select a task-relevant tool subset so the LLM is not dumped every schema.
 * Safe default: no keyword match -> all tools.
 */
export function selectToolsForTask(
  task: string,
  catalog: ToolCatalogEntry[],
  allTools: ToolDefinition[],
): ToolDefinition[] {
  const byName = new Map(allTools.map((t) => [t.name, t]));
  const catalogNames = new Set(catalog.map((c) => c.name));
  const selected = new Set<string>();
  const lower = task.toLowerCase();

  // Always keep ask_user when available
  if (byName.has("ask_user") && catalogNames.has("ask_user")) {
    selected.add("ask_user");
  }

  // Optional meta tool stays available for on-demand catalog expansion
  if (byName.has("discover_tools") && catalogNames.has("discover_tools")) {
    selected.add("discover_tools");
  }

  const addIfPresent = (name: string) => {
    if (byName.has(name) && catalogNames.has(name)) selected.add(name);
  };

  // math / calc -> code_exec
  if (
    /math|计算|算|compute|calc|\d+\s*[+\-*/×÷]/.test(lower) ||
    /[+\-*/]\s*\d/.test(task)
  ) {
    addIfPresent("code_exec");
  }

  // remember / memory -> memory_*
  if (/remember|记忆|记住|记得|偏好|preference|memory/.test(lower)) {
    for (const name of MEMORY_TOOLS) addIfPresent(name);
  }

  // knowledge / RAG / 知识库 -> knowledge_*
  if (/knowledge|rag|知识|知识库|react\s*模式|agent\s*公式/.test(lower)) {
    for (const name of KNOWLEDGE_TOOLS) addIfPresent(name);
  }

  // search -> web_search
  if (/search|搜索|查|检索|查找/.test(lower)) {
    addIfPresent("web_search");
  }

  // file / list / read / write -> fs tools
  if (
    /file|文件|list|列目录|目录|read|读|write|写|workspace|工作区/.test(lower)
  ) {
    for (const name of FS_TOOLS) addIfPresent(name);
  }

  // multi / delegate -> delegate
  if (/multi|多\s*agent|delegate|handoff|委派|协作|分工/.test(lower)) {
    addIfPresent("delegate");
  }

  // MCP adapter tools (book ch4)
  if (/\bmcp\b|调用\s*mcp/.test(lower)) {
    for (const t of allTools) {
      if (t.name.startsWith("mcp_")) addIfPresent(t.name);
    }
  }

  // Dynamic tool meta-bootstrap (book ch5)
  if (/创建工具|create_tool|自定义工具/i.test(task)) {
    addIfPresent("create_tool");
  }

  // Only ask_user / discover_tools selected => no domain match => return ALL
  const domainSelected = [...selected].filter(
    (n) => n !== "ask_user" && n !== "discover_tools",
  );
  if (domainSelected.length === 0) {
    return [...allTools];
  }

  const out: ToolDefinition[] = [];
  for (const name of selected) {
    const tool = byName.get(name);
    if (tool) out.push(tool);
  }
  // Preserve original registration order for stability
  const order = new Map(allTools.map((t, i) => [t.name, i]));
  out.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
  return out;
}

/** Short catalog listing for system / tool prompts (no full schemas). */
export function formatCatalogForPrompt(catalog: ToolCatalogEntry[]): string {
  if (catalog.length === 0) return "(no tools registered)";
  const lines = catalog.map(
    (e) =>
      `- ${e.name} [${e.category}] tags=${e.tags.join(",")}: ${e.description}`,
  );
  return ["Available tools (catalog):", ...lines].join("\n");
}

/**
 * Optional meta-tool: returns catalog text so the agent can expand awareness
 * without loading every schema up front.
 */
export function createDiscoverToolsTool(
  getCatalog: () => ToolCatalogEntry[],
): ToolDefinition {
  return {
    name: "discover_tools",
    description:
      "List available tools (name, category, tags, short description). Use when unsure which tool fits.",
    category: "perception",
    parameters: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Optional keyword filter on name/tags/description",
        },
      },
    },
    async execute(args): Promise<ToolResult> {
      const filter =
        typeof args.filter === "string" ? args.filter.toLowerCase().trim() : "";
      let catalog = getCatalog();
      if (filter) {
        catalog = catalog.filter(
          (e) =>
            e.name.toLowerCase().includes(filter) ||
            e.description.toLowerCase().includes(filter) ||
            e.tags.some((t) => t.toLowerCase().includes(filter)) ||
            e.category.toLowerCase().includes(filter),
        );
      }
      const text = formatCatalogForPrompt(catalog);
      const evidence: Record<string, unknown> = {
        tool: "discover_tools",
        count: catalog.length,
      };
      if (filter) evidence.filter = filter;
      return {
        ok: true,
        content: text,
        evidence,
      };
    },
  };
}
