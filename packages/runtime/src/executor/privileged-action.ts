export const PRIVILEGED_ACTION_KINDS = [
  "observe_accessibility",
  "desktop_action",
  "workspace_bookmark",
  "native_notes",
  "native_finder",
  "native_notification",
  "permission_status",
] as const;

export type PrivilegedActionKind = (typeof PRIVILEGED_ACTION_KINDS)[number];

export const REJECTED_PRIVILEGED_SHAPES = [
  "arbitrary_shell",
  "arbitrary_applescript",
  "arbitrary_selector",
  "arbitrary_path",
  "arbitrary_url_scheme",
  "model_claimed_approval",
] as const;

export type RejectedPrivilegedShape = (typeof REJECTED_PRIVILEGED_SHAPES)[number];

export function isPrivilegedActionKind(value: string): value is PrivilegedActionKind {
  return (PRIVILEGED_ACTION_KINDS as readonly string[]).includes(value);
}

export function rejectUnknownPrivilegedAction(kind: string): never {
  throw new Error(`Executor rejected unknown action '${kind}'.`);
}
