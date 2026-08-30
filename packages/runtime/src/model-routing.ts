import type { TurnIntentFrame } from "@yishu/kernel";
import { utteranceRequiresObservationalPointing } from "./assistant-output.js";
import { LOCAL_GROK_DEFAULT_MODEL, LOCAL_GROK_PROVIDER } from "./protocol.js";
import type {
  ModelPreference,
  ModelRouting,
  TurnStartCommand,
} from "./protocol.js";

export type ResolvedModelRoute =
  | "realtime_conversation"
  | "screen_collaboration"
  | "deep_task"
  | "fixed_model";

export interface ResolvedModelRouting {
  readonly routingMode: ModelRouting["mode"];
  readonly resolvedRoute: ResolvedModelRoute;
  readonly preference: ModelPreference;
}

export interface ResolveModelRoutingInput {
  readonly routing: ModelRouting | undefined;
  readonly legacyPreference: ModelPreference | undefined;
  readonly intent: TurnIntentFrame;
  readonly utterance: string;
  readonly currentPageNote: boolean;
}

export interface TurnModelRoutingResolution {
  readonly command: TurnStartCommand;
  readonly decision?: ResolvedModelRouting;
}

export function isScreenDependentUtterance(utterance: string): boolean {
  return utteranceRequiresObservationalPointing(utterance.trim());
}

/** Resolve one turn without changing explicit user modes or inventing a deep route. */
export function resolveModelRouting(
  input: ResolveModelRoutingInput,
): ResolvedModelRouting | undefined {
  const routing = input.routing;
  if (routing === undefined) {
    return input.legacyPreference === undefined
      ? undefined
      : {
          routingMode: "fixed_model",
          resolvedRoute: "fixed_model",
          preference: input.legacyPreference,
        };
  }

  if (routing.mode === "fixed_model") {
    return {
      routingMode: routing.mode,
      resolvedRoute: "fixed_model",
      preference: routing.preference,
    };
  }

  const requiresScreenCollaboration = input.intent.effect === "external"
    || input.currentPageNote
    || isScreenDependentUtterance(input.utterance);
  const resolvedRoute = routing.mode === "auto"
    ? requiresScreenCollaboration ? "screen_collaboration" : "realtime_conversation"
    : routing.mode;

  const preference = resolvedRoute === "screen_collaboration"
    ? routing.profiles.screenCollaboration
    : resolvedRoute === "deep_task"
      ? routing.profiles.deepTask
      : routing.profiles.realtimeConversation;

  return {
    routingMode: routing.mode,
    resolvedRoute,
    preference,
  };
}

export function resolveTurnModelRouting(
  command: TurnStartCommand,
  intent: TurnIntentFrame,
  currentPageNote: boolean,
): TurnModelRoutingResolution {
  if (intent.route.kind !== "model") return { command };
  const decision = resolveModelRouting({
    routing: command.payload.modelRouting,
    legacyPreference: command.payload.modelPreference,
    intent,
    utterance: command.payload.utterance,
    currentPageNote,
  });
  if (decision === undefined) return { command };
  return {
    command: command.payload.modelRouting === undefined
      ? command
      : {
          ...command,
          payload: { ...command.payload, modelPreference: decision.preference },
        },
    decision,
  };
}

export function recordConversationModel(
  models: Map<string, string>,
  conversationId: string,
  preference: ModelPreference | undefined,
): boolean {
  const effective = preference ?? {
    provider: LOCAL_GROK_PROVIDER,
    model: LOCAL_GROK_DEFAULT_MODEL,
  };
  const conversationKey = conversationId.toLowerCase();
  const modelKey = `${effective.provider}:${effective.model}`;
  const changed = models.has(conversationKey) && models.get(conversationKey) !== modelKey;
  models.set(conversationKey, modelKey);
  return changed;
}
