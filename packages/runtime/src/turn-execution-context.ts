/**
 * One product-owned semantic execution context for an ordinary Main turn.
 *
 * Product Kernel recall/selects; executor adapters only render. Adapters must
 * not query Kernel/store/EverOS to reconstruct missing context.
 */
import type { TaskExecutionContract, TurnIntentFrame } from "@yishu/kernel";
import type {
  DelegatedResultSnippet,
  PromptBehaviorRule,
  PromptConversationTurn,
  PromptMemorySnippet,
  PromptMindLesson,
  PromptTrailObservation,
} from "./context-prompt.js";
import { attachTurnIntentFrame } from "./intent-frame.js";
import type { TurnStartCommand } from "./protocol.js";
import { attachTaskExecutionContract } from "./task-contract.js";

export const TURN_EXECUTION_CONTEXT = Symbol("yishu.turnExecutionContext");

export type ContextTrustClass =
  | "untrusted_historical_data"
  | "untrusted_stale_capable_observation"
  | "untrusted_fallible_data"
  | "user_authoritative_context"
  | "product_behavior_preference"
  | "product_procedural_lesson"
  | "product_authoritative_constraint";

export interface TurnExecutionContext {
  readonly conversationHistory: readonly PromptConversationTurn[];
  readonly recalledMemories: readonly PromptMemorySnippet[];
  readonly behaviorRules: readonly PromptBehaviorRule[];
  readonly mindLessons: readonly PromptMindLesson[];
  readonly delegatedResults: readonly DelegatedResultSnippet[];
  readonly recentTrail: readonly PromptTrailObservation[];
  readonly intentFrame?: TurnIntentFrame;
  readonly taskContract?: TaskExecutionContract;
  readonly sessionScopeKind: string;
  readonly privateSession: boolean;
}

export interface TurnExecutionContextInput {
  readonly conversationHistory?: readonly PromptConversationTurn[];
  readonly recalledMemories?: readonly PromptMemorySnippet[];
  readonly behaviorRules?: readonly PromptBehaviorRule[];
  readonly mindLessons?: readonly PromptMindLesson[];
  readonly delegatedResults?: readonly DelegatedResultSnippet[];
  readonly recentTrail?: readonly PromptTrailObservation[];
  readonly intentFrame?: TurnIntentFrame;
  readonly taskContract?: TaskExecutionContract;
  readonly sessionScopeKind: string;
}

type ContextCommand = TurnStartCommand & {
  [TURN_EXECUTION_CONTEXT]?: TurnExecutionContext;
};

function freezeList<T>(items: readonly T[] | undefined): readonly T[] {
  return Object.freeze([...(items ?? [])]);
}

export function createTurnExecutionContext(
  input: TurnExecutionContextInput,
): TurnExecutionContext {
  const privateSession = input.sessionScopeKind === "private";
  return Object.freeze({
    conversationHistory: privateSession ? Object.freeze([]) : freezeList(input.conversationHistory),
    recalledMemories: privateSession ? Object.freeze([]) : freezeList(input.recalledMemories),
    behaviorRules: privateSession ? Object.freeze([]) : freezeList(input.behaviorRules),
    mindLessons: privateSession ? Object.freeze([]) : freezeList(input.mindLessons),
    delegatedResults: privateSession ? Object.freeze([]) : freezeList(input.delegatedResults),
    recentTrail: privateSession ? Object.freeze([]) : freezeList(input.recentTrail),
    ...(input.intentFrame === undefined ? {} : { intentFrame: input.intentFrame }),
    ...(input.taskContract === undefined ? {} : { taskContract: input.taskContract }),
    sessionScopeKind: input.sessionScopeKind,
    privateSession,
  });
}

/**
 * Enumerable so later payload spreads keep the bundle. Symbol keys never
 * enter JSON / the client wire schema.
 */
export function attachTurnExecutionContext(
  command: TurnStartCommand,
  context: TurnExecutionContext,
): TurnStartCommand {
  Object.defineProperty(command, TURN_EXECUTION_CONTEXT, {
    value: context,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return command;
}

export function turnExecutionContextFromCommand(
  command: TurnStartCommand,
): TurnExecutionContext | undefined {
  return (command as ContextCommand)[TURN_EXECUTION_CONTEXT];
}

/** Attach the typed bundle and keep intent/task symbols on the same command. */
export function applyTurnExecutionContext(
  command: TurnStartCommand,
  input: TurnExecutionContextInput,
): TurnStartCommand {
  const context = createTurnExecutionContext(input);
  let next = command;
  if (context.intentFrame !== undefined) {
    next = attachTurnIntentFrame(next, context.intentFrame);
  }
  if (context.taskContract !== undefined) {
    next = attachTaskExecutionContract(next, context.taskContract);
  }
  return attachTurnExecutionContext(next, context);
}
