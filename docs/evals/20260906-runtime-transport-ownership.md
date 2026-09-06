# Phase 0B：从 YishuAgentRuntimeClient 抽出 runtime stdio 传输所有权

- 日期：2026-09-06
- 状态：active
- 上下文：GitHub Issue #27（parent #24）；#25 / PR #26 已合入 `main`

## 一句话任务

把 Node sidecar 的 Process / 管道 / 换行分帧从 `YishuAgentRuntimeClient` 抽到独立传输所有者，协议与产品语义保持等价。

## Change（用户能观察到什么）

语音轮次、取消、插话、登录/历史/记忆/任务 RPC、电脑动作回执，与抽之前同一条路径。用户看不出这次是重构。

## Not this（不算数的替代）

- 只把方法挪走、Process 仍由 client 持有
- 包一层只转发的 wrapper
- 做成通用网络框架
- 改协议、插话、watchdog、鉴权、Task/Run、全双工

## Goal / Hard bar / Improve

- Goal：传输生命周期有唯一所有者；client 仍是协议/产品客户端
- Hard bar：Issue #27 的分帧/发送/启停/终止/stderr 测全绿；现有 turn/cancel/interrupt/steer/RPC 覆盖不回退；client 不再直接拥有 Process/FileHandle/stdout buffer
- Improve：无

## 验收标准

| # | 标准 | evaluator | 证据 |
|---|---|---|---|
| 1 | 半行+半行 → 恰好一行 | 机器：`xcodebuild test … -only-testing:leanring-buddyTests/YishuRuntimeStdoutFramerTests …` | `fragmentedChunksBecomeOneLineExactlyOnce` 绿 |
| 2 | 一块里两行 → A 然后 B 各一次 | 同上 | `batchedChunkDeliversLinesInOrderExactlyOnce` 绿 |
| 3 | 尾部半行留在缓冲直到补齐 | 同上 | `trailingPartialStaysBufferedUntilNewline` 绿 |
| 4 | send 恰好追加一个换行且不改 payload 字节 | 机器：`… YishuRuntimeStdinFramingTests` + `YishuRuntimeStdioTransportTests` | `frameAppendsExactlyOneNewlineWithoutMutatingPayload` 与 cat 回显绿 |
| 5 | running 时重复 start 不造第二个进程 | 机器：`… YishuRuntimeStdioTransportTests` | `repeatedStartWhileRunningKeepsOneProcess` 绿 |
| 6 | stop 清掉 handler/管道/进程，不留活传输 | 同上 | `stopClearsLiveTransportOwnership` 绿 |
| 7 | 终止回调到达 client 边界恰好一次 | 同上 | `terminationReachesBoundaryExactlyOnce` 绿 |
| 8 | stderr 被排空，不进协议/产品输出 | 同上 | `stderrIsDrainedAndNeverForwardedAsStdout` 绿 |
| 9 | 现有 turn/cancel/interrupt/steer/late-event 覆盖不回退 | 机器：`… -only-testing:leanring-buddyTests/YishuBargeInTests` | TEST SUCCEEDED |
| 10 | 现有进程死亡结束 pending RPC 覆盖不回退 | 机器：`… -only-testing:leanring-buddyTests/leanring_buddyTests` | TEST SUCCEEDED |
| 11 | client 不再直接拥有 Process/管道读循环 | 机器：`rg -n "Process\\?|FileHandle\\?|outputBuffer|readabilityHandler" apps/clicky/leanring-buddy/YishuAgentRuntimeClient.swift` | 无传输所有权命中 |
| 12 | 棘轮不抬；预存 collector 红线不当新回归 | 机器：`node script/check-file-size-limit.cjs`；`pnpm product:build:clicky` | CompanionManager 4446/4609；collector 880/856 预存；build 退出 0 |

## 非目标

- 全双工 / IM / Task-Run 重设计 / AgentIdentity / 统一执行上下文 / 记忆重设计
- 改协议 schema、模型路由、电脑动作语义

## 基线与结果

- 动手前：client 3900 行，同时拥有 Process/管道/stdout 缓冲与协议/产品语义。collector 880/856 预存红线。
- 交付：`YishuRuntimeStdioTransport` 拥有进程与分帧；client 3861 行，只消费行事件并编码命令。传输测 + barge-in + leanring_buddyTests TEST SUCCEEDED；`product:build:clicky` 退出 0。

## 人评清单（交付时填）

- [ ] 无用户可见行为改动（本轮不装真机）
