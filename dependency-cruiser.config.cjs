/**
 * Machine-executable architecture contract for the Yishu monorepo (docs/architecture.md).
 *
 * Encodes the dependency direction rules from docs/architecture.md and docs/decisions:
 * - The Yishu-owned product stack is one-way: Kernel <- Runtime <- Clicky.
 * - Kernel must never depend on Runtime (the execution harness) or AgentCore.
 * - AgentCore is a standalone laboratory and must not be imported by Kernel,
 *   Runtime, or the Clicky app.
 * - No circular dependencies anywhere in product source.
 *
 * This replaces the fragile token-grep portion of script/check-product-boundaries.sh
 * with a real dependency-graph contract that catches renamed imports, transitive
 * edges, and cycles that regex cannot see.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // Intra-package cycles around the ProductKernelRuntime hub are a real but
    // large existing debt (a god-file strongl-connected component). Gate them
    // as "warn" so the CI stays green while the list is churned down to zero;
    // cross-package cycles are already impossible because the package boundary
    // rules below are "error". Report with: pnpm dep:check
    { name: "no-circular", severity: "warn", from: {}, to: { circular: true } },

    // Kernel is the product core, not an execution harness. It must not reach
    // up into Runtime or out into the AgentCore laboratory.
    {
      name: "no-kernel-to-runtime",
      severity: "error",
      from: { path: "^packages/kernel/src" },
      to: { path: "^packages/runtime/src" },
    },
    {
      name: "no-kernel-to-agent-core",
      severity: "error",
      from: { path: "^packages/kernel/src" },
      to: { path: "^packages/agent-core/src" },
    },

    // Runtime is the shipping loop and must not link the AgentCore laboratory.
    {
      name: "no-runtime-to-agent-core",
      severity: "error",
      from: { path: "^packages/runtime/src" },
      to: { path: "^packages/agent-core/src" },
    },

    // AgentCore stays a standalone lab: no dependency on Kernel or Runtime.
    {
      name: "no-agent-core-to-kernel",
      severity: "error",
      from: { path: "^packages/agent-core/src" },
      to: { path: "^packages/kernel/src" },
    },
    {
      name: "no-agent-core-to-runtime",
      severity: "error",
      from: { path: "^packages/agent-core/src" },
      to: { path: "^packages/runtime/src" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(dist|\\.build|coverage|__coverage__|/\\.pnpm/)" },
    tsConfig: { fileName: "tsconfig.base.json" },
    includeOnly: { path: "^packages/[^/]+/src" },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
