import type { SessionScope } from "@yishu/kernel";

export type FileCapability = "read" | "create" | "edit" | "move" | "trash";

export type FileOp =
  | "list_workspaces"
  | "list"
  | "stat"
  | "search"
  | "read_text"
  | "create_text"
  | "apply_patch"
  | "mkdir"
  | "copy"
  | "move"
  | "trash"
  | "restore_from_trash"
  | "open_in_app";

export const FILE_OP_CAPABILITY: Record<FileOp, FileCapability | "restore" | "none"> = {
  list_workspaces: "none",
  list: "read",
  stat: "read",
  search: "read",
  read_text: "read",
  create_text: "create",
  apply_patch: "edit",
  mkdir: "create",
  copy: "move",
  move: "move",
  trash: "trash",
  restore_from_trash: "restore",
  open_in_app: "read",
};

export type FilePolicyDecision =
  | { decision: "allow" }
  | { decision: "approval_required"; reason: string }
  | { decision: "deny"; reason: string };

export const FILE_MUTATION_COUNT_LIMIT = 20;
export const FILE_MUTATION_BYTES_LIMIT = 2 * 1024 * 1024;

export function evaluateFileOp(input: {
  op: FileOp;
  scope: SessionScope;
  capabilities: readonly FileCapability[];
  grantRevoked?: boolean;
  overwriteExisting?: boolean;
  mutationCount?: number;
  mutationBytes?: number;
}): FilePolicyDecision {
  if (input.grantRevoked === true) {
    return { decision: "deny", reason: "Workspace grant is revoked." };
  }
  if (input.scope.kind === "private" && input.op !== "list_workspaces" && input.op !== "list" && input.op !== "stat" && input.op !== "read_text" && input.op !== "search") {
    return { decision: "deny", reason: "Private grants are read-only for the current session." };
  }
  const needed = FILE_OP_CAPABILITY[input.op];
  if (needed === "none") {
    return { decision: "allow" };
  }
  if (needed !== "restore" && !input.capabilities.includes(needed)) {
    return { decision: "deny", reason: `Workspace grant does not include ${needed}.` };
  }
  if (input.op === "trash" || input.overwriteExisting === true) {
    return { decision: "approval_required", reason: "Overwriting or trashing a file requires explicit approval." };
  }
  if ((input.mutationCount ?? 0) > FILE_MUTATION_COUNT_LIMIT || (input.mutationBytes ?? 0) > FILE_MUTATION_BYTES_LIMIT) {
    return { decision: "approval_required", reason: "File mutation exceeds the default 20-file or 2 MB bound." };
  }
  return { decision: "allow" };
}
