import assert from "node:assert/strict";
import test from "node:test";
import {
  FileDropApprovalRegistry,
  fileDropTargetFingerprint,
  isExactFileDropConfirmation,
  isFileDropRequestUtterance,
  isLikelyFileDropTarget,
  isSupportedBrowserBundleId,
  isValidDownloadFileName,
  type FileDropTargetBinding,
} from "../src/desktop/file-drop-approval.js";

const now = new Date("2026-09-05T00:00:00.000Z");

function binding(overrides: Partial<FileDropTargetBinding> = {}): FileDropTargetBinding {
  return {
    conversationId: "conversation-a",
    fileName: "奕枢测试文件.txt",
    targetId: "3",
    targetBundleId: "com.apple.Safari",
    targetPid: 321,
    targetWindowNumber: 17,
    targetFingerprint: fileDropTargetFingerprint({
      role: "AXGroup",
      title: "上传文件",
      description: "拖放到这里",
      frame: { x: 100, y: 200, width: 240, height: 80 },
    }),
    ...overrides,
  };
}

test("download file names are one exact basename with an extension", () => {
  assert.equal(isValidDownloadFileName("奕枢测试文件.txt"), true);
  assert.equal(isValidDownloadFileName("合同 v2.pdf"), true);
  for (const value of ["", ".", "..", "no-extension", "/tmp/a.txt", "../a.txt", "folder/a.txt", "folder\\a.txt", "a\u0000.txt", "a\n.txt"]) {
    assert.equal(isValidDownloadFileName(value), false, value);
  }
  assert.equal(isValidDownloadFileName(`${"a".repeat(252)}.txt`), false);
});

test("file-drop intent and confirmation are narrow imperatives", () => {
  assert.equal(isFileDropRequestUtterance("把下载里的 奕枢测试文件.txt 拖到这个上传框"), true);
  assert.equal(isFileDropRequestUtterance("请上传 Downloads 里的合同.pdf 到这里"), true);
  assert.equal(isFileDropRequestUtterance("怎么把下载里的合同.pdf 拖进去？"), false);
  assert.equal(isFileDropRequestUtterance("不要上传下载里的合同.pdf"), false);
  assert.equal(isExactFileDropConfirmation("去"), true);
  assert.equal(isExactFileDropConfirmation(" 去。 "), true);
  assert.equal(isExactFileDropConfirmation("去提交"), false);
  assert.equal(isExactFileDropConfirmation("可以吗"), false);
});

test("only named upload or drop areas are eligible targets", () => {
  assert.equal(isLikelyFileDropTarget({ title: "上传文件", description: "拖放到这里" }), true);
  assert.equal(isLikelyFileDropTarget({ title: "Drop files here" }), true);
  assert.equal(isLikelyFileDropTarget({ title: "提交", description: "发送表单" }), false);
  assert.equal(isLikelyFileDropTarget({ role: "AXGroup" }), false);
});

test("file-drop target fingerprints change when the bound frame moves", () => {
  const target = {
    role: "AXGroup",
    title: "上传文件",
    description: "拖放到这里",
    frame: { x: 100, y: 200, width: 240, height: 80 },
  };
  assert.notEqual(
    fileDropTargetFingerprint(target),
    fileDropTargetFingerprint({ ...target, frame: { ...target.frame, x: 124 } }),
  );
  assert.equal(
    fileDropTargetFingerprint(target),
    ["AXGroup", "上传文件", "拖放到这里", "200,400,480,160"].join("\u001e"),
  );
});

test("file drops target supported visible browsers only", () => {
  for (const bundleId of [
    "local.yishu.chrome-main",
    "com.apple.Safari",
    "com.google.Chrome",
    "org.chromium.Chromium",
    "com.microsoft.edgemac",
    "org.mozilla.firefox",
    "company.thebrowser.Browser",
    "com.brave.Browser",
  ]) assert.equal(isSupportedBrowserBundleId(bundleId), true, bundleId);
  assert.equal(isSupportedBrowserBundleId("com.apple.TextEdit"), false);
  assert.equal(isSupportedBrowserBundleId("evil.com.google.Chrome"), false);
});

test("approval is conversation, file, window, and AX target bound; it expires and cannot replay", () => {
  const approvals = new FileDropApprovalRegistry();
  approvals.stage(binding(), now);
  assert.deepEqual(approvals.pendingBinding("conversation-a", now), binding());

  assert.equal(approvals.authorize({
    conversationId: "conversation-b",
    confirmationRequestId: "request-wrong-conversation",
    utterance: "去",
    current: binding({ conversationId: "conversation-b" }),
    now,
  }).decision, "none");

  const authorized = approvals.authorize({
    conversationId: "conversation-a",
    confirmationRequestId: "request-confirm",
    utterance: "去",
    current: binding(),
    now,
  });
  assert.equal(authorized.decision, "authorized");

  assert.equal(approvals.consume({
    confirmationRequestId: "request-confirm",
    fileName: "other.txt",
    targetId: "3",
    current: binding(),
    now,
  }).decision, "mismatch");
  assert.equal(approvals.consume({
    confirmationRequestId: "request-confirm",
    fileName: "奕枢测试文件.txt",
    targetId: "3",
    current: binding(),
    now,
  }).decision, "none");

  approvals.stage(binding(), now);
  assert.equal(approvals.authorize({
    conversationId: "conversation-a",
    confirmationRequestId: "request-expired",
    utterance: "去",
    current: binding(),
    now: new Date(now.getTime() + 60_001),
  }).decision, "expired");
});

test("a changed browser window or target fingerprint invalidates confirmation", () => {
  for (const current of [
    binding({ targetWindowNumber: 18 }),
    binding({ targetFingerprint: "changed" }),
    binding({ targetBundleId: "com.google.Chrome" }),
  ]) {
    const approvals = new FileDropApprovalRegistry();
    approvals.stage(binding(), now);
    assert.equal(approvals.authorize({
      conversationId: "conversation-a",
      confirmationRequestId: `request-${current.targetWindowNumber}-${current.targetBundleId}`,
      utterance: "去",
      current,
      now,
    }).decision, "mismatch");
  }
});

test("an unusable confirmation frame can explicitly invalidate pending approval", () => {
  const approvals = new FileDropApprovalRegistry();
  approvals.stage(binding(), now);
  approvals.cancelPending("conversation-a");
  assert.equal(approvals.pendingBinding("conversation-a", now), undefined);
});
