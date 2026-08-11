# ADR 0008: Agent Native 仅作方法论

Type: decision
Status: current
Verified: 21629d6 2026-08-10
Review: 该决策被重新讨论或推翻时（只能由新 ADR supersede）

## Status

Accepted

## Context

Agent Native 项目沉淀了一套 Action 设计经验。需要明确：吸收其方法，还是引入其代码。

## Decision

Agent Native 只提供 Action 设计方法论：

- 单一 typed Action
- fresh target / observation
- 执行前 revalidate
- 结构化 receipt
- 可见 read-back

它不是 Yishu 的 Swift / Node 依赖，也不是第二运行时。

## Alternatives considered

- 导入 Agent Native 的包或代码。

## Why

方法论可移植，运行时不可混入——混入第二套执行语义会破坏 ADR 0003 的单一 harness 与 ADR 0005 的产品真相归属。

## Consequences

- 上述模式由 kernel 自有类型承载（`defineYishuAction` / `ActionReceipt`）。
- kernel 与 runtime 不 import 任何 Agent Native 包或代码。
