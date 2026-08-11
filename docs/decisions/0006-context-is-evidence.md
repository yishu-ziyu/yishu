# ADR 0006: Context 即证据

Type: decision
Status: current
Verified: 21629d6 2026-08-10
Review: 该决策被重新讨论或推翻时（只能由新 ADR supersede）

## Status

Accepted

## Context

上下文采集（光标、窗口、AX 元素、截图）可能过期、低置信或含敏感内容。直接把全量上下文送模型既危险又浪费。

## Decision

- 每个 context item 携带 `source`、`capturedAt`、`confidence`、`expiry`。
- 过期 / 低置信内容做标注，并可触发视觉确认。
- 优化正确的上下文，而非最大的上下文。
- screenshot 字节不落 `ContextTrail`。
- 敏感内容 fail-closed（ledger-safety）。
- 进入模型的屏幕内容经注入扫描（2026-08-10 PR #1 起）。

## Alternatives considered

- 全量上下文直送模型。

## Why

错误的上下文比缺少上下文更危险：模型会自信地基于错误前提行动。

## Consequences

- 采集、存储、注入三处各自承担脱敏边界。
- Context 证据语义由 `YishuContext` 承载，生产采集器由正式 App 提供。
