import type { ZodType, infer as ZodInfer } from "zod";
import type {
  ActionContextMode,
  ActionRisk,
  ActionVerification,
  ActionVerifyContext,
  AuthorityLevel,
  YishuActionDefinition,
  ActionRunContext,
} from "./types.js";

/** Config accepted by `defineYishuAction`. */
export interface DefineYishuActionConfig<
  TSchema extends ZodType,
  TOutput,
> {
  name: string;
  description: string;
  inputSchema: TSchema;
  authority: AuthorityLevel;
  risk: ActionRisk;
  /** Defaults to true when authority is `reversible`, otherwise false. */
  reversible?: boolean;
  /** Defaults to `"none"`. */
  context?: ActionContextMode;
  run: (
    ctx: ActionRunContext<ZodInfer<TSchema>>,
  ) => Promise<TOutput> | TOutput;
  verify?: (
    ctx: ActionVerifyContext<ZodInfer<TSchema>, TOutput>,
  ) => Promise<ActionVerification> | ActionVerification;
}

/**
 * Build a frozen, product-owned action definition.
 * Input validation is performed by the registry via `inputSchema.safeParse`.
 */
export function defineYishuAction<
  TSchema extends ZodType,
  TOutput = unknown,
>(
  config: DefineYishuActionConfig<TSchema, TOutput>,
): YishuActionDefinition<ZodInfer<TSchema>, TOutput> {
  const name = config.name.trim();
  if (!name) {
    throw new Error("defineYishuAction: name must be a non-empty string");
  }

  const reversible =
    config.reversible !== undefined
      ? config.reversible
      : config.authority === "reversible";

  const base = {
    name,
    description: config.description,
    inputSchema: config.inputSchema,
    authority: config.authority,
    risk: config.risk,
    reversible,
    context: config.context ?? ("none" as const),
    run: config.run,
  };

  const definition = (
    config.verify
      ? { ...base, verify: config.verify }
      : base
  ) as YishuActionDefinition<ZodInfer<TSchema>, TOutput>;

  return Object.freeze(definition);
}
