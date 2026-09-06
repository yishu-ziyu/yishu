# Phase 0C：前台 Runtime 轮次生命周期从语音呈现层抽出

- 日期：2026-09-06
- 状态：active
- 上下文：GitHub Issue #29（parent #24）；#27 / PR #28 已合入 `main`（`a244c84`）

## 一句话任务

把前台 Runtime 执行生命周期从 `CompanionManager` 抽到独立所有者；停声、取消执行、插话/转向、替换可见生成变成可分开调用的操作。用户可见的 Control+Option 行为保持等价。

## Change（用户能观察到什么）

按住 Control+Option 说话、普通轮次、新句打断、同会话口语插话、有效果/看屏句走新上下文、Runtime 崩溃/超时、电脑动作回执核验，与抽之前同一条路径。用户看不出这次是重构。

## Not this（不算数的替代）

- 只把 `startTurn`/`cancelTurn` 挪到另一个 `CompanionManager` 扩展
- 包一层只转发、自己不拥有 request identity 的 wrapper
- 用改名、缩搜索面、排除文件、抬阈值让检查器变绿
- 做全双工、Task/Run、IM、AgentIdentity、统一记忆上下文

## Goal / Hard bar / Improve

- Goal：前台 Runtime 执行有唯一所有者；`CompanionManager` 只决定产品策略并保留 TTS/overlay/电脑动作呈现
- Hard bar：`foreground_execution_ownership_violations == 0`；Issue #29 的表征测全绿；既有 barge-in / turn-generation / runtime-client / computer-action 覆盖不回退
- Improve：`foreground_execution_ownership_violations`（越低越好，目标 0）

## 验收标准

| # | 标准 | evaluator | 证据 |
|---|---|---|---|
| 1 | 健身函数到 0 | 机器：`node script/check-clicky-foreground-lifecycle-boundary.cjs` | 打印 `foreground_execution_ownership_violations: 0`，退出 0 |
| 2 | start 所有权在执行所有者 | 机器：`xcodebuild test … -only-testing:leanring-buddyTests/YishuForegroundRuntimeExecutionTests` | `startGivesExecutionOwnerAuthoritativeRequestIdentity` 绿 |
| 3 | 只停呈现不能取消 Runtime | 同上 | `presentationStopAloneDoesNotCancelRuntimeExecution` 绿 |
| 4 | 显式用户打断恰好一次 cancel | 同上 | `explicitUserInterruptCancelsRuntimeExactlyOnce` 绿 |
| 5 | 同会话口语插话 interrupt→accepted→steer，不新开 turn | 同上 | `eligibleConversationalBargeInSteersSameTurn` 绿 |
| 6 | 有效果/看屏句取消旧 turn、新开带新上下文的 turn | 同上 + 既有 `YishuBargeInTests/sameSessionSteerIsStrictlyPureConversation` | 两条都绿 |
| 7 | complete/cancel/fail/timeout/termination 只结算一次 | 同上 | `terminalOutcomesSettleExecutionExactlyOnce` 绿 |
| 8 | 过期 request/generation 不能复活执行 | 同上 | `staleRequestAndGenerationEventsCannotResurrectExecution` 绿 |
| 9 | steer 后可见生成替换仍正确 | 机器：既有 `YishuBargeInTests` 的 generation/projection 条 | TEST SUCCEEDED |
| 10 | 电脑动作 request/receipt/verification 未改 | 机器：`… YishuComputerUseReadBackTests` + `YishuFileDropTests` + `YishuFileDropProtocolTests` | TEST SUCCEEDED |
| 11 | 既有 barge-in / runtime-client 覆盖不回退 | 机器：`… YishuBargeInTests` + `leanring_buddyTests` | TEST SUCCEEDED |
| 12 | 检查器永久钉在 product:check 架构路径 | 机器：`script/check-product-boundaries.sh` 调用上述 checker | 脚本含调用；product:check 路径会跑到 |
| 13 | 协议 schema 未改；棘轮不抬；collector 预存红线不当新回归 | 机器：`git diff -- packages/runtime/src/protocol.ts` 空；`node script/check-file-size-limit.cjs`；`pnpm product:build:clicky` | 无协议 diff；CompanionManager ≤4609；collector 880/856 预存；build 退出 0 |

## 非目标

- 全双工 / 免按键麦克风
- 持久 Task/Run、崩溃恢复
- IM、AgentIdentity、统一记忆/执行上下文
- 改协议 schema、模型路由、电脑动作语义、视觉重做

## 基线与结果

- 动手前（`a244c84`，生产代码未改）：`node script/check-clicky-foreground-lifecycle-boundary.cjs` → `foreground_execution_ownership_violations: 7`，退出 1。
  - Issue #29 写的是 6：1 `startTurn` + 2 `cancelTurn` + 1 `interruptTurn` + 1 `steerTurn` + 1 `activeRuntimeRequestId`。
  - 实测多 1 处：`respondThroughYishuRuntime` 的 `onCancel`（约 L3138）也直接 `cancelTurn`。这是「呈现/任务取消隐式取消 Runtime」的耦合点，不能从度量里拿掉。
  - 7 处：L333 identity；L1869 interruptTurn；L1943 steerTurn；L2008 cancelTurn；L2904 startTurn；L3138 cancelTurn；L3935 cancelTurn。
- 目标：0。
- 交付：`node script/check-clicky-foreground-lifecycle-boundary.cjs` → `foreground_execution_ownership_violations: 0`，退出 0。CompanionManager 4442/4609。表征测 + barge-in + computer-action + leanring_buddyTests TEST SUCCEEDED。`pnpm product:build:clicky` 退出 0。协议无 diff。collector 880/856 预存红线未动。

## 人评清单（交付时填）

- [ ] 无用户可见行为改动（本轮不装真机）
