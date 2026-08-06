import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import {
  FileMemoryStore,
  effectiveLayer,
  type MemoryCard,
} from "../src/memory/store.js";

const dir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".tmp-memory",
);

describe("memory store", () => {
  it("persists cards across load", async () => {
    await fs.mkdir(dir, { recursive: true });
    const memPath = path.join(dir, "memory.json");
    try {
      await fs.unlink(memPath);
    } catch {
      /* ok */
    }

    const a = new FileMemoryStore(memPath);
    await a.load();
    await a.add({
      content: "我偏好 tokyonight 主题",
      kind: "preference",
      tags: ["user", "theme"],
    });

    const b = new FileMemoryStore(memPath);
    await b.load();
    const hits = await b.search("tokyonight");
    assert.equal(hits.length, 1);
    assert.ok(hits[0]?.content.includes("tokyonight"));
  });

  it("defaults new cards to session layer", async () => {
    await fs.mkdir(dir, { recursive: true });
    const memPath = path.join(dir, "memory-layer-default.json");
    try {
      await fs.unlink(memPath);
    } catch {
      /* ok */
    }

    const store = new FileMemoryStore(memPath);
    await store.load();
    const card = await store.add({ content: "临时笔记" });
    assert.equal(card.layer, "session");
    assert.equal(effectiveLayer(card), "session");
  });

  it("accepts explicit layer on add", async () => {
    await fs.mkdir(dir, { recursive: true });
    const memPath = path.join(dir, "memory-layer-explicit.json");
    try {
      await fs.unlink(memPath);
    } catch {
      /* ok */
    }

    const store = new FileMemoryStore(memPath);
    await store.load();
    const card = await store.add({
      content: "我偏好深色主题",
      layer: "profile",
      kind: "preference",
    });
    assert.equal(card.layer, "profile");
  });

  it("treats legacy cards without layer as session", async () => {
    await fs.mkdir(dir, { recursive: true });
    const memPath = path.join(dir, "memory-legacy.json");
    const legacy: MemoryCard[] = [
      {
        id: "legacy-1",
        kind: "note",
        content: "legacy note about coffee",
        tags: ["user"],
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z",
        // no layer field
      },
    ];
    await fs.writeFile(memPath, JSON.stringify(legacy), "utf8");

    const store = new FileMemoryStore(memPath);
    await store.load();
    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.layer, undefined);
    assert.equal(effectiveLayer(listed[0]!), "session");

    const hits = await store.search("coffee", { layer: "session" });
    assert.equal(hits.length, 1);
  });

  it("search ranks profile > long_term > session > working", async () => {
    await fs.mkdir(dir, { recursive: true });
    const memPath = path.join(dir, "memory-rank.json");
    try {
      await fs.unlink(memPath);
    } catch {
      /* ok */
    }

    const store = new FileMemoryStore(memPath);
    await store.load();
    // Insert in reverse rank order so sort must do real work
    await store.add({ content: "theme working note", layer: "working" });
    await store.add({ content: "theme session note", layer: "session" });
    await store.add({ content: "theme long_term note", layer: "long_term" });
    await store.add({ content: "theme profile note", layer: "profile" });

    const hits = await store.search("theme");
    assert.equal(hits.length, 4);
    assert.deepEqual(
      hits.map((h) => h.layer),
      ["profile", "long_term", "session", "working"],
    );
  });

  it("search can filter by layer", async () => {
    await fs.mkdir(dir, { recursive: true });
    const memPath = path.join(dir, "memory-filter.json");
    try {
      await fs.unlink(memPath);
    } catch {
      /* ok */
    }

    const store = new FileMemoryStore(memPath);
    await store.load();
    await store.add({ content: "apple session", layer: "session" });
    await store.add({ content: "apple profile", layer: "profile" });

    const onlyProfile = await store.search("apple", { layer: "profile" });
    assert.equal(onlyProfile.length, 1);
    assert.equal(onlyProfile[0]?.layer, "profile");
  });

  it("promoteMemory moves card to target layer", async () => {
    await fs.mkdir(dir, { recursive: true });
    const memPath = path.join(dir, "memory-promote.json");
    try {
      await fs.unlink(memPath);
    } catch {
      /* ok */
    }

    const store = new FileMemoryStore(memPath);
    await store.load();
    const card = await store.add({ content: "promote me", layer: "working" });
    const promoted = await store.promoteMemory(card.id, "long_term");
    assert.ok(promoted);
    assert.equal(promoted!.layer, "long_term");

    const missing = await store.promoteMemory("no-such-id", "profile");
    assert.equal(missing, null);
  });
});
