/**
 * Dependency direction for product source:
 * Kernel <- Runtime <- Clicky.
 * Kernel never imports Runtime or AgentCore.
 * AgentCore is a laboratory: Kernel, Runtime, and Clicky must not import it.
 * No circular dependencies in product source.
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
