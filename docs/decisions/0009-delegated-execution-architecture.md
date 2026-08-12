# ADR 0009: 接受 delegated concurrent execution V1 架构

Type: decision
Status: current
Verified: 4b1e3b1 2026-08-12
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
- Execution Cell 为 execution/resource boundary；Desktop Cell 使用进程共享的 token/epoch lease 互斥，busy 时直接拒绝而不排队。
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
- Result Inbox 是 Kernel store 中的 payload-only 记录，SQLite 与 JSON 都支持持久化 claim、ack 与 release。Main turn 只在自身终态持久化后 ack；失败、取消或未终态重启都 release，避免结果静默丢失。
- Runtime 重启时不恢复子执行：孤立 running TaskTruth 被原子投影为 failed + durable result，且不自动重试。这是 fail closed，不是 checkpoint resume。
- 子任务终态、取消、异常或 Runtime dispose 都按 child conversation identity 释放对应 Pi session，不触及 Main session。
- Desktop lease 仅在单 Runtime 进程内有效，无等待队列与跨进程协调。Distributed scheduler / lease、真正 checkpoint resume 仍不在 V1 内。
- 并发回归契约由 `packages/runtime/test/pi-runtime-adapter-concurrency.test.ts` 保护；capsule 安全与 parent-child truth 由 kernel 测试保护。
