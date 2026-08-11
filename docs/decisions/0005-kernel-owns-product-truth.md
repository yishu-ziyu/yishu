# ADR 0005: kernel 拥有产品真相

Type: decision
Status: superseded
Superseded-by: docs/decisions/0011-pi-single-agent-loop.md

## Status

Superseded 2026-08-11. Kernel 真相所有权保留；旧的 Runtime → AgentCore 依赖描述由 ADR 0011 更新。

## Context

Voice、UI、initiative、MCP、CLI、Pi 等多个调用方都需要触发产品能力。若各方自建 handler，产品行为会随入口分叉。

## Decision

- `packages/kernel` 拥有 `YishuAction` registry、`ContextTrail`、证据存储（MemoryClaim / Learning / Skill / Mandate / TaskTruth）与 `ContextCapsule`。
- voice / UI / initiative / MCP / CLI / Pi 共享 `defineYishuAction` 与 `ActionReceipt`，不得 fork handler。
- 依赖方向 `kernel ← runtime → agent-core`，无环；kernel 只依赖 zod。

## Alternatives considered

- 各调用方自建 handler。
- 产品逻辑放进 Pi。

## Why

产品真相必须产品自有；harness 可替换，真相不可随之迁移。

## Consequences

- god-file 压力登记为 debt-001 ~ debt-003。
- 协议 `schemaVersion 1` 内只做 additive 演进。
