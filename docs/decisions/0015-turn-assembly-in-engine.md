# ADR 0015: 上下文装配下沉引擎（B 架构）与 P1 记忆实施决定

Type: decision
Status: current
Verified: 34c0eaa 2026-08-15
Review: 装配分层、记忆写入触发或会话刷新策略变化时（只能由新 ADR supersede）

## Status

Accepted 2026-08-15

## Context

ADR 0014 内化 model-tool 循环后，记忆/Skills/状态栏的 prompt 组装存在两个候选层：产品层每轮一次性装配（方案 A），或引擎经 provider 端口在循环内装配（方案 B）。产品决策要求选择 B：引擎成为"懂产品上下文概念的执行器"，获得循环中途刷新能力（工具批后更新状态栏、按需重查记忆），对齐 EverOS"记忆运行时即产品"的形态。

## Decision

1. **B 架构**：`model-loop` 定义 `TurnContextProviders` 端口（`skillCatalog` / `assembleTurnMemory` / `statusBar`），引擎在三个时机调用：会话创建时把 Skills L1 目录并入 system 稳定前缀；每轮首条模型调用前经 `assembleTurnMemory` 取记忆块并入首条 user 消息；每个工具批完成后经 `statusBar` 取状态栏文本，作为**瞬态尾随消息**注入下一次模型调用（不持久化进历史，书义"末尾状态栏"的正确实现）。
2. **端口在引擎、实现在产品**：`model-loop` 不 import `@yishu/kernel`；loop-adapter 暴露 `setTurnContextProviderFactory`（同 `setSessionToolPolicy` 的 additive seam），ProductKernelRuntime 用 kernel 实现工厂并注入。测试面用 fake provider，引擎通用性以端口为界。
3. **P1 读写并行**：写入侧（Markdown 真相层 + turn 终态提取）与读取侧（装配升级 + Skills L1）同属 P1 批次，按两个连续 PR 交付。
4. **skill 晋升 → 会话失效**：session cache key 增加 skills 版本段；`remember_how` 晋升动作后由 PKR 调 `invalidateSkillSessions()`，下轮冷启动携带新 L1 目录（同 providerAuthGenerations 模式）。
5. **提取异步队列**（写入侧，本 ADR 一并定案）：turn 终态入 SQLite 队列，提取 worker 异步消费（cascade 模式），turn 返回不等提取，崩溃可重放。
6. 命令派生装配（ContextFrame/trail/冷启动历史）仍留在 adapter 的 grounded prompt——它依赖 turn 命令载荷，与依赖 kernel 状态的召回正交。

## Alternatives considered

- A 产品层装配。拒绝：长任务中途工具结果挤压记忆块时产品层无法干预；prompt 已交出后丧失刷新能力。
- A+（A 加窄回调）。拒绝：回调本质是 B 的残缺形态，两套心智。
- 引擎直接 import kernel。拒绝：测试面与层次耦合不可逆；端口即可获得全部能力。

## Consequences

- `createYishuAgentSession` 签名扩展（`persona`、`context`）；引擎新增瞬态尾随消息机制（两个 wire builder 支持 `transientTail`，不落历史）。
- 记忆召回路径分两步迁移：本决定先落端口与 Skills/状态栏接线；写入侧 PR 之后，读取侧 PR-2 让 `assembleTurnMemory` 读取 PKR 的 per-turn 召回缓存（`memory.used` 仍由 PKR 发出），不再把记忆挂到命令上，避免双装配。
- 状态栏首版内容为引擎可观测事实（工具计数/最近工具/失败位），kernel 任务步骤投影后续增强。
- 书义原则保持：system 稳定前缀只在 skill 晋升时变化（会话失效兜底）；状态栏末尾注入且代码维护。
