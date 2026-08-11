// ContextCapsule security and isolation contract (ADR 0006, ADR 0009):
// a capsule is a sanitized, windowed, deep-copied handoff projection.
// Screenshots, credentials, and hidden reasoning must never cross the
// serialize/parse boundary. Expiry is data, not enforcement — receivers
// must validate it explicitly at the handoff boundary (RFC v2 §3.10).

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
  buildContextCapsule,
  parseContextCapsule,
  serializeContextCapsule,
  type ContextCapsule,
} from "../src/context/capsule.js";
import { ContextTrail } from "../src/context/trail.js";
import type { TrailSourceFrame } from "../src/context/sanitize.js";

const NOW = new Date("2026-08-11T12:00:00.000Z");

function observed<T>(value: T) {
  return { value, source: "test", capturedAt: NOW.toISOString(), confidence: 1 };
}

function makeFrame(minutesAgo: number, appName: string): TrailSourceFrame {
  return {
    frameId: randomUUID(),
    capturedAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
    frontmostApplication: observed({
      name: appName,
      bundleIdentifier: "com.example.App",
      processIdentifier: 100,
    }),
    activeWindow: observed({
      title: `${appName} window`,
      ownerName: appName,
      processIdentifier: 100,
      bounds: null,
    }),
    elementUnderCursor: observed({
      role: "AXButton",
      subrole: null,
      title: "Export",
      description: null,
      valuePreview: "row 1: revenue up 12%",
    }),
    screenshots: [{ label: "display", base64Data: "c2NyZWVuc2hvdC1ieXRlcw==" }],
    warnings: [],
  };
}

function buildCapsule() {
  const trail = new ContextTrail({ retentionMs: 24 * 60 * 60_000 });
  for (const minutesAgo of [60, 30, 4, 1]) {
    trail.append(makeFrame(minutesAgo, `App-${minutesAgo}`), NOW);
  }
  const capsule = buildContextCapsule({
    frame: makeFrame(0, "App-0"),
    trail,
    userIntent: "Summarize why the Export button is disabled",
    projectHint: "yishu",
    recentMinutes: 5,
    ttlMs: 15 * 60_000,
    now: NOW,
  });
  return { trail, capsule };
}

describe("ContextCapsule", () => {
  it("carries only the recent window, never the full trail history", () => {
    const { capsule } = buildCapsule();
    assert.deepEqual(
      capsule.recentTrail.map((entry) => entry.appName),
      ["App-4", "App-1"],
    );
    assert.ok(!("turns" in capsule) && !("conversation" in capsule));
  });

  it("never serializes screenshot bytes", () => {
    const { capsule } = buildCapsule();
    const json = serializeContextCapsule(capsule);
    assert.ok(!json.includes("c2NyZWVuc2hvdC1ieXRlcw=="));
    assert.ok(!json.includes('"base64Data"'));
  });

  it("hard-rejects smuggled screenshots, credentials, and hidden reasoning", () => {
    const { capsule } = buildCapsule();
    for (const key of [
      "base64Data",
      "screenshot",
      "apiKey",
      "accessToken",
      "password",
      "credential",
      "chainOfThought",
      "systemPrompt",
    ]) {
      assert.throws(
        () => parseContextCapsule(JSON.stringify({ ...capsule, [key]: "x" })),
        undefined,
        `${key} must be rejected`,
      );
    }
  });

  it("drops unknown fields from hand-built objects at the serialization boundary", () => {
    const { capsule } = buildCapsule();
    const parsed = JSON.parse(
      serializeContextCapsule({ ...capsule, internalNotes: "raw reasoning" } as unknown as ContextCapsule),
    ) as Record<string, unknown>;
    assert.ok(!("internalNotes" in parsed));
  });

  it("returns a deep-copied projection: mutating a parsed copy cannot reach the source", () => {
    const { trail, capsule } = buildCapsule();
    const copy = parseContextCapsule(serializeContextCapsule(capsule));
    copy.userIntent = "rewritten";
    copy.recentTrail.length = 0;
    if (copy.frontmostApp) copy.frontmostApp.name = "EVIL";

    assert.equal(capsule.userIntent, "Summarize why the Export button is disabled");
    assert.equal(capsule.recentTrail.length, 2);
    assert.deepEqual(
      trail.recentMinutes(5, NOW).map((entry) => entry.appName),
      ["App-4", "App-1"],
    );
  });

  it("treats expiry as data: parse accepts an expired capsule, so receivers must enforce it", () => {
    const { capsule } = buildCapsule();
    const expiredNow = new Date(Date.parse(capsule.expiresAt) + 1_000);
    // Structural parse does not enforce expiry — this pins the gap so a future
    // built-in enforcement change is a deliberate, reviewed decision.
    const parsed = parseContextCapsule(serializeContextCapsule(capsule));
    assert.ok(Date.parse(parsed.expiresAt) < expiredNow.getTime());
  });
});
