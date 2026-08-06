import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compressMessages } from "../src/context/compress.js";
import type { ChatMessage } from "../src/types.js";

describe("compressMessages", () => {
  it("keeps system messages when compressing", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "SYSTEM_KEEP" },
      { role: "user", content: "u1 ".repeat(100) },
      { role: "assistant", content: "a1 ".repeat(100) },
      { role: "user", content: "u2 ".repeat(100) },
      { role: "assistant", content: "a2 ".repeat(100) },
      { role: "user", content: "u3 ".repeat(100) },
      { role: "assistant", content: "a3 ".repeat(100) },
      { role: "user", content: "u4 ".repeat(100) },
      { role: "assistant", content: "a4 ".repeat(100) },
      { role: "user", content: "latest" },
    ];
    const out = compressMessages(messages, 400, 4);
    assert.ok(out.some((m) => m.role === "system" && m.content.includes("SYSTEM_KEEP")));
    assert.ok(out.some((m) => m.content.includes("compressed") || m.content === "latest"));
    const total = out.reduce((n, m) => n + m.content.length, 0);
    assert.ok(total <= 400 + 50); // small slack for ellipsis
  });
});
