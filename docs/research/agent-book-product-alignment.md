# 书义架构 × 奕枢产品路径：反思与能力对齐

Type: research
Status: historical
As-of: 2026-08-15

> 输入：《深入理解 AI Agent》（bojieli/ai-agent-book，桌面克隆教材）ch1/2/3/4/8/10 架构原则；本仓库产品源码现状（commit 34c0eaa）。
> 已有沉淀：[BOOK_PATTERNS.md](../agent-book/BOOK_PATTERNS.md)（ch1/2/4/10 可移植规则）、[ai-agent-book-memory.md](./ai-agent-book-memory.md)（ch3/8 记忆证据）、[CAPABILITY_MAP.md](../agent-book/CAPABILITY_MAP.md)（以 agent-core 实验室为主的章节对照）。
> 本文增量：**聚焦产品路径**（kernel/runtime/clicky，而非实验室）的反思与对齐优先级。实验室对照已由 CAPABILITY_MAP 覆盖，此处不重复。
>
> **修订 2026-08-15（同日）**：初版第四节"边界提醒"把 ADR 0006 证据四元组强制套用于记忆条目、要求整理必须经 Kernel typed action、评估严格前置——经与 EverOS 九维度对判后判定为教条，已重写。架构决策（记忆层 EverOS 全构）见 [ADR 0013](../decisions/0013-memory-everos-backbone.md)。

## 一、总反思：书讲通用工程，奕枢是特化——对齐不是补齐，而是迁移

书的公式：`Agent = LLM + 上下文 + 工具`，生产可靠时再包 `[约束 + 验证 + 纠正]`。

奕枢的产品判断：**从第一行代码就把"约束/验证/纠正"做成了强类型骨架**——Kernel authority/TaskTruth、verified receipt、fresh evidence、typed cancellation、"工具成功 ≠ 任务完成"不变量。这一点奕枢**超越书的通用建议**，是产品护城河，不需要"对齐"。

真正的错位在另一处：**书的核心能力大部分活在 `packages/agent-core` 实验室，产品路径只吸收了少数**。按 ADR 0011 这是刻意设计（成熟一项迁一项），但迁移进度与产品缺口之间出现了清晰的可计算差距：

| 书中架构能力 | 实验室（agent-core） | 产品路径（kernel/runtime/clicky） | 差距判定 |
|---|---|---|---|
| ReAct 核心循环 | ✅ loop/react.ts | ✅ Pi **SDK 进程内嵌引擎**（npm 库、会话产品自管、模型端点自控；ADR 0011） | 已对齐 |
| 约束/验证/纠正 | ✅ reviewer/trajectory/gate | ✅ TaskTruth/ActionReceipt/authority（更强） | 已对齐（产品更强） |
| 注入防护 | ✅ injection-guard | ✅ 已迁移（runtime untrusted-content） | **迁移范本**：证明"逐项迁移"可行 |
| 上下文压缩 | ✅ compress.ts（12k 折叠） | ⚠️ Pi 内部管理；产品只注入有界历史 | 部分对齐，可接受 |
| Skills 渐进披露（L1 目录常驻） | ✅ context/skills.ts | ❌ 产品 VerifiedSkill 无 prompt 注入路径（仅 run_skill 显式触发） | **缺口 P2** |
| 状态栏（末尾注入 TODO/工具计数，代码维护） | ✅ context/status-bar.ts | ❌ 产品 prompt 组装无 TODO/步骤投影 | 缺口 P3 |
| 用户记忆分层（episodic/semantic/procedural） | ✅ 四层 MemoryCard（文件级） | ⚠️ semantic（MemoryClaim）+ procedural（Skill）有雏形；**episodic 无叙事化/检索**；写入仅显式动作 | **缺口 P1（最大）** |
| 记忆冲突 ADD/UPDATE/DELETE/NOOP | ❌ 实验室也没有 | ❌ supersedes 字段在、决策逻辑无 | 缺口 P1 |
| 轨迹→学习信号→候选→门控晋升 | ✅ evolution 全管线 | ⚠️ 产品有 mind suggestion（≥2 证据）但普通 Pi turn 不产学习信号 | 缺口 P2 |
| 评估（黄金任务+Judge+统计） | ✅ eval/judge/stats | ❌ 产品无记忆/能力评估集 | **缺口 P0（前置）** |
| 事件触发类工具（timer/monitor） | ✅ events/bus | ✅ ContextWatch + 时间提醒（窄而验证充分） | 已对齐（窄） |
| 多 Agent（Manager/Peer/Staged） | ✅ multi/* | ⚠️ delegate（ADR 0009，只注册不执行） | 部分对齐，符合书"先别上多 Agent"的判据 |
| 记忆 UI 控制面 | — | ⚠️ list/forget/history 已有；来源查看/冲突解释/导出无 | 缺口 P3 |

## 二、逐项反思（产品视角）

### 1. 已对齐且无需动的

- **执行骨架**：书的"生产公式"在奕枢是 Kernel 契约（`TaskExecutionContract` maxAttempts=1、`ActionReceipt.verified` 仅由 read-back 产生、`cancelled_after_commit` 诚实语义）。书的 Proposer-Reviewer 分离对应产品"runtime 报 observation、kernel 决定持久 status"。**不要为了"更像书"而弱化这些**。
- **证据化上下文**：书 ch2 的 context 是消息列表 + 状态栏；奕枢 ContextFrame 是带 source/capturedAt/confidence/expiry 的证据（ADR 0006）。这是产品超出书的部分。

### 2. 最大缺口：记忆写入管线（书 ch3 三性质无处落地）

书的要求：记忆是**选择性、抽象化、结构化**的提取，不是逐字搬运；普通对话结束后由后台提取候选。

产品现状（[yishu-memory-current-state.md](./yishu-memory-current-state.md) 审计 + 当前代码）：
- 写入只有显式动作（`remember` / `remember_how` / `record_learning`），普通 Pi turn 结束后**没有**任何候选提取；
- 读取已有最小概览（`recallRelevantMemories` ≤3 条 + mind lessons ≤3 条），但**没有 detail 层按需检索**；
- `supersedes` 可写但无 reconcile 决策；两条矛盾 claim 可同时 active。

结论：书的"两层记忆（概览+细节）"在产品只做了概览的雏形。**这是对齐的第一优先级**，且方案已在 [yishu-memory-system.md](./yishu-memory-system.md) P2 冻结，EverOS 的工程模式（见 [everos-memory-reference.md](./everos-memory-reference.md)）可补具体实现细节。

### 3. 第二缺口：评估先行（书 ch3/ch8 的方法论）

书在记忆（L1 基础回忆 / L2 多会话检索 / L3 主动服务）和经验学习（outcome/process/quality 三层 + transfer/retention/negative-transfer）上都要求**先有评估集再谈能力**。实验室有完整评估设施（黄金 7 用例、heuristic/llm judge、Wilson/bootstrap），产品一件都没接。

反思：yishu-memory-system.md P0（冻结记忆契约与评估集）在 P1 底座完成后被跳过了。**在实现提取管线之前应先补 P0 的评估 fixtures**，否则"记忆变好"无法证明——这正是书的纪律，也是实验室已验证的方法论。

### 4. 第三缺口：Skills 渐进披露未进产品 prompt

书 ch2：Skill 元数据（name+description）启动时常驻，正文按需加载——`description 是路由条件，不是功能广告`。

产品现状：`VerifiedSkill` 存在、`run_skill` 可显式触发，但 Pi 的 system/context prompt **不含已验证 skill 目录**，模型无法自主路由到技能。这是低成本高收益的对齐项：在 `context-prompt.ts` 组装时注入 skill L1 目录（name+description，带 Use when/Don't use when），命中时经 typed action 加载全文。

### 5. 第四缺口：状态栏

书 ch2 状态栏（末尾注入、代码维护、含 TODO/当前步骤/工具重复计数）解决"局部迷失"。产品的多步执行（委托任务、桌面动作链）已有 TaskTruth 进度，但没有投影为下一 turn 的状态上下文。委托任务已注入 `delegated_results` 块——同模式可扩展为通用状态栏（当前任务/步骤/上次工具结果计数），由代码维护而非 LLM。

### 6. 明确不对齐的（书说了，奕枢刻意不做或推迟）

- **模型后训练**（ch7）：奕枢不训练底座，永远不对齐。
- **通用多 Agent 编排**：书自己的判据是"协作是否引入单 Agent 拿不到的新信息"；奕枢当前委托架构（child 无 computer_control/delegate，结构性防递归）已满足窄场景，通用 Manager/Peer 编排暂无产品必要。
- **向量 RAG 全家桶**：书的立场是"按层渐进"（Simple Notes → … → 两层检索）；奕枢当前 token 召回 + 3 条上限是 L1 水平，先补评估与提取管线，embedding 检索在 episodic 层有数据后再上（见 EverOS 参考文档的升级路径）。

## 三、对齐优先级（建议，2026-08-15 修订版）

按 ADR 0013（EverOS 全构）落为可执行清单；记忆相关项的架构骨架由 ADR 定义，此处只排顺序：

| 优先级 | 对齐项 | 落点 | 依赖 |
|---|---|---|---|
| P1 | 记忆层 Markdown 真相模块 + cascade 队列表（骨架先立，见 ADR 0013 第 1/2/5 条） | kernel 新增 markdown 存储 + SQLite 队列；`MemoryClaim` 迁移 facts/episodes | 无 |
| P1 | turn 终态自动提取：episode 叙事投影 + facts candidate → 敏感 fail-closed → active | runtime turn 终态触发；LLM 经 worker 代理 | 上行 |
| P1 | smoke 评估 5 条（基础回忆/多会话/冲突更新/scope 隔离/private 拒写）随管线首发，随使用生长 | `packages/kernel/test/` | 与提取同 PR |
| P2 | skills L1 目录注入产品 prompt（name+description，Use when/Don't use when） | `packages/runtime/src/context-prompt.ts` + kernel `listVerifiedSkills` | 无（可先行） |
| P2 | supersedes 自动化：reconcile 相似检索（先 token，后向量 tier）→ UPDATE 链 + 检索过滤非 active | kernel reconcile 模块 | P1 |
| P2 | profile 派生单文件 + episodic 按 scope 检索注入（概览+细节两层） | kernel + context-prompt | P1 |
| P3 | 状态栏块（当前任务/步骤/工具计数，代码维护） | context-prompt.ts | 无 |
| P3 | 记忆控制面补全：来源查看（claim → 源 turn）、冲突解释、导出；md 直编由 Markdown 真相层天然获得 | Clicky 面板 + kernel API | P1 |
| P4 | Reflection：episode 簇合并 → merged 叙事 candidate + supersedes 原始（分区锁/单簇失败不阻断/审计） | kernel 后台 worker（数据加工，非 Agent 运行时） | P1、P2 |
| P4 | 检索 tier 2/3：向量（经 worker 代理）+ 可选 rerank，cascade 异步索引 | kernel + worker | P2 |

## 四、真正的边界（2026-08-15 重写）

初版本节是"教条清单"，已废弃。对判后真正要守的只有三条，其余都是可以随借鉴改的：

1. **private scope 双侧拒绝**：提取触发点之前即拒绝（Swift 采集侧已拦 + kernel `assertDurableSessionScope`）。这是产品特性，与借鉴正交。
2. **秘密隔离**：密钥只存在 worker 与 Pi 凭据存储；不采 EverOS 明文 toml。这是真实工程差距，不是教条。
3. **账本 ledger-safety fail-closed**：敏感值不落盘的写入守卫保留。候选记忆从 `candidate` 到 `active` 必经此门。

明确放开的三条（原教条）：

- ~~记忆条目必填 confidence~~ → 必填 `source/capturedAt/status`；confidence 仅在可计算处（skill 聚类）使用（ADR 0013 第 9 条）。
- ~~整理/提取必须实现为 Kernel typed action~~ → 后台数据加工 worker 即可；ADR 0011 管的是 model-tool 执行循环，不管数据加工（ADR 0013 第 7 条）。
- ~~评估严格前置~~ → 5 条 smoke 随管线首发，随真实使用生长（ADR 0013 Consequences）。
