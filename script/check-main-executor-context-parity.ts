#!/usr/bin/env node
/**
 * Architecture ratchet: ordinary Main turns share one product-owned
 * execution context across Pi and Codex.
 *
 * Metric 1: main_executor_context_parity_failures
 *   Count one failure for each required semantic dimension that is not
 *   rendered exactly once with the required trust/authority markers by
 *   BOTH Pi and Codex. Symmetric absence and symmetric weak trust fail.
 *
 * Metric 2: turn_scoped_context_assembly_paths
 *   Count independent production mechanisms that assemble product-owned,
 *   turn-scoped semantic context after Product Kernel recall.
 *
 * Zero is the permanent ceiling for metric 1. One is the permanent
 * ceiling for metric 2. Do not drop a dimension, exclude an executor,
 * or duplicate formatters inside this checker to pass.
 *
 * This script loads production rendering seams. @yishu/kernel is resolved
 * through package exports to dist/, so the .mjs wrapper builds Kernel
 * first — the same convention as runtime `pretest`.
 *
 * Usage: node script/check-main-executor-context-parity.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTaskExecutionContract } from "../packages/runtime/src/task-contract.js";
import {
  buildGroundedPrompt,
} from "../packages/runtime/src/context-prompt.js";
import { buildCodexPrompt } from "../packages/runtime/src/providers/codex-runtime.js";
import { applyTurnExecutionContext } from "../packages/runtime/src/turn-execution-context.js";
import {
  MAIN_EXECUTOR_CONTEXT_DIMENSIONS,
  MAIN_EXECUTOR_CONTEXT_SENTINELS,
  evaluateMainExecutorContextParity,
  type MainExecutorContextDimension,
} from "../packages/runtime/src/main-executor-context-parity.js";
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

const SENTINELS = MAIN_EXECUTOR_CONTEXT_SENTINELS;

const DURABLE_DIMENSIONS: MainExecutorContextDimension[] = [
  "history",
  "memory",
  "rules",
  "mind",
  "delegated",
  "trail",
];

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

function fixtureInput(scopeKind: "personal" | "private") {
  return {
    conversationHistory: [{
      id: "22222222-2222-4222-8222-222222222222",
      capturedAt: "2026-09-06T00:00:00.000Z",
      userInput: SENTINELS.history,
      assistantOutput: "先前回答",
    }],
    recalledMemories: [{
      id: "11111111-1111-4111-8111-111111111111",
      claim: SENTINELS.memory,
      source: "conversation",
      capturedAt: "2026-09-06T00:00:00.000Z",
      scope: "personal" as const,
      authority: "user" as const,
    }],
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
      resultKind: "completed" as const,
      summary: SENTINELS.delegated,
    }],
    recentTrail: [{
      frameId: "66666666-6666-4666-8666-666666666666",
      capturedAt: "2026-09-06T00:00:00.000Z",
      appName: SENTINELS.trail,
      windowTitle: "TrailWindow",
      axRole: "AXButton",
      axTitle: "OK",
      axValuePreview: null,
      cursorRegion: "center",
      warnings: [] as const,
    }],
    intentFrame: intentFrame(),
    taskContract: createTaskExecutionContract({
      objective: SENTINELS.taskContract,
      successMode: scopeKind === "private" ? "read_only_delivery" : "external_effect",
      authority: scopeKind === "private" ? "automatic" : "reversible",
      risk: scopeKind === "private" ? "low" : "medium",
      maxAttempts: 1,
    }),
    sessionScopeKind: scopeKind,
  };
}

function fixtureCommand(scopeKind: "personal" | "private"): TurnStartCommand {
  const command = makeTurnStartCommand();
  command.payload.utterance = scopeKind === "private"
    ? "私密请求"
    : "当前用户请求：parity live utterance";
  command.payload.sessionScope = { kind: scopeKind };
  return applyTurnExecutionContext(command, fixtureInput(scopeKind));
}

function renderPi(command: TurnStartCommand): string {
  return buildGroundedPrompt(command, { includeConversationHistory: true });
}

function renderCodex(command: TurnStartCommand): string {
  return buildCodexPrompt(command);
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

function main(): void {
  const command = fixtureCommand("personal");
  const piText = renderPi(command);
  const codexText = renderCodex(command);
  const parity = evaluateMainExecutorContextParity(piText, codexText);

  const expansions: string[] = [];
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

  const privateCommand = fixtureCommand("private");
  const privatePi = renderPi(privateCommand);
  const privateCodex = renderCodex(privateCommand);
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

  reportLine("main_executor_context_parity_failures", parity.failureCount);
  reportLine("turn_scoped_context_assembly_paths", assembly.count);
  reportLine("private_session_durable_context_items", privateItems);
  reportLine("context_authorization_expansions", expansions.length);
  reportLine("duplicate_semantic_context_sections", parity.duplicates.length);
  reportLine("executor_kernel_reads", kernelReads.count);

  console.log("target_parity: 0");
  console.log("target_assembly_paths: 1");
  if (parity.failures.length > 0) {
    console.log("parity_failures:");
    for (const failure of parity.failures) console.log(`  - ${failure}`);
  }
  console.log("parity_matrix:");
  for (const id of MAIN_EXECUTOR_CONTEXT_DIMENSIONS) {
    const row = parity.matrix[id];
    const describe = (side: { count: number; trust: boolean }): string => {
      if (side.count === 1 && side.trust) return "render";
      if (side.count === 0) return "missing";
      if (side.count > 1) return `duplicate(${side.count})`;
      return "weak";
    };
    console.log(`  ${id}: pi=${describe(row.pi)} codex=${describe(row.codex)}`);
  }
  if (assembly.paths.length > 0) {
    console.log("assembly_paths:");
    for (const item of assembly.paths) console.log(`  - ${item}`);
  }
  if (parity.duplicates.length > 0) {
    console.log("duplicates:");
    for (const item of parity.duplicates) console.log(`  - ${item}`);
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

  const failed = parity.failureCount > 0
    || assembly.count !== 1
    || privateItems !== 0
    || expansions.length !== 0
    || parity.duplicates.length !== 0
    || kernelReads.count !== 0
    || !emptyValid;
  if (failed) {
    process.exitCode = 1;
  }
}

main();
