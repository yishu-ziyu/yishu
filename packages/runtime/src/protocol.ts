import { randomUUID } from "node:crypto";
import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

/**
 * The only model gateway that the desktop presentation layer may select.
 *
 * Clicky owns the credentialed hop from this loopback endpoint to its existing
 * upstream proxy. The runtime intentionally has no remote endpoint field so a
 * turn cannot redirect Pi to an arbitrary URL.
 */
export const LOCAL_GROK_PROVIDER = "yishu-local-grok" as const;
export const LOCAL_GROK_BASE_URL = "http://127.0.0.1:8787/v1" as const;
export const LOCAL_GROK_DEFAULT_MODEL = "grok-4.5" as const;

/** Current Grok choices exposed by Clicky's model picker. */
export const LOCAL_GROK_MODEL_IDS = [
  "grok-4.5",
  "grok-4.3",
  "grok-4.20-0309-reasoning",
  "grok-4.20-0309-non-reasoning",
  "grok-4.20-multi-agent-0309",
  "grok-3-mini",
  "grok-3-mini-fast",
  "grok-composer-2.5-fast",
  "grok-build-0.1",
] as const;

const grokModelIdSchema = z.enum(LOCAL_GROK_MODEL_IDS);

const confidenceSchema = z.number().min(0).max(1);

export const screenPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  coordinateSpace: z.enum(["global-top-left", "appkit-bottom-left"]),
});

export const computerActionSchema = z.object({
  action: z.literal("left_click"),
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  screen: z.number().int().positive().optional(),
  label: z.string().trim().min(1).max(120).optional(),
});

export const pointerSampleSchema = z.object({
  capturedAt: z.string().datetime(),
  point: screenPointSchema,
  kind: z.enum(["move", "drag", "leftDown", "leftUp", "rightDown", "rightUp", "scroll"]),
});

export const observedValueSchema = <Schema extends z.ZodType>(valueSchema: Schema) =>
  z.object({
    value: valueSchema,
    source: z.string().min(1),
    capturedAt: z.string().datetime(),
    confidence: confidenceSchema,
  });

export const applicationContextSchema = z.object({
  name: z.string().min(1),
  bundleIdentifier: z.string().nullable(),
  processIdentifier: z.number().int().positive(),
});

export const windowContextSchema = z.object({
  title: z.string().nullable(),
  ownerName: z.string().min(1),
  processIdentifier: z.number().int().positive(),
  bounds: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  }).nullable(),
});

export const accessibilityElementSchema = z.object({
  role: z.string().nullable(),
  subrole: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  valuePreview: z.string().nullable(),
});

export const screenshotSchema = z.object({
  label: z.string().min(1),
  mediaType: z.literal("image/jpeg"),
  base64Data: z.string().min(1),
  displayWidthPoints: z.number().int().positive(),
  displayHeightPoints: z.number().int().positive(),
  screenshotWidthPixels: z.number().int().positive(),
  screenshotHeightPixels: z.number().int().positive(),
});

export const contextFrameSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  frameId: z.string().uuid(),
  capturedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  cursor: observedValueSchema(screenPointSchema),
  pointerTrail: z.array(pointerSampleSchema).max(240),
  frontmostApplication: observedValueSchema(applicationContextSchema).nullable(),
  activeWindow: observedValueSchema(windowContextSchema).nullable(),
  elementUnderCursor: observedValueSchema(accessibilityElementSchema).nullable(),
  screenshots: z.array(screenshotSchema).max(4),
  warnings: z.array(z.string()),
});

export const capabilityProfileSchema = z.enum(["conversation", "observe", "build", "owner"]);

/**
 * A constrained model choice supplied by Clicky. Keep this object strict: the
 * provider is fixed to the local gateway and the model id is limited to
 * Clicky's current Grok allowlist, with no URL or header override accepted on
 * the wire.
 */
export const modelPreferenceSchema = z
  .object({
    provider: z.literal(LOCAL_GROK_PROVIDER),
    model: grokModelIdSchema,
  })
  .strict();

export const turnStartCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("turn.start"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: z.object({
    utterance: z.string().trim().min(1),
    contextFrame: contextFrameSchema,
    capabilityProfile: capabilityProfileSchema.default("conversation"),
    modelPreference: modelPreferenceSchema.optional(),
  }),
});

export const turnSteerCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("turn.steer"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: z.object({ message: z.string().trim().min(1) }),
});

export const turnCancelCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("turn.cancel"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: z.object({ reason: z.string().trim().min(1).optional() }),
});

export const computerActionResultCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("computer.action.result"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: z.object({
    actionId: z.string().uuid(),
    succeeded: z.boolean(),
    verified: z.boolean(),
    message: z.string().trim().min(1).max(500),
    evidence: z.string().trim().min(1).max(500).optional(),
  }),
});

export const runtimePingCommandSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("runtime.ping"),
  requestId: z.string().uuid(),
  traceId: z.string().uuid(),
  sentAt: z.string().datetime(),
  payload: z.object({}).default({}),
});

export const clientCommandSchema = z.discriminatedUnion("type", [
  turnStartCommandSchema,
  turnSteerCommandSchema,
  turnCancelCommandSchema,
  computerActionResultCommandSchema,
  runtimePingCommandSchema,
]);

export type ContextFrame = z.infer<typeof contextFrameSchema>;
export type CapabilityProfile = z.infer<typeof capabilityProfileSchema>;
export type ModelPreference = z.infer<typeof modelPreferenceSchema>;
export type TurnStartCommand = z.infer<typeof turnStartCommandSchema>;
export type TurnSteerCommand = z.infer<typeof turnSteerCommandSchema>;
export type TurnCancelCommand = z.infer<typeof turnCancelCommandSchema>;
export type ComputerAction = z.infer<typeof computerActionSchema>;
export type ComputerActionResultCommand = z.infer<typeof computerActionResultCommandSchema>;
export type ClientCommand = z.infer<typeof clientCommandSchema>;

export type RuntimeEventType =
  | "runtime.ready"
  | "runtime.pong"
  | "runtime.status"
  | "turn.started"
  | "response.delta"
  | "tool.started"
  | "tool.completed"
  | "computer.action.requested"
  | "response.completed"
  | "turn.cancelled"
  | "turn.failed"
  | "runtime.error";

export interface RuntimeEvent<Payload = Record<string, unknown>> {
  schemaVersion: typeof PROTOCOL_VERSION;
  type: RuntimeEventType;
  eventId: string;
  requestId: string;
  traceId: string;
  occurredAt: string;
  payload: Payload;
}

export function runtimeEvent<Payload>(
  type: RuntimeEventType,
  requestId: string,
  traceId: string,
  payload: Payload,
): RuntimeEvent<Payload> {
  return {
    schemaVersion: PROTOCOL_VERSION,
    type,
    eventId: randomUUID(),
    requestId,
    traceId,
    occurredAt: new Date().toISOString(),
    payload,
  };
}
