# 奕枢统一主链：P1 验收与风险矩阵（最终验收）

> 审计范围：当前本地工作树的 `packages/kernel`、`packages/runtime` 和
> `apps/clicky`。本文保留 P1 主链结论，并追加 P1.1 的项目/私密会话作用域
> 验收；结论依据当前共享树的测试、Xcode 和启动验收。

## 先给结论

**P1 主链和 P1.1 作用域前置已完成；完整记忆产品仍未完成。**

已经成为真实主链的部分：

```text
Clicky 稳定 conversationId
  -> versioned Runtime turn.start
  -> ProductKernelRuntime 先开 Kernel turn
  -> Pi 只负责模型/工具执行并产生 typed events
  -> Runtime 将安全事件、TaskTruth 和 terminal receipt 投影回 Kernel
  -> Kernel JSON/SQLite 可重启读回并对 terminal turn 做 replay
  -> Clicky 呈现结果；缓存不拥有 durable truth
```

本批已完成的边界：

- Kernel 的 in-memory、JSON、SQLite conversation ledger 已实现；turn/event sequence、
  terminal 状态、冲突检查和重启读回由 Kernel 持有。
- Runtime 在调用 Pi 前先写 `open` turn；`response.delta` 不进 durable ledger；安全的
  tool/action/task 事件和一个 terminal 结果才进入 ledger。
- 已完成 request 的重放从 Kernel terminal 记录回放，不再次调用 inner runtime；未完成
  `open` turn fail closed，不盲目重跑。
- MemoryClaim、Learning、TaskTruth 和 ledger event 的持久边界已通过 fail-closed、
  bounded-scalar、replay/live privacy/audit 验收；ContextTrail、ContextCapsule、Skill
  和 directSkill store 链也已通过。
- A4 取消竞态已关闭：commit 前取消无副作用并落 `turn.cancelled`；commit 后取消在
  memory/JSON/SQLite × `remember`/`record_learning` 六种组合全部得到明确的
  `action.completed.status=cancelled_after_commit` 与
  `turn.failed.code=action_committed_after_cancel`，且没有 `response.completed`。

当前**不属于本批完成范围**的部分：

- Clicky 的 `conversationHistory` 仍是旧的进程内 presentation fallback，尚没有由
  Kernel 历史读取替代它的完整历史 UI。
- 完整记忆产品（自动候选提取、自动召回、检索、冲突合并、衰减/过期、用户编辑/忘记、
  保留期）尚未形成闭环。
- 并发部署仍有外围限制：JSON 多个独立实例可能 lost update；多个
  `ProductKernelRuntime` 共享 SQLite 并复用同一 `requestId` 可能重复执行，当前正式
  部署必须是单 Clicky、单 sidecar、单 SQLite；lease/lock 属于后续工作。

## 最终验收证据

当前共享树的最终证据如下：

| 验收 | 结果 |
|---|---|
| `pnpm --filter @yishu/kernel test` | **71/71 通过** |
| `pnpm --filter @yishu/runtime test` | **85/85 通过**，包含 runtime pretest 构建 |
| `pnpm test` | **通过** |
| `pnpm run check` | **通过** |
| `swift test` | **4/4 通过** |
| Clicky `xcodebuild` | **TEST SUCCEEDED**，包含 conversationId 持久化测试 |
| `./script/build_and_run.sh --verify` | **通过** |

因此本批不仅是 Node/Kernel harness 通过，Clicky Xcode 测试、conversationId 路径和真实
启动验收也已纳入证据。剩余项是产品范围和并发策略，不是 P1 主链的未关闭 blocker。

## ID 契约与 conversationId 稳定性

| ID | 语义 | 生命周期 | 不能替代 |
|---|---|---|---|
| `conversationId` | 一条用户可见的连续会话/关系 scope | Clicky 创建；sidecar 重启不轮换；显式新建对话才轮换 | `requestId`、Pi session、进程 ID |
| `requestId` | 一次 wire `turn.start`，同时作为该 turn 的 durable ID | 每次新提交/重试应新建；已完成后重放只回放 terminal | `conversationId` |
| `traceId` | 一次命令链的追踪 ID | start 建立；cancel/steer 复用同一 turn trace | 业务主键 |
| `actionId` | 一次计算机动作 | 每次 action 请求 | turn/conversation |
| `attemptId` | 同一 action 的某次尝试 | 每次重试新建 | 新一轮 turn |
| `eventId` | 一条 runtime/ledger event 的去重键 | 事件永久唯一；同 ID 不同内容报冲突 | UI 自行生成的临时 key |

`YishuAgentRuntimeClient.swift` 将 UUID 写入 `yishu.runtime.conversationId.v1`，每个
turn payload 发送同一值；`beginNewConversation()` 才轮换。Swift 4/4、Clicky
`xcodebuild TEST SUCCEEDED`（含 conversationId 测试）和 `build_and_run --verify` 已验证
这条入口与 sidecar 路径。缺失 `conversationId` 的旧 turn 仍按明确 policy 使用
`requestId` 作为 legacy conversation scope，不伪造旧客户端的跨 turn 连续性。

## P1 完整用户链验收矩阵

下表的“通过”是本批主链验收；“下一批”是有意保留的产品能力，不重新命名为 blocker。

| ID | 用户动作与注入 | P1 当前状态 | 下一批 residual |
|---|---|---|---|
| A1 纯对话 | 同一 `conversationId` 连续多轮；Pi 不发 tool | **通过**：Kernel ledger、Runtime projection、SQLite restart/replay、Clicky conversationId 和启动验收均通过 | Clicky 完整历史 UI 仍未改为 Kernel read path |
| A2 带工具任务 | `tool.started` → `tool.completed` → verified completion | **通过**：TaskTruth、safe tool metadata、terminal gate 和真实 Clicky 验收通过 | 更丰富的外部 post-condition/自动召回属于下一批 |
| A3 执行失败 | tool 后 `turn.failed`，错误含敏感/长文本 | **通过**：失败只出稳定 code，inner 不在 ledger 失败前执行，隐私审计通过 | provider/工具生态扩展不改变本批结论 |
| A4 取消 | 执行中 cancel，随后注入迟到 failed/completed | **通过并关闭红队 blocker**：commit 前无副作用；commit 后六组合均落 cancelled-after-commit + action-committed-after-cancel，无 `response.completed` | 后续可优化用户解释和恢复 UX，不再是状态正确性 blocker |
| A5 dispose/restart | active turn `dispose()`，再重建 runtime | **通过**：producer drain、abort、SQLite restart/replay、Clicky build/run verify 均通过 | 并发多实例 lease/lock 属于外围 residual |
| A6 重复 request | 活动期并发重复；完成后重放同一 request | **通过（单 Clicky/单 sidecar 拓扑）**：活动重复拒绝，terminal replay 不再执行 inner，store payload/trace 冲突 fail closed | 共享 SQLite 的多个 ProductKernelRuntime 仍可能重复执行；见并发 residual |
| A7 敏感文本 | utterance/tool payload/截图/token/password 等 | **通过（本批审计面）**：replay/live privacy/audit、bounded event、MemoryClaim/Learning fail-closed、ContextTrail/Capsule 均通过；private 不落 ledger/trail/task/memory | 全量自动记忆治理仍属下一批 |
| A8 项目/会话隔离 | conversation A/B、project A/B 写同名事实/任务 | **P1.1 通过**：conversation/turn/task 有统一 scope，跨域重用 fail closed，fact/learning 用 `project:<UUID>`，private 只在内存执行 | 多项目历史选择器和 ContextCapsule 自动召回属于下一批 |
| A9 旧协议兼容 | v1 turn 无 conversationId；旧 action receipt 缺新字段 | **通过**：optional 字段、legacy fallback、Clicky build/test 和 sidecar 路径通过 | 旧客户端升级/回滚演练可继续补充，不阻塞第一刀 |

同一 turn 的 durable 顺序约束仍是：

```text
turn.started -> (tool/action/task events)* -> exactly one of
               turn.completed | turn.cancelled | turn.failed
```

`response.delta` 只用于实时展示；`tool.completed`、`action.completed` 也不等于任务
完成，必须由 verified receipt 或可见/外部 post-condition 决定。Kernel sequence、
terminal conflict、replay 和 live event projection 已通过最终测试。

## B1–B8：本批 blockers = 0

| Blocker | 最终结论 | 最终证据/边界 |
|---|---|---|
| B1 `YishuStoreSnapshot` 新数组导致编译失败 | **核销** | Kernel 71/71、Runtime 85/85、`pnpm test/check` 全通过；JSON/SQLite snapshot 含 conversations/turns/events |
| B2 conversation store 方法缺实现 | **核销** | in-memory/JSON/SQLite 均实现写入、读取、sequence、restart/migration 和 conflict tests |
| B3 conversationId 只停在 schema/Swift | **核销** | Runtime→Kernel event/turn 传播、Swift 4/4、Clicky `xcodebuild TEST SUCCEEDED`、`build_and_run --verify` |
| B4 完成后 request 可重复执行 | **核销** | terminal replay、open-turn recovery、活动重复和 payload/trace conflict 全通过；单 Clicky/单 sidecar 拓扑下不重复执行 |
| B5 缺 project scope | **P1.1 核销** | `SessionScope` 进入 protocol、Kernel ledger、TaskTruth 和 Clicky；项目 ID 稳定、跨域冲突 fail closed、private 不落盘 |
| B6 MemoryClaim/Learning/trajectory 安全边界 | **P1 durable boundary 核销** | Kernel 71/71、replay/live privacy/audit、MemoryClaim/Learning fail-closed、ContextTrail/Capsule/Skill/directSkill store 全通过 |
| B7 Swift conversationId payload/未定义 requestId 编译风险 | **核销** | `swift test` 4/4、Clicky `xcodebuild TEST SUCCEEDED`（含 conversationId test）、`build_and_run --verify` |
| B8 `runtimeEvent()` 重复赋值 eventId | **核销** | 当前实现单次生成 eventId；Runtime 85/85、协议和 replay/idempotency 验收通过 |

所以当前准确表述是：**B1–B8 全部核销，P1 主链与 P1.1 作用域前置已完成。**
完整记忆和 Clicky 历史 UI 仍是下一批目标。

## 绝不能落盘的字段（本批安全边界）

这些字段即使短暂作为模型输入或 Swift actuator 输入，也不得进入 Kernel JSON/SQLite、
durable event payload、TaskTruth、UserDefaults、日志或 analytics：

- API/OAuth access-refresh token、cookie、Authorization header、密码、一次性登录值、
  私钥和 provider 原始响应。
- 截图 JPEG/PNG base64、data URI、像素 blob、录音/原始音频、屏幕捕获原文。
- system/internal prompt、chain-of-thought/reasoning、完整隐藏 tool arguments/results、
  可能含 secret 的异常堆栈和 stdout/stderr。
- 原始 AX `value`、secure text、剪贴板和用户选中的私人内容，除非用户明确选择为记忆，
  且经过同一脱敏、scope、可撤销流程。

允许进入第一刀 ledger 的只有：

- 用户可见 input/final output，经过 `sanitizeVisibleText`、长度上限和 secret 替换；
  不写 streaming delta 全量。
- bounded、单行、非敏感的 tool/action/task metadata 和稳定分类码。
- MemoryClaim/Learning 的明确用户写入；safety boundary 失败时整笔拒绝，不生成
  `[redacted]` 伪记忆。
- ContextFrame 的无字节短期 metadata。截图可作为受控 turn 输入，但不能成为图片存档。

Replay/live privacy/audit、ContextTrail-Capsule-Skill 和 directSkill store 已通过；这
证明的是产品-owned durable boundary；自动记忆召回仍未实现。

## 如何证明 Pi/Clicky 缓存不是第二真相

本批已通过的证据：

1. SQLite restart/replay 读回 conversation、turn sequence 和 terminal receipt；重放旧
   turn 不再次调用 inner runtime。
2. 重复 eventId 只保留一个安全投影；delta、tool 参数、secret 和截图不进入 durable
   event；不同 payload/trace fail closed。
3. Clicky conversationId 在 Swift/Xcode/build-and-run 路径稳定传递；Pi 仍是执行
   harness，不拥有 Kernel product state。
4. 取消竞态在 commit 前、commit 后和 memory/JSON/SQLite 六种组合均以明确 terminal
   状态收敛，没有迟到的 `response.completed`。

仍待下一批处理的缓存/并发边界：

1. Clicky `conversationHistory` 仍是旧 presentation fallback；完整历史 UI 要改为从
   Kernel 明确读取，才能彻底证明它只是可丢弃缓存。
2. JSON 多个独立 store 实例可能 lost update；当前不把多进程 JSON 当正式部署拓扑。
3. 多个 `ProductKernelRuntime` 共享 SQLite 并复用同一 `requestId` 时，可能在 ledger
   冲突前重复执行外部副作用；当前正式拓扑必须单 Clicky、单 sidecar、单 SQLite，后续
   用 lease/lock 或等价的跨实例 claim 解决。

所以目前可以说：**Kernel 已是 P1 durable truth，Pi 是执行 harness；作用域
前置已就位，Clicky 历史 UI 和自动记忆召回是完整记忆产品的下一刀。**

## 剩余 residuals 与下一刀

按优先级排序：

1. **R1 Clicky 历史 UI**：把 `conversationHistory` 降为可丢弃 presentation cache，
   提供 Kernel-backed load/forget/new-conversation/private-session 入口。
2. **R2 完整记忆产品**：candidate → review → retrieval → consolidation；普通 turn 不
   自动写长期记忆，只有审核后的 MemoryClaim/Learning 才进入召回，并具备置信度、冲突、
   过期、撤销和可见编辑。
3. **R3 JSON 并发安全**：为多实例写入增加 lock/transaction，或明确禁止多进程共享同一
   JSON store，避免 lost update。
4. **R4 SQLite runtime claim**：为共享 SQLite 的多个 ProductKernelRuntime 增加 lease/
   lock/atomic claim，防止同一 requestId 在 ledger 冲突前重复外部动作；在此之前坚持
   单 Clicky、单 sidecar、单 SQLite 正式部署约束。

最终产品表述：**P1 统一主链和 P1.1 项目/私密作用域已完成；Pi 仍是执行
harness，Clicky 历史 UI、自动记忆召回与并发执行租约进入下一批。**
