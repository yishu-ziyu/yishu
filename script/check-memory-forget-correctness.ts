#!/usr/bin/env node
/**
 * Architecture ratchet: user-confirmed memory forget is truthful,
 * fail-closed, retryable, and owned by one semantic boundary.
 *
 * Metric 1: false_positive_memory_forget_successes
 * Metric 2: non_convergent_memory_forget_retries
 * Metric 3: memory_forget_mutation_paths
 *
 * Zero / zero / one are the permanent ceilings.
 *
 * Usage: node script/check-memory-forget-correctness.mjs
 */
import { measureMemoryForgetFitness } from "../packages/kernel/test/memory-forget-harness.ts";

function reportLine(name: string, value: number): void {
  console.log(`${name}: ${value}`);
}

const report = await measureMemoryForgetFitness();
reportLine("false_positive_memory_forget_successes", report.falsePositiveSuccesses);
reportLine("non_convergent_memory_forget_retries", report.nonConvergentRetries);
reportLine("memory_forget_mutation_paths", report.mutationPaths);
console.log("target_false_positive: 0");
console.log("target_non_convergent: 0");
console.log("target_mutation_paths: 1");
if (report.paths.length > 0) {
  console.log("mutation_paths:");
  for (const item of report.paths) console.log(`  - ${item}`);
}
if (report.details.length > 0) {
  console.log("failures:");
  for (const item of report.details) console.log(`  - ${item}`);
}

const failed = report.falsePositiveSuccesses !== 0
  || report.nonConvergentRetries !== 0
  || report.mutationPaths !== 1
  || report.unrelatedDeletions !== 0
  || report.crossScopeMutations !== 0;
if (failed) {
  process.exitCode = 1;
}
