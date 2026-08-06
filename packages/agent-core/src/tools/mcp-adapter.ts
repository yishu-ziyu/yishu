/**
 * Minimal offline MCP (Model Context Protocol) tool adapter.
 * Book Ch4: map local MCP-shaped descriptors into agent-core ToolDefinition.
 * No network SDK — pure JSON config + optional in-process handlers.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { JsonSchemaLike, ToolCategory, ToolDefinition, ToolResult } from "../types.js";
import type { ToolRegistry } from "./registry.js";

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchemaLike;
  category?: ToolCategory;
}

export type McpToolHandler = (
  args: Record<string, unknown>,
) => Promise<{ ok: boolean; content: string }>;

export interface McpServerConfig {
  name: string;
  tools: McpToolDescriptor[];
  /** In-process handlers (not loaded from JSON). Key = original tool name. */
  handlers?: Record<string, McpToolHandler>;
}

/** Safe slug for server / tool name segments. */
export function mcpSlug(value: string): string {
  const s = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "unnamed";
}

/** Prefixed tool name: mcp_<server>_<tool> */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp_${mcpSlug(serverName)}_${mcpSlug(toolName)}`;
}

function isToolCategory(v: unknown): v is ToolCategory {
  return (
    v === "perception" ||
    v === "execution" ||
    v === "collaboration" ||
    v === "communication"
  );
}

function normalizeDescriptor(raw: unknown, index: number): McpToolDescriptor {
  if (!raw || typeof raw !== "object") {
    throw new Error(`MCP tool[${index}] must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) throw new Error(`MCP tool[${index}] missing name`);
  const description =
    typeof o.description === "string" ? o.description : `MCP tool ${name}`;
  const inputSchema =
    o.inputSchema && typeof o.inputSchema === "object"
      ? (o.inputSchema as JsonSchemaLike)
      : o.parameters && typeof o.parameters === "object"
        ? (o.parameters as JsonSchemaLike)
        : { type: "object", properties: {} };
  const category = isToolCategory(o.category) ? o.category : undefined;
  const desc: McpToolDescriptor = { name, description, inputSchema };
  if (category) desc.category = category;
  return desc;
}

/** Parse a plain object into McpServerConfig (no handlers). */
export function parseMcpServerConfig(raw: unknown, source = "config"): McpServerConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid MCP config (${source}): expected object`);
  }
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) throw new Error(`Invalid MCP config (${source}): missing name`);
  if (!Array.isArray(o.tools)) {
    throw new Error(`Invalid MCP config (${source}): tools must be an array`);
  }
  const tools = o.tools.map((t, i) => normalizeDescriptor(t, i));
  return { name, tools };
}

/** Load one MCP server config from a JSON file (handlers not included). */
export async function loadMcpConfig(filePath: string): Promise<McpServerConfig> {
  const raw = await fs.readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse MCP config ${filePath}: ${msg}`);
  }
  return parseMcpServerConfig(parsed, filePath);
}

/**
 * Load all `*.json` MCP server configs from a directory.
 * Missing directory → empty list (offline-friendly).
 */
export async function loadMcpConfigsFromDir(dir: string): Promise<McpServerConfig[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return [];
    throw err;
  }
  const configs: McpServerConfig[] = [];
  const jsonFiles = entries.filter((e) => e.endsWith(".json")).sort();
  for (const file of jsonFiles) {
    const full = path.join(dir, file);
    const st = await fs.stat(full);
    if (!st.isFile()) continue;
    configs.push(await loadMcpConfig(full));
  }
  return configs;
}

function offlineStubContent(
  toolName: string,
  args: Record<string, unknown>,
): string {
  return `MCP tool ${toolName} invoked with ${JSON.stringify(args)}`;
}

/** Map MCP server tools into agent-core ToolDefinitions. */
export function mcpToolsToDefinitions(config: McpServerConfig): ToolDefinition[] {
  const handlers = config.handlers ?? {};
  return config.tools.map((tool) => {
    const registeredName = mcpToolName(config.name, tool.name);
    const category: ToolCategory = tool.category ?? "execution";
    const originalName = tool.name;
    const def: ToolDefinition = {
      name: registeredName,
      description: `[MCP:${config.name}] ${tool.description}`,
      category,
      parameters: tool.inputSchema,
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const handler = handlers[originalName];
        if (handler) {
          try {
            const r = await handler(args ?? {});
            return {
              ok: r.ok,
              content: r.content,
              evidence: {
                mcp: true,
                server: config.name,
                tool: originalName,
                registeredName,
              },
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              ok: false,
              content: "",
              error: msg,
              evidence: {
                mcp: true,
                server: config.name,
                tool: originalName,
              },
            };
          }
        }
        return {
          ok: true,
          content: offlineStubContent(originalName, args ?? {}),
          evidence: {
            mcp: true,
            server: config.name,
            tool: originalName,
            registeredName,
            stub: true,
          },
        };
      },
    };
    return def;
  });
}

/** Register all tools from one MCP server; return registered names. */
export function registerMcpServer(
  registry: ToolRegistry,
  config: McpServerConfig,
): string[] {
  const defs = mcpToolsToDefinitions(config);
  const names: string[] = [];
  for (const def of defs) {
    registry.register(def);
    names.push(def.name);
  }
  return names;
}

/**
 * Load every JSON config under dir and register into registry.
 * Returns flat list of registered tool names.
 */
export async function registerMcpDir(
  registry: ToolRegistry,
  dir: string,
): Promise<string[]> {
  const configs = await loadMcpConfigsFromDir(dir);
  const names: string[] = [];
  for (const cfg of configs) {
    names.push(...registerMcpServer(registry, cfg));
  }
  return names;
}
