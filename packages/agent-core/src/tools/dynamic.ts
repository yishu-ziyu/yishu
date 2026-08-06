/**
 * Book Ch5: offline-safe dynamic tool meta-bootstrap.
 * Only echo / const / template kinds - no arbitrary JS eval.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolCategory, ToolDefinition, ToolResult } from "../types.js";
import type { ToolRegistry } from "./registry.js";

export type DynamicToolKind = "echo" | "const" | "template";

export interface DynamicToolDef {
  name: string;
  description: string;
  kind: DynamicToolKind;
  body: string;
  category?: ToolCategory;
}

/** Name: starts with a-z, then a-z0-9_, length 2-41 total. */
export const DYNAMIC_TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,40}$/;

const KINDS = new Set<DynamicToolKind>(["echo", "const", "template"]);

const RESERVED_PREFIXES = ["mcp_"] as const;

/** Builtin / meta names that must not be overwritten by dynamic tools. */
const RESERVED_NAMES = new Set([
  "create_tool",
  "discover_tools",
  "web_search",
  "list_dir",
  "read_file",
  "write_file",
  "code_exec",
  "memory_write",
  "memory_search",
  "memory_promote",
  "knowledge_search",
  "knowledge_ingest",
  "ask_user",
  "delegate",
]);

function isToolCategory(v: unknown): v is ToolCategory {
  return (
    v === "perception" ||
    v === "execution" ||
    v === "collaboration" ||
    v === "communication"
  );
}

export function isDynamicToolKind(v: unknown): v is DynamicToolKind {
  return typeof v === "string" && KINDS.has(v as DynamicToolKind);
}

/**
 * Validate dynamic tool name.
 * Throws with a short message on failure.
 */
export function validateDynamicToolName(name: string): void {
  if (!DYNAMIC_TOOL_NAME_RE.test(name)) {
    throw new Error(
      `Invalid tool name "${name}": must match /^[a-z][a-z0-9_]{1,40}$/`,
    );
  }
  for (const p of RESERVED_PREFIXES) {
    if (name.startsWith(p)) {
      throw new Error(
        `Invalid tool name "${name}": prefix "${p}" is reserved`,
      );
    }
  }
  if (RESERVED_NAMES.has(name)) {
    throw new Error(
      `Invalid tool name "${name}": conflicts with a builtin tool`,
    );
  }
}

/** Apply {{key}} substitutions from args (missing keys → empty string). */
export function applyTemplate(
  template: string,
  args: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_m, key: string) => {
    const v = args[key];
    if (v === undefined || v === null) return "";
    return String(v);
  });
}

function executeDynamic(
  def: DynamicToolDef,
  args: Record<string, unknown>,
): ToolResult {
  try {
    let content: string;
    if (def.kind === "echo") {
      content = JSON.stringify(args ?? {}, null, 2);
    } else if (def.kind === "const") {
      content = def.body;
    } else {
      content = applyTemplate(def.body, args ?? {});
    }
    return {
      ok: true,
      content,
      evidence: {
        tool: def.name,
        kind: def.kind,
        dynamic: true,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, content: "", error: msg };
  }
}

/** Build a ToolDefinition from a persisted/dynamic def (no registry side effects). */
export function buildDynamicTool(def: DynamicToolDef): ToolDefinition {
  validateDynamicToolName(def.name);
  if (!isDynamicToolKind(def.kind)) {
    throw new Error(`Invalid kind "${String(def.kind)}": use echo|const|template`);
  }
  const category: ToolCategory = def.category ?? "execution";
  const parameters: ToolDefinition["parameters"] =
    def.kind === "echo" || def.kind === "template"
      ? {
          type: "object",
          properties: {},
          description:
            def.kind === "template"
              ? "Template variables matching {{key}} in body"
              : "Arbitrary args echoed as JSON",
        }
      : { type: "object", properties: {} };

  return {
    name: def.name,
    description: def.description || `Dynamic ${def.kind} tool`,
    category,
    parameters,
    async execute(args): Promise<ToolResult> {
      return executeDynamic(def, args ?? {});
    },
  };
}

/**
 * Register a dynamic tool into the registry and return the definition.
 * Overwrites any previous tool with the same name.
 */
export function registerDynamicTool(
  registry: ToolRegistry,
  def: DynamicToolDef,
): ToolDefinition {
  const tool = buildDynamicTool(def);
  registry.register(tool);
  return tool;
}

/** File-backed store for dynamic tool definitions (data/dynamic-tools.json). */
export class DynamicToolStore {
  private defs: DynamicToolDef[] = [];
  private loaded = false;

  constructor(private readonly storePath: string) {}

  get path(): string {
    return this.storePath;
  }

  async load(): Promise<DynamicToolDef[]> {
    try {
      const raw = await fs.readFile(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        this.defs = parsed
          .map((item, i) => normalizeDef(item, i))
          .filter((d): d is DynamicToolDef => d !== null);
      } else {
        this.defs = [];
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.defs = [];
      } else {
        throw err;
      }
    }
    this.loaded = true;
    return [...this.defs];
  }

  async save(defs?: DynamicToolDef[]): Promise<void> {
    if (defs) this.defs = [...defs];
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.writeFile(
      this.storePath,
      JSON.stringify(this.defs, null, 2),
      "utf8",
    );
  }

  list(): DynamicToolDef[] {
    return [...this.defs];
  }

  /** Insert or replace by name, then persist. */
  async upsert(def: DynamicToolDef): Promise<DynamicToolDef[]> {
    if (!this.loaded) await this.load();
    validateDynamicToolName(def.name);
    if (!isDynamicToolKind(def.kind)) {
      throw new Error(`Invalid kind "${String(def.kind)}"`);
    }
    const next: DynamicToolDef = {
      name: def.name,
      description: def.description,
      kind: def.kind,
      body: def.body,
    };
    if (def.category) next.category = def.category;
    const idx = this.defs.findIndex((d) => d.name === def.name);
    if (idx >= 0) this.defs[idx] = next;
    else this.defs.push(next);
    await this.save();
    return this.list();
  }
}

function normalizeDef(raw: unknown, index: number): DynamicToolDef | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) return null;
  try {
    validateDynamicToolName(name);
  } catch {
    return null;
  }
  const kind = o.kind;
  if (!isDynamicToolKind(kind)) return null;
  const description =
    typeof o.description === "string" ? o.description : `Dynamic tool ${name}`;
  const body = typeof o.body === "string" ? o.body : "";
  const def: DynamicToolDef = { name, description, kind, body };
  if (isToolCategory(o.category)) def.category = o.category;
  // silence unused index in production paths
  void index;
  return def;
}

export interface CreateToolToolOptions {
  registry: ToolRegistry;
  store: DynamicToolStore;
}

/**
 * Builtin meta-tool: create_tool (category execution).
 * Registers into the live registry and persists to dynamic-tools.json.
 */
export function createCreateToolTool(
  options: CreateToolToolOptions,
): ToolDefinition {
  const { registry, store } = options;
  return {
    name: "create_tool",
    description:
      "Create a new offline dynamic tool (kind: echo|const|template) and persist it",
    category: "execution",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Tool name matching /^[a-z][a-z0-9_]{1,40}$/",
        },
        description: { type: "string", description: "Short description" },
        kind: {
          type: "string",
          description: "echo | const | template",
        },
        body: {
          type: "string",
          description:
            "const: fixed return; template: {{key}} placeholders; echo: ignored",
        },
        category: {
          type: "string",
          description: "Optional category (default execution)",
        },
      },
      required: ["name", "description", "kind", "body"],
    },
    async execute(args): Promise<ToolResult> {
      try {
        const name = String(args.name ?? "").trim();
        const description = String(args.description ?? "").trim();
        const kindRaw = String(args.kind ?? "").trim().toLowerCase();
        const body = String(args.body ?? "");
        if (!isDynamicToolKind(kindRaw)) {
          return {
            ok: false,
            content: "",
            error: `Invalid kind "${kindRaw}": use echo|const|template`,
          };
        }
        validateDynamicToolName(name);
        const def: DynamicToolDef = {
          name,
          description: description || `Dynamic ${kindRaw} tool ${name}`,
          kind: kindRaw,
          body,
        };
        if (isToolCategory(args.category)) {
          def.category = args.category;
        }
        registerDynamicTool(registry, def);
        await store.upsert(def);
        return {
          ok: true,
          content: JSON.stringify({
            created: true,
            name: def.name,
            kind: def.kind,
            description: def.description,
            body: def.body,
            category: def.category ?? "execution",
          }),
          evidence: {
            tool: "create_tool",
            name: def.name,
            kind: def.kind,
            dynamic: true,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, content: "", error: msg };
      }
    },
  };
}

/**
 * Load persisted dynamic tools and register them.
 * Returns registered names.
 */
export async function loadAndRegisterDynamicTools(
  registry: ToolRegistry,
  store: DynamicToolStore,
): Promise<string[]> {
  const defs = await store.load();
  const names: string[] = [];
  for (const def of defs) {
    try {
      registerDynamicTool(registry, def);
      names.push(def.name);
    } catch {
      // skip invalid entries
    }
  }
  return names;
}
