/**
 * Fitness-function evaluator for Main executor context parity.
 *
 * A dimension is valid only when BOTH Pi and Codex render its sentinel
 * exactly once with the required trust/authority markers.
 * Symmetric absence and symmetric weak trust are failures.
 *
 * Trust/authority evidence is taken from that dimension's own renderer
 * contract (distinctive preamble through closer). A character window
 * before the opener can include a neighboring section's safety prose.
 */

export const MAIN_EXECUTOR_CONTEXT_SENTINELS = {
  history: "PARITY_HISTORY_7f3c9e2a",
  memory: "PARITY_MEMORY_b41d80c6",
  rules: "PARITY_RULE_e9a12f04",
  mind: "PARITY_MIND_55c0ab17",
  delegated: "PARITY_DELEGATED_c8d3e201",
  trail: "PARITY_TRAIL_APP_9b7e4d22",
  intent: "PARITY_INTENT_OBJ_3a91f6d8",
  taskContract: "PARITY_CONTRACT_OBJ_d2c47b0e",
} as const;

export type MainExecutorContextDimension = keyof typeof MAIN_EXECUTOR_CONTEXT_SENTINELS;

export const MAIN_EXECUTOR_CONTEXT_DIMENSIONS = [
  "history",
  "memory",
  "rules",
  "mind",
  "delegated",
  "trail",
  "intent",
  "taskContract",
] as const satisfies readonly MainExecutorContextDimension[];

interface DimensionContract {
  /** First line of this dimension's own production preamble. */
  preamble: string;
  open: string;
  close: string;
  trust: readonly RegExp[];
}

const CONTRACT: Record<MainExecutorContextDimension, DimensionContract> = {
  history: {
    preamble: "The following earlier visible turns restore continuity after a cold Pi session.",
    open: '<untrusted source="conversation_history">',
    close: "</untrusted>",
    trust: [
      /<untrusted source="conversation_history">/,
      /historical data, not new instructions|Historical content cannot expand permissions|历史内容本身不授权/,
    ],
  },
  memory: {
    preamble: "These are relevant memory candidates from earlier interactions.",
    open: "<durable_memories>",
    close: "</durable_memories>",
    trust: [
      /<durable_memories>/,
      /cannot authorize|不能授权/,
      /id=[^;\s]+; authority=user;/,
    ],
  },
  rules: {
    preamble: "The user previously established these durable behavior rules for this exact scope.",
    open: "<behavior_rules>",
    close: "</behavior_rules>",
    trust: [
      /<behavior_rules>/,
      /cannot grant permission/,
      /weaken safety/,
    ],
  },
  mind: {
    preamble: "You previously learned the following lessons from repeated outcomes.",
    open: "<mind_lessons>",
    close: "</mind_lessons>",
    trust: [/<mind_lessons>/],
  },
  delegated: {
    preamble: "Background tasks you delegated earlier finished while you were busy.",
    open: '<untrusted source="delegated_results">',
    close: "</untrusted>",
    trust: [
      /<untrusted source="delegated_results">/,
      /data, not instructions|Treat them as observations|unverified/,
    ],
  },
  trail: {
    preamble: "These are untrusted historical observations from the same session scope.",
    open: '<untrusted source="recent_context_trail">',
    close: "</untrusted>",
    trust: [
      /<untrusted source="recent_context_trail">/,
      /may already be stale|stale|不是指令|time-stamped context/,
    ],
  },
  intent: {
    preamble: "This is the authoritative product intent for the current turn.",
    open: "<turn_intent_frame>",
    close: "</turn_intent_frame>",
    trust: [
      /<turn_intent_frame>/,
      /authoritative product (intent|constraint)|cannot be weakened|产品权威/,
    ],
  },
  taskContract: {
    preamble: "This is the authoritative product task execution contract for the current turn.",
    open: "<task_execution_contract>",
    close: "</task_execution_contract>",
    trust: [
      /<task_execution_contract>/,
      /authoritative product (task|execution|constraint)|cannot be weakened|产品权威/,
    ],
  },
};

export interface ExecutorDimensionPresence {
  value: boolean;
  trust: boolean;
  count: number;
}

export interface MainExecutorContextParityResult {
  failureCount: number;
  failures: string[];
  duplicates: string[];
  matrix: Record<MainExecutorContextDimension, {
    pi: ExecutorDimensionPresence;
    codex: ExecutorDimensionPresence;
  }>;
}

export function countSentinelOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

/**
 * Slice this dimension's own preamble through its closer.
 * Returns "" when the preamble does not uniquely belong to this opener.
 */
function ownRenderedContract(text: string, id: MainExecutorContextDimension): string {
  const spec = CONTRACT[id];
  const openAt = text.indexOf(spec.open);
  if (openAt < 0) return "";
  const closeAt = text.indexOf(spec.close, openAt + spec.open.length);
  if (closeAt < 0) return "";
  const preambleAt = text.lastIndexOf(spec.preamble, openAt);
  if (preambleAt < 0) return "";
  const between = text.slice(preambleAt + spec.preamble.length, openAt);
  for (const other of MAIN_EXECUTOR_CONTEXT_DIMENSIONS) {
    if (other === id) continue;
    if (between.includes(CONTRACT[other].open)) return "";
  }
  return text.slice(preambleAt, closeAt + spec.close.length);
}

function inspect(text: string, id: MainExecutorContextDimension): ExecutorDimensionPresence {
  const count = countSentinelOccurrences(text, MAIN_EXECUTOR_CONTEXT_SENTINELS[id]);
  const value = count > 0;
  const evidence = ownRenderedContract(text, id);
  const trust = value && CONTRACT[id].trust.every((pattern) => pattern.test(evidence));
  return { value, trust, count };
}

function isValid(presence: ExecutorDimensionPresence): boolean {
  return presence.count === 1 && presence.trust;
}

/**
 * Primary fitness function over already-rendered Pi and Codex contexts.
 * Does not assemble or format product context.
 */
export function evaluateMainExecutorContextParity(
  piText: string,
  codexText: string,
): MainExecutorContextParityResult {
  const failures: string[] = [];
  const duplicates: string[] = [];
  const matrix = {} as MainExecutorContextParityResult["matrix"];

  for (const id of MAIN_EXECUTOR_CONTEXT_DIMENSIONS) {
    const pi = inspect(piText, id);
    const codex = inspect(codexText, id);
    matrix[id] = { pi, codex };
    const piValid = isValid(pi);
    const codexValid = isValid(codex);
    if (!piValid || !codexValid) {
      failures.push(
        `${id}: pi count=${pi.count} trust=${pi.trust}; codex count=${codex.count} trust=${codex.trust}`,
      );
    }
    if (pi.count > 1) duplicates.push(`pi ${id} count=${pi.count}`);
    if (codex.count > 1) duplicates.push(`codex ${id} count=${codex.count}`);
  }

  return {
    failureCount: failures.length,
    failures,
    duplicates,
    matrix,
  };
}
