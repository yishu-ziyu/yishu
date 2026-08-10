# ADR 0003: Pi 是唯一 execution harness

Type: decision
Status: current
Verified: 21629d6 2026-08-10
Review: 该决策被重新讨论或推翻时（只能由新 ADR supersede）

## Status

Accepted

## Context

Agent 产品需要一个模型与工具循环的执行 harness。自研与外采之间存在取舍，且多 harness 会分裂任务真相。

## Decision

- Pi 是唯一 execution harness。
- 产品身份、关系记忆、主动性、权限、任务真相由 Yishu 拥有，不交给 harness。
- 成熟 Pi 工具经 task capability profiles 保留；无证据不重建。

## Alternatives considered

- 自研 harness。
- 多 harness 并行。

## Why

执行是商品化能力，产品差异化在身份、记忆与真相。把执行外包给 Pi，把真相留在产品内。

## Consequences

- Pi 特有细节封闭在 `PiRuntimeAdapter`，产品代码只见 `AgentRuntime` 端口。
- `pi-coding-agent` 为 0.x pin（0.83.0），升级需 conformance pass（见 debt-004）。
