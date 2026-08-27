import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  grantIsActive,
  normalizeSessionScope,
  PERSONAL_WORKSPACE_CAPABILITIES,
  sessionScopesEqual,
  type WorkspaceCapability,
  type YishuKernel,
} from "@yishu/kernel";
import type {
  WorkspaceApproveCommand,
  WorkspaceGrantCommand,
  WorkspaceListCommand,
  WorkspaceRevokeCommand,
} from "../protocol.js";
import { runtimeEvent } from "../protocol.js";
import type { RuntimeEventSink } from "../runtime-port.js";

export interface WorkspaceCommandHost {
  readonly kernel: YishuKernel;
  readonly isTrashApproved: (workspaceId: string) => boolean;
  readonly clearTrashApproval: (workspaceId: string) => void;
  readonly approveTrash: (workspaceId: string, allowed: boolean) => boolean;
  readonly isDisposed: () => boolean;
}

type ResolvedGrantFolder =
  | { ok: true; path: string }
  | { ok: false; code: string; message: string };

async function resolveGrantedFolder(rootPath: string): Promise<ResolvedGrantFolder> {
  if (!path.isAbsolute(rootPath) || rootPath.includes("\0")) {
    return { ok: false, code: "folder_path_invalid", message: "文件夹路径无效。" };
  }
  try {
    const info = await stat(rootPath);
    if (!info.isDirectory()) {
      return { ok: false, code: "folder_not_directory", message: "请选一个文件夹。" };
    }
  } catch {
    return { ok: false, code: "folder_unavailable", message: "这个文件夹现在打不开。" };
  }
  try {
    return { ok: true, path: await realpath(rootPath) };
  } catch {
    return { ok: true, path: path.resolve(rootPath) };
  }
}

function uniqueWorkspaceCapabilities(
  capabilities: readonly WorkspaceCapability[],
): WorkspaceCapability[] {
  return [...new Set(capabilities)];
}

export class WorkspaceCommandHandler {
  constructor(private readonly host: WorkspaceCommandHost) {}

  async grant(command: WorkspaceGrantCommand, emit: RuntimeEventSink): Promise<void> {
    if (this.host.isDisposed()) {
      emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
        code: "runtime_disposed",
        message: "这次没有加上这个文件夹。",
      }));
      return;
    }
    try {
      const sessionScope = normalizeSessionScope(command.payload.sessionScope);
      if (sessionScope.kind !== "personal") {
        emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
          code: "scope_not_supported",
          message: "只能在「我的」里添加文件夹工作区。",
        }));
        return;
      }
      const resolved = await resolveGrantedFolder(command.payload.rootPath);
      if (resolved.ok === false) {
        emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
          code: resolved.code,
          message: resolved.message,
        }));
        return;
      }
      const capabilities = command.payload.capabilities === undefined
        ? [...PERSONAL_WORKSPACE_CAPABILITIES]
        : uniqueWorkspaceCapabilities(command.payload.capabilities);
      const grant = this.host.kernel.workspaces.ingest({
        id: command.payload.workspaceId,
        displayName: command.payload.displayName,
        rootPathReference: resolved.path,
        scope: sessionScope,
        capabilities,
      });
      emit(runtimeEvent("workspace.granted", command.requestId, command.traceId, {
        workspaceId: grant.id,
        displayName: grant.displayName,
        capabilities: grant.capabilities,
        createdAt: grant.createdAt,
        trashApproved: this.host.isTrashApproved(grant.id),
      }));
    } catch {
      emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
        code: "workspace_grant_failed",
        message: "这次没有加上这个文件夹。",
      }));
    }
  }

  async revoke(command: WorkspaceRevokeCommand, emit: RuntimeEventSink): Promise<void> {
    if (this.host.isDisposed()) {
      emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
        code: "runtime_disposed",
        message: "这次没有撤销。",
      }));
      return;
    }
    try {
      const sessionScope = normalizeSessionScope(command.payload.sessionScope);
      if (sessionScope.kind !== "personal") {
        emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
          code: "scope_not_supported",
          message: "只能撤销「我的」里的文件夹工作区。",
        }));
        return;
      }
      const existing = this.host.kernel.workspaces.get(command.payload.workspaceId);
      if (existing !== undefined && !sessionScopesEqual(existing.scope, sessionScope)) {
        emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
          code: "scope_mismatch",
          message: "这个文件夹不在当前范围，未撤销。",
        }));
        return;
      }
      this.host.kernel.workspaces.revoke(command.payload.workspaceId);
      this.host.clearTrashApproval(command.payload.workspaceId);
      emit(runtimeEvent("workspace.revoked", command.requestId, command.traceId, {
        workspaceId: command.payload.workspaceId,
        alreadyGone: existing === undefined || existing.revokedAt !== undefined,
      }));
    } catch {
      emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
        code: "workspace_revoke_failed",
        message: "这次没有撤销。",
      }));
    }
  }

  async list(command: WorkspaceListCommand, emit: RuntimeEventSink): Promise<void> {
    if (this.host.isDisposed()) {
      emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
        code: "runtime_disposed",
        message: "暂时无法读取文件夹工作区。",
      }));
      return;
    }
    try {
      const sessionScope = normalizeSessionScope(command.payload.sessionScope);
      if (sessionScope.kind !== "personal") {
        emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
          code: "scope_not_supported",
          message: "只能在「我的」查看文件夹工作区。",
        }));
        return;
      }
      const now = new Date();
      const items = this.host.kernel.workspaces.list(sessionScope)
        .filter((grant) => grantIsActive(grant, now))
        .map((grant) => ({
          id: grant.id,
          displayName: grant.displayName,
          capabilities: grant.capabilities,
          createdAt: grant.createdAt,
          trashApproved: this.host.isTrashApproved(grant.id),
        }));
      emit(runtimeEvent("workspace.listed", command.requestId, command.traceId, {
        sessionScope,
        items,
      }));
    } catch {
      emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
        code: "workspace_list_failed",
        message: "暂时无法读取文件夹工作区。",
      }));
    }
  }

  async approve(command: WorkspaceApproveCommand, emit: RuntimeEventSink): Promise<void> {
    if (this.host.isDisposed()) {
      emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
        code: "runtime_disposed",
        message: "这次没有改废纸篓许可。",
      }));
      return;
    }
    try {
      const sessionScope = normalizeSessionScope(command.payload.sessionScope);
      if (sessionScope.kind !== "personal") {
        emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
          code: "scope_not_supported",
          message: "只能在「我的」确认废纸篓。",
        }));
        return;
      }
      const grant = this.host.kernel.workspaces.get(command.payload.workspaceId);
      if (grant === undefined || !grantIsActive(grant) || !sessionScopesEqual(grant.scope, sessionScope)) {
        emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
          code: "unknown_workspace",
          message: "没有这个文件夹工作区。",
        }));
        return;
      }
      const allowed = command.payload.allowed;
      this.host.approveTrash(command.payload.workspaceId, allowed);
      emit(runtimeEvent("workspace.approved", command.requestId, command.traceId, {
        workspaceId: command.payload.workspaceId,
        op: "trash",
        allowed,
      }));
    } catch {
      emit(runtimeEvent("workspace.failed", command.requestId, command.traceId, {
        code: "workspace_approve_failed",
        message: "这次没有改废纸篓许可。",
      }));
    }
  }
}
