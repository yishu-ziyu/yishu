import type { ChatMessage } from "../types.js";

/**
 * Keep system messages + last N messages; summarize the middle as one system note.
 */
export function compressMessages(
  messages: ChatMessage[],
  maxChars: number,
  keepLast = 6,
): ChatMessage[] {
  const total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total <= maxChars) return messages;

  const system = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");

  if (nonSystem.length <= keepLast) {
    // Still over budget: truncate oldest non-system content
    return trimToBudget([...system, ...nonSystem], maxChars);
  }

  const head = nonSystem.slice(0, Math.max(0, nonSystem.length - keepLast));
  const tail = nonSystem.slice(-keepLast);
  const summaryText = summarizeMiddle(head);
  const summary: ChatMessage = {
    role: "system",
    content: `[compressed ${head.length} messages] ${summaryText}`,
  };

  return trimToBudget([...system, summary, ...tail], maxChars);
}

function summarizeMiddle(msgs: ChatMessage[]): string {
  const parts = msgs.map((m) => {
    const snippet = m.content.replace(/\s+/g, " ").slice(0, 80);
    return `${m.role}:${snippet}`;
  });
  return parts.join(" | ").slice(0, 500);
}

function trimToBudget(
  messages: ChatMessage[],
  maxChars: number,
): ChatMessage[] {
  let total = messages.reduce((n, m) => n + m.content.length, 0);
  if (total <= maxChars) return messages;

  const out = messages.map((m) => ({ ...m }));
  // Shrink non-system first, then system if still over budget.
  const order = [
    ...out.map((m, i) => ({ m, i })).filter((x) => x.m.role !== "system"),
    ...out.map((m, i) => ({ m, i })).filter((x) => x.m.role === "system"),
  ];
  for (const { m } of order) {
    if (total <= maxChars) break;
    if (m.content.length <= 24) continue;
    const over = total - maxChars;
    const keep = Math.max(20, m.content.length - over - 1);
    m.content = `${m.content.slice(0, keep)}…`;
    total = out.reduce((n, x) => n + x.content.length, 0);
  }
  // Hard cap: drop oldest non-system messages if still oversized
  while (total > maxChars && out.length > 1) {
    const idx = out.findIndex((m) => m.role !== "system");
    if (idx === -1) break;
    total -= out[idx]!.content.length;
    out.splice(idx, 1);
  }
  return out;
}
