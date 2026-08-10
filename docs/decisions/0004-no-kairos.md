# ADR 0004: 不引入 Kairos 运行路径

Type: decision
Status: current
Verified: 21629d6 2026-08-10
Review: 该决策被重新讨论或推翻时（只能由新 ADR supersede）

## Status

Accepted

## Context

Kairos 是独立历史项目，曾有一套 bridge 与进度流实现。集成过程中出现过把它作为运行路径或回退的诱惑。

## Decision

- Kairos bridge、SSE progress stream、`RunProgressPresenter`、`forceKairosRouting` 都不是 Yishu 的依赖、回退或运行路径，禁止迁入、调用或恢复。
- Task state 只来自 typed Pi `AgentRuntime` events。
- Kairos 仅在 Kairos 历史仓库保留旧记录。

## Alternatives considered

- 保留 bridge 作为回退路径。

## Why

第二运行路径破坏单一任务真相：同一任务出现两个状态来源后，无法判定哪个是真的。

## Consequences

- 代码中零容忍；2026-08-10 审计确认仅剩文档引用。
- 进度与任务状态的展示统一走 typed events（见 `docs/architecture.md`）。
