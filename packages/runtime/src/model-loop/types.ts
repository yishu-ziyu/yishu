/**
 * Yishu-owned model-tool loop types (ADR 0014).
 *
 * These types replace the structural subset this package used to import from
 * `@earendil-works/pi-coding-agent`. The shapes match what the existing
 * product tools and the adapter's session contract already consume, so the
 * wire protocol and the `AgentRuntime` port stay unchanged.
 */

/** JSON-Schema-shaped parameter definition (typebox schemas are JSON Schema). */
export type ToolParameterSchema = object;

export interface ToolExecuteResult<TDetails = unknown> {
  content: Array<{ type: "text"; text: string }>;
  details: TDetails;
}

/**
 * Product tool contract. Structurally identical to the previous engine's
 * definition so `computer_control` / `web_search` / `delegate` / the
 * page-note tool work without modification. `TSchema` is the typebox schema
 * type (schema-as-type linkage); the runtime value is a JSON object.
 */
export interface ToolDefinition<TSchema = any, TDetails = any> {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
  readonly parameters: TSchema;
  /** `parallel` tools may overlap. `sequential` is the exclusive desktop hand. */
  readonly executionMode: "sequential" | "parallel";
  execute(
    toolCallId: string,
    params: TSchema extends { static: infer TStatic } ? TStatic : any,
    signal?: AbortSignal,
  ): Promise<ToolExecuteResult<TDetails>>;
}

/** Any-tool view used by the registry (generics erased at the boundary). */
export type AnyToolDefinition = ToolDefinition<any, any>;

export interface PromptImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
  /** Caption placed immediately after this image (pixel dimensions). */
  readonly label?: string;
}

export interface PromptOptions {
  /** Called once the provider admits the prompt (auth/stream accepted). */
  preflightResult?: (accepted: boolean) => void;
  images?: readonly PromptImage[];
  streamingBehavior?: "steer";
}

/** Canonical conversation item the engine keeps per session. */
export type CanonicalMessage =
  | { role: "system"; text: string }
  | { role: "user"; text: string; images?: readonly PromptImage[] }
  | { role: "assistant"; text: string; toolCalls: readonly ToolCallRecord[] }
  | { role: "tool"; callId: string; toolName: string; output: string; isError: boolean };

export interface ToolCallRecord {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
}

/** Envelope the adapter's generation arbitration reads from message events. */
export interface SessionMessageEnvelope {
  readonly role: string;
  readonly timestamp: number;
  readonly responseId: string;
  readonly provider?: string;
  readonly model?: string;
  readonly content: string;
}

export type SessionEvent =
  | { type: "message_start"; message: SessionMessageEnvelope }
  | {
    type: "message_update";
    message: SessionMessageEnvelope;
    assistantMessageEvent: { type: "text_delta"; delta: string };
  }
  | { type: "message_end"; message: SessionMessageEnvelope }
  | { type: "turn_end"; message: SessionMessageEnvelope }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; isError: boolean };

/**
 * The session contract the loop adapter consumes. The previous engine's
 * sessions satisfied the same shape; tests inject fakes against it.
 */
export interface ModelSession {
  readonly sessionId: string;
  readonly agent: { state: { errorMessage: string | null } };
  subscribe(listener: (event: SessionEvent) => void): () => void;
  prompt(text: string, options?: PromptOptions): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  getActiveToolNames(): readonly string[];
  setActiveToolsByName(names: readonly string[]): void;
}

/** Which wire protocol a resolved model speaks. */
export type ModelApiKind = "openai-completions" | "codex-responses";

export interface ResolvedModel {
  readonly providerId: string;
  readonly id: string;
  readonly name: string;
  readonly api: ModelApiKind;
  readonly baseUrl: string;
  readonly input: readonly ("text" | "image")[];
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface ProviderModelListing {
  readonly id: string;
  readonly name?: string;
}

export interface ProviderDefinition {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  /** OAuth-only by construction; there is no ambient API-key path. */
  readonly oauth: boolean;
  readonly models: readonly ProviderModelListing[];
}

/**
 * Provider/model resolution plus the structural auth surface
 * (`AuthModelRuntime`) the auth service already programs against.
 */
export interface ModelProviderRuntime {
  getProvider(providerId: string): ProviderDefinition | undefined;
  getAvailable(providerId: string): Promise<readonly ProviderModelListing[]>;
  checkAuth(providerId: string): Promise<{ type: "api_key" | "oauth" } | undefined>;
  getAuth(providerId: string): Promise<unknown>;
  login(providerId: string, type: "oauth", interaction: unknown): Promise<unknown>;
  logout(providerId: string): Promise<void>;
  /** Resolve a model, throwing when OAuth is required but missing. */
  resolveModel(providerId: string, modelId: string): Promise<ResolvedModel>;
  /** Bearer token for one provider request; owns refresh when near expiry. */
  bearer(providerId: string): Promise<string>;
  /** Extra header values a provider channel requires (e.g. chatgpt-account-id). */
  extraHeaders(providerId: string): Promise<Record<string, string>>;
  /** Monotonic per-provider version bumped by login/logout transitions. */
  providerVersion(providerId: string): number;
}
