/**
 * Pure range clamp for MiniMax TTS speed (mirrors local-server.mjs).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const MIN = 0.5;
const MAX = 2.0;
const DEF = 1.0;

function clampSpeechSpeed(raw) {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEF;
  return Math.min(MAX, Math.max(MIN, n));
}

test("clampSpeechSpeed keeps provider range", () => {
  assert.equal(clampSpeechSpeed(1), 1);
  assert.equal(clampSpeechSpeed(0.5), 0.5);
  assert.equal(clampSpeechSpeed(2), 2);
  assert.equal(clampSpeechSpeed(0.1), 0.5);
  assert.equal(clampSpeechSpeed(3), 2);
  assert.equal(clampSpeechSpeed("1.4"), 1.4);
  assert.equal(clampSpeechSpeed("x"), 1);
  assert.equal(clampSpeechSpeed(undefined), 1);
  assert.equal(clampSpeechSpeed(NaN), 1);
});

test("request speed wins over env fallback pattern", () => {
  const resolve = (incomingSpeed, envSpeed) =>
    clampSpeechSpeed(
      incomingSpeed !== undefined && incomingSpeed !== null
        ? incomingSpeed
        : envSpeed || 1.0
    );
  assert.equal(resolve(1.6, "0.8"), 1.6);
  assert.equal(resolve(undefined, "0.8"), 0.8);
  assert.equal(resolve(null, "0.8"), 0.8);
  assert.equal(resolve(9, "0.8"), 2);
});
