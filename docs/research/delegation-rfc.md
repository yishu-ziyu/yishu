# Delegation RFC v2 — Delegated Concurrent Execution

Type: research
Status: current
Verified: 03dc00e 2026-08-11
Review: 进入 Scope Definition 前；或任一已验证结论被新证据推翻时

Supersedes: Delegation RFC v1（未入库，存在于 2026-08-10 设计对话；v2 第一节记录被删除/修正的 v1 设计）

## 1. v1 → v2：被删除或修正的设计

以下 v1 设计与 spike 证据冲突，**明确删除**，不得在任何后续设计中复活：

1. ~~同一 `PiRuntimeAdapter` 不能并行执行多个独立 execution（v1 视为 blocker 级 unknown）~~ → 已验证可并行，见 §2.1。
2. ~~Delegation 需要新增 `AgentTask.status` 或独立的 delegated-task 状态系统~~ → 已删除。`TaskTruth` 保持唯一任务状态真相源，见 §2.4。
3. ~~delegate 需要等待 child result 后才能返回（同步 receipt）~~ → 已删除。异步 `{ accepted, taskId }` receipt 成立，见 §2.3。
4. ~~parent-child truth 需要新的关联/终态机制~~ → 已删除。现有 `parentId + terminal guard` 足够，见 §2.6。

## 2. 已验证结论（spike 证据：docs/spikes/2026-08-10-delegation-concurrency.md）

1. **同一 `PiRuntimeAdapter` 可以并行执行不同 `conversationId` 的真实 Pi session。** 真实证据：B 在 A 完成前 3.806s 启动，两个不同真实 sessionId，双双完成（2026-08-11，openai-codex/gpt-5.4-mini）。
2. **request / session / event / cancel 可以保持隔离。** 事件按 requestId 归属零交叉；cancel A 不影响并发 B；dispose 终止全部 in-flight session。
3. **Delegation 可以采用异步 `{ accepted, taskId }` receipt。** receipt 在 child 仍 running 时返回；child 独立到达终态。
4. **`TaskTruth` 继续作为唯一任务状态真相源。**
5. **不新增 `AgentTask.status` 或第二套任务状态系统。** Result Inbox 只存 payload，不存 status。
6. **`parentId + terminal guard` 足够支撑当前 parent-child truth semantics。** child 的 failed/cancelled 不传染 Main；终态后迟到信号被守卫拒绝。

### 验证边界（不得外推）

以上结论仅在以下边界内成立：

- 单 provider（openai-codex）
- conversation capability profile
- 无 Desktop computer-use 操作
- concurrency = 2

边界外的并发行为（多 provider、computer-use profile、并发 >2、真实 cancel 传播、跨轮 history 隔离）**仍然是 unknown**，见 §4。

## 3. V1 架构要素（基于已验证结论）

- **delegate()**：登记 child TaskTruth（parentId 关联）→ 后台启动 execution → 立即返回 `{ accepted: true, taskId }`。
- **ContextCapsule handoff**：Main 以现有 `ContextCapsule` 作为 child 的最小受控上下文，不复制完整 conversation。（Spike D 验证中）
- **Exclusive Desktop Cell**：真实 macOS Desktop 是互斥资源；任何 desktop action 必须持有 lease。（Spike E 验证中）
- **Result Inbox**：child result 以 payload-only 形式进入 inbox，Main 在 presentation point 显式 consume，不抢占当前 interaction。（Spike F 验证中）

## 4. 仍是 unknown（本轮不阻塞 V1 架构决策）

- concurrency > 2 的行为
- 多 provider 混合并发
- 多进程 worker 宿主模型
- distributed lease
- scheduler crash recovery
- VM Cell
- 长期 session history isolation
- recursive delegation
- Gmail integration
- Presence UI
- 真实进行中 turn 的 cancel 传播
- computer-use profile 并发时的 Desktop 动作互斥（Spike E 只验证 lease 语义，不验证真实 Pi 并发 desktop 执行）

## 5. 不变量继承

本 RFC 不改变任何已有架构约束：`kernel ← runtime → agent-core`；Pi 为唯一 execution harness；Clicky identity / TCC / signing 不变；协议 `schemaVersion 1` 内 additive 演进；不引入 Kairos 或第二套 runtime。
