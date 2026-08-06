import type { ChatMessage, ToolCallRequest, ToolDefinition } from "./types.js";

export type LlmResponse =
  | { type: "text"; text: string }
  | { type: "tool_calls"; toolCalls: ToolCallRequest[] };

export interface LlmPort {
  complete(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
  ): Promise<LlmResponse>;
}

let callSeq = 0;

function nextToolId(name: string): string {
  callSeq += 1;
  return `call_${name}_${callSeq}`;
}

function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") return m.content;
  }
  return "";
}

function hasToolResults(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === "tool");
}

function collectToolContents(messages: ChatMessage[]): string[] {
  return messages.filter((m) => m.role === "tool").map((m) => m.content);
}

function toolCall(
  name: string,
  args: Record<string, unknown>,
): ToolCallRequest {
  return { id: nextToolId(name), name, arguments: args };
}

/** Extract a simple arithmetic expression from free text. */
function extractMathExpr(text: string): string | null {
  // Chinese: 计算 17*19+3
  const cn = text.match(
    /(?:计算|算一下|算下|compute|calc(?:ulate)?)\s*[:：]?\s*([0-9+\-*/().\s]+)/i,
  );
  if (cn?.[1]) return cn[1].trim();

  // Bare expression-like: 17*19+3
  const bare = text.match(/\b(\d+(?:\s*[+\-*/()]\s*\d+)+)\b/);
  if (bare?.[1]) return bare[1].replace(/\s+/g, "");

  // "what is 3+4"
  const what = text.match(
    /(?:what\s+is|等于|是多少)\s*([0-9+\-*/().\s]+)/i,
  );
  if (what?.[1]) return what[1].trim();

  return null;
}

function extractQuotedOrAfter(
  text: string,
  patterns: RegExp[],
): string | null {
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function lastToolName(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role === "tool" && m.name) return m.name;
  }
  return undefined;
}

function synthesizeFromTools(
  task: string,
  toolContents: string[],
  toolName?: string,
): string {
  const joined = toolContents.join("\n");
  const num =
    joined.match(/result[=:]\s*(-?\d+(?:\.\d+)?)/i) ??
    joined.match(/"value"\s*:\s*(-?\d+(?:\.\d+)?)/);

  if (
    toolName === "code_exec" ||
    (/计算|算|math|compute|calc|\d+\s*[+\-*/]/.test(task) && num)
  ) {
    if (num?.[1]) return `结果是 ${num[1]}。`;
  }

  if (toolName === "memory_write" || (/记住|remember|记一下|记下/.test(task) && /"id"\s*:/.test(joined))) {
    return `已记下。`;
  }

  if (
    toolName === "memory_search" ||
    (/what do you know about me|我偏好|记得我|你记得/i.test(task) &&
      !/搜索|search/i.test(task))
  ) {
    if (/no matches/i.test(joined) && !/"content"/i.test(joined)) {
      return `目前记忆里还没有相关条目。你可以说「记住…」让我记下。`;
    }
    return `关于你，我查到：\n${joined.slice(0, 800)}`;
  }

  // Prefer last-tool write over knowledge task match (multi-hop RAG → file)
  if (
    toolName === "write_file" ||
    (/write\s+file|写文件|写入|写到|保存到/.test(task) &&
      (/Wrote |wrote=/i.test(joined) || joined.length > 0) &&
      toolName !== "knowledge_search")
  ) {
    return `文件已写入。证据：${joined.slice(0, 400)}`;
  }

  if (
    toolName === "knowledge_search" ||
    /知识库|knowledge|RAG|查知识|ReAct\s*模式|Agent\s*公式/i.test(task)
  ) {
    if (/no knowledge matches/i.test(joined)) {
      return `知识库里没有相关条目。可以用 knowledge_ingest 写入后再查。`;
    }
    // Prefer citing titles / snippets from ranked results
    const titles = [...joined.matchAll(/"title"\s*:\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    const snippets = [...joined.matchAll(/"snippet"\s*:\s*"([^"]+)"/g)].map(
      (m) => m[1],
    );
    if (titles.length > 0 || snippets.length > 0) {
      const cite = titles
        .map((t, i) => {
          const sn = snippets[i] ?? "";
          return sn ? `「${t}」：${sn}` : `「${t}」`;
        })
        .join("\n");
      return `根据知识库：\n${cite.slice(0, 1000)}`;
    }
    return `根据知识库：\n${joined.slice(0, 1000)}`;
  }

  if (toolName === "knowledge_ingest") {
    return `已写入知识库。`;
  }

  if (
    toolName === "create_tool" ||
    /创建工具|create_tool|自定义工具/i.test(task)
  ) {
    const nameMatch = joined.match(/"name"\s*:\s*"([^"]+)"/);
    const kindMatch = joined.match(/"kind"\s*:\s*"([^"]+)"/);
    if (nameMatch?.[1]) {
      const kind = kindMatch?.[1] ?? "?";
      return `已创建工具 ${nameMatch[1]}（${kind}）。`;
    }
    return `工具创建结果：\n${joined.slice(0, 600)}`;
  }

  if (toolName === "web_search" || /search|research|查|搜/i.test(task)) {
    return `检索结果摘要：\n${joined.slice(0, 1000)}`;
  }

  if (toolName === "list_dir" || /list|列目录|目录|files/i.test(task)) {
    return `目录内容：\n${joined.slice(0, 800)}`;
  }

  if (toolName === "read_file" || /read|读|打开/i.test(task)) {
    return `文件内容：\n${joined.slice(0, 1000)}`;
  }

  if (
    (toolName?.startsWith("mcp_") ?? false) ||
    /mcp\s*echo|调用\s*mcp/i.test(task)
  ) {
    return `MCP 工具结果：\n${joined.slice(0, 800)}`;
  }

  if (num?.[1]) {
    return `结果是 ${num[1]}。`;
  }

  return `已处理。依据工具结果：\n${joined.slice(0, 800)}`;
}

function findMcpEchoTool(
  tools: ToolDefinition[] | undefined,
): ToolDefinition | undefined {
  if (!tools?.length) return undefined;
  return (
    tools.find((t) => /^mcp_.+_echo$/.test(t.name)) ??
    tools.find((t) => t.name.startsWith("mcp_") && /echo/i.test(t.name))
  );
}

function extractMcpEchoMessage(userText: string): string {
  const quoted =
    extractQuotedOrAfter(userText, [
      /mcp\s*echo\s*[：:=]?\s*[「"'`](.+?)[」"'`]/i,
      /mcp\s*echo\s+[：:=]?\s*(.+)$/i,
      /调用\s*mcp\s*(?:回显|echo)?\s*[：:=]?\s*(.+)$/i,
      /echo\s*[：:=]\s*(.+)$/i,
    ]) ?? null;
  if (quoted) return quoted.trim();
  // Strip trigger words; leftover is the payload
  const stripped = userText
    .replace(/mcp\s*echo/gi, " ")
    .replace(/调用\s*mcp/gi, " ")
    .replace(/回显|echo/gi, " ")
    .replace(/请|一下/g, " ")
    .trim();
  return stripped || "hello";
}

/** Parse create_tool args from free text (book ch5). */
function parseCreateToolArgs(userText: string): {
  name: string;
  description: string;
  kind: string;
  body: string;
} {
  const kv = (key: string): string | null => {
    const re = new RegExp(
      `(?:^|[\\s,;])${key}\\s*[：:=]\\s*([^\\s]+(?:\\s+(?!(?:name|kind|body|description|desc)\\s*[：:=])[^\\s]+)*)`,
      "i",
    );
    // Simpler: key=value until next key= or end
    const simple = userText.match(
      new RegExp(
        `${key}\\s*[：:=]\\s*([^\\n]+?)(?=\\s+(?:name|kind|body|description|desc)\\s*[：:=]|$)`,
        "i",
      ),
    );
    if (simple?.[1]) return simple[1].trim().replace(/^["'`]|["'`]$/g, "");
    void re;
    return null;
  };

  let name =
    kv("name") ??
    extractQuotedOrAfter(userText, [
      /创建工具\s+([a-z][a-z0-9_]{1,40})/i,
      /自定义工具\s+([a-z][a-z0-9_]{1,40})/i,
      /create_tool\s+([a-z][a-z0-9_]{1,40})/i,
    ]);

  let kind =
    kv("kind") ??
    extractQuotedOrAfter(userText, [
      /\b(echo|const|template)\b/i,
    ]);

  let body =
    kv("body") ??
    extractQuotedOrAfter(userText, [
      /body\s*[：:=]\s*[「"'`](.+?)[」"'`]/i,
      /内容\s*[：:=]\s*[「"'`](.+?)[」"'`]/,
    ]);

  let description =
    kv("description") ??
    kv("desc") ??
    extractQuotedOrAfter(userText, [
      /description\s*[：:=]\s*[「"'`](.+?)[」"'`]/i,
    ]);

  // Fallbacks from common Chinese phrasing: 创建工具 foo const "hello"
  if (!name) {
    const m = userText.match(
      /(?:创建工具|create_tool|自定义工具)\s+([a-z][a-z0-9_]{1,40})/i,
    );
    if (m?.[1]) name = m[1];
  }
  if (!kind) {
    const m = userText.match(/\b(echo|const|template)\b/i);
    if (m?.[1]) kind = m[1].toLowerCase();
  }
  if (!body) {
    // quoted string after kind or name
    const m = userText.match(/[「"'`]([^」"'`]+)[」"'`]/);
    if (m?.[1]) body = m[1];
  }

  name = (name ?? "dyn_tool").toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!/^[a-z]/.test(name)) name = `t_${name}`;
  kind = (kind ?? "const").toLowerCase();
  if (!/^(echo|const|template)$/.test(kind)) kind = "const";
  body = body ?? (kind === "echo" ? "" : "ok");
  description =
    description ?? `Dynamic ${kind} tool ${name}`;

  return { name, description, kind, body };
}

/** After create_tool, detect optional "use it" intent and new tool name. */
function shouldCallNewToolAfterCreate(
  task: string,
  toolContents: string[],
): { name: string; args: Record<string, unknown> } | null {
  if (!/使用|调用|用一下|call|use\s+(it|the\s+tool)|然后用/i.test(task)) {
    return null;
  }
  const joined = toolContents.join("\n");
  if (!/"created"\s*:\s*true/.test(joined) && !/"name"\s*:/.test(joined)) {
    return null;
  }
  const nameMatch = joined.match(/"name"\s*:\s*"([a-z][a-z0-9_]{0,40})"/);
  if (!nameMatch?.[1]) return null;
  const kindMatch = joined.match(/"kind"\s*:\s*"([^"]+)"/);
  const kind = kindMatch?.[1] ?? "const";
  const args: Record<string, unknown> = {};
  if (kind === "template" || kind === "echo") {
    // Pull simple key=value pairs after 用/use for template args
    const afterUse = task.match(
      /(?:使用|调用|用一下|call|use)\s*(?:it|the\s+tool)?\s*(.*)$/i,
    );
    const tail = afterUse?.[1] ?? "";
    for (const m of tail.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*[：:=]\s*(\S+)/g)) {
      if (m[1] && m[2]) args[m[1]] = m[2];
    }
  }
  return { name: nameMatch[1], args };
}

/** Compound RAG → write_file: task asks for knowledge then a file. */
function shouldWriteAfterKnowledge(task: string): boolean {
  return /写文件|写入文件|write\s+file|写到|保存到|并写|再写/i.test(task);
}

function extractWritePathFromTask(task: string): string {
  return (
    extractQuotedOrAfter(task, [
      /(?:写文件|写入文件|write\s+file|写到|保存到|并写文件|再写文件)\s+(\S+\.\w+)/i,
      /([\w./-]+\.(?:md|txt|json|ts|js))/,
    ]) ?? "knowledge-summary.md"
  );
}

/** Build file body from knowledge_search tool JSON (titles + snippets). */
function buildKnowledgeSummaryContent(toolContents: string[]): string {
  const joined = toolContents.join("\n");
  if (/no knowledge matches/i.test(joined)) {
    return "知识摘要：知识库无匹配结果。\n";
  }
  const titles = [...joined.matchAll(/"title"\s*:\s*"([^"]+)"/g)].map(
    (m) => m[1]!,
  );
  const snippets = [...joined.matchAll(/"snippet"\s*:\s*"([^"]+)"/g)].map(
    (m) => m[1]!,
  );
  if (titles.length === 0 && snippets.length === 0) {
    return `知识摘要：\n${joined.slice(0, 800)}\n`;
  }
  const lines = titles.map((t, i) => {
    const sn = snippets[i] ?? "";
    return sn ? `- ${t}：${sn}` : `- ${t}`;
  });
  return `知识摘要：\n${lines.join("\n")}\n`;
}

/**
 * Optional second knowledge_search when task says 然后/再查 + another query.
 * Only when we have not already searched twice.
 */
function shouldSecondKnowledgeSearch(
  task: string,
  messages: ChatMessage[],
): string | null {
  const searchCount = messages.filter(
    (m) => m.role === "tool" && m.name === "knowledge_search",
  ).length;
  if (searchCount !== 1) return null;
  // e.g. 查知识 A 然后查 B / 再查 B
  const m = task.match(
    /(?:然后|再查|再搜索|再检索)\s*(?:查知识|知识|knowledge)?\s*[：: ]?\s*(.+?)(?:\s*(?:并|然后|再|写文件|写入)|$)/i,
  );
  if (!m?.[1]) return null;
  const q = m[1].trim();
  if (!q || q.length < 2) return null;
  // Avoid re-querying the same first clause
  const firstQ = task
    .replace(/(?:然后|再查|再搜索|再检索).*$/i, "")
    .replace(/查知识|知识库|knowledge|RAG/gi, "")
    .trim();
  if (q === firstQ) return null;
  return q.slice(0, 200);
}

/**
 * Rule-based offline brain. Deterministic, no network.
 * Tracks call count so after tool results we prefer final text.
 */
export class DeterministicLlm implements LlmPort {
  callCount = 0;

  async complete(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
  ): Promise<LlmResponse> {
    this.callCount += 1;
    const userText = lastUserText(messages);
    const lower = userText.toLowerCase();
    const toolsPresent = hasToolResults(messages);

    // After tools ran, synthesize final answer (prefer text).
    if (toolsPresent && this.callCount > 1) {
      const contents = collectToolContents(messages);
      const last = messages[messages.length - 1];
      if (last?.role === "tool" || this.callCount >= 2) {
        // Only auto-search memory when user is recalling, not when writing.
        const isRecall =
          /what do you know about me|记得我|你还记得|你记得我|关于我/i.test(
            userText,
          ) && !/记住|记一下|记下|remember/i.test(userText);
        if (isRecall) {
          const alreadySearched = messages.some(
            (m) => m.role === "tool" && m.name === "memory_search",
          );
          if (!alreadySearched) {
            return {
              type: "tool_calls",
              toolCalls: [
                toolCall("memory_search", { query: "preference user 偏好" }),
              ],
            };
          }
        }

        // Book ch5: after create_tool, optionally invoke the new tool
        if (lastToolName(messages) === "create_tool") {
          const alreadyUsed = messages.some(
            (m) =>
              m.role === "tool" &&
              m.name !== "create_tool" &&
              m.name !== undefined,
          );
          if (!alreadyUsed) {
            const next = shouldCallNewToolAfterCreate(userText, contents);
            if (next) {
              return {
                type: "tool_calls",
                toolCalls: [toolCall(next.name, next.args)],
              };
            }
          }
        }

        // Multi-hop RAG lite: optional second knowledge_search (然后/再查)
        if (lastToolName(messages) === "knowledge_search") {
          const secondQ = shouldSecondKnowledgeSearch(userText, messages);
          if (secondQ) {
            return {
              type: "tool_calls",
              toolCalls: [
                toolCall("knowledge_search", { query: secondQ, limit: 5 }),
              ],
            };
          }
          // Compound: knowledge → write_file summary
          const alreadyWrote = messages.some(
            (m) => m.role === "tool" && m.name === "write_file",
          );
          if (!alreadyWrote && shouldWriteAfterKnowledge(userText)) {
            return {
              type: "tool_calls",
              toolCalls: [
                toolCall("write_file", {
                  path: extractWritePathFromTask(userText),
                  content: buildKnowledgeSummaryContent(contents),
                }),
              ],
            };
          }
        }

        return {
          type: "text",
          text: synthesizeFromTools(userText, contents, lastToolName(messages)),
        };
      }
    }

    // Book ch5: create dynamic tool (echo|const|template)
    if (
      /创建工具|create_tool|自定义工具/i.test(userText) &&
      !toolsPresent
    ) {
      const parsed = parseCreateToolArgs(userText);
      return {
        type: "tool_calls",
        toolCalls: [
          toolCall("create_tool", {
            name: parsed.name,
            description: parsed.description,
            kind: parsed.kind,
            body: parsed.body,
          }),
        ],
      };
    }

    // MCP echo / 调用 mcp → offline MCP adapter tool when present
    if (
      (/mcp\s*echo|调用\s*mcp/i.test(userText) ||
        (/\bmcp\b/i.test(userText) && /echo|回显/i.test(userText))) &&
      !toolsPresent
    ) {
      const echoTool = findMcpEchoTool(tools);
      if (echoTool) {
        return {
          type: "tool_calls",
          toolCalls: [
            toolCall(echoTool.name, {
              message: extractMcpEchoMessage(userText),
            }),
          ],
        };
      }
    }

    // Math / calc
    const mathExpr = extractMathExpr(userText);
    if (mathExpr && !toolsPresent) {
      return {
        type: "tool_calls",
        toolCalls: [
          toolCall("code_exec", {
            expression: mathExpr.replace(/\s+/g, ""),
            language: "js",
          }),
        ],
      };
    }

    // Remember / 记住
    if (
      /记住|remember\b|记一下|记下/.test(userText) &&
      !toolsPresent
    ) {
      const content =
        extractQuotedOrAfter(userText, [
          /记住[：:]\s*(.+)/,
          /记住\s+(.+)/,
          /remember(?:\s+that)?[：: ]\s*(.+)/i,
          /记一下[：: ]\s*(.+)/,
        ]) ?? userText.replace(/记住|remember|记一下|记下/gi, "").trim();
      const body = content || userText;
      // Preference-like content → profile layer; otherwise session (Ch3 progressive memory)
      const layer = /偏好|prefer/i.test(body) ? "profile" : "session";
      return {
        type: "tool_calls",
        toolCalls: [
          toolCall("memory_write", {
            content: body,
            kind: "note",
            tags: ["user"],
            layer,
          }),
        ],
      };
    }

    // Recall preferences / about me
    if (
      /what do you know about me|我偏好|记得我|你还记得|你记得我/.test(
        userText,
      ) ||
      /what do you know about me/.test(lower)
    ) {
      if (!toolsPresent) {
        return {
          type: "tool_calls",
          toolCalls: [
            toolCall("memory_search", {
              query: "preference user 偏好",
            }),
          ],
        };
      }
    }

    // Knowledge base / RAG (before generic web search)
    if (
      /知识库|knowledge|RAG|查知识|关于\s*ReAct\s*模式|Agent\s*公式/i.test(
        userText,
      ) &&
      !toolsPresent
    ) {
      const q =
        extractQuotedOrAfter(userText, [
          /(?:查知识|知识库|knowledge|RAG)\s*[：: ]\s*(.+)/i,
          /(?:关于)\s+(.+)/i,
          /(?:search\s+knowledge|knowledge\s+search)\s*[：: ]?\s*(.+)/i,
        ]) ?? userText;
      return {
        type: "tool_calls",
        toolCalls: [
          toolCall("knowledge_search", { query: q.slice(0, 200), limit: 5 }),
        ],
      };
    }

    // Search / research / 查
    if (
      /(?:web[_ ]?search|research|搜索|查一下|查下|检索|搜一下)/i.test(
        userText,
      ) &&
      !toolsPresent
    ) {
      const q =
        extractQuotedOrAfter(userText, [
          /(?:搜索|查一下|查下|检索|搜一下|research|search)\s*[：: ]\s*(.+)/i,
          /(?:about|关于)\s+(.+)/i,
        ]) ?? userText;
      return {
        type: "tool_calls",
        toolCalls: [toolCall("web_search", { query: q.slice(0, 200) })],
      };
    }

    // List files / 列目录
    if (
      /list\s*(files|dir|directory)|列目录|列出文件|ls\b|目录有什么/i.test(
        userText,
      ) &&
      !toolsPresent
    ) {
      const rel =
        extractQuotedOrAfter(userText, [
          /(?:path|目录|路径)\s*[：:=]\s*(\S+)/i,
          /list\s+(?:files\s+in\s+)?(\S+)/i,
        ]) ?? ".";
      return {
        type: "tool_calls",
        toolCalls: [toolCall("list_dir", { path: rel })],
      };
    }

    // Read file
    if (
      /read\s+file|读取文件|读文件|打开文件|read\s+\S+/i.test(userText) &&
      !toolsPresent
    ) {
      const path =
        extractQuotedOrAfter(userText, [
          /read\s+file\s+[：: ]?\s*(\S+)/i,
          /读取文件\s*[：: ]?\s*(\S+)/,
          /读文件\s*[：: ]?\s*(\S+)/,
          /打开文件\s*[：: ]?\s*(\S+)/,
          /read\s+(\S+\.\w+)/i,
        ]) ?? "README.md";
      return {
        type: "tool_calls",
        toolCalls: [toolCall("read_file", { path })],
      };
    }

    // Write file intent
    // Forms: "写文件 note.md 内容 hello" | "write file path content body" | "保存到 x.txt …"
    if (
      /write\s+file|写入文件|写文件|保存到|写到/i.test(userText) &&
      !toolsPresent
    ) {
      const path =
        extractQuotedOrAfter(userText, [
          // 写文件 eval-note.md 内容 …
          /(?:写文件|写入文件|write\s+file|写到|保存到)\s+(\S+\.\w+)/i,
          /(?:path|文件|到)\s*[：:=]\s*(\S+)/i,
          /write\s+file\s+(\S+)/i,
          /([\w./-]+\.(?:md|txt|json|ts|js))/,
        ]) ?? "output.txt";
      const content =
        extractQuotedOrAfter(userText, [
          // Prefer trailing payload after 内容/content so path is not swallowed
          /(?:写文件|写入文件|write\s+file)\s+\S+\.\w+\s+(?:内容|content)\s*[：:=]?\s*(.+)$/i,
          /content\s*[：:=]\s*(.+)$/i,
          /内容\s*[：:=]?\s*(.+)$/,
          /写入?\s*[「"'](.+)[」"']/,
        ]) ?? "hello from yishu";
      return {
        type: "tool_calls",
        toolCalls: [
          toolCall("write_file", {
            path,
            content: content.trim(),
          }),
        ],
      };
    }

    // Default: short helpful text, 奕枢 style
    return {
      type: "text",
      text: defaultReply(userText),
    };
  }
}

function defaultReply(userText: string): string {
  if (!userText.trim()) {
    return "在。需要算数、查资料、记偏好或看目录，直接说。";
  }
  if (/你好|hello|hi\b|在吗/i.test(userText)) {
    return "在。我是奕枢。说任务就行。";
  }
  if (/谢谢|thanks/i.test(userText)) {
    return "嗯。";
  }
  return `收到：「${userText.slice(0, 120)}」。若要计算、搜索、读写文件或记偏好，说具体一点我就能动手。`;
}

/** Reset tool id sequence (for tests). */
export function resetLlmSeq(): void {
  callSeq = 0;
}
