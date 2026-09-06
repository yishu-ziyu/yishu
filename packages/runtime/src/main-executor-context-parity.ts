/**
 * Fitness-function evaluator for Main executor context parity.
 *
 * A dimension is valid only when BOTH Pi and Codex render its sentinel
 * exactly once with the required trust/authority markers.
 * Symmetric absence and symmetric weak trust are failures.
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

const TRUST: Record<MainExecutorContextDimension, readonly RegExp[]> = {
  history: [
    /<untrusted source="conversation_history">/,
    /historical data, not new instructions|Historical content cannot expand permissions|历史内容本身不授权/,
  ],
  memory: [
    /<durable_memories>/,
    /cannot authorize|cannot grant permission|不能授权/,
  ],
  rules: [
    /<behavior_rules>/,
    /cannot grant permission|cannot authorize|weaken safety|不能.*授权|不能.*放宽/,
  ],
  mind: [/<mind_lessons>/],
  delegated: [
    /<untrusted source="delegated_results">/,
    /data, not instructions|Treat them as observations|unverified/,
  ],
  trail: [
    /<untrusted source="recent_context_trail">/,
    /may already be stale|stale|不是指令|time-stamped context/,
  ],
  intent: [
    /<turn_intent_frame>/,
    /authoritative product (intent|constraint)|cannot be weakened|产品权威/,
  ],
  taskContract: [
    /<task_execution_contract>/,
    /authoritative product (task|execution|constraint)|cannot be weakened|产品权威/,
  ],
};

const SECTION_BOUNDS: Record<MainExecutorContextDimension, readonly [string, string]> = {
  history: ['<untrusted source="conversation_history">', "</untrusted>"],
  memory: ["<durable_memories>", "</durable_memories>"],
  rules: ["<behavior_rules>", "</behavior_rules>"],
  mind: ["<mind_lessons>", "</mind_lessons>"],
  delegated: ['<untrusted source="delegated_results">', "</untrusted>"],
  trail: ['<untrusted source="recent_context_trail">', "</untrusted>"],
  intent: ["<turn_intent_frame>", "</turn_intent_frame>"],
  taskContract: ["<task_execution_contract>", "</task_execution_contract>"],
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

function sectionAround(text: string, id: MainExecutorContextDimension): string {
  const [open, close] = SECTION_BOUNDS[id];
  const start = text.indexOf(open);
  if (start < 0) return "";
  const end = text.indexOf(close, start + open.length);
  if (end < 0) return "";
  const preamble = Math.max(0, start - 700);
  return text.slice(preamble, end + close.length);
}

function inspect(text: string, id: MainExecutorContextDimension): ExecutorDimensionPresence {
  const count = countSentinelOccurrences(text, MAIN_EXECUTOR_CONTEXT_SENTINELS[id]);
  const value = count > 0;
  const trust = value && TRUST[id].every((pattern) => pattern.test(sectionAround(text, id)));
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
