/**
 * Per-conversation tool surface decided at the createSession boundary
 * (delegation V1, ADR 0009). Main sessions keep computer control, search
 * the public web, and may delegate long work. Delegated child sessions
 * search the web but receive neither computer control nor recursive
 * delegate.
 *
 * Extracted from loop-adapter.ts to break the delegation <-> loop-adapter
 * dependency cycle (dependency-cruiser no-circular).
 */

import type { ToolDefinition } from "./model-loop/index.js";

export interface SessionToolPolicy {
  readonly computerControl: boolean;
  /** Tools always registered in Main session registry, but not necessarily active this turn. */
  readonly registeredExtraTools?: readonly ToolDefinition[];
  readonly extraTools: ToolDefinition[];
  /** Explicit active Main-tool names for this prompt; absent keeps extraTools active. */
  readonly activeExtraToolNames?: readonly string[];
}

export const DEFAULT_SESSION_TOOL_POLICY: SessionToolPolicy = {
  computerControl: true,
  extraTools: [],
};
