# ADR 0009: 接受 delegated concurrent execution V1 架构

Type: decision
Status: current
Verified: 48da76e 2026-08-11
Review: 该决策被重新讨论或推翻时（只能由新 ADR supersede）

## Status

Accepted 2026-08-11

## Context

Yishu 需要把任务委派给独立后台 execution（如"研究 X"），同时 Main 继续服务用户。v1 设计期存在四个 blocker 级未知：adapter 能否并发、delegation 是否需要新任务状态系统、receipt 同步还是异步、parent-child truth 如何关联。

## Decision

接受 RFC v2（docs/research/delegation-rfc.md）的 V1 架构，canonical decisions 共 14 条，要点：

- `TaskTruth` 唯一任务状态真相源；不新增 `AgentTask.status`；Result Inbox 仅 payload；Presence 是 projection。
- 异步 `{ accepted, taskId }` receipt；Main 不同步等待；Child 独立 execution session；child result 不 mutation 当前 Main turn。
- `ContextCapsule` 为 handoff payload；接收路径显式执行 expiry validation。
- Execution Cell 为 execution/resource boundary；Desktop Cell 互斥；V1 单 coordinator + token-based lease。
- V1 不引入 distributed scheduler / distributed lease。

## Alternatives considered

- 同步 delegation（Main 等待 child result）。
- 独立 delegated-task 状态系统（`AgentTask.status`）。
- distributed lease / distributed scheduler。
- 完整 conversation 复制作为 child 上下文。

## Why

Spike A/B/D/E/F 全部 PASS（docs/spikes/2026-08-10-delegation-concurrency.md）：真实 Pi 并发 session 隔离（3.806s 重叠）、异步 receipt 与 parent-child truth 隔离、capsule 三道防线、token lease 互斥、inbox 不抢占 active turn。被否决方案均与证据冲突。

## Consequences

- 验证边界：单 provider、conversation profile、无 Desktop、concurrency=2；边界外仍是 unknown（RFC §4），不得外推。
- kernel 无内建 capsule expiry 执行点：handoff 接收路径必须显式实现（RFC §3.10）；产品实现遗漏即安全缺口。
- Desktop lease、Result Inbox、Scheduler 的产品实现尚未开始；其验收清单以 spike 文档 E1–E5 / F1–F7 / B1–B7 为准。
- 并发回归契约由 `packages/runtime/test/pi-runtime-adapter-concurrency.test.ts` 保护；capsule 安全与 parent-child truth 由 kernel 测试保护。
