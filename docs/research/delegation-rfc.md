# Delegation RFC v2 — Delegated Concurrent Execution

Type: research
Status: current
Verified: dd5a362 2026-08-23
Review: 进入 Scope Definition 前；或任一已验证结论被新证据推翻时

**Acceptance: Accepted 2026-08-11。**

- Verified baseline：main `122b7f5`（post-merge CI 全绿）+ spike 验证 commit `48da76e`。
- 支撑证据：`docs/spikes/2026-08-10-delegation-concurrency.md`（Spike A/B/D/E/F 全部 PASS）。
- 决策锚点：ADR 0009（docs/decisions/0009-delegated-execution-architecture.md）。

Supersedes: Delegation RFC v1（未入库，存在于 2026-08-10 设计对话；v2 第一节记录被删除/修正的 v1 设计）

> ADR 0014 修订：本 RFC 的 2026-08-11 spike 证据发生在旧 `PiRuntimeAdapter` 上；当前生产实现是 `YishuLoopRuntimeAdapter` + `model-loop/`，并由现有 loop-adapter concurrency / delegation tests 保护。旧名称仅描述当时证据，不是当前依赖。

## 1. v1 → v2：被删除或修正的设计

以下 v1 设计与 spike 证据冲突，**明确删除**，不得在任何后续设计中复活：

1. ~~同一执行适配器不能并行执行多个独立 execution（v1 视为 blocker 级 unknown）~~ → 已验证可并行，见 §2.1。
2. ~~Delegation 需要新增 `AgentTask.status` 或独立的 delegated-task 状态系统~~ → 已删除。`TaskTruth` 保持唯一任务状态真相源，见 §2.4。
3. ~~delegate 需要等待 child result 后才能返回（同步 receipt）~~ → 已删除。异步 `{ accepted, taskId }` receipt 成立，见 §2.3。
4. ~~parent-child truth 需要新的关联/终态机制~~ → 已删除。现有 `parentId + terminal guard` 足够，见 §2.6。

## 2. 已验证结论（spike 证据：docs/spikes/2026-08-10-delegation-concurrency.md）

1. **同一执行适配器可以并行执行不同 `conversationId` 的独立 session。** 历史 spike 证据：B 在 A 完成前 3.806s 启动，两个不同真实 sessionId，双双完成（2026-08-11，旧 Pi adapter，openai-codex/gpt-5.4-mini）；当前等价边界由 `loop-adapter-concurrency.test.ts` 保护。
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

## 3. Canonical decisions（V1，Accepted）

以下 14 条为本 RFC 的 canonical 决策，由 ADR 0009 锚定：

**Truth model**

1. `TaskTruth` 是唯一任务状态真相源。
2. 不新增 `AgentTask.status` 或任何第二套任务状态系统。
3. Result Inbox 是 payload-only；result envelope 描述结果性质，不复制 task status。
4. Presence 是 projection，不是独立 truth source。

**Execution model**

5. Delegation 使用异步 `{ accepted, taskId }` receipt。
6. Main 不同步等待 Child。
7. Child 使用独立 execution session（不同 conversationId → 不同 session）。
8. Child result 不得 mutation 当前 Main turn；re-entry 只写 inbox，Main 在 presentation point 显式一次性 consume。

**Context & safety**

9. `ContextCapsule` 是 handoff payload。
10. `ContextCapsule` 接收路径必须显式执行 expiry validation（kernel 无内建执行点，接收方责任）。

**Resource model**

11. Execution Cell 是 execution/resource boundary。
12. Desktop Cell 是 exclusive resource；desktop action 必须持有 lease。
13. V1 使用单 coordinator 下的 token-based lease（cancel/failed 由 coordinator forceRelease；stale release 不得释放新 owner）。

**边界**

14. V1 不引入 distributed scheduler / distributed lease。

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
- computer-use profile 并发时的 Desktop 动作互斥（Spike E 只验证 lease 语义，不验证真实 provider 并发 desktop 执行）

## 5. 不变量继承

本 RFC 不改变任何已有架构约束：`runtime → kernel` 且 agent-core 与产品解耦；`packages/runtime/src/model-loop/` 为唯一 execution harness；Clicky identity / TCC / signing 不变；协议 `schemaVersion 1` 内 additive 演进；不引入 Kairos 或第二套 runtime。
