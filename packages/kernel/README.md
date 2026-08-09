# @yishu/kernel

Product kernel for Yishu: typed `YishuAction` registry, `ContextTrail`, evidence store (`YishuStore`), and `ContextCapsule` handoff.

## What this is

- Product actions with authority, risk, verify, and audit `ActionReceipt`
- Rolling context trail (sanitized frames, no screenshot bytes)
- Evidence store: `MemoryClaim`, `Learning`, `SkillCandidate` / `VerifiedSkill`, `Mandate`, `TaskTruth`
- Product-owned `TaskTruthProjector`: execution observations → monotonic, durable task state
- Backends: `memory` | `json` | **`sqlite`** (`node:sqlite`, default for product hosts)
- Trail-replay skill verification (ordered app/window evidence, not mouse coords)
- Utterance router for short voice commands
- Short-lived `ContextCapsule` for multi-agent handoff (Pi / Codex / Claude / Cua)

## What this is not

- Not a Pi replacement
- Not an Agent-Native runtime or dependency
- Not the Clicky shell or Swift actuator

Pi stays the execution harness. This package is the product layer above it.

## Quick start

```ts
import { createYishuKernel } from "@yishu/kernel";

const { registry, store, trail, taskTruth, defaultActionNames } = createYishuKernel();
// defaultActionNames: remember, forget, remember_how, share_context, record_learning

// Optional: feed recent frames (no raw image bytes stored in trail)
// trail.append(contextFrameLike);

const remembered = await registry.invoke("remember", {
  caller: "voice",
  input: {
    claim: "用户在这个项目中偏好 React",
    scope: "project:yishu",
    confidence: 0.91,
  },
});
// remembered.status === "verified"; output is MemoryClaim

const how = await registry.invoke("remember_how", {
  caller: "voice",
  input: {
    minutes: 5,
    name: "hand_repo_to_codex",
    triggerPhrase: "把这个仓库交给 Codex",
    autoVerify: true,
  },
});
// SkillCandidate (+ VerifiedSkill when autoVerify)

const shared = await registry.invoke("share_context", {
  caller: "cli",
  input: { userIntent: "把当前上下文交给 Codex", projectHint: "project:yishu" },
  contextFrame: /* optional live frame */,
});
// shared.output.json has no base64Data
```

`taskTruth.record(...)` accepts only product-level progress signals. A task is
created lazily on `start`; `verified` becomes `done`, `unverified` becomes
`blocked`, and failure/cancellation remain terminal. Titles and bounded
evidence are normalized and credential-like material is hidden before the
store boundary.

File-backed store:

```ts
const kernel = createYishuKernel({ storeDir: "/path/to/yishu-store" });
```

## Default actions

| Name | Purpose |
|------|---------|
| `remember` | Store an evidence-backed `MemoryClaim` |
| `forget` | Soft-retire a memory by id |
| `remember_how` | Extract procedural skill from `ContextTrail` ("记住我刚才是怎么做的") |
| `share_context` | Build a `ContextCapsule` JSON for handoff |
| `record_learning` | Record a user correction as `Learning` |

Callers: `voice` | `ui` | `initiative` | `mcp` | `cli` | `pi` | `system`.

Authority levels: `automatic` | `reversible` | `standing_mandate` | `explicit_approval`. High-risk / explicit paths without `approved: true` return `needs_approval`.

## Layout

```text
src/
  action/     defineYishuAction, registry, authority, ActionReceipt
  actions/    remember, forget, remember_how, share_context, record_learning
  context/    ContextTrail, ContextCapsule, sanitize
  store/      YishuStore, MemoryClaim / Skill / Mandate types
  task-truth.ts  execution progress -> durable TaskTruth policy
  kernel.ts   createYishuKernel
```

## Commands

```bash
pnpm --filter @yishu/kernel test
pnpm --filter @yishu/kernel check
pnpm --filter @yishu/kernel build
```

Acceptance: [docs/acceptance/v0-product-kernel.md](../../docs/acceptance/v0-product-kernel.md).
