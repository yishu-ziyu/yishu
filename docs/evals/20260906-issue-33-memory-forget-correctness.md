# Phase 0：用户确认的忘记必须诚实、可重试、只有一个语义主人

- 日期：2026-09-06
- 状态：active
- 上下文：GitHub Issue #33；#31 / PR #32 已合入 `main`（`4a8ff1c`）

## 一句话任务

用户确认忘记一条记忆时，产品只能在适用权威层都清掉、且召回不再立刻吐出该目标之后，才说已经忘记；失败必须能按同一意图重试到完成。

## Change（用户能观察到什么）

对「记住」过的个人事实说忘记：成功后 `记忆.md` 里没有这条、可搜索索引里没有这条、适用的 legacy Truth 没有这条、派生召回不会立刻把刚删的事实送回来。可见层或 Truth 写入失败时，产品不得报已忘记、不得发 `memory.forgotten`。失败后同一条意图能重试到真正忘记。自然语言 forget 与记忆面板 forget 走同一套语义。

## Not this（不算数的替代）

- 只改一边路径（只修 action 或只修 ledger）
- 只看 store 的 `retiredAt` / 行不存在就报成功
- 吞掉 visible / Truth 错误后仍 verified
- 先硬删唯一 id→claim 出处，导致重试变成 `alreadyGone` 但可见层还在
- 模糊删掉用词相近的其它子弹
- 新记忆产品、向量库、通用事务框架
- 全双工 / IM / AgentIdentity / Task-Run / 子代理电脑操控

## Goal / Hard bar / Improve

- Goal：一份产品拥有的忘记语义边界；两条入口只委托它；部分失败可重试；成功验证看完整后置条件
- Hard bar：三个健身函数到目标；失败矩阵（可见/Truth/store 注入、重开、范围错配、幂等、相似事实、取消）绿；#29 两个零、#31 0/1 保持
- Improve：主健身函数越低越好，目标 0

## 验收标准

没有 evaluator 的句子不算标准。机器项写具体命令，跑到全绿再交付；人评项标「人评」，交付时单独列给用户裁。

| # | 标准 | evaluator | 证据 |
|---|---|---|---|
| 1 | 主健身函数到 0 | 机器：`node script/check-memory-forget-correctness.mjs` | 打印 `false_positive_memory_forget_successes: 0` |
| 2 | 部分失败重试可收敛 | 同上 | 打印 `non_convergent_memory_forget_retries: 0` |
| 3 | 只有一条生产忘记变异路径 | 同上 | 打印 `memory_forget_mutation_paths: 1` |
| 4 | 显式记住后忘记，三层与召回都干净 | 机器：`pnpm --filter @yishu/kernel exec node --import tsx --test test/memory-forget-correctness.test.ts` | 成功；可见/store/Truth 适用层缺目标；recall 不返回 |
| 5 | 可见层失败不得报成功；重试收敛；其它子弹还在 | 同上 | 无 verified / 无 `memory.forgotten`；修依赖后重试成功 |
| 6 | Truth 失败不得报成功；重试收敛 | 同上 | 真 Truth 支持的记忆；注入 `removeFact` 失败后无成功 |
| 7 | store 失败不得报成功；出处还在；重试收敛 | 同上 | 权威层已改、store 注入失败后无成功 |
| 8 | 部分失败后持久重开再重试能完成 | 同上（JSON 最小后端） | 重开后同一 id 收敛 |
| 9 | 范围错配 fail-closed，跨范围不删 | 同上 | 返回 null / failed；目标仍在 |
| 10 | 真正完成后的再忘记幂等 | 同上 | `alreadyGone`；不重建事实 |
| 11 | 相似可见事实不被误删 | 同上 | 忘掉一条，另一条仍在 |
| 12 | 取消不得把部分状态说成成功 | 同上 | 无 verified；若已部分变异则可重试 |
| 13 | 两个入口共用一个语义主人 | 同上 + 静态路径计数 | action 与 ledger 只委托同一函数 |
| 13a | 缺 store 行且无完成回执不得报成功 | 同上：legacy store-gone + visible residue 夹具，两条入口 | action 非 verified/ok；ledger 非 forgotten；可见残留仍在；其它子弹仍在。该夹具计入 `false_positive_memory_forget_successes` |
| 13b | 真正完成后的再忘记仍幂等 | 同上 + JSON 重开 | 有完成回执（无明文）；`alreadyGone` / verified |
| 13c | 入口不得独立决定 alreadyGone / verified | 反作弊：把 missing-id shortcut、ledger 旁路、store 缺失即 verified、Runtime store 缺失即 alreadyGone 喂给路径计数器 | 四种作弊源都使 `memory_forget_mutation_paths ≠ 1` |
| 13d | 完成回执写入失败不得毁掉重试 | 同上：注入 `forgetReceiptIO.write` 失败 + JSON 重开；源码顺序回执必须在 store 删除前 | 无 verified；出处仍在；恢复后重开重试完成；再忘记 `alreadyGone`；无明文。该夹具计入 `non_convergent_memory_forget_retries` |
| 14 | Runtime 显式 forget 失败不发 `memory.forgotten` | 机器：`pnpm --filter @yishu/runtime exec node --import tsx --test test/product-kernel-runtime.test.ts` 中相关用例 | 可见失败 → `memory.failed` |
| 15 | 既有 kernel 记忆/动作/store 测不回退 | 机器：`pnpm --filter @yishu/kernel test` | 全绿 |
| 16 | #29 / #31 保持 | 机器：lifecycle + parity checker | 0/0 与 0/1 |
| 17 | 协议未改；collector 棘轮不抬 | 机器：`git diff -- packages/runtime/src/protocol.ts`；`pnpm product:check` | 无协议 diff；停在预存 880/856 |
| 18 | 检查器钉在产品边界 | 机器：`script/check-product-boundaries.sh` 含调用 | 脚本含 checker |

## 非目标

- 全双工语音、新记忆排序/召回、EverOS 替换、新记忆 UI
- IM / AgentIdentity / Task-Run / 子代理电脑操控
- 通用分布式事务、与忘记正确性无关的 store 大重构

## 基线与结果

- 动手前（`4a8ff1c`，生产代码未改）实测：
  - `false_positive_memory_forget_successes: 2`（Issue 写 ≥1）。action 在 visible 失败、Truth 失败时仍 verified。
  - `non_convergent_memory_forget_retries: 1`（Issue 写 ≥1）。ledger 先硬删 store，visible 失败后重试 `alreadyGone`，可见层还在。
  - `memory_forget_mutation_paths: 2`（createForgetAction + MemoryLedger.forget）。
- 目标：0 / 0 / 1。
- 交付：`false_positive_memory_forget_successes: 2 → 0`；`non_convergent_memory_forget_retries: 1 → 0`；`memory_forget_mutation_paths: 2 → 1`。#29 0/0、#31 0/1 保持。协议无 diff。`pnpm product:check` 越过本检查器，停在预存 collector 880/856。
- PR #34 再审：缺 store 行 + 可见残留且无完成回执不得报成功；真正完成后的窄回执支持幂等。路径计数改为所有权（独立 alreadyGone/verified 也算额外路径）。目标仍 0/0/1。
- PR #34 再审 2：完成回执必须在硬删 store 之前写。回执写入失败要保持可重试，计入 `non_convergent_memory_forget_retries`。预写回执在 store 行仍在时不算成功。

## 人评清单（交付时填）

- 无。此任务是正确性边界，不装真机。
