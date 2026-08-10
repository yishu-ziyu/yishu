import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ContextTrail,
  buildContextCapsule,
  parseContextCapsule,
  serializeContextCapsule,
  toTrailEntry,
} from "../src/context/index.js";
import { SENSITIVE_CONTENT_REJECTED } from "../src/store/index.js";
import { makeFrame } from "./fixtures.js";

describe("ContextTrail + ContextCapsule", () => {
  it("strips screenshot bytes from trail entries", () => {
    const frame = makeFrame({ withScreenshot: true });
    const entry = toTrailEntry(frame);
    assert.equal(entry.hasScreenshot, true);
    assert.ok(entry.screenshotExpiresAt);
    const serialized = JSON.stringify(entry);
    assert.equal(serialized.includes("base64Data"), false);
    assert.equal(serialized.includes("QUJDREVGR0g="), false);
  });

  it("removes warning payloads while preserving ordinary policy text", () => {
    const frame = makeFrame();
    frame.warnings = [
      "screenshot base64Data: SECRET_SCREEN_BYTES_12345",
      "data:image/png;base64,SECRET_DATA_URI_12345",
      "system_prompt: PRIVATE_HIDDEN_INSTRUCTION",
      "政策：不要保存 screenshot 或 system prompt",
    ];
    const entry = toTrailEntry(frame);
    const serialized = JSON.stringify(entry);
    assert.equal(serialized.includes("SECRET_SCREEN_BYTES_12345"), false);
    assert.equal(serialized.includes("SECRET_DATA_URI_12345"), false);
    assert.equal(serialized.includes("PRIVATE_HIDDEN_INSTRUCTION"), false);
    assert.match(entry.warnings[3] ?? "", /政策/);
  });

  it("queries recent minutes and text search", () => {
    const trail = new ContextTrail({ retentionMs: 30 * 60_000 });
    const t0 = Date.parse("2026-08-07T12:00:00.000Z");
    trail.append(
      makeFrame({
        capturedAt: new Date(t0).toISOString(),
        appName: "Chrome",
        windowTitle: "github.com/yishu",
      }),
      new Date(t0),
    );
    trail.append(
      makeFrame({
        capturedAt: new Date(t0 + 60_000).toISOString(),
        appName: "Codex",
        windowTitle: "runtime-port.ts",
      }),
      new Date(t0 + 60_000),
    );
    trail.append(
      makeFrame({
        capturedAt: new Date(t0 + 120_000).toISOString(),
        appName: "Chrome",
        windowTitle: "agent-native docs",
      }),
      new Date(t0 + 120_000),
    );

    const now = new Date(t0 + 130_000);
    const recent = trail.recentMinutes(3, now);
    assert.equal(recent.length, 3);

    const codex = trail.query({ query: "codex", sinceMs: 10 * 60_000 }, now);
    assert.equal(codex.length, 1);
    assert.equal(codex[0]?.appName, "Codex");

    const summary = trail.summarize(3, now);
    assert.match(summary, /Chrome/);
    assert.match(summary, /Codex/);
  });

  it("expires screenshot metadata after TTL without dropping the row", () => {
    const trail = new ContextTrail({ screenshotTtlMs: 1_000 });
    const t0 = Date.parse("2026-08-07T12:00:00.000Z");
    trail.append(
      makeFrame({
        capturedAt: new Date(t0).toISOString(),
        withScreenshot: true,
      }),
      new Date(t0),
    );

    const stillHot = trail.query({}, new Date(t0 + 200));
    assert.equal(stillHot[0]?.hasScreenshot, true);

    const cold = trail.query({}, new Date(t0 + 5_000));
    assert.equal(cold[0]?.hasScreenshot, false);
    assert.equal(cold.length, 1);
  });

  it("builds a capsule free of screenshot bytes", () => {
    const trail = new ContextTrail();
    const now = new Date("2026-08-07T12:10:00.000Z");
    const frame = makeFrame({
      capturedAt: now.toISOString(),
      appName: "Chrome",
      windowTitle: "yishu PR",
      withScreenshot: true,
    });
    trail.append(frame, now);

    const capsule = buildContextCapsule({
      frame,
      trail,
      userIntent: "hand this to Codex",
      projectHint: "project:yishu",
      recentMinutes: 5,
      now,
    });

    assert.equal(capsule.schemaVersion, 1);
    assert.equal(capsule.userIntent, "hand this to Codex");
    assert.equal(capsule.frontmostApp?.name, "Chrome");
    assert.ok(capsule.selectedText);
    assert.equal(capsule.provenance.source, "yishu");
    assert.ok(capsule.provenance.trailEntryCount >= 1);

    const json = serializeContextCapsule(capsule);
    assert.equal(json.includes("base64Data"), false);
    assert.equal(json.includes("QUJDREVGR0g="), false);

    const roundTrip = parseContextCapsule(json);
    assert.equal(roundTrip.capsuleId, capsule.capsuleId);
  });

  it("redacts sensitive live-frame and intent text before capsule handoff", () => {
    const trail = new ContextTrail();
    const now = new Date("2026-08-07T12:10:00.000Z");
    const frame = makeFrame({
      capturedAt: now.toISOString(),
      windowTitle: "https://example.test/?token=LIVE_SECRET_12345",
      axValue: "password=AX_SECRET_12345",
    });
    frame.warnings = ["screenshot base64Data: SCREEN_SECRET_12345"];
    trail.append(frame, now);

    const capsule = buildContextCapsule({
      frame,
      trail,
      userIntent: "交给 Codex password=INTENT_SECRET_12345",
      projectHint: "打开 Secret Manager；政策是禁止保存 screenshot",
      now,
    });
    const json = serializeContextCapsule(capsule);
    assert.equal(json.includes("LIVE_SECRET_12345"), false);
    assert.equal(json.includes("AX_SECRET_12345"), false);
    assert.equal(json.includes("INTENT_SECRET_12345"), false);
    assert.equal(json.includes("SCREEN_SECRET_12345"), false);
    assert.match(capsule.projectHint ?? "", /Secret Manager/);

    const withUnknown = {
      ...capsule,
      privatePayload: "password=UNKNOWN_SECRET_12345",
    } as typeof capsule & { privatePayload: string };
    const canonical = serializeContextCapsule(withUnknown);
    assert.equal(canonical.includes("privatePayload"), false);
    assert.equal(canonical.includes("UNKNOWN_SECRET_12345"), false);
  });

  it("fails closed when an incoming capsule contains sensitive text", () => {
    const trail = new ContextTrail();
    const now = new Date("2026-08-07T12:10:00.000Z");
    const frame = makeFrame({ capturedAt: now.toISOString() });
    trail.append(frame, now);
    const capsule = buildContextCapsule({ trail, now });
    const raw = JSON.parse(serializeContextCapsule(capsule)) as Record<string, unknown>;
    raw.userIntent = "password=DO_NOT_FORWARD_12345";
    assert.throws(
      () => parseContextCapsule(JSON.stringify(raw)),
      (error: unknown) =>
        error instanceof Error && error.message === SENSITIVE_CONTENT_REJECTED,
    );

    const trailEntry = (raw.recentTrail as Array<Record<string, unknown>>)[0];
    if (trailEntry) {
      trailEntry.warnings = ["data:image/png;base64,DO_NOT_FORWARD_12345"];
      assert.throws(
        () => parseContextCapsule(JSON.stringify(raw)),
        (error: unknown) =>
          error instanceof Error && error.message === SENSITIVE_CONTENT_REJECTED,
      );
    }

    const withFrame = buildContextCapsule({
      trail,
      frame,
      now,
    });
    const unsafeWindow = JSON.parse(serializeContextCapsule(withFrame)) as Record<string, unknown>;
    (unsafeWindow.window as Record<string, unknown>).title =
      "https://example.test/?token=DO_NOT_FORWARD_WINDOW_12345";
    assert.throws(
      () => parseContextCapsule(JSON.stringify(unsafeWindow)),
      (error: unknown) =>
        error instanceof Error && error.message === SENSITIVE_CONTENT_REJECTED,
    );
  });
});
