# 《AI Agent Book》Memory 系统证据报告

> 目的：用本机原始书稿与配套代码回答“记忆到底如何搭建”，并给出可映射到 Yishu 的系统模型。
>
> 证据标签：
> - **[书稿]**：`/Users/mahaoxuan/Desktop/AI产品经理/ai-agent-book/book-en/` 下的原始章节。
> - **[配套代码]**：同一仓库 `chapter3/` 下的实验实现；它是书中方案的可运行示例，不等于唯一生产架构。
> - **[推论]**：由上述证据推导出的 Yishu 映射或工程建议，不冒充书中原文。

## 结论先行：不是“全文 transcript 或摘要”二选一

原书不支持把问题简化成“只存逐字 transcript”或“只存摘要”二选一：它明确把两者放在不同层次。

1. **逐字/原始轨迹保留在证据层**：单次 Agent run 的 trajectory 是按时间追加、写入后不改不删的完整事件序列（用户消息、模型回复、工具结果）；它用于当前任务、审计、回溯和后续按需检索。[书稿：`chapter3.md:74-88`；`chapter8.md:80-92`]
2. **结构化长期记忆进入常驻概览层**：跨会话的 User Long-Term Memory 不是逐字记录，而是经过选择、抽象、结构化、合并和裁剪的稳定用户模型。[书稿：`chapter3.md:15-19,21-43,80-84`]
3. **原始细节不应默认塞入每次 context**：达到高级能力时，书稿给出的“两层记忆”是“小量 Advanced JSON Cards 常驻作为 overview + Contextual Retrieval 按需取原始会话细节”。[书稿：`chapter3.md:643-658`]
4. **是否长期保存全文由产品隐私/合规策略决定**：书稿给出了 trajectory/审计和按需 RAG 的架构角色，但没有规定所有产品必须永久保留逐字 transcript。配套实验保存 conversation history，然而新会话对话 Agent 只读结构化长期记忆，后台处理器才读取原始历史。[配套代码：`chapter3/user-memory/conversation_history.py:17-21,36-90`；`chapter3/user-memory/conversational_agent.py:154-194`]

因此，直接可用的决策是：**原始记录（可配置保留）与长期记忆分层；回答时默认使用概览，只有需要证据、时间、冲突或细节时才检索原文。** 这同时满足可审计性、隐私边界和 context 预算，不是把全部 transcript 当作“记忆”注入模型。

## 原始材料索引

| 材料 | 精确路径 | 本报告使用的主题 |
|---|---|---|
| 第 3 章原始书稿 | `/Users/mahaoxuan/Desktop/AI产品经理/ai-agent-book/book-en/chapter3.md` | User Memory、三套正交分类、Mem0/Memobase、压缩、隐私、两层检索 |
| 第 2 章原始书稿 | `/Users/mahaoxuan/Desktop/AI产品经理/ai-agent-book/book-en/chapter2.md` | 单任务 context/trajectory、Skills、注入防护、context compression 的边界 |
| 第 8 章原始书稿 | `/Users/mahaoxuan/Desktop/AI产品经理/ai-agent-book/book-en/chapter8.md` | 经验学习、评估、Proposer/Reviewer 边界、sleep learning、过期/回滚 |
| 用户记忆配套说明 | `/Users/mahaoxuan/Desktop/AI产品经理/ai-agent-book/chapter3/user-memory/README.md` | 对话 Agent 与后台处理器分离、四种 memory mode |
| 对话 Agent | `/Users/mahaoxuan/Desktop/AI产品经理/ai-agent-book/chapter3/user-memory/conversational_agent.py` | 只读记忆、当前 session 原文、跨 session 通过结构化记忆 |
| 后台处理器 | `/Users/mahaoxuan/Desktop/AI产品经理/ai-agent-book/chapter3/user-memory/background_memory_processor.py` | 批次/间隔触发、LLM 分析、add/update/delete |
| 存储与整理 | `/Users/mahaoxuan/Desktop/AI产品经理/ai-agent-book/chapter3/user-memory/memory_manager.py` | Notes/JSON Cards、原子保存、容量裁剪、确定性去重/冲突整理 |
| 原始会话历史 | `/Users/mahaoxuan/Desktop/AI产品经理/ai-agent-book/chapter3/user-memory/conversation_history.py` | JSON transcript、session 元数据、可选向量搜索 |
| 评测执行器 | `/Users/mahaoxuan/Desktop/AI产品经理/ai-agent-book/chapter3/user-memory/run_evaluation.py` | 后续 session 只给 memory state，不给旧 raw history；独立 judge |
| 评测说明 | `/Users/mahaoxuan/Desktop/AI产品经理/ai-agent-book/chapter3/user-memory-evaluation/README.md` | Level 1/2/3、60 case、precision/recall/reasoning/proactivity、幻觉 veto |
| 脱敏实验 | `/Users/mahaoxuan/Desktop/AI产品经理/ai-agent-book/chapter3/log-sanitization/README.md` | 本地规则/本地 LLM、secret/PII 类别与替换策略 |

仓库内 `docs/agent-book/BOOK_PATTERNS.md`、`docs/agent-book/CAPABILITY_MAP.md`、`docs/agent-book/research/EVOLUTION_LOOP.md` 是当前项目的二次整理（例如 `BOOK_PATTERNS.md:3-4` 明确说明其为 quick notes），不能当作原书原文；`packages/agent-core` 也是当前实现，不代表书中完整架构。

## 1. 记忆的三套正交分类：Where / How / What

书稿在 `chapter3.md:74-88,90-118,189-209` 明确把记忆设计拆成三个互相独立的维度。它们不是三种竞争方案，而是同一条记忆可以同时拥有的三个标签。

| 维度 | 书稿回答的问题 | 书稿类别 | 工程含义 | Yishu 映射（**推论**） |
|---|---|---|---|---|
| **Where** | 存在哪里/生命周期是什么 | `Trajectory`（当前 run 的完整追加日志）；`User Long-Term Memory`（跨 session 稳定信息）；`Business State`（任务阶段） | 决定可写性、作用域、保留时长和读取时机 | `TrajectoryLog`；用户级 `OverviewMemory`/`DetailIndex`；`TaskTruth`/任务状态 |
| **How** | 用什么表示和更新 | Simple Notes；Enhanced Notes；JSON Cards；Advanced JSON Cards | 决定结构、关联、部分更新、冲突消解和维护成本 | 低风险短事实可用 `MemoryClaim`/notes；关系/主体/时间关键事实用 typed card；高风险状态用可验证结构而非自由文本 |
| **What** | 保存什么内容 | Episodic（具体事件）；Semantic（从事件抽象的稳定事实）；Procedural（条件下的行为/流程） | 决定检索方式、是否可转成 Skill/规则、是否需要时间线 | `ActionReceipt`/事件证据；用户偏好/关系/约束；候选 `Skill`/`Mandate`（须经验证，不直接把原文变成能力） |

书稿还给出组合例子：semantic “偏好靠窗”可以放在 User Long-Term Memory 的 Simple Notes；procedural “先搜直飞再确认座位”可以放在 Advanced JSON Cards。[书稿：`chapter3.md:199-209`]

### 关键边界：Procedural Memory 不是自动生成可执行 Skill

书稿把 Procedural Memory 定义为行为模式/流程（`chapter3.md:193-197`），但第 8 章进一步要求：只有从多个轨迹中评估、比较、泛化、验证后，才可沉淀为经验知识、Prompt/Skill、程序或参数；原始轨迹和单次反思都不是正式能力。[书稿：`chapter8.md:3-11,63-92,239-249`]

所以在 Yishu 中，用户“习惯”可以作为 semantic/episodic memory；一个“要始终执行的授权规则”才有资格进入 `Mandate`，一个“系统如何做事的程序”才有资格进入 `Skill`。二者都要经过独立验证和版本化，不能因为 LLM 在聊天中说了一句就直接写入生产能力。[**推论**]

## 2. 书稿的完整生命周期：增量记录 + 定期整理

### 2.1 在线路径：先写证据，不直接改生产能力

第 8 章的基本原则是：在线 Agent 完成任务并追加不可变证据；后台流程在空闲或门槛满足时读取一批新经验，再合并、冲突处理、生成候选和回归验证。[书稿：`chapter8.md:297-307`]

第 3 章给出的 User-as-Code 版本也明确采用数据库式“两阶段”模式：每个 session 后 LLM 逐条提取事实写入 append-only fact log；周期性从完整 fact log 重建 typed user model，类似 write-ahead log + checkpoint。[书稿：`chapter3.md:120-125`]

可抽象为：

```text
当前任务
  -> append-only trajectory / receipt / raw evidence
  -> outcome + process + quality verification
  -> memory candidate（Proposer）
  -> compare with existing memory
  -> candidate overview/detail update
  -> independent review + regression/safety gate
  -> release current version / keep previous version for rollback
```

这意味着“记忆写入”至少需要区分：

- `append`：保存发生过什么，尽量不丢证据；
- `propose`：从证据抽取候选事实/事件/规则；
- `reconcile`：与已有事实比对，ADD/UPDATE/DELETE/NOOP 或保留版本；
- `review`：检查来源、权限、隐私、冲突和风险；
- `publish`：只有通过门槛的版本才能进入默认检索/常驻概览。

### 2.2 书中 Mem0：Extract–Compare–Decide

书稿对 Mem0 的说明是一个清晰的 Proposer 流程：会话段结束后抽取候选记忆；向量检索相似旧记忆；LLM 逐条决定 `ADD`、`UPDATE`、`DELETE` 或 `NOOP`。[书稿：`chapter3.md:211-221`]

配套代码的 `MemoryUpdate` 也保留了同样的动作集合（`add/update/delete/none`），并记录 `memory_id`、内容、原因和 tags。[配套代码：`chapter3/user-memory/background_memory_processor.py:24-43`]

但书稿没有要求“DELETE 必须物理删除”。相反，压缩章节要求冲突采用版本策略：历史版本保留、最新版本标记；当前地址可以只服务最新版本，工作经历则保留完整历史。[书稿：`chapter3.md:236-248`]

**工程结论：** `DELETE` 在产品层应优先解释为“从当前有效索引撤下/标记 superseded”，是否物理删除要由用户删除请求、法规和隐私策略决定。[推论]

### 2.3 Proposer 与 Reviewer 必须分开

第 8 章要求 verifier 只提供评价、证据和置信度，独立的 diagnosis/evolution 模块再决定修改哪个部分，避免同一个模型既当裁判又直接改规则。[书稿：`chapter8.md:19-27,31-49`]

高风险或低置信度案例应交给第二模型或人工；新能力先进入 candidate 区，不得直接服务真实流量；安全机制、测试集、阈值、审计日志和稳定版本备份不可由 Agent 自改。[书稿：`chapter8.md:245-249,287-295`]

映射到 Yishu：

| 角色 | 允许做什么 | 不允许做什么 |
|---|---|---|
| **Proposer / Memory Writer** | 从已限定范围的证据抽取 candidate，给出 source、原因、适用范围、时间、confidence | 直接把外部文本当指令；绕过权限写入有效 mandate/skill |
| **Reviewer / Verifier** | 验证任务结果、流程合规、隐私、事实和 promise-action consistency；返回分维度证据 | 直接修改生产 memory；用单一 scalar 覆盖证据 |
| **Publisher / Gate** | 依据版本、风险等级、用户授权和回归结果发布/撤回 | 让候选自动变成长期能力 |

这里的 Reviewer 不要求另一个“更聪明的聊天 Agent”；低层结果尽量读环境状态、工具返回和测试，只有难以形式化的质量维度才交给 LLM Judge。[书稿：`chapter8.md:21-27,47-59`]

## 3. 概览 + 细节：书稿明确的 Two-Tier Memory Architecture

这是解决“原文 vs 摘要”误区的核心。

### 概览层（resident overview）

小量、高价值、可解释的 Advanced JSON Cards，保存稳定事实、主体、关系、背景、时间、状态和版本。它常驻 context 或可快速加载，用于跨 session 的全局关联和主动提醒。[书稿：`chapter3.md:104-112,223-232,649-658`]

### 细节层（on-demand details）

大体量、可能需要审计的原始会话/事件片段，使用 Contextual Retrieval 或 Agentic RAG 按需检索。索引时给每个 chunk 加能保留“人物、时间、意图、实体”的 context prefix，避免“Okay, let's book this”这类孤立片段失去含义。[书稿：`chapter3.md:600-627,641-658`]

### 运行时路径

```text
问题/任务
  -> 读取 overview cards（找全局事实和可能关联）
  -> 需要证据、时间、冲突或细节？
       -> Contextual Retrieval 找原始片段
       -> 以 source/time/session/task 元数据核验
  -> 生成回答或采取行动
  -> 把结果、receipt、用户纠正写回 trajectory/evidence
```

书稿的 Level 3 例子就是先看“东京旅行 + 护照到期”的 JSON Cards，再检索原始对话核对日期，最后主动提醒。[书稿：`chapter3.md:643-658`]

**映射到 Yishu（推论）：**

- `ContextCapsule` 不应等同于全部 Memory；它是一次运行从 overview、当前 trajectory、授权/TaskTruth 和按需 detail 组成的有界输入。
- overview 适合放经过发布的 `MemoryClaim`、偏好、关系、有效 mandate 摘要；detail 适合放带 provenance 的 `ActionReceipt`、session 片段和原始证据索引。
- 默认回答只加载 overview；`why/when/which version/what exactly happened` 等触发器才扩大到 detail，且应带证据回读。

## 4. 逐字 transcript、trajectory、conversation history 的准确关系

| 名称 | 书稿语义 | 是否写入 | 是否默认注入回答 context |
|---|---|---|---|
| **Trajectory** | 单次 run 的完整事件序列，append-only，不改写 | 是（至少作为可审计证据，保留时长可配置） | 当前任务窗口可取相关部分；跨 session 不应全部注入 |
| **Conversation history** | 用户/助手对话的可持久化实现形式；可被检索 | 配套代码保存为 JSON，每 turn 有 session/time/turn | 新 session 的 conversation Agent 不读取旧 raw turns，只读取结构化 memory；后台 processor 读取旧 history |
| **Long-term memory** | 跨 session 的稳定、抽象、结构化用户模型 | 是，经过 writer/reconciler 更新 | 作为概览/候选 detail，按 scope 与 relevance 取用 |
| **Context compression** | 当前单任务窗口内替换/摘要消息 | 只影响当前 trajectory 的 context 视图，不等于跨任务学习 | 是当前调用的 context 管理，不是持久 memory 的最终事实 |

书稿还专门警告：将一百条 trajectory 放进向量库可能改善命中，但不自动等于学习；学习需要评价、比较、泛化和验证。[书稿：`chapter8.md:3-11`]

配套实现的边界很具体：

- `conversation_history.py:17-21,36-90` 把每个 turn 以 `session_id/user_message/assistant_message/timestamp/turn_number` 持久化，并原子替换文件；可选 Dify 向量搜索。
- `conversational_agent.py:41-45,121-125` 初始化为 read-only memory；`_get_memory_context` 只把当前 session 原文加入对话，旧 session 只能通过结构化长期 memory 进入（`154-194`）。
- `background_memory_processor.py:45-49,78-98,364-474` 单独读取历史，按最近窗口/已处理 turn 过滤，交给分析 Agent 通过 memory tools 产生 add/update/delete。

这套代码直接支持“证据层 transcript + 概览层 memory”的组合；它不是要求在“全文”与“摘要”中择一。

## 5. 写入、检索、压缩、过期和冲突

### 5.1 选择性、抽象、结构化

书稿的初始抽取规则是三条：

- **选择性**：丢掉只对当前会话有用的瞬时信息（如一次搜索返回几项）；
- **抽象**：把“这次航班喜欢靠窗”提升为跨航班的稳定偏好；
- **结构化**：给偏好、限制、账户、事件等打类型，方便准确检索。[书稿：`chapter3.md:21-43`]

配套 `run_evaluation.py:110-124` 把这变成 prompt 约束：只选未来可能有用的事实，但保留 exact value、归属、事件状态、日期、provenance 和关系；更新时不得丢掉仍有效的旧事实。

### 5.2 检索

书稿承认 Simple Notes 的关键词/碎片检索适合 Level 1，但实体消歧、多片段关联和主动服务需要更丰富的结构或两层 RAG。[书稿：`chapter3.md:98-118,643-658`]

配套代码的默认检索是可审计的简单实现：Notes `search_memories` 做文本/tag 匹配（`memory_manager.py:260-267`）；会话历史可走 Dify vector search，否则文本匹配（`conversation_history.py:145-171,174-190`）。它展示接口边界，不代表生产系统必须用某个向量数据库。

### 5.3 压缩与整理是三个不同问题

不要把下面三者混为“压缩”：

1. **当前 context compression（Chapter 2）**：窗口超限或噪声过多时，在 API 调用之间摘要/替换工具结果；目标是当前任务 token/推理质量，保留静态前缀和关键决策/验证状态。[书稿：`chapter2.md:355-365,962-1001,1011-1015,1044-1079`]
2. **存储层 memory organization（Chapter 3）**：对跨 session 记忆做重要性筛选、聚类摘要、episodic→semantic/procedural 抽象，按信息类型使用历史版本或最新版本。[书稿：`chapter3.md:236-248`]
3. **跨任务 experience consolidation（Chapter 8）**：从已验证的多条轨迹产生行为经验/Skill/程序候选，经过回归、发布和回滚；不是一次对话摘要。[书稿：`chapter8.md:80-104,297-320`]

书稿给出的存储整理启发式包括访问频率、时间衰减、情绪强度、信息独特性；随后聚类、生成代表摘要、归档原文；冲突用版本保留并按字段选择“只取最新”或“保留历史”。[书稿：`chapter3.md:236-248`]

配套 `NotesMemoryManager.consolidate_memories` 则做了一个较窄、确定性的版本：规范化内容去重，按首个 tag 视为属性键，用 `updated_at` 选最新并报告 superseded；只有实际改变才保存。[配套代码：`memory_manager.py:269-361`]

### 5.4 过期、归档、删除

第 8 章的 sleep-learning cycle 明确包含 `Prune and index`：长期未使用或被新证据否定的能力标记为 expired、archived 或 deleted，同时保留 provenance 和 rollback 版本。[书稿：`chapter8.md:297-307`]

书稿没有给出统一 TTL，也没有说“越旧必删”。时间衰减只是重要性的一项；例如当前地址可服务最新版本，工作历史应保留完整历史。[书稿：`chapter3.md:240-246`]

因此 Yishu 应把 `expires_at`、`supersedes`、`status`（candidate/active/superseded/expired/archived/deleted）、`source_ids` 和 `version` 做成数据字段，而不是把过期逻辑藏在提示词里。[推论]

## 6. 评估：不是“能回忆一句”就算记忆工作

### 6.1 User Memory 三层验收

书稿定义八类能力（个人信息、偏好、切题、更新矛盾、多会话连续性、复杂推理、时间意识、冲突解决），又压成三层渐进能力。[书稿：`chapter3.md:45-70`]

| Level | 可观测验收 |
|---|---|
| **L1 Basic Recall** | 直接、明确的事实能准确写入和取回；包括标识符/日期等 exact value |
| **L2 Multi-Session Retrieval** | 跨人物、实体、会话和时间汇总全部相关信息；有歧义时澄清，不猜；能处理更新/冲突 |
| **L3 Proactive Service** | 跨很多 session 组合远处事实，主动发现风险/下一步，不等用户明确询问 |

Experiment 3-1 设计为每层 20 个 case；后续 session 只让 memory writer 看到上一轮 memory state + 新 session，不给旧 raw history；最后在全新 session 只凭 memory 回答，再由独立 LLM judge 评分。[书稿：`chapter3.md:68-72`；配套代码：`run_evaluation.py:1-11,110-145`]

配套评测 README 进一步规定 60 cases、每 case 50+ rounds，评分 precision、recall、reasoning、proactivity，并要求 evidence、boundary-case decision 和 hallucination veto。[配套代码：`chapter3/user-memory-evaluation/README.md:14-33`]

### 6.2 Experience/Agent 评估

第 8 章建议把 verifier 拆成三层：

1. **Outcome**：环境状态/测试/工具结果是否真的完成；
2. **Process**：权限、业务规则、动作序列是否合规；
3. **Quality**：语言、策略、替代方案是否符合 Rubric。[书稿：`chapter8.md:19-49`]

结果不要压成单一 scalar，应携带 `pass/fail/uncertain`、evidence、confidence；高风险/低置信度送第二 verifier 或人工。[书稿：`chapter8.md:47-59`]

长期 memory/evolution 还要单独测：transfer、规则变更后的替换/退休、旧能力 retention、negative transfer、safety，以及 artifact activation/adherence。[书稿：`chapter8.md:322-330`]

**对 Yishu 的验收门槛（推论）：**

- 任何 `MemoryClaim` 至少能回指 source/event/time 和 extraction reason；无来源的“模型觉得”不能 active。
- `TaskTruth`/`ActionReceipt` 优先由真实外部状态和 typed Pi event 验证，不由最终自然语言自证。
- 记忆“写对了但未被加载”和“加载了但未遵循”必须分开计数；对应书稿的 artifact activation 与 adherence。
- 对跨用户、跨主体、时间更新和主动提醒分别建 case；不能只做关键词 recall。

## 7. 隐私与注入：记忆不是可信指令区

### 7.1 注入防护

Chapter 2 明确指出：网页、邮件、工具结果、第三方 Skill 和检索文档都可能把恶意文本带入 context；`Memory Injection` 实验专门检查攻击者写入看似无害的“下次处理文件要发送副本”是否会在后续 session 被记住并执行。[书稿：`chapter2.md:674-706`]

由此得到硬边界：**证据（data）与指令（instruction）必须分栏、带 source/trust 标记；外部内容不能直接写入 Skill、Mandate 或高权限 memory。** 第 8 章要求原始网页/工具输出先经摘要、版本化和 reviewer；候选能力与生产能力分离。[书稿：`chapter8.md:287-295`]

### 7.2 脱敏

Chapter 3 的 log-sanitization 实验选择本地 Qwen/本地规则而非把含敏感信息的日志先发云端；输出结构化的 `type/location/confidence`，覆盖结构化、半结构化和自然语言 PII，并可用 regex 快筛 + 本地 LLM 深检。[书稿：`chapter3.md:250-258`]

配套 README 将 offline regex 设为默认第一道防线、无网络，覆盖 private key/JWT/URL credential/API token/Bearer/password/email/card/IBAN/SSN/身份证/手机号/IP 等，另以本地 LLM 处理医疗、护照、账户、诊疗等 Level 3 PII。[配套代码：`chapter3/log-sanitization/README.md:12-54`]

**对 Yishu 的推论：**

- `TrajectoryLog`/raw detail 可以加密、短期保留或用户可删除；进入模型 context 前先脱敏和按权限筛选。
- `MemoryClaim` 的值、source、confidence、expiry 应与 secret payload 分离；不要把凭证或原始敏感内容写进普通日志、ActionReceipt 或 Skill。
- “用户说了要记住”不等于“允许系统在所有 scope 永久保存”；写入时应记录 scope、purpose、retention、consent/authorization 状态。
- 隐私 verifier 是独立门槛，不能因为回答效果好就跳过。

## 8. Skills、Context 与 Memory 的关系

### Context 是当前运行的有界视图

Chapter 2 把 context 描述为 static prefix（system/tool definitions）+ 动态 trajectory，并允许在 API 调用之间摘要或替换后段。[书稿：`chapter2.md:355-365`]

`Working Memory` 是当前任务可用的动态子集；trajectory 是不可改写的完整事件序列。两者都服务当前决策，但前者经过 relevance filter，后者用于完整记录。[书稿：`chapter3.md:189-209,229-234`]

因此 Yishu 的 `ContextCapsule` 应是一次调用的受控投影，而非新的永久 memory 类型：

```text
ContextCapsule = current trajectory slice
               + verified TaskTruth / ActionReceipt
               + active mandate / permissions
               + resident overview claims
               + on-demand detail (only when justified)
```

### Skills 是可加载的程序性能力，不是普通事实表

Skills 采用 progressive disclosure：启动时仅注入 name/description，选中后加载 `SKILL.md`，再按需读取细节/代码/模板。[书稿：`chapter2.md:709-750`]

关系应这样理解：

- **Memory** 记录“用户/世界是什么样”“发生过什么”“在什么条件下的候选行为模式”；
- **Skill** 记录可复用的领域工作流/操作知识，拥有版本、测试和安装/加载边界；
- **Mandate**（Yishu 产品推论）是用户授权的长期规则，不应从未经审核的 Skill 或外部文本自动推导；
- **Trajectory** 记录运行实际发生了什么；其中可产生 candidate lesson，但不是直接可执行 Skill。

第 8 章的经验知识流程是“完整 trajectory + 环境结果 → 每 run 分析 → 跨 run 比较/归纳 → 具备证据的正式文档/Skill → transfer 验证”，并明确原始 trajectory 不适合作为正式知识单元。[书稿：`chapter8.md:80-104`]

## 9. 可直接采用的 Yishu Memory 系统模型（推论）

下面是把书稿语义映射到已有 Yishu 边界的最小模型；它不是声称原书规定这些类型名，而是方便项目落地。

```text
                         ┌──────────────────────────┐
                         │  User-visible Yishu      │
                         │  answer/action/receipt   │
                         └─────────────┬────────────┘
                                       │ uses
                      ┌────────────────▼────────────────┐
                      │ ContextCapsule (bounded view)  │
                      │ overview + current state +     │
                      │ permission + justified detail │
                      └───────┬───────────┬────────────┘
                              │           │ on demand
               ┌──────────────▼───┐   ┌───▼─────────────────┐
               │ Overview Memory  │   │ Detail Evidence     │
               │ MemoryClaim/card │   │ raw/session/receipt │
               │ current versions │   │ contextual index    │
               └──────────────┬───┘   └─────────┬───────────┘
                              │                 │ provenance
               ┌──────────────▼─────────────────▼─────────┐
               │ Writer/Reconciler + Reviewer + Gate       │
               │ candidate → verify → publish/rollback    │
               └──────────────┬────────────────────────────┘
                              │ append first
               ┌──────────────▼────────────────────────────┐
               │ Immutable Trajectory / ActionReceipt log  │
               │ user/session/task scope, time, source    │
               └───────────────────────────────────────────┘
```

建议每一条可发布的 overview/detail 索引至少具备：

```text
id, user_scope, subject/person, memory_type,
content_or_typed_value, source_ids, session/task ids,
created_at, observed_at, expires_at,
confidence, status, version, supersedes,
provenance, sensitivity, authorization_scope
```

这组字段分别承接书稿的主体/关系/时间（Advanced Cards）、来源与证据（Chapter 8）、版本/过期/回滚（Chapter 3/8）、作用域和隐私门槛（书稿的 User ID/PII 边界）。[推论]

### 一次写入的建议流程

1. **Capture**：把用户输入、Pi typed event、工具结果、ActionReceipt 追加到对应 scope 的 trajectory/evidence；外部文本标记为 untrusted data。
2. **Verify**：先验证 outcome/process/privacy/quality，记录分维度 evidence/confidence。
3. **Propose**：后台 writer 从最近 batch 提取 episodic/semantic/procedural candidate；不在主对话里直接写长期事实。
4. **Reconcile**：按 subject/key/time/source 查相似现有记忆，执行 ADD/UPDATE/DELETE/NOOP；冲突保留历史并标记 superseded，除非字段允许只服务最新值。
5. **Review/Gate**：独立 reviewer 或规则验证；高风险/低置信度需要第二模型/人工；候选与 active 分区。
6. **Publish**：更新 overview 索引和 detail 检索索引；保留旧版本可回滚。
7. **Prune**：依据时间、使用、唯一性、冲突和用户策略将内容标记 active/expired/archived/deleted，同时不破坏审计来源。

### 一次读取的建议流程

1. 先按 user/session/task/permission scope 读取小型 overview；
2. 做 deterministic checks（时间、状态、冲突、授权）后再决定是否需要 detail；
3. 对需要证据的陈述按 query + context prefix 检索原始片段；
4. 只把相关 detail 装入 `ContextCapsule`，并保留 source/time；
5. 产生外部动作后必须写 `ActionReceipt` 并回读真实状态；工具成功不等于任务完成。

## 10. 书本明确的边界与尚未规定的产品决定

### 书本明确支持的判断

- 记忆不是所有对话的 transcript；长期记忆是选择性、抽象、可复查的用户模型。[`chapter3.md:15-19`]
- 但原始 trajectory/证据应与结构化记忆分层保存，以便审计、验证、冲突和按需细节检索。[`chapter3.md:80-88`；`chapter8.md:80-92`]
- Where/How/What 三套分类正交；不可用“JSON 卡片”代替 memory 类型和生命周期设计。[`chapter3.md:199-209`]
- 写入应是增量 append evidence + 后台定期 consolidate；单次反思不等于学习。[`chapter3.md:120-125`；`chapter8.md:297-307`]
- Proposer、Reviewer、Publisher 的职责和候选/生产边界必须分开。[`chapter8.md:47-59,245-249,287-295`]
- Level 1/2/3 与 transfer/retention/negative-transfer/safety 是最低评估框架。[`chapter3.md:45-72`；`chapter8.md:322-330`]

### 书本没有替 Yishu 决定的事项

- 是否永久保存全文、保留多久、何时物理删除；书中给出可审计 trajectory 与按需 RAG，但没有统一 retention/consent 规则。
- 具体数据库、向量库、embedding、reranker 或索引服务；Mem0/Memobase 是对比案例，配套代码也同时提供 JSON、文本和可选 Dify 路径。
- 哪些用户事实属于 MemoryClaim、哪些属于 Mandate/TaskTruth/Skill；这是产品语义和权限边界，要以 Yishu 的唯一身份、用户授权和安全不变量落定。
- 面向用户的查看、纠正、删除和导出 UI；书稿强调可复查、版本和回滚，但没有规定 UI。

因此当前不应再把“是否保存 transcript”作为孤立的产品选择题。应先确定每个数据层的作用域和保留策略，再由隐私风险、证据需求和产品体验决定默认保存/脱敏/删除行为。

## 11. 当前项目实现的差距提示（只作边界，不当作书本证据）

配套 `user-memory` 已演示：对话/后台分离、四种表示、原子 JSON、简单整理和三层评测；它仍是教学/实验实现。例如 `NotesMemoryManager` 按数量保留最新 note（`memory_manager.py:180-190`），并没有书稿重要性评分、跨 run 证据门槛或完整的用户删除/同意策略；`ConversationHistory` 可选 Dify 搜索也不是书稿规定的唯一方案。

本仓库的 `docs/agent-book/` 与 `packages/agent-core` 是后续工程整理，当前 `packages/agent-core` 的四层 store 或 text search 不能倒推为原书的完整 memory architecture。集成 Yishu 时应保留书稿的语义分层、证据与审查门槛，再决定具体实现，而不是直接把配套 demo 当最终产品。

## 最终可执行判断

对 Yishu，记忆应被定义为一个带证据、作用域、版本、置信度和生命周期的系统，而不是一个“聊天摘要文件”：

```text
raw evidence/trajectory  = 发生过什么（可审计、可按策略保留）
overview memory          = 对未来有用的稳定事实/事件摘要（默认加载）
detail retrieval         = 需要时回到带上下文的原文证据
procedural/skill         = 经多次验证后才发布的做事方式
task truth/receipt       = 外部世界是否真的发生了变化
```

这正是书稿同时容纳 transcript、摘要、RAG、Skills、TaskTruth 和长期演化的原因：**它们是不同问题、不同层级、不同权限，不应挤在一个“Memory”名字下。**
