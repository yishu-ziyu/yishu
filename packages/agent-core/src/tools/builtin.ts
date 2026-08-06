import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isMemoryLayer,
  type MemoryLayer,
  type MemoryStore,
} from "../memory/store.js";
import { FileKnowledgeStore } from "../knowledge/store.js";
import type { ToolDefinition, ToolResult } from "../types.js";

export interface BuiltinToolsOptions {
  workspaceDir: string;
  memory: MemoryStore;
  /** Pre-built knowledge store (preferred when harness owns lifecycle). */
  knowledge?: FileKnowledgeStore;
  /** Directory for FileKnowledgeStore (index.json inside). Used if knowledge missing. */
  knowledgePath?: string;
}

/** Resolve path under workspace; throw if escapes. */
export function resolveWorkspacePath(
  workspaceDir: string,
  relPath: string,
): string {
  const root = path.resolve(workspaceDir);
  const cleaned = relPath.replace(/^\.\//, "") || ".";
  const resolved = path.resolve(root, cleaned);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${relPath}`);
  }
  return resolved;
}

/** Safe arithmetic / simple math expression evaluator (no arbitrary code). */
export function evalArithmetic(expression: string): number {
  const expr = expression.replace(/\s+/g, "");
  if (!expr) throw new Error("Empty expression");
  if (!/^[0-9+\-*/().]+$/.test(expr)) {
    throw new Error("Only digits and + - * / ( ) allowed");
  }
  // Disallow consecutive operators that could form comments etc.
  if (/[+\-*/]{3,}/.test(expr)) {
    throw new Error("Invalid operator sequence");
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function(`"use strict"; return (${expr});`);
  const value = fn() as unknown;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Expression did not yield a finite number");
  }
  return value;
}

function offlineSearch(query: string): Array<{
  title: string;
  snippet: string;
  url: string;
}> {
  const q = query.toLowerCase();
  const catalog = [
    {
      keywords: ["agent", "react", "llm", "tool"],
      title: "ReAct: Reasoning and Acting in Language Models",
      snippet:
        "Interleave reasoning traces with task-specific actions for grounded answers.",
      url: "https://local.offline/react-agent",
    },
    {
      keywords: ["memory", "记忆", "preference", "偏好"],
      title: "Agent Memory Patterns",
      snippet: "JSONL/JSON card stores with tags and progressive recall.",
      url: "https://local.offline/memory-patterns",
    },
    {
      keywords: ["typescript", "node", "esm"],
      title: "TypeScript NodeNext ESM Guide",
      snippet: "Use .js extensions in imports under NodeNext resolution.",
      url: "https://local.offline/ts-nodenext",
    },
    {
      keywords: ["yishu", "奕枢", "persona"],
      title: "Yishu Product Kernel",
      snippet: "Voice and spatial presence; context as evidence.",
      url: "https://local.offline/yishu-kernel",
    },
  ];

  const hits = catalog.filter((item) =>
    item.keywords.some((k) => q.includes(k)),
  );
  if (hits.length > 0) {
    return hits.map(({ title, snippet, url }) => ({ title, snippet, url }));
  }
  return [
    {
      title: `Offline stub for: ${query.slice(0, 80)}`,
      snippet:
        "No live network. Deterministic canned result for offline agent-core.",
      url: "https://local.offline/stub",
    },
  ];
}

export function createBuiltinTools(
  options: BuiltinToolsOptions,
): ToolDefinition[] {
  const { workspaceDir, memory } = options;
  const knowledge =
    options.knowledge ??
    new FileKnowledgeStore(
      options.knowledgePath ??
        path.join(workspaceDir, "knowledge"),
    );

  const web_search: ToolDefinition = {
    name: "web_search",
    description: "Offline structured search over canned knowledge",
    category: "perception",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
    async execute(args): Promise<ToolResult> {
      const query = String(args.query ?? "");
      const results = offlineSearch(query);
      return {
        ok: true,
        content: JSON.stringify({ query, results }, null, 2),
        evidence: { tool: "web_search", count: results.length },
      };
    },
  };

  const list_dir: ToolDefinition = {
    name: "list_dir",
    description: "List files under workspace relative path",
    category: "perception",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path, default ." },
      },
    },
    async execute(args): Promise<ToolResult> {
      try {
        const rel = String(args.path ?? ".");
        const abs = resolveWorkspacePath(workspaceDir, rel);
        const entries = await fs.readdir(abs, { withFileTypes: true });
        const names = entries.map((e) =>
          e.isDirectory() ? `${e.name}/` : e.name,
        );
        return {
          ok: true,
          content: names.join("\n") || "(empty)",
          evidence: { tool: "list_dir", path: rel, count: names.length },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, content: "", error: msg };
      }
    },
  };

  const read_file: ToolDefinition = {
    name: "read_file",
    description: "Read a text file under workspace",
    category: "perception",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    async execute(args): Promise<ToolResult> {
      try {
        const rel = String(args.path ?? "");
        const abs = resolveWorkspacePath(workspaceDir, rel);
        const text = await fs.readFile(abs, "utf8");
        return {
          ok: true,
          content: text.slice(0, 50_000),
          evidence: { tool: "read_file", path: rel, bytes: text.length },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, content: "", error: msg };
      }
    },
  };

  const write_file: ToolDefinition = {
    name: "write_file",
    description: "Write text under workspace (sandboxed)",
    category: "execution",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    async execute(args): Promise<ToolResult> {
      try {
        const rel = String(args.path ?? "");
        const content = String(args.content ?? "");
        const abs = resolveWorkspacePath(workspaceDir, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, "utf8");
        return {
          ok: true,
          content: `Wrote ${content.length} bytes to ${rel}`,
          evidence: { tool: "write_file", path: rel, bytes: content.length },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, content: "", error: msg };
      }
    },
  };

  const code_exec: ToolDefinition = {
    name: "code_exec",
    description:
      "Evaluate pure arithmetic expressions (safe subset, no arbitrary code)",
    category: "execution",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string" },
        language: { type: "string" },
      },
      required: ["expression"],
    },
    async execute(args): Promise<ToolResult> {
      try {
        const expression = String(args.expression ?? "");
        const value = evalArithmetic(expression);
        return {
          ok: true,
          content: `result=${value}`,
          evidence: { tool: "code_exec", expression, value },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, content: "", error: msg };
      }
    },
  };

  const memory_write: ToolDefinition = {
    name: "memory_write",
    description:
      "Write a memory card (optional layer: working|session|long_term|profile)",
    category: "execution",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string" },
        kind: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        layer: {
          type: "string",
          description: "working | session | long_term | profile (default session)",
        },
      },
      required: ["content"],
    },
    async execute(args): Promise<ToolResult> {
      const content = String(args.content ?? "");
      const kind =
        typeof args.kind === "string" ? args.kind : "note";
      const tags = Array.isArray(args.tags)
        ? args.tags.map(String)
        : [];
      const layer: MemoryLayer | undefined = isMemoryLayer(args.layer)
        ? args.layer
        : undefined;
      const card = await memory.add({
        content,
        kind,
        tags,
        ...(layer !== undefined ? { layer } : {}),
      });
      return {
        ok: true,
        content: JSON.stringify(card),
        evidence: { tool: "memory_write", id: card.id, layer: card.layer },
      };
    },
  };

  const memory_search: ToolDefinition = {
    name: "memory_search",
    description:
      "Search memory cards by keyword; optional layer filter; ranks profile > long_term > session > working",
    category: "perception",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        layer: {
          type: "string",
          description: "Optional layer filter: working|session|long_term|profile",
        },
      },
      required: ["query"],
    },
    async execute(args): Promise<ToolResult> {
      const query = String(args.query ?? "");
      const layer = isMemoryLayer(args.layer) ? args.layer : undefined;
      const hits = await memory.search(
        query,
        layer !== undefined ? { layer } : undefined,
      );
      return {
        ok: true,
        content:
          hits.length === 0
            ? "no matches"
            : JSON.stringify(hits, null, 2),
        evidence: {
          tool: "memory_search",
          query,
          count: hits.length,
          ...(layer !== undefined ? { layer } : {}),
        },
      };
    },
  };

  const memory_promote: ToolDefinition = {
    name: "memory_promote",
    description:
      "Promote a memory card to another layer (working|session|long_term|profile)",
    category: "execution",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory card id" },
        layer: {
          type: "string",
          description: "Target layer",
        },
      },
      required: ["id", "layer"],
    },
    async execute(args): Promise<ToolResult> {
      const id = String(args.id ?? "");
      if (!id) {
        return { ok: false, content: "", error: "id is required" };
      }
      if (!isMemoryLayer(args.layer)) {
        return {
          ok: false,
          content: "",
          error: "layer must be working|session|long_term|profile",
        };
      }
      const card = await memory.promoteMemory(id, args.layer);
      if (!card) {
        return { ok: false, content: "", error: `memory not found: ${id}` };
      }
      return {
        ok: true,
        content: JSON.stringify(card),
        evidence: {
          tool: "memory_promote",
          id: card.id,
          layer: card.layer,
        },
      };
    },
  };

  const knowledge_search: ToolDefinition = {
    name: "knowledge_search",
    description:
      "Search the offline knowledge base (RAG) by keyword; returns ranked snippets",
    category: "perception",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max hits (default 5)" },
      },
      required: ["query"],
    },
    async execute(args): Promise<ToolResult> {
      try {
        const query = String(args.query ?? "");
        const limit =
          typeof args.limit === "number" && Number.isFinite(args.limit)
            ? Math.max(1, Math.floor(args.limit))
            : 5;
        const hits = await knowledge.search(query, limit);
        const payload = hits.map((h) => ({
          id: h.doc.id,
          title: h.doc.title,
          score: h.score,
          snippet: h.snippet,
          tags: h.doc.tags,
          source: h.doc.source,
        }));
        return {
          ok: true,
          content:
            payload.length === 0
              ? "no knowledge matches"
              : JSON.stringify({ query, results: payload }, null, 2),
          evidence: {
            tool: "knowledge_search",
            query,
            count: payload.length,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, content: "", error: msg };
      }
    },
  };

  const knowledge_ingest: ToolDefinition = {
    name: "knowledge_ingest",
    description: "Ingest a document into the offline knowledge base",
    category: "execution",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["title", "content"],
    },
    async execute(args): Promise<ToolResult> {
      try {
        const title = String(args.title ?? "").trim();
        const content = String(args.content ?? "");
        if (!title) {
          return {
            ok: false,
            content: "",
            error: "title is required",
          };
        }
        const tags = Array.isArray(args.tags)
          ? args.tags.map(String)
          : [];
        const doc = await knowledge.ingest({
          title,
          content,
          tags,
          source: "tool",
        });
        return {
          ok: true,
          content: JSON.stringify({
            id: doc.id,
            title: doc.title,
            tags: doc.tags,
            createdAt: doc.createdAt,
          }),
          evidence: { tool: "knowledge_ingest", id: doc.id },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, content: "", error: msg };
      }
    },
  };

  const ask_user: ToolDefinition = {
    name: "ask_user",
    description: "Request structured user input (offline stub)",
    category: "communication",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string" },
      },
      required: ["question"],
    },
    async execute(args): Promise<ToolResult> {
      const question = String(args.question ?? "");
      return {
        ok: true,
        content: JSON.stringify({
          type: "need_user_input",
          question,
        }),
        evidence: { tool: "ask_user" },
      };
    },
  };

  const delegate: ToolDefinition = {
    name: "delegate",
    description: "Record a handoff request to another role",
    category: "collaboration",
    parameters: {
      type: "object",
      properties: {
        role: { type: "string" },
        task: { type: "string" },
      },
      required: ["role", "task"],
    },
    async execute(args): Promise<ToolResult> {
      const role = String(args.role ?? "researcher");
      const task = String(args.task ?? "");
      return {
        ok: true,
        content: JSON.stringify({
          type: "handoff",
          role,
          task,
          status: "queued",
        }),
        evidence: { tool: "delegate", role },
      };
    },
  };

  return [
    web_search,
    list_dir,
    read_file,
    write_file,
    code_exec,
    memory_write,
    memory_search,
    memory_promote,
    knowledge_search,
    knowledge_ingest,
    ask_user,
    delegate,
  ];
}
