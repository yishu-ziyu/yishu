import type { ToolDefinition, ToolResult } from "../types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: ToolDefinition[]): void {
    for (const t of tools) this.register(t);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /**
   * Filtered registry view containing only named tools (order preserved).
   * Unknown names are skipped. Shares the same ToolDefinition references.
   */
  subset(names: string[]): ToolRegistry {
    const view = new ToolRegistry();
    const want = new Set(names);
    for (const tool of this.list()) {
      if (want.has(tool.name)) view.register(tool);
    }
    return view;
  }

  /** Schema-like list for LLM tool choice (no execute). */
  listDefinitions(): Array<{
    name: string;
    description: string;
    category: ToolDefinition["category"];
    parameters: ToolDefinition["parameters"];
  }> {
    return this.list().map(({ name, description, category, parameters }) => ({
      name,
      description,
      category,
      parameters,
    }));
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        content: "",
        error: `Unknown tool: ${name}`,
      };
    }
    try {
      return await tool.execute(args ?? {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, content: "", error: msg };
    }
  }
}
