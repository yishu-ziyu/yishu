import assert from "node:assert/strict";
import test from "node:test";
import { downloadsObservationSchema, type ContextFrame } from "../src/protocol.js";
import { desktopActionBudgetForTurn, groundedDownloadFileName } from "../src/desktop/computer-turn.js";

const now = new Date("2026-09-05T02:00:00.000Z");
const utterance = "把下载里的易书测试文件点.txt拖到这个上传框";
const good = { status: "available" as const, capturedAt: now.toISOString(), candidates: ["奕枢测试文件.txt"], truncated: false };
// Only the Downloads observation is consulted by this resolver; target/window checks happen at admission.
const frame = (observation: ContextFrame["downloadFiles"]) => ({ downloadFiles: observation }) as ContextFrame;

test("native lookup resolves the spoken name and grants a one-action budget, not a model-selected filename", () => {
  const fileName = groundedDownloadFileName(utterance, frame(good), now);
  assert.equal(fileName, "奕枢测试文件.txt");
  assert.equal(desktopActionBudgetForTurn({ utterance: "把下载里的易书测试文件拖进去", intentAllowsEffect: true, groundedFileName: fileName }), 1);
  assert.equal(groundedDownloadFileName("把下载里的会义记录上传", frame({ ...good, candidates: ["会议记录.md"] }), now), "会议记录.md");
  assert.equal(groundedDownloadFileName("不要上传下载里的文件", frame(good), now), undefined);
});

test("failed, empty, ambiguous, truncated, future and stale native observations cannot fall back to ASR spelling", () => {
  for (const observation of [
    { ...good, status: "permission_denied" as const, candidates: [] },
    { ...good, status: "unavailable" as const, candidates: [] },
    { ...good, candidates: [] },
    { ...good, candidates: ["奕枢测试文件.txt", "易书测试文件.txt"] },
    { ...good, truncated: true },
    { ...good, capturedAt: new Date(now.getTime() - 60_001).toISOString() },
    { ...good, capturedAt: new Date(now.getTime() + 1).toISOString() },
  ]) assert.equal(groundedDownloadFileName(utterance, frame(observation), now), undefined);
  assert.equal(groundedDownloadFileName("把下载里的会议记录.md拖进去", frame(undefined), now), "会议记录.md", "old v1 exact-name clients remain compatible");
});

test("wire observation rejects impossible statuses, duplicate candidates and path injection", () => {
  assert.deepEqual(downloadsObservationSchema.parse(good), good);
  for (const observation of [
    { ...good, status: "permission_denied" },
    { ...good, candidates: ["../secret.txt"] },
    { ...good, candidates: ["a.txt", "a.txt"] },
    { ...good, candidates: Array.from({ length: 21 }, (_, index) => `${index}.txt`) },
  ]) assert.equal(downloadsObservationSchema.safeParse(observation).success, false);
});
