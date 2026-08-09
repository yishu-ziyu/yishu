import type {
  AuthorityDecision,
  StandingMandate,
  YishuActionDefinition,
  CallerKind,
} from "./types.js";

export interface EvaluateAuthorityInput {
  definition: YishuActionDefinition;
  caller: CallerKind;
  approved?: boolean;
  mandates?: StandingMandate[];
}

/**
 * Decide whether an action may run under the current authority, risk,
 * approval flag, and standing mandates.
 *
 * Rules:
 * - critical risk always requires explicit approval (`approved === true`)
 * - automatic + low risk → allow
 * - reversible authority → allow unless critical (handled above)
 * - standing_mandate → allow only with a matching mandate (name or `"*"`)
 * - explicit_approval → allow only when `approved === true`
 */
export function evaluateAuthority(
  input: EvaluateAuthorityInput,
): AuthorityDecision {
  const { definition, approved, mandates } = input;

  // Hard deny when the caller already refused.
  if (approved === false) {
    return {
      allowed: false,
      status: "denied",
      message: `Action "${definition.name}" was denied by the caller`,
    };
  }

  // Critical always needs explicit approval, regardless of authority level.
  if (definition.risk === "critical") {
    if (approved === true) {
      return { allowed: true };
    }
    return {
      allowed: false,
      status: "needs_approval",
      message: `Critical action "${definition.name}" requires explicit approval`,
    };
  }

  // Explicit approval satisfies any non-critical action.
  if (approved === true) {
    return { allowed: true };
  }

  switch (definition.authority) {
    case "automatic": {
      if (definition.risk === "low") {
        return { allowed: true };
      }
      return {
        allowed: false,
        status: "needs_approval",
        message: `Automatic action "${definition.name}" is not low-risk (risk=${definition.risk}) and needs approval`,
      };
    }

    case "reversible": {
      // Non-critical reversible actions may proceed without interruption.
      return { allowed: true };
    }

    case "standing_mandate": {
      if (hasMatchingMandate(definition.name, mandates)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        status: "needs_approval",
        message: `Action "${definition.name}" requires a standing mandate covering its name or "*"`,
      };
    }

    case "explicit_approval": {
      return {
        allowed: false,
        status: "needs_approval",
        message: `Action "${definition.name}" requires explicit approval`,
      };
    }

    default: {
      // Exhaustiveness guard for future AuthorityLevel values.
      const _exhaustive: never = definition.authority;
      return {
        allowed: false,
        status: "denied",
        message: `Unknown authority level: ${String(_exhaustive)}`,
      };
    }
  }
}

function hasMatchingMandate(
  actionName: string,
  mandates: StandingMandate[] | undefined,
): boolean {
  if (!mandates || mandates.length === 0) {
    return false;
  }
  return mandates.some(
    (m) => m.scope === actionName || m.scope === "*",
  );
}
