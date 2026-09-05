import { randomUUID } from "node:crypto";

export const FILE_DROP_APPROVAL_TTL_MS = 60_000;

export interface FileDropTargetDescriptor {
  role?: string | null;
  title?: string | null;
  description?: string | null;
  frame?: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
}

export interface FileDropTargetBinding {
  conversationId: string;
  fileName: string;
  targetId: string;
  targetBundleId: string;
  targetPid: number;
  targetWindowNumber: number;
  targetFingerprint: string;
}

interface PendingFileDrop extends FileDropTargetBinding {
  expiresAtMs: number;
}

export type FileDropApprovalDecision =
  | { decision: "none" }
  | { decision: "expired" }
  | { decision: "mismatch" }
  | { decision: "authorized"; binding: FileDropTargetBinding; expiresAt: string; nonce: string };

export type FileDropConsumeDecision =
  | { decision: "none" }
  | { decision: "expired" }
  | { decision: "mismatch" }
  | { decision: "approved"; binding: FileDropTargetBinding; expiresAt: string; nonce: string };

const denialOrQuestionPattern = /^(?:(?:请|麻烦|帮我|请帮我)\s*)?(?:不要|别(?:再)?|无需|不(?:要|用|必)|禁止)|(?:怎么|如何|为什么|是否|能否|可以.*吗|会怎样)|[?？]/iu;
const downloadsPattern = /(?:下载(?:文件夹|目录|里|中的)?|downloads?)/iu;
const fileDropVerbPattern = /(?:拖(?:到|进|入|放)|放到|上传)/u;

export function isValidDownloadFileName(value: string): boolean {
  if (value.length === 0 || value !== value.trim()) return false;
  if (Array.from(value).length > 255) return false;
  if (value === "." || value === "..") return false;
  if (/[\\/\u0000-\u001f\u007f]/u.test(value)) return false;
  const lastDot = value.lastIndexOf(".");
  return lastDot > 0 && lastDot < value.length - 1;
}

export function isFileDropRequestUtterance(utterance: string): boolean {
  const text = utterance.trim();
  if (text.length === 0 || denialOrQuestionPattern.test(text)) return false;
  return downloadsPattern.test(text) && fileDropVerbPattern.test(text);
}

export function isExactFileDropConfirmation(utterance: string): boolean {
  return utterance.trim().replace(/[。！!]$/u, "").trim() === "去";
}

export function fileDropTargetFingerprint(target: FileDropTargetDescriptor): string {
  const frame = target.frame;
  const frameKey = frame === undefined || frame === null
    ? ""
    : [frame.x, frame.y, frame.width, frame.height]
      .map((value) => String(Math.round(value * 2)))
      .join(",");
  return [target.role ?? "", target.title ?? "", target.description ?? "", frameKey].join("\u001e");
}

export function isLikelyFileDropTarget(target: FileDropTargetDescriptor): boolean {
  const accessibleName = [target.title ?? "", target.description ?? ""].join(" ").trim();
  return /(?:上传|拖放|拖拽|附件|文件|\bupload\b|\bdrop\b|\battach(?:ment)?\b)/iu.test(accessibleName);
}

const SUPPORTED_BROWSER_BUNDLE_PREFIXES = [
  "local.yishu.chrome-main",
  "com.apple.Safari",
  "com.google.Chrome",
  "org.chromium.Chromium",
  "com.microsoft.edgemac",
  "org.mozilla.firefox",
  "company.thebrowser.Browser",
  "com.brave.Browser",
] as const;

export function isSupportedBrowserBundleId(bundleId: string): boolean {
  return SUPPORTED_BROWSER_BUNDLE_PREFIXES.some(
    (prefix) => bundleId === prefix || bundleId.startsWith(`${prefix}.`),
  );
}

function sameBinding(left: FileDropTargetBinding, right: FileDropTargetBinding): boolean {
  return left.conversationId === right.conversationId
    && left.fileName === right.fileName
    && left.targetId === right.targetId
    && left.targetBundleId === right.targetBundleId
    && left.targetPid === right.targetPid
    && left.targetWindowNumber === right.targetWindowNumber
    && left.targetFingerprint === right.targetFingerprint;
}

export class FileDropApprovalRegistry {
  private readonly pendingByConversation = new Map<string, PendingFileDrop>();
  private readonly authorizedByRequest = new Map<string, PendingFileDrop & { nonce: string }>();

  stage(binding: FileDropTargetBinding, now: Date): void {
    this.pendingByConversation.set(binding.conversationId, {
      ...binding,
      expiresAtMs: now.getTime() + FILE_DROP_APPROVAL_TTL_MS,
    });
  }

  pendingBinding(conversationId: string, now: Date): FileDropTargetBinding | undefined {
    const pending = this.pendingByConversation.get(conversationId);
    if (!pending) return undefined;
    if (pending.expiresAtMs <= now.getTime()) {
      this.pendingByConversation.delete(conversationId);
      return undefined;
    }
    const { expiresAtMs: _, ...binding } = pending;
    return binding;
  }

  cancelPending(conversationId: string): void {
    this.pendingByConversation.delete(conversationId);
  }

  authorize(input: {
    conversationId: string;
    confirmationRequestId: string;
    utterance: string;
    current: FileDropTargetBinding;
    now: Date;
  }): FileDropApprovalDecision {
    if (!isExactFileDropConfirmation(input.utterance)) return { decision: "none" };
    const pending = this.pendingByConversation.get(input.conversationId);
    if (!pending) return { decision: "none" };
    this.pendingByConversation.delete(input.conversationId);
    if (pending.expiresAtMs <= input.now.getTime()) return { decision: "expired" };
    if (!sameBinding(pending, input.current)) return { decision: "mismatch" };
    const nonce = randomUUID();
    this.authorizedByRequest.set(input.confirmationRequestId, { ...pending, nonce });
    return {
      decision: "authorized",
      binding: pending,
      expiresAt: new Date(pending.expiresAtMs).toISOString(),
      nonce,
    };
  }

  consume(input: {
    confirmationRequestId: string;
    fileName: string;
    targetId: string;
    current: FileDropTargetBinding;
    now: Date;
  }): FileDropConsumeDecision {
    const authorized = this.authorizedByRequest.get(input.confirmationRequestId);
    if (!authorized) return { decision: "none" };
    this.authorizedByRequest.delete(input.confirmationRequestId);
    if (authorized.expiresAtMs <= input.now.getTime()) return { decision: "expired" };
    if (input.fileName !== authorized.fileName
      || input.targetId !== authorized.targetId
      || !sameBinding(authorized, input.current)) {
      return { decision: "mismatch" };
    }
    return {
      decision: "approved",
      binding: authorized,
      expiresAt: new Date(authorized.expiresAtMs).toISOString(),
      nonce: authorized.nonce,
    };
  }

  clear(): void {
    this.pendingByConversation.clear();
    this.authorizedByRequest.clear();
  }
}
