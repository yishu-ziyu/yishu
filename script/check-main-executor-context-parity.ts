#!/usr/bin/env node
/**
 * Architecture ratchet: ordinary Main turns share one product-owned
 * execution context across Pi and Codex.
 *
 * Metric 1: main_executor_context_parity_failures
 *   Count one failure for each required semantic dimension that reaches
 *   the reference Main executor (Pi) with its intended trust/authority
 *   but is absent, dropped, or materially weaker for Codex.
 *
 * Metric 2: turn_scoped_context_assembly_paths
 *   Count independent production mechanisms that assemble product-owned,
 *   turn-scoped semantic context after Product Kernel recall.
 *
 * Zero is the permanent ceiling for metric 1. One is the permanent
 * ceiling for metric 2. Do not drop a dimension, exclude an executor,
 * or duplicate formatters inside this checker to pass.
 *
 * Usage: node script/check-main-executor-context-parity.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachTaskExecutionContract,
  createTaskExecutionContract,
  taskExecutionContractFromCommand,
} from "../packages/runtime/src/task-contract.js";
import {
  attachTurnIntentFrame,
  turnIntentFrameFromCommand,
} from "../packages/runtime/src/intent-frame.js";
import {
  attachBehaviorRules,
  attachConversationHistory,
  attachDelegatedResults,
  attachRecentTrail,
  attachRecalledMind,
  buildGroundedPrompt,
  formatTurnMemoryBlock,
  type PromptMemorySnippet,
} from "../packages/runtime/src/context-prompt.js";
import { buildCodexPrompt } from "../packages/runtime/src/providers/codex-runtime.js";
import { makeTurnStartCommand } from "../packages/runtime/test/fixtures.js";
import type { TurnIntentFrame } from "@yishu/kernel";
import type { TurnStartCommand } from "../packages/runtime/src/protocol.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKR = path.join(ROOT, "packages/runtime/src/product-kernel-runtime.ts");
const LOOP = path.join(ROOT, "packages/runtime/src/loop-adapter.ts");
const CODEX = path.join(ROOT, "packages/runtime/src/providers/codex-runtime.ts");
const MODEL_SESSION = path.join(ROOT, "packages/runtime/src/model-loop/model-session.ts");
const CONTEXT_PROMPT = path.join(ROOT, "packages/runtime/src/context-prompt.ts");
const TURN_CONTEXT = path.join(ROOT, "packages/runtime/src/model-loop/turn-context.ts");

const SENTINELS = {
  history: "PARITY_HISTORY_7f3c9e2a",
  memory: "PARITY_MEMORY_b41d80c6",
  rules: "PARITY_RULE_e9a12f04",
  mind: "PARITY_MIND_55c0ab17",
  delegated: "PARITY_DELEGATED_c8d3e201",
  trail: "PARITY_TRAIL_APP_9b7e4d22",
  intent: "PARITY_INTENT_OBJ_3a91f6d8",
  taskContract: "PARITY_CONTRACT_OBJ_d2c47b0e",
} as const;

type DimensionId = keyof typeof SENTINELS;
type ExecutorId = "pi" | "codex";

const TRUST = {
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
} as const;

const DURABLE_DIMENSIONS: DimensionId[] = [
  "history",
  "memory",
  "rules",
  "mind",
  "delegated",
  "trail",
];

interface DimensionPresence {
  value: boolean;
  trust: boolean;
  count: number;
  via: "render" | "runtime" | "missing";
}

function countOccurrences(haystack: string, needle: string): number {
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

function matchesAll(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.every((pattern) => pattern.test(text));
}

const SECTION_BOUNDS: Record<DimensionId, readonly [string, string]> = {
  history: ['<untrusted source="conversation_history">', "</untrusted>"],
  memory: ["<durable_memories>", "</durable_memories>"],
  rules: ["<behavior_rules>", "</behavior_rules>"],
  mind: ["<mind_lessons>", "</mind_lessons>"],
  delegated: ['<untrusted source="delegated_results">', "</untrusted>"],
  trail: ['<untrusted source="recent_context_trail">', "</untrusted>"],
  intent: ["<turn_intent_frame>", "</turn_intent_frame>"],
  taskContract: ["<task_execution_contract>", "</task_execution_contract>"],
};

function sectionAround(text: string, id: DimensionId): string {
  const [open, close] = SECTION_BOUNDS[id];
  const start = text.indexOf(open);
  if (start < 0) return "";
  const end = text.indexOf(close, start + open.length);
  if (end < 0) return "";
  const preamble = Math.max(0, start - 700);
  return text.slice(preamble, end + close.length);
}

async function optionalBundleApi(): Promise<{
  applyTurnExecutionContext?: (
    command: TurnStartCommand,
    input: Record<string, unknown>,
  ) => TurnStartCommand;
  turnExecutionContextFromCommand?: (command: TurnStartCommand) => unknown;
} | null> {
  const candidate = path.join(ROOT, "packages/runtime/src/turn-execution-context.ts");
  if (!fs.existsSync(candidate)) return null;
  try {
    return await import("../packages/runtime/src/turn-execution-context.js");
  } catch {
    return null;
  }
}

function intentFrame(): TurnIntentFrame {
  return {
    schemaVersion: 1,
    objective: SENTINELS.intent,
    speechAct: "command",
    effect: "external",
    route: { kind: "model" },
    successMode: "external_effect",
    authority: "reversible",
    risk: "medium",
    steerable: false,
    source: "deterministic",
  };
}

function memories(): readonly PromptMemorySnippet[] {
  return [
    {
      id: "11111111-1111-4111-8111-111111111111",
      claim: SENTINELS.memory,
      source: "conversation",
      capturedAt: "2026-09-06T00:00:00.000Z",
      scope: "personal",
      authority: "user",
    },
  ];
}

function attachLegacy(command: TurnStartCommand): TurnStartCommand {
  // Mirror ProductKernelRuntime.runInnerTurn order so the checker
  // measures the real seam, including any attachment-copy loss.
  let next = attachTurnIntentFrame(command, intentFrame());
  next = attachConversationHistory(next, [
    {
      id: "22222222-2222-4222-8222-222222222222",
      capturedAt: "2026-09-06T00:00:00.000Z",
      userInput: SENTINELS.history,
      assistantOutput: "先前回答",
    },
  ]);
  next = attachBehaviorRules(next, [
    {
      id: "33333333-3333-4333-8333-333333333333",
      rule: SENTINELS.rules,
      capturedAt: "2026-09-06T00:00:00.000Z",
      scope: "personal",
    },
  ]);
  next = attachRecalledMind(next, [SENTINELS.mind]);
  next = attachDelegatedResults(next, [
    {
      taskId: "44444444-4444-4444-8444-444444444444",
      parentId: "55555555-5555-4555-8555-555555555555",
      resultKind: "completed",
      summary: SENTINELS.delegated,
    },
  ]);
  next = attachRecentTrail(next, [
    {
      frameId: "66666666-6666-4666-8666-666666666666",
      capturedAt: "2026-09-06T00:00:00.000Z",
      appName: SENTINELS.trail,
      windowTitle: "TrailWindow",
      axRole: "AXButton",
      axTitle: "OK",
      axValuePreview: null,
      cursorRegion: "center",
      warnings: [],
    },
  ]);
  next = attachTaskExecutionContract(
    next,
    createTaskExecutionContract({
      objective: SENTINELS.taskContract,
      successMode: "external_effect",
      authority: "reversible",
      risk: "medium",
      maxAttempts: 1,
    }),
  );
  return next;
}

function renderPi(command: TurnStartCommand, recalled: readonly PromptMemorySnippet[]): string {
  const prompt = buildGroundedPrompt(command, { includeConversationHistory: true });
  if (command.payload.sessionScope?.kind === "private") return prompt;
  if (prompt.includes(SENTINELS.memory)) return prompt;
  const block = formatTurnMemoryBlock(recalled);
  return block ? `${block}\n\n${prompt}` : prompt;
}

function renderCodex(command: TurnStartCommand): string {
  return buildCodexPrompt(command);
}

function piRuntimeHasIntent(command: TurnStartCommand): boolean {
  return turnIntentFrameFromCommand(command) !== undefined;
}

function piRuntimeHasContract(command: TurnStartCommand): boolean {
  return taskExecutionContractFromCommand(command) !== undefined;
}

function inspectDimension(
  executor: ExecutorId,
  text: string,
  command: TurnStartCommand,
  id: DimensionId,
): DimensionPresence {
  const sentinel = SENTINELS[id];
  const count = countOccurrences(text, sentinel);
  const value = count > 0;
  const trust = value && matchesAll(sectionAround(text, id), TRUST[id]);
  if (value) {
    return { value, trust, count, via: "render" };
  }
  if (id === "intent" && executor === "pi" && piRuntimeHasIntent(command)) {
    return { value: true, trust: true, count: 1, via: "runtime" };
  }
  if (id === "taskContract" && executor === "pi" && piRuntimeHasContract(command)) {
    return { value: true, trust: true, count: 1, via: "runtime" };
  }
  return { value, trust, count, via: "missing" };
}

function source(file: string): string {
  return fs.readFileSync(file, "utf8");
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function countAssemblyPaths(): { count: number; paths: string[] } {
  const pkr = stripComments(source(PKR));
  const paths: string[] = [];
  const hasTypedBundle = /applyTurnExecutionContext|attachTurnExecutionContext|createTurnExecutionContext/.test(pkr);
  const hasLegacyAttach = /attachConversationHistory\s*\(/.test(pkr)
    && /attachBehaviorRules\s*\(/.test(pkr)
    && /attachRecalledMind\s*\(/.test(pkr);
  if (hasTypedBundle) {
    paths.push("product-kernel typed execution context");
  } else if (hasLegacyAttach) {
    paths.push("product-kernel command attachments");
  }
  const memoryFactory = pkr.match(/assembleTurnMemory\s*:\s*async[\s\S]*?\n\s*\},/);
  const factoryBody = memoryFactory?.[0] ?? "";
  if (/formatTurnMemoryBlock\s*\(/.test(factoryBody) || /toPromptMemorySnippet\s*\(/.test(factoryBody)) {
    paths.push("pi assembleTurnMemory from turn cache");
  }
  return { count: paths.length, paths };
}

function executorKernelReads(): { count: number; hits: string[] } {
  const files = [LOOP, CODEX, MODEL_SESSION, CONTEXT_PROMPT, TURN_CONTEXT];
  const bundle = path.join(ROOT, "packages/runtime/src/turn-execution-context.ts");
  if (fs.existsSync(bundle)) files.push(bundle);
  const forbidden = [
    /\bkernel\.store\b/,
    /\bkernel\.memories\b/,
    /\bkernel\.trail\b/,
    /\beveros\.search\b/,
    /\beveros\.profile\b/,
    /\bthis\.kernel\b/,
    /\bcreateYishuKernel\b/,
  ];
  const hits: string[] = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const text = stripComments(source(file));
    for (const pattern of forbidden) {
      if (pattern.test(text)) {
        hits.push(`${path.relative(ROOT, file)} ${pattern}`);
      }
    }
  }
  return { count: hits.length, hits };
}

function reportLine(name: string, value: number): void {
  console.log(`${name}: ${value}`);
}

async function main(): Promise<void> {
  const recalled = memories();
  const base = makeTurnStartCommand();
  base.payload.utterance = "当前用户请求：parity live utterance";
  base.payload.sessionScope = { kind: "personal" };

  const bundleApi = await optionalBundleApi();
  let command = attachLegacy(base);
  if (bundleApi?.applyTurnExecutionContext) {
    command = bundleApi.applyTurnExecutionContext(makeTurnStartCommand(), {
      conversationHistory: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          capturedAt: "2026-09-06T00:00:00.000Z",
          userInput: SENTINELS.history,
          assistantOutput: "先前回答",
        },
      ],
      recalledMemories: recalled,
      behaviorRules: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          rule: SENTINELS.rules,
          capturedAt: "2026-09-06T00:00:00.000Z",
          scope: "personal",
        },
      ],
      mindLessons: [SENTINELS.mind],
      delegatedResults: [
        {
          taskId: "44444444-4444-4444-8444-444444444444",
          parentId: "55555555-5555-4555-8555-555555555555",
          resultKind: "completed",
          summary: SENTINELS.delegated,
        },
      ],
      recentTrail: [
        {
          frameId: "66666666-6666-4666-8666-666666666666",
          capturedAt: "2026-09-06T00:00:00.000Z",
          appName: SENTINELS.trail,
          windowTitle: "TrailWindow",
          axRole: "AXButton",
          axTitle: "OK",
          axValuePreview: null,
          cursorRegion: "center",
          warnings: [],
        },
      ],
      intentFrame: intentFrame(),
      taskContract: createTaskExecutionContract({
        objective: SENTINELS.taskContract,
        successMode: "external_effect",
        authority: "reversible",
        risk: "medium",
        maxAttempts: 1,
      }),
      sessionScopeKind: "personal",
    });
    command.payload.utterance = "当前用户请求：parity live utterance";
    command.payload.sessionScope = { kind: "personal" };
  }

  const piText = renderPi(command, recalled);
  const codexText = renderCodex(command);
  const dimensions: DimensionId[] = [
    "history",
    "memory",
    "rules",
    "mind",
    "delegated",
    "trail",
    "intent",
    "taskContract",
  ];

  const failures: string[] = [];
  const duplicates: string[] = [];
  const expansions: string[] = [];
  const matrix: Record<DimensionId, { pi: DimensionPresence; codex: DimensionPresence }> = {} as never;

  for (const id of dimensions) {
    const pi = inspectDimension("pi", piText, command, id);
    const codex = inspectDimension("codex", codexText, command, id);
    matrix[id] = { pi, codex };
    const piHas = pi.via !== "missing";
    const codexHas = codex.via !== "missing";
    if (piHas && !codexHas) {
      failures.push(`${id}: pi via ${pi.via}, codex missing`);
    } else if (!piHas && codexHas) {
      failures.push(`${id}: codex via ${codex.via}, pi missing`);
    } else if (piHas && codexHas && pi.trust !== codex.trust) {
      failures.push(`${id}: trust/authority divergence pi=${pi.trust} codex=${codex.trust}`);
    }
    if (pi.via === "render" && pi.count !== 1) {
      duplicates.push(`pi ${id} count=${pi.count}`);
    }
    if (codex.via === "render" && codex.count !== 1) {
      duplicates.push(`codex ${id} count=${codex.count}`);
    }
  }

  const authorizingUntrusted = [
    { label: "history", re: /<untrusted source="conversation_history">([\s\S]*?)<\/untrusted>/ },
    { label: "delegated", re: /<untrusted source="delegated_results">([\s\S]*?)<\/untrusted>/ },
    { label: "trail", re: /<untrusted source="recent_context_trail">([\s\S]*?)<\/untrusted>/ },
  ];
  for (const text of [piText, codexText]) {
    for (const section of authorizingUntrusted) {
      const body = text.match(section.re)?.[1] ?? "";
      if (/authoriz(?:e|es|ed) (?:an? )?(?:action|effect)|granted permission|expand tool access/i.test(body)
        && !/cannot|not |never |do not /i.test(body)) {
        expansions.push(`${section.label} untrusted body gained authority`);
      }
    }
    if (/<durable_memories>[\s\S]*?<\/durable_memories>/.test(text)
      && !/cannot authorize|cannot grant permission/.test(text)) {
      expansions.push("memory rendered without non-authorizing marker");
    }
    if (/<behavior_rules>[\s\S]*?<\/behavior_rules>/.test(text)
      && !/cannot grant permission|cannot authorize|weaken safety/.test(text)) {
      expansions.push("behavior rules rendered without non-authorizing marker");
    }
  }

  const privateCommand = makeTurnStartCommand();
  privateCommand.payload.sessionScope = { kind: "private" };
  privateCommand.payload.utterance = "私密请求";
  let privateAttached = privateCommand;
  if (bundleApi?.applyTurnExecutionContext) {
    privateAttached = bundleApi.applyTurnExecutionContext(privateCommand, {
      conversationHistory: [{
        id: "22222222-2222-4222-8222-222222222222",
        capturedAt: "2026-09-06T00:00:00.000Z",
        userInput: SENTINELS.history,
        assistantOutput: "先前回答",
      }],
      recalledMemories: recalled,
      behaviorRules: [{
        id: "33333333-3333-4333-8333-333333333333",
        rule: SENTINELS.rules,
        capturedAt: "2026-09-06T00:00:00.000Z",
        scope: "personal",
      }],
      mindLessons: [SENTINELS.mind],
      delegatedResults: [{
        taskId: "44444444-4444-4444-8444-444444444444",
        parentId: "55555555-5555-4555-8555-555555555555",
        resultKind: "completed",
        summary: SENTINELS.delegated,
      }],
      recentTrail: [{
        frameId: "66666666-6666-4666-8666-666666666666",
        capturedAt: "2026-09-06T00:00:00.000Z",
        appName: SENTINELS.trail,
        windowTitle: null,
        axRole: null,
        axTitle: null,
        axValuePreview: null,
        cursorRegion: "center",
        warnings: [],
      }],
      intentFrame: intentFrame(),
      taskContract: createTaskExecutionContract({
        objective: SENTINELS.taskContract,
        successMode: "read_only_delivery",
        authority: "automatic",
        risk: "low",
        maxAttempts: 1,
      }),
      sessionScopeKind: "private",
    });
    privateAttached.payload.sessionScope = { kind: "private" };
  }
  const privatePi = renderPi(privateAttached, recalled);
  const privateCodex = renderCodex(privateAttached);
  let privateItems = 0;
  for (const id of DURABLE_DIMENSIONS) {
    if (privatePi.includes(SENTINELS[id])) privateItems += 1;
    if (privateCodex.includes(SENTINELS[id])) privateItems += 1;
  }

  const empty = makeTurnStartCommand();
  empty.payload.utterance = "EMPTY_CONTEXT_UTTERANCE";
  empty.payload.sessionScope = { kind: "personal" };
  const emptyPi = buildGroundedPrompt(empty, { includeConversationHistory: true });
  const emptyCodex = buildCodexPrompt(empty);
  const emptyValid = emptyPi.includes("EMPTY_CONTEXT_UTTERANCE")
    && emptyCodex.includes("EMPTY_CONTEXT_UTTERANCE");

  const assembly = countAssemblyPaths();
  const kernelReads = executorKernelReads();

  reportLine("main_executor_context_parity_failures", failures.length);
  reportLine("turn_scoped_context_assembly_paths", assembly.count);
  reportLine("private_session_durable_context_items", privateItems);
  reportLine("context_authorization_expansions", expansions.length);
  reportLine("duplicate_semantic_context_sections", duplicates.length);
  reportLine("executor_kernel_reads", kernelReads.count);

  console.log("target_parity: 0");
  console.log("target_assembly_paths: 1");
  if (failures.length > 0) {
    console.log("parity_failures:");
    for (const failure of failures) console.log(`  - ${failure}`);
  }
  console.log("parity_matrix:");
  for (const id of dimensions) {
    const row = matrix[id];
    console.log(
      `  ${id}: pi=${row.pi.via}${row.pi.value && row.pi.trust ? "" : "(weak)"} codex=${row.codex.via}${row.codex.value && row.codex.trust ? "" : "(weak)"}`,
    );
  }
  if (assembly.paths.length > 0) {
    console.log("assembly_paths:");
    for (const item of assembly.paths) console.log(`  - ${item}`);
  }
  if (duplicates.length > 0) {
    console.log("duplicates:");
    for (const item of duplicates) console.log(`  - ${item}`);
  }
  if (expansions.length > 0) {
    console.log("authorization_expansions:");
    for (const item of expansions) console.log(`  - ${item}`);
  }
  if (kernelReads.hits.length > 0) {
    console.log("executor_kernel_reads_hits:");
    for (const item of kernelReads.hits) console.log(`  - ${item}`);
  }
  if (!emptyValid) {
    console.log("empty_context: invalid");
  }

  const failed = failures.length > 0
    || assembly.count !== 1
    || privateItems !== 0
    || expansions.length !== 0
    || duplicates.length !== 0
    || kernelReads.count !== 0
    || !emptyValid;
  if (failed) {
    process.exitCode = 1;
  }
}

await main();
