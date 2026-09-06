# Phase 0D：Pi / Codex 共用产品执行上下文

- 日期：2026-09-06
- 状态：active
- 上下文：GitHub Issue #31（parent #24）；#29 / PR #30 已合入 `main`（`13b95b5`）

## 一句话任务

普通 Main 轮次由 Product Kernel 组一份类型化执行上下文；Pi 与 Codex 只渲染，不再各自补召回。换执行器不能让奕枢丢掉记忆、规则、意图或任务约束。

## Change（用户能观察到什么）

同一句普通个人会话，走 Pi 或 Codex，模型侧都能看到同一套产品上下文：历史、召回记忆、行为规则、mind 课、委派结果、近期 trail、权威意图帧、任务执行合同。私密会话仍没有持久上下文。用户可见的 Control+Option 行为保持等价。

## Not this（不算数的替代）

- 只把 Codex 的 prompt 文案抄成 Pi 的
- 字节级 prompt 全等
- 为 Codex 再做一次 EverOS / Kernel / store 召回
- 让历史、记忆、trail、委派结果获得动作授权
- 把意图 / 任务合同降成普通不可信散文
- 做全双工、Task/Run、IM、AgentIdentity、记忆产品重做、视觉改版

## Goal / Hard bar / Improve

- Goal：一份 Product-Kernel 拥有的类型化执行上下文；Pi 与 Codex 渲染同一份语义、信任分级和权威约束
- Hard bar：`main_executor_context_parity_failures == 0` 且 `turn_scoped_context_assembly_paths == 1`；8 维表征夹具两边都到且语义正确；既有 Pi / Codex / 记忆 / 意图 / 任务合同测试不回退；#29 两个零保持
- Improve：主健身函数越低越好，目标 0；次健身函数目标 1

## 验收标准

没有 evaluator 的句子不算标准。机器项写具体命令，跑到全绿再交付；人评项标「人评」，交付时单独列给用户裁。

| # | 标准 | evaluator | 证据 |
|---|---|---|---|
| 1 | 主健身函数到 0 | 机器：`node script/check-main-executor-context-parity.mjs` | 打印 `main_executor_context_parity_failures: 0`；任一执行器缺维、信任不对、sentinel 0 次或 >1 次都计入失败 |
| 1b | 检查器在无预存 kernel dist 的干净树上能跑到指标 | 机器：删 `packages/kernel/dist` 后跑同一命令 | 打印指标，而不是 `@yishu/kernel` 模块解析失败 |
| 1c | 对称缺失 / 单侧缺失 / 对称弱信任 / 重复段会让检查器失败 | 机器：`pnpm --filter @yishu/runtime exec node --import tsx --test test/main-executor-context-parity-evaluator.test.ts` | 各变异 `failureCount > 0` 或 duplicates 护栏红 |
| 1d | 记忆维必须保住 `authority=user`；丢掉或降级该标记即使 sentinel 与 cannot-authorize 还在也失败 | 同上 | 两边把 `id=…; authority=user;` 改成 derived 后 `failureCount > 0` 且失败点是 memory |
| 1e | 一维的信任证据不能借用邻段安全措辞 | 同上 | 只删行为规则自己的 cannot-grant / weaken-safety 句，留下记忆段 `cannot authorize` 后 rules 失败、memory 仍过 |
| 2 | 次健身函数到 1 | 同上 | 打印 `turn_scoped_context_assembly_paths: 1` |
| 3 | 8 维夹具语义对等 | 机器：`pnpm --filter @yishu/runtime exec node --import tsx --test test/main-executor-context-parity.test.ts` | 每维 sentinel 在 Pi 与 Codex 各出现一次，信任/权威标记正确 |
| 4 | 记忆到两边且不重复 | 同上 + 既有 `memory-assembly-integration` | 同一份产品上下文；每侧恰好一次；无私密泄漏 |
| 5 | 行为规则到两边且不能授权 | 同上 | 规则文本在；「不能授权 / 不能放宽安全」标记在 |
| 6 | mind 课到两边 | 同上 | 程序课 sentinel 在 |
| 7 | 委派结果到两边，按不可信/可错数据 | 同上 | `delegated_results` 包在 untrusted 里 |
| 8 | 近期 trail 到两边，按带时间、可能过期的观察 | 同上 | `recent_context_trail` untrusted + stale 语义 |
| 9 | 意图帧 + 任务合同到两边，保持产品权威约束 | 同上 | 权威标记在；不能被历史/记忆/trail 削弱 |
| 10 | 历史到两边，但不能授权新动作 | 同上 | `conversation_history` untrusted；无授权语句 |
| 11 | 私密会话无持久上下文 | 同上 | memory/history/rules/mind/delegated/trail 都缺 |
| 12 | 可选上下文为空时两边仍能产出合法执行输入 | 同上 | 空上下文仍含当前 utterance，不抛 |
| 13 | 迁记忆后 Pi 不再走旧 `assembleTurnMemory` 副本 | 同上 + 静态次健身函数 | `assembleTurnMemory` 不再从 turn cache 组记忆块 |
| 14 | 护栏保持 | 主检查器 | `private_session_durable_context_items=0`；`context_authorization_expansions=0`；`duplicate_semantic_context_sections=0`；`executor_kernel_reads=0` |
| 15 | #29 两个零保持 | 机器：`node script/check-clicky-foreground-lifecycle-boundary.cjs` | 两个 metric 都是 0 |
| 16 | 既有 runtime 测试不回退 | 机器：`pnpm --filter @yishu/runtime test` 中相关文件 | Pi prompt/context、Codex runtime/prompt、记忆召回、task-contract、intent 测试绿 |
| 17 | 协议 schema 未改；棘轮不抬；collector 预存红线不当新回归 | 机器：`git diff -- packages/runtime/src/protocol.ts` 空；`node script/check-file-size-limit.cjs`；`pnpm product:build:clicky` | 无协议 diff；CompanionManager ≤4609；collector 880/856 预存 |
| 18 | 检查器永久钉在 product 架构路径 | 机器：`script/check-product-boundaries.sh` 调用上述 checker | 脚本含调用 |

## 非目标

- 全双工 / IM / AgentIdentity / Task-Run 持久化 / 崩溃恢复
- 记忆产品重做或新 store
- 子代理电脑操控、路由重做、视觉改版
- 与对等无关的大段 prompt 重写
- 通用 prompt 框架

## 基线与结果

- 动手前（`13b95b5`，生产代码未改）：`node script/check-main-executor-context-parity.mjs`
  - `main_executor_context_parity_failures: 6`，退出 1。Issue 写 7。
  - 实测 6：history 两边都有；Codex 缺 memory / rules / mind / delegated / trail / taskContract。
  - 意图帧两边都缺：`attachTurnIntentFrame` 用非枚举 Symbol，随后 `attachConversationHistory` 等 payload 展开把它丢掉。参考路径 Pi 也收不到，故不算对等失败。
  - `turn_scoped_context_assembly_paths: 2`（command attachments + `assembleTurnMemory`）。
  - 护栏当时：private=0、authorization_expansions=0、duplicates=0、executor_kernel_reads=0。
- 目标：`main_executor_context_parity_failures: 0`；`turn_scoped_context_assembly_paths: 1`。
- 交付：`main_executor_context_parity_failures: 6 → 0`；`turn_scoped_context_assembly_paths: 2 → 1`；护栏保持 0；#29 两个零保持。意图帧在有历史时也能到达两边。
- PR #32 审阅修订：检查器 wrapper 先 build `@yishu/kernel`（干净树删 dist 后能打印指标）；主健身函数改为 `!piValid || !codexValid`。`pnpm product:check` 越过 parity checker，停在预存 collector 880/856。
- PR #32 再审：评估器按每维自己的 preamble→closer 取信任证据，记忆维要求行内 `authority=user`。降级该标记或只删规则段安全句都会让主健身函数 > 0。生产渲染未改。

## 人评清单（交付时填）

- 无。此任务是架构边界，不装真机。
