/** Shared types for @yishu/agent-core */

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: MessageRole;
  content: string;
  /** Present when role is tool */
  toolCallId?: string;
  name?: string;
  /** Assistant tool call payloads */
  toolCalls?: ToolCallRequest[];
}

export type ToolCategory =
  | "perception"
  | "execution"
  | "collaboration"
  | "communication";

/** Minimal JSON-schema-ish parameter description */
export interface JsonSchemaLike {
  type?: string;
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  description?: string;
  items?: JsonSchemaLike;
  [key: string]: unknown;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  evidence?: Record<string, unknown>;
  error?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  parameters: JsonSchemaLike;
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type TrajectoryStepKind =
  | "think"
  | "tool_call"
  | "tool_result"
  | "status"
  | "final"
  | "review";

export interface TrajectoryStep {
  kind: TrajectoryStepKind;
  at: string;
  data: unknown;
}

export type TrajectoryStatus =
  | "running"
  | "completed"
  | "failed"
  | "rejected"
  | "max_iterations";

export interface Trajectory {
  id: string;
  task: string;
  startedAt: string;
  endedAt?: string;
  steps: TrajectoryStep[];
  status: TrajectoryStatus;
  result?: string;
}

export interface AgentConfig {
  maxIterations: number;
  maxReviewRounds: number;
  workspaceDir: string;
  skillsDir: string;
  memoryPath: string;
  enableReview: boolean;
  model?: string;
}

export interface Skill {
  name: string;
  description: string;
  body: string;
  path: string;
}

export const DEFAULT_AGENT_CONFIG: Omit<
  AgentConfig,
  "workspaceDir" | "skillsDir" | "memoryPath"
> = {
  maxIterations: 8,
  maxReviewRounds: 2,
  enableReview: true,
};
