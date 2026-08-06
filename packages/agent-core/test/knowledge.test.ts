import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import {
  FileKnowledgeStore,
  DEFAULT_KNOWLEDGE_SEEDS,
} from "../src/knowledge/store.js";
import { createBuiltinTools } from "../src/tools/builtin.js";
import { FileMemoryStore } from "../src/memory/store.js";
import {
  buildCatalog,
  selectToolsForTask,
} from "../src/tools/discovery.js";
import { DeterministicLlm, resetLlmSeq } from "../src/llm.js";

const dir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".tmp-knowledge",
);

async function freshDir(name: string): Promise<string> {
  const d = path.join(dir, name);
  await fs.rm(d, { recursive: true, force: true });
  await fs.mkdir(d, { recursive: true });
  return d;
}

describe("knowledge store", () => {
  it("seeds default docs on empty load and persists", async () => {
    const kd = await freshDir("seed");
    const a = new FileKnowledgeStore(kd);
    await a.load();
    const list = await a.list();
    assert.equal(list.length, DEFAULT_KNOWLEDGE_SEEDS.length);
    assert.ok(list.some((d) => d.title === "ReAct Pattern"));
    assert.ok(list.some((d) => d.title === "Agent Formula"));

    const b = new FileKnowledgeStore(kd);
    await b.load();
    const again = await b.list();
    assert.equal(again.length, DEFAULT_KNOWLEDGE_SEEDS.length);
  });

  it("ingests docs and ranks search by token overlap", async () => {
    const kd = await freshDir("rank");
    const store = new FileKnowledgeStore(kd);
    await store.load();

    await store.ingest({
      title: "Unique Pineapple Protocol",
      content: "Pineapple ranking token should win over generic agent text.",
      tags: ["pineapple", "rank-test"],
      source: "test",
    });
    await store.ingest({
      title: "Other Note",
      content: "Mentions pineapple once only.",
      tags: ["other"],
      source: "test",
    });

    const hits = await store.search("pineapple ranking", 5);
    assert.ok(hits.length >= 1);
    assert.equal(hits[0]?.doc.title, "Unique Pineapple Protocol");
    assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0));
  });

  it("knowledge_search and knowledge_ingest tools work", async () => {
    const kd = await freshDir("tools");
    const workspace = await freshDir("tools-ws");
    const knowledge = new FileKnowledgeStore(kd);
    await knowledge.load();
    const memory = new FileMemoryStore(path.join(workspace, "m.json"));
    await memory.load();

    const tools = createBuiltinTools({
      workspaceDir: workspace,
      memory,
      knowledge,
    });
    const byName = new Map(tools.map((t) => [t.name, t]));
    assert.ok(byName.has("knowledge_search"));
    assert.ok(byName.has("knowledge_ingest"));

    const ingested = await byName.get("knowledge_ingest")!.execute({
      title: "CLI Notes",
      content: "yishu-agent run can query knowledge base offline",
      tags: ["cli"],
    });
    assert.equal(ingested.ok, true);
    assert.ok(ingested.content.includes("CLI Notes"));

    const found = await byName.get("knowledge_search")!.execute({
      query: "yishu-agent knowledge offline",
      limit: 3,
    });
    assert.equal(found.ok, true);
    assert.ok(found.content.includes("CLI Notes"));
    assert.ok(found.evidence && (found.evidence as { count: number }).count >= 1);
  });

  it("discovery selects knowledge tools for RAG keywords", () => {
    const workspace = path.join(dir, "disc-ws");
    const knowledge = new FileKnowledgeStore(path.join(dir, "disc-k"));
    const memory = new FileMemoryStore(path.join(dir, "disc-m.json"));
    const tools = createBuiltinTools({ workspaceDir: workspace, memory, knowledge });
    const catalog = buildCatalog(tools);
    const selected = selectToolsForTask("查知识库里的 RAG 资料", catalog, tools);
    const names = selected.map((t) => t.name);
    assert.ok(names.includes("knowledge_search"), `got ${names.join(",")}`);
    assert.ok(names.includes("knowledge_ingest"));
  });

  it("DeterministicLlm routes knowledge queries to knowledge_search", async () => {
    resetLlmSeq();
    const llm = new DeterministicLlm();
    const res = await llm.complete([
      { role: "user", content: "关于 ReAct 模式" },
    ]);
    assert.equal(res.type, "tool_calls");
    if (res.type !== "tool_calls") return;
    assert.equal(res.toolCalls[0]?.name, "knowledge_search");

    const res2 = await llm.complete([
      { role: "user", content: "Agent 公式是什么" },
    ]);
    assert.equal(res2.type, "tool_calls");
    if (res2.type !== "tool_calls") return;
    assert.equal(res2.toolCalls[0]?.name, "knowledge_search");
  });

  it("DeterministicLlm multi-hop: knowledge_search then write_file", async () => {
    resetLlmSeq();
    const llm = new DeterministicLlm();
    const task =
      "查知识 Agent 公式 并写文件 formula-summary.md 内容为知识摘要";

    const step1 = await llm.complete([{ role: "user", content: task }]);
    assert.equal(step1.type, "tool_calls");
    if (step1.type !== "tool_calls") return;
    assert.equal(step1.toolCalls[0]?.name, "knowledge_search");

    const knowledgePayload = JSON.stringify([
      {
        title: "Agent Formula",
        snippet: "Agent = LLM + context + tools",
        score: 3,
      },
    ]);
    const step2 = await llm.complete([
      { role: "user", content: task },
      {
        role: "assistant",
        content: "",
        toolCalls: step1.toolCalls,
      },
      {
        role: "tool",
        name: "knowledge_search",
        toolCallId: step1.toolCalls[0]!.id,
        content: knowledgePayload,
      },
    ]);
    assert.equal(step2.type, "tool_calls");
    if (step2.type !== "tool_calls") return;
    assert.equal(step2.toolCalls[0]?.name, "write_file");
    const args = step2.toolCalls[0]!.arguments as {
      path?: string;
      content?: string;
    };
    assert.equal(args.path, "formula-summary.md");
    assert.match(String(args.content ?? ""), /知识摘要|Agent Formula|LLM/);
  });
});
