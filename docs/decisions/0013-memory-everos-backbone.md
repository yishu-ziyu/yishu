# ADR 0013: 记忆系统采用 EverOS 架构骨干

Type: decision
Status: current (homemade implementation superseded by [0017](0017-memory-uses-everos.md); invariants remain)
Verified: 34c0eaa 2026-08-15
Review: 记忆层存储骨干、提取管线或检索分层变化时（只能由新 ADR supersede）

## Status

Accepted 2026-08-15

## Context

记忆系统现状缺口（[审计](../research/yishu-memory-current-state.md)、[对判](../research/everos-memory-reference.md)）：写入仅显式动作、无 episodic 叙事层、`supersedes` 无自动决策、检索 token-only、用户不可直读自己的记忆。

对 EverOS（EverMind-AI/EverOS，Apache-2.0，commit e5118c5）九维度对判结论：数据模型认知分型、冲突处理完整性、自动提取、Markdown 可审计真相层、离线 Reflection、tiered 检索均优；奕枢仅在秘密隔离与 scope 隔离上保留。此前把 ADR 0006 的证据四元组强制套用于所有记忆条目、以及"数据加工必须经 Kernel typed action"的解释，被判定为教条（前者是类别错误——confidence 属于 ContextFrame 类观测；后者把 ADR 0011 越界延伸到非 Agent 循环的后台数据加工）。

## Decision

1. **记忆层采用 Markdown 为真相层**。episodes（episodic 叙事，append-only）、facts（semantic 单句事实）、profile（semantic 派生单文件，可覆盖可重建）、skills（procedural，自 `VerifiedSkill` 演进）存于 `~/Library/Application Support/Yishu/Memory/<scope>/`（personal / project/<uuid> 分目录；private 无目录）。Markdown 可读、可改、可 diff、可 git；索引与派生物全部可重建。
2. **SQLite 保留为**：会话账本（Conversation/Turn/Event）、TaskTruth、cascade 队列、索引元数据与 Mind。本条收窄 ADR 0007 的适用范围，不推翻其账本/任务部分。
3. **自动提取**：普通对话 turn 终态触发后台提取（LLM 经现有 worker 代理，密钥不进 runtime）；产物一律 `candidate`，经敏感 fail-closed 与 scope 校验后 `active`。private scope 在触发点前拒绝（沿用 `assertDurableSessionScope`）。
4. **冲突与覆盖**：事实层冲突用 `supersedes`（同 EverOS `deprecated_by`：检索自动过滤非 active，md 侧留痕，可回滚）；profile 允许整文件覆盖（证据 episodes 恒 append-only）。
5. **异步索引（cascade 模式）**：SQLite 队列表（单调 LSN、有限重试、死信）；md 写成功即返回（强一致），索引最终一致。
6. **检索 tier 渐进**：keyword-only → +向量 → +rerank；embedding/rerank 经 worker 代理，能力缺失时降级运行而非报错。
7. **Reflection**：episode 簇合并为进程内后台数据加工（分区锁、单簇失败不阻断、审计记录），产物 `candidate`。它不是第二个 Agent 运行时；ADR 0011 约束的是 model-tool 执行循环。
8. **保留奕枢不变量**：秘密隔离（不采用明文密钥配置）、private 会话双侧拒绝、账本 ledger-safety fail-closed、桌面动作 verified receipt（本 ADR 不触及）。
9. **修正解释**：记忆条目必填 `source / capturedAt / status`；`confidence` 为可选字段，仅在可真实计算处使用（如 skill 聚类 score），不作为入库门槛。

## Alternatives considered

- 管线照搬但 SQLite-only。拒绝：用户不可直读直编自己的记忆，可审计性缺失。
- 最小步只借提取与 Reflection。拒绝：存储骨干反复改造，一次性定构成本更低。
- 维持显式-only 现状。拒绝：陪伴产品的记忆无法自然生长。

## Consequences

- kernel 新增 markdown 存储模块（原子写 + per-path 锁 + CWE-22 三层防御：scope id 即路径段，须 sanitize）与 cascade 队列表；现有 `MemoryClaim` 数据迁移至 facts/episodes 对应层。
- "入库四问"的失效发现由 markdown diff + `Verified` 行 + git 能力回答。
- 评估以 5 条 smoke fixtures（基础回忆/多会话/冲突更新/scope 隔离/private 拒写）随管线首发，随真实使用生长；不作为上线前置门槛。
- 实施顺序与书义对齐清单见 [agent-book-product-alignment.md](../research/agent-book-product-alignment.md)（2026-08-15 修订版）。
