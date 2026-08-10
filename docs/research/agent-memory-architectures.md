# Agent 记忆架构调研

> 调研目的：为奕枢的持久记忆设计建立可解释的系统模型，而不是先让用户在“保存 transcript 还是保存摘要”之间做一个脱离上下文的技术选择。
>
> 证据范围：优先采用《深入理解 AI Agent》原书、论文和官方文档。外部系统的“产品行为”和“框架提供的能力”分开记录。检索日期：2026-08-08。

## 结论先行

“记忆”不是一个开关，也不是一个单一的数据库表。几种一手架构虽然命名不同，但都把下面几个问题分开：

1. **证据是否保留**：原始对话、工具事件、观察和结果能否追溯。
2. **当前线程如何继续**：本轮对话、暂停/恢复、任务检查点和上下文压缩。
3. **哪些事实跨会话有效**：用户偏好、稳定事实、关系和约束。
4. **哪些经历值得回忆**：过去发生过的事件、成功/失败案例和时间线。
5. **哪些行为可以复用**：经过验证的流程、技能和规则。
6. **模型此刻看到什么**：从上述数据中按任务、权限和预算投影出的工作上下文。

因此，第一版不应把“持久化记忆”定义成“是否保存逐字 transcript”。更准确的架构是：

```text
原始证据（可审计、只增不改）
        │
        ├── 线程/任务状态（可恢复）
        ├── 记忆提取与整理（候选 → 审核 → 版本化）
        │       ├── 语义记忆：稳定事实、偏好、约束
        │       ├── 情景记忆：事件、经历、时间线
        │       └── 程序记忆：技能、流程、行为规则
        │
        └── ContextCapsule（按当前任务、权限、时间和 token 预算投影）
```

“保存”与“让模型默认看到”必须是两个不同的策略；“更新”与“抹掉证据”也必须分开。真正需要产品定义的是记忆的边界、来源、有效期、冲突和用户控制，而不是某个向量库的选型。

## 一、书中的系统性描述

### 1. 记忆的三套正交分类

《深入理解 AI Agent》第 3 章先区分“放在哪里”“怎么存”“存什么”：

| 维度 | 书中的类别 | 对奕枢的含义 |
| --- | --- | --- |
| 记忆层次：放在哪里 | 轨迹（当前会话）、用户长期记忆（跨会话）、业务状态（任务阶段） | 不要把 `TaskTruth`、对话历史和用户画像混成一张记忆表 |
| 存储格式：怎么存 | Simple Notes、Enhanced Notes、JSON Cards、Advanced JSON Cards | 先按信息重要性选择粒度；关键关系需要结构化卡片 |
| 认知类型：存什么 | 情景（具体事件）、语义（一般事实）、程序（行为流程） | “上次订了东京航班”、 “偏好靠窗”、 “订票步骤”是三类不同对象 |

书中明确指出，三套分类是正交维度：一条“偏好靠窗”的语义记忆可以存成简单笔记，也可以放在结构化卡片中；一段订票流程是程序记忆，但不等于某次订票的事件记录。[原书第 3 章：用户记忆和知识库](https://github.com/bojieli/ai-agent-book/blob/main/book/chapter3.md#用户记忆和知识库)

### 2. 书给出的写入模型：选择性提取，而非逐字搬运

书的用户记忆流程是：对话结束后，用额外的 LLM 调用分析会话，提取对未来有用的信息，抽象为跨场景事实，并用结构化格式保存。它刻意排除“搜索返回了 3 个选项”一类只对当前会话有意义的临时信息。书把这三个性质称为：

- **选择性**：只保留未来可能有用的事实；
- **抽象化**：把一次性表达提炼成可复用的偏好/约束；
- **结构化**：让后续更新、检索和消歧可执行。

这不是说原始对话不应保留。书后面的知识治理部分反而要求把原始对话、轨迹和文档作为**原始证据层**，把可持续修订的摘要/知识作为**知识层**，把检索索引作为**服务层**；知识更新需要能回答“从哪条证据而来、谁在什么时候批准”。所以“证据留存”和“记忆生效”是两条不同管线。[原书关于证据层、知识层与服务层](https://github.com/bojieli/ai-agent-book/blob/main/book/chapter3.md#知识库的更新与维护)

### 3. 书给出的记忆层级

书把轨迹描述为一次运行的完整、按时间追加的事件序列；它用于当前决策、追溯和审计。用户长期记忆则是跨会话、跨实例、可以反复改写/合并/淘汰的稳定信息。业务状态表示任务阶段，例如“需要澄清”“处理中”“等待付款”“完成”。这三者用途不同，不能用“一个摘要”替代。[原书的轨迹、长期记忆与业务状态](https://github.com/bojieli/ai-agent-book/blob/main/book/chapter3.md#记忆的层次结构)

书还把 Advanced JSON Cards 推进到带有 `backstory`、主体 `person`、关系 `relationship` 和时间戳的结构。这是对奕枢很重要的提醒：裸字符串“张医生”不足以决定她是用户自己的医生、父母的医生，还是过去某个任务中的联系人；**来源、对象、关系和时间是记忆内容的一部分**。[原书的四种存储格式](https://github.com/bojieli/ai-agent-book/blob/main/book/chapter3.md#用户记忆的四种存储格式)

### 4. 书给出的双层记忆与检索

书对最高级的“主动服务”给出双层方案：

- 少量关键事实用结构化卡片作为概览，帮助 Agent 发现跨会话关联；
- 大量原始对话用上下文感知检索按需取回细节，避免仅靠摘要推断。

上下文感知检索在索引期给每个 chunk 补充“来自哪份文档/哪个对象/哪个时间”的前缀，从而同时改善关键词和向量检索。书也明确展示了仅按对话块检索的缺陷：面对同一指令的多次修改，孤立块可能同时召回互相矛盾的结果，不能简单选择“最新一条”。[原书的双层记忆结构](https://github.com/bojieli/ai-agent-book/blob/main/book/chapter3.md#利用上下文感知检索增强用户记忆)

### 5. 书给出的评估标准

书不是只测“能否记住一句话”，而是三层递进：

1. **基础回忆**：精确存取一个直接、明确的事实；
2. **多会话检索**：跨对象、跨会话、跨时间找到全部相关信息，并处理有效/失效状态；
3. **主动服务**：综合很久以前的多个信息，在用户没有明确要求时主动发现风险或关联。

书总结的能力项包括：个人信息保留、偏好追踪、上下文切换、记忆更新、多会话连续性、复杂思考、时间感知和冲突解决。配套实验用多轮会话生成记忆，再用仅可见记忆的后续问答和 LLM-as-a-judge 评分，避免系统偷偷回看原始会话。[原书的记忆三层次评估](https://github.com/bojieli/ai-agent-book/blob/main/book/chapter3.md#记忆能力的评估三层次框架)

## 二、同类架构对照

### 1. MemGPT / Letta：把 Agent 变成“记忆操作系统”

**论文的核心模型。** MemGPT 把有限 context window 比作物理内存，把外部存储比作磁盘，通过 function call 让 LLM 自己决定何时写入、检索和修改上下文。主上下文由只读 system instructions、可读写 working context 和滚动 FIFO 队列构成；队列接近上限时发出 memory pressure 警告，超过阈值后淘汰旧消息并生成递归摘要。被淘汰的消息仍进入 recall storage，需要时可搜索取回；archival storage 则用于更大的、主动写入的长期材料。Heartbeat/function chaining 允许 Agent 在一次用户回合内连续调用记忆函数，而不是每次都把控制权交回用户。[MemGPT 论文](https://arxiv.org/abs/2310.08560)

**Letta 产品化后的边界。** 官方文档把能力拆成：

- **Memory Blocks**：始终在上下文中，可读写或只读；适合 persona、human、少量关键偏好和政策；有 label、description、value、字符上限；可 attach/detach，能在多个 Agent 间共享；
- **Files**：比 block 大、可按需打开和搜索的外部文件；
- **Archival Memory**：不常驻上下文、可写入和语义搜索的长期存储，可附带时间和 tags；
- **Conversation Search**：对完整过去对话做回忆检索；
- **External RAG**：由应用通过工具/MCP 自己提供的更大知识库。

官方给出的选择原则是：少量且必须始终知道的内容放 block；大文档放 files；不必每次召回的历史放 archival；百万级外部资料使用 RAG。[Letta context hierarchy](https://docs.letta.com/guides/core-concepts/memory/context-hierarchy)  Blocks 还能被设为只读、按任务临时挂载或撤销，这提供了访问控制的原语，但并不自动替产品决定谁有权写入。[Letta memory blocks](https://docs.letta.com/guides/core-concepts/memory/memory-blocks)

| 维度 | MemGPT / Letta 的做法 | 这是产品策略还是框架能力？ |
| --- | --- | --- |
| 分层 | working/core、FIFO/recall、archival、files、外部 RAG | 分层和工具是框架能力；哪些内容进入 core 是 Agent/应用策略 |
| 写入 | LLM 用 memory/archival 工具自编辑；Letta 也允许应用直接写 | “模型自主写”是能力，不等于可信的产品晋升流程 |
| 检索 | conversation search、archival 向量检索、文件搜索，分页/按需载入 | 检索器是框架；权限、相关性阈值、是否可用于动作由产品决定 |
| 整理/压缩 | FIFO 淘汰、递归摘要、working block 重写 | 有上下文压力处理；没有替奕枢定义事实有效性的证据规则 |
| 忘记 | block 可删除/撤销挂载，archival passage 可删除；论文中的 recall 主要是长期保留 | 有删除 API；没有自动满足用户隐私/源证据级联删除的产品协议 |
| 来源/置信度 | 有 block 描述、时间、tags 等元数据 | 元数据字段可用，但 provenance/confidence 不是完整的产品真值层 |
| 多 Agent | 共享 block 或共享 archive | 共享是能力；租户和用户边界需应用强制 |

**对奕枢的启示。** Letta 证明“常驻少量核心记忆 + 取回大量细节”是成熟的工程边界，但它不应直接成为奕枢的身份或记忆真相层。Pi 可以借鉴其 paging、按需取回和 heartbeat；`MemoryClaim` 的来源、授权、过期和用户可见控制仍应属于 Kernel。

### 2. Mem0：抽取 → 相似记忆对比 → ADD/UPDATE/DELETE/NOOP

Mem0 论文明确把长期记忆拆成两个阶段：

1. **Extraction**：以新的一对消息为输入，同时提供全局 conversation summary 和最近若干条消息；LLM 抽取“值得长期记住”的候选事实。
2. **Update**：用向量检索找出 top-s 个相似旧记忆，再让 LLM 在候选与旧记忆之间选择 `ADD`、`UPDATE`、`DELETE` 或 `NOOP`。这样可以把“住在北京”更新为“搬到上海”，而不是无条件追加重复事实。

图记忆变体 `Mem0^g` 把实体作为节点、关系作为带标签的边，更新时做冲突检测；被取代的关系会标为 invalid，而不是物理删除，以保留时间推理能力。检索同时支持实体中心的邻居扩展和语义 triplet 搜索。[Mem0 论文方法部分](https://arxiv.org/html/2504.19413v1#S2)

论文在 LOCOMO 上按 single-hop、multi-hop、open-domain、temporal 分类评估，并同时测回答质量、检索 token、搜索/总延迟和构建开销；这比只测“记忆命中率”更接近生产。[Mem0 论文评估部分](https://arxiv.org/html/2504.19413v1#S3)

| 维度 | Mem0 的做法 | 对产品设计的限制 |
| --- | --- | --- |
| 写入 | 每次消息对抽取候选；可异步刷新会话摘要 | LLM 抽取结果仍是候选，不应直接取得“用户事实”地位 |
| 冲突 | 相似召回后由 LLM 选择 ADD/UPDATE/DELETE/NOOP；图版保留 invalid 关系 | 更新决策需保留版本、证据和有效时间，不能只留最终字符串 |
| 检索 | 向量相似；图版加实体/关系和时间 | 需要在此之外加 namespace、权限和敏感级别过滤 |
| 遗忘 | 删除/invalid 是记忆库操作 | 论文没有替应用定义用户“忘掉”时的源对话和索引级联协议 |
| 评估 | LoCoMo + LLM judge + token/latency | 还需要加入删除合规、越权泄露、置信度校准等产品指标 |

**对奕枢的启示。** Mem0 最值得吸收的是“抽取后先找邻居，再做显式冲突决策”，而不是某个具体向量数据库。对用户说“我改主意了”时，Kernel 应记录新版本并让旧版本进入 `superseded`/`retired` 状态；原始证据仍可审计，检索默认只返回当前有效版本。

### 3. LangGraph / LangMem：线程检查点与跨线程 Store 分离

LangGraph 官方把持久化拆成两种互补设施：

- **Checkpointer**：持久化单个 thread 的 graph state，服务于当前会话连续性、暂停/恢复、人机协同、time travel 和故障恢复；
- **Store**：存放应用定义的 key-value 数据，跨 thread 共享，服务于用户偏好、事实和共享知识。

官方表格明确把二者分别称为 short-term/thread-scoped 与 long-term/cross-thread memory；生产使用数据库后端，并提醒长期对话的 checkpoints 会无限增长，需要定期 prune 或 retention policy。[LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)

LangGraph Store 以多级 namespace 隔离数据，例如 `(organization_id, user_id, context)`，支持直接按 key 取、语义搜索和 metadata filter。官方示例把 user id 作为运行时 context，而不是让模型自己猜 namespace。[LangGraph memory](https://docs.langchain.com/oss/python/langgraph/add-memory#use-long-term-memory)

LangMem 又把“记忆什么时候形成”拆成两种：

- **Hot path / conscious formation**：Agent 在当前回合调用 `manage_memory` 工具，立即插入/更新/删除；关键上下文及时生效，但增加响应延迟并让模型多一个决策点。
- **Background / subconscious formation**：对话结束或空闲后，由 `ReflectionExecutor`/memory manager 异步抽取、合并、泛化和更新；不阻塞当前响应，更适合模式分析和摘要，但会有短暂最终一致性。

LangMem 的概念文档还明确列出 semantic、episodic、procedural 三类记忆；memory manager 会检索已有相关记忆，再由 LLM 产生结构化更新，最后由 Store Manager upsert/delete。`enable_deletes` 默认关闭，说明“自动删除”应是显式的风险选择，而不是默认行为。[LangMem core concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)；[LangMem memory manager API](https://langchain-ai.github.io/langmem/reference/memory/)

| 维度 | LangGraph / LangMem 的做法 | 这是产品策略还是框架能力？ |
| --- | --- | --- |
| 短期状态 | checkpoint + thread_id | 框架能力；任务阶段和完成标准仍需产品定义 |
| 长期记忆 | Store + hierarchical namespace + semantic/metadata retrieval | 框架能力；namespace 命名和授权属于应用 |
| 写入时机 | hot path 或 background reflection | 两种编排能力；何时采用哪种由业务风险/延迟目标决定 |
| 类型 | semantic / episodic / procedural | 概念分类与 schema 能力；是否晋升为产品规则需审核 |
| 更新/删除 | manager 检索旧记忆后生成结构化变更；删除默认关闭 | 能力提供方；没有奕枢所需的用户确认、审计、敏感信息政策 |
| 保留 | checkpoint 需应用配置 prune/retention | 框架明确提醒风险，但不替产品选 retention |

**对奕枢的启示。** 这是目前最接近我们要做的“边界”答案：`TaskTruth`/当前对话属于 thread state；用户长期记忆属于跨 thread Store；记忆提取应允许显式 hot path 与异步 background 两条管线，而不是把所有逻辑塞进 Pi 的一次运行。

### 4. 去掉产品名后，可采用的机制

前面各系统的名称不同，但可供奕枢吸收的机制其实收敛为以下几项：

| 可采用机制 | 产品含义 | 首版边界 |
| --- | --- | --- |
| **Working / thread checkpoint** | 保存当前回合、任务计划、审批暂停点和可恢复执行状态 | 绑定 `thread_id`/`task_id`；不是跨会话用户画像 |
| **Core / profile always-on** | 少量、稳定且必须每次都知道的身份和用户偏好 | 有字符/token 上限；只放低敏、已确认内容；不可把整个历史塞入 |
| **Episodic archive retrieval** | 将过去事件、对话摘要和时间线放在上下文外，按查询召回 | 默认不注入；召回时带时间、来源和主体；原文作为证据回查 |
| **Semantic facts** | 将偏好、事实、关系和约束存成可更新的结构化 claim | 版本化、有效期、冲突状态、来源和置信度必须存在 |
| **Procedural skills** | 将重复成功的做法抽成可复用流程 | 只能由验证过的轨迹/评审/eval 晋升；失败可回滚 |
| **Hot-path / background writes** | 显式“记住”走当前回合；自动抽取走后台反思 | 热路径只处理高优先级或用户明确要求；后台最终一致 |
| **Version + conflict + provenance** | 新事实不抹掉旧证据，更新有来源和有效时间 | `active / superseded / retired / disputed` 等状态先于向量检索 |
| **Scoped retrieval + eval** | 按 user/project/task/tenant 和时间过滤，再做相似度召回 | 先过权限与敏感过滤；用 Level 1/2/3、隔离、删除和冲突 fixture 验收 |

这些是“采用机制”，不是要把某个框架照搬进奕枢。它们可以由 Kernel 的端口和 schema 实现，Pi 只提供执行事件；存储后端（SQLite、JSON、向量索引或图数据库）是之后可替换的实现细节。

首版明确不采用以下做法作为产品真相：

- 让模型自行改写一块长期记忆并直接生效；
- 把完整 transcript 或工具 payload 默认塞进长期 prompt；
- 仅按向量相似度决定“最新事实”，不处理有效期和冲突；
- 把供应商的 conversation/session id 当作奕枢的语义记忆；
- 自动删除但不保留变更/来源审计；
- 只测“回答像不像”，不测越权、错误更新和忘记合规。

### 5. OpenAI：对话状态、Agent Session 与用户可见记忆是三件事

OpenAI 官方文档把 API 层的“延续上下文”分成几种不同策略：

- **Conversations API**：创建一个带 durable id 的 conversation，可跨 session、设备和 job 使用；其中存放 message、tool call、tool output 等 items；
- **`previous_response_id`**：把一次 response 链到下一次，是轻量的 response-to-response continuation；
- **Agents SDK session**：由应用控制存储（例如 `SQLiteSession`），适合持久聊天、可恢复审批和自有数据存储；
- **`result.history`**：应用自己保存和回放完整历史。

官方特别提醒：每个 conversation 应选择一种 state strategy，混用本地 replay 与 server-managed state 可能重复注入上下文。[OpenAI Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)；[OpenAI Agents running agents](https://developers.openai.com/api/docs/guides/agents/running-agents)

这说明“对话状态持久化”不等于“语义记忆”。Conversations API 可以保留对话和工具事件，但没有在 Agents 文档中规定如何从中抽取用户偏好、处理冲突、设置信心或自动遗忘；这些仍是应用层职责。另一个重要事实是，OpenAI 文档对 response 对象与 conversation item 的保留期限分别描述：response 默认可保存 30 天，而 conversation items 不受该 30 天 TTL 约束。第三方产品不能把“供应商存着”当作自己的 retention/forgetting 协议。

**ChatGPT 产品层**则提供了不同的用户控制：

- `saved memories`：用户明确要求记住或系统判断值得长期保留的细节；
- `reference chat history`：从过去聊天中选择有用信息，但不承诺记住每个细节，且内容可能随时间更新；
- 用户可在设置中开关、查看/删除记忆，也可对话中要求忘记；Temporary Chat 不使用或更新记忆；
- 删除聊天不会自动删除 saved memory；要完全移除，需分别删除记忆和来源聊天。

[OpenAI Memory controls](https://help.openai.com/en/articles/11146739-how-does-reference-saved-memories-work)；[OpenAI Memory and new controls](https://openai.com/index/memory-and-new-controls-for-chatgpt/)

这是一个产品协议而不是 SDK 数据结构：**记忆开关、查看、编辑、删除、临时会话和项目/工作区隔离应由产品拥有**，不能假设框架会自动提供。

## 三、跨系统归纳出的参考模型

### 1. 记忆类型与生命周期

| 类型 | 典型内容 | 是否默认进 ContextCapsule | 写入方式 | 失效/删除 |
| --- | --- | --- | --- | --- |
| 原始证据 / Evidence | 用户原话、assistant 输出、工具输入输出、屏幕/环境观察、时间和 source id | 否；只按需取证 | 事件追加，尽量不改 | 按用户/租户 retention；删除需有明确级联协议 |
| 线程状态 / Thread state | 当前消息、checkpoint、审批暂停、恢复点 | 当前 thread 是；跨 thread 否 | 每步 checkpoint | prune/TTL；不能当长期偏好 |
| 工作记忆 / Working context | 当前目标、约束、计划、已激活记忆、压缩摘要 | 是，但有 token/权限预算 | 代码维护 + 受控摘要 | 回合结束或任务结束时重建 |
| 语义记忆 / Semantic | 稳定偏好、事实、关系、约束 | 相关时 | 显式记住或候选抽取后审核 | 新版本 `superseded`，或用户删除 |
| 情景记忆 / Episodic | 某次事件、成功/失败经历、时间线 | 否，按主题/时间检索 | 会话摘要/事件抽取 | TTL、低频归档、用户删除 |
| 程序记忆 / Procedural | 验证过的 Skill、流程、行为规则 | 只在匹配任务时 | 轨迹 → 候选 → reviewer/eval → 晋升 | 版本化、回滚、失效；不能由一次成功自动晋升 |
| 共享知识 / Domain knowledge | 产品文档、法规、团队流程 | 相关时 | 文档入库、分块、索引、版本审核 | 生效/失效时间、权限过滤、版本下线 |
| 业务真相 / Task truth | 任务阶段、完成/阻塞/失败、外部 receipt | 当前任务相关 | typed runtime events + verifier | 终态单调；重试产生新 execution，不覆盖证据 |

这里最容易混淆的是：轨迹/证据是“发生过什么”，工作记忆是“现在让模型看到什么”，语义记忆是“未来可复用的稳定事实”，任务真相是“这件事目前处于什么状态”。它们不能互相替代。

### 2. 每条可用记忆至少要带的元数据

不同系统的字段名称不同，但要构建可审计产品，至少应有：

```text
id
kind: semantic | episodic | procedural | task | evidence
content / structured_value
source_event_ids[]       # 来自哪些原始事件/文档/receipt
subject / relationship   # 关于谁、与谁的关系
namespace                # user / agent / project / task / tenant
created_at / updated_at
valid_from                # 事实生效时间，不等于写入时间
valid_to                  # 事实失效时间；空值表示仍有效
confidence + status       # candidate / active / superseded / retired / disputed
sensitivity + consent    # 是否敏感、是否允许自动记忆/检索
provenance               # extractor / reviewer / user-confirmed / external-source
retention / expires_at
```

这里的 `confidence` 不是让 LLM 自报一个漂亮分数，而是区分证据来源和验证层级；`provenance` 要能回到原始事件；`valid_to` 用于处理“旧事实仍曾经成立但现在不再有效”。Book 的 Advanced JSON Cards、Mem0 的 timestamp/invalid relationship、Letta 的 descriptions/tags、LangGraph 的 namespace 和 OpenAI 的独立 memory/chat 删除边界，共同支持了这组要求，但没有任何一家开源框架替产品完整实现它。

## 四、推荐的写入、检索与整理管线

### 1. 写入管线：两条时延路径

```text
用户/环境事件
  → 敏感信息与权限过滤
  → EvidenceLog append-only
  → 任务/线程 checkpoint
  → 记忆候选提取
       ├─ 显式“记住”：当前回合确认、可见、优先级高
       └─ 自动学习：后台抽取，不能阻塞回复
  → 召回相似旧记忆
  → 冲突/重复 adjudication
       ADD | UPDATE(version) | SUPERSEDE | RETIRE | NOOP | DISPUTED
  → 结构化 MemoryClaim 落库
  → 异步索引/摘要/统计
```

具体建议：

- **显式记忆**可以进入 hot path，但应让用户知道“已记住什么”，敏感类别默认要求确认。
- **自动抽取**放 background，避免每次对话增加一次明显延迟，也避免把模型的临时推测写成事实。
- **原始证据先落盘，候选记忆后生效**。错误的摘要或更新不能删除底层证据。
- **更新是版本化事件**。例如“住在北京”→“搬到上海”不是把字符串覆盖掉，而是保留旧版本、设置有效时间和 `superseded` 状态。
- **程序记忆必须有验证门**。一次任务成功只产生候选 Skill；只有 reviewer、回放和 eval 通过才进入 live Skill。

### 2. 检索管线：先确定边界，再找相似度

```text
当前请求
  → 判断需要哪种记忆（事实 / 事件 / 技能 / 任务状态）
  → 绑定 user + tenant + project + task namespace
  → 过滤敏感级别、有效时间、active/disputed 状态
  → 直接 key / BM25 / 向量 / 图邻居的混合召回
  → 重排序与冲突检测
  → 只注入 top-k + provenance + 时间条件
  → 必要时再取原始证据核验
```

不能把所有长期记忆都塞进 system prompt，也不能只按相似度排序后让模型猜哪条“最新”。对于可能影响外部动作的事实，检索结果应带来源与有效期；若仍有冲突，应该进入 `disputed/needs_confirmation`，而不是伪造一个确定答案。

### 3. 整理、压缩与遗忘

- **线程层**：按 token 压力生成摘要、淘汰旧 checkpoint；原始轨迹是否保留由 EvidenceLog retention 决定。
- **语义层**：周期性去重、合并、发现过期和矛盾；旧版本进入 `superseded`/`retired`，而非无痕覆盖。
- **情景层**：低频事件可以降权或设置 TTL；仍需支持按时间/主题找回。
- **程序层**：定期回放和评估；失败率升高时回滚或下线。
- **知识层**：按版本/生效时间过滤；索引是派生物，可以重建。
- **用户忘记**：至少删除/隐藏所有派生 MemoryClaim、索引和默认检索结果；是否同时删除源聊天/证据必须写进产品协议。OpenAI 的产品文档明确提醒 saved memory 与来源聊天是两套删除对象，这正是不能含糊的原因。

## 五、用户控制与隐私边界

成熟产品提供的不是一个“保留全部/不保留任何”的二元开关，而是多层控制：

1. **记忆总开关**：关闭后不写入也不检索长期记忆；
2. **会话级模式**：Temporary Chat/不记忆，用于敏感或一次性任务；
3. **显式记住**：用户主动要求的内容可以高优先级保存；
4. **可见性**：展示记住了什么、何时写入、来源和为什么被使用；
5. **编辑/忘记**：支持单条删除、批量删除和撤销错误更新；
6. **范围**：user、project、task、tenant、agent 等 namespace 隔离；
7. **敏感类别**：健康、财务、凭据、私人关系等默认不自动长期保存，或先确认；
8. **访问权限**：只读 block、临时 attach/detach、按任务授权，避免把全部用户记忆暴露给每个执行器。

这些是产品契约；MemGPT/Letta、Mem0、LangGraph/LangMem 和 OpenAI API 提供的是存储、工具、namespace、session 或搜索原语，不能替奕枢决定何时该记住、谁能看和如何忘记。

## 六、评估方法

记忆系统必须同时评估“写得对不对”和“用得对不对”：

### 1. 离线能力集

- **Level 1 基础回忆**：明确姓名、偏好、约束、编号等事实的精确回忆；
- **Level 2 多会话检索**：多辆车、多份合同、多位关系人、跨时间的有效/失效状态；
- **Level 3 主动服务**：从多个不相邻事件发现风险或机会，并能回到原始证据核验；
- **更新与冲突**：旧事实、新事实、撤销、不同主体/时间/任务条件；
- **不应记忆**：密码、token、屏幕中的偶然内容、用户明确说“不要记”；
- **隔离**：不同用户、项目、任务、Agent 之间不能串记忆；
- **忘记合规**：删除后不再检索、索引和提示注入，且必要时删除源证据。

### 2. 指标

| 类别 | 建议指标 |
| --- | --- |
| 记忆写入 | precision（写入的有用事实比例）、recall（应记事实漏写比例）、结构化 schema 合法率 |
| 检索 | recall@k、precision@k、MRR/nDCG、来源覆盖率、越权泄露率 |
| 事实正确性 | 更新/冲突解决准确率、时间推理准确率、主体消歧准确率、可拒答率 |
| 用户体验 | 首 token/总延迟、额外 LLM 调用、检索 token、跨会话连续性 |
| 生命周期 | 过期过滤率、superseded 不再误召回、删除合规率、恢复/回滚成功率 |
| 主动服务 | 风险发现 precision、误报率、需要确认时是否停下 |

Mem0 的 LOCOMO 评估提供了 single-hop、multi-hop、open-domain、temporal 和 token/latency 的组合参考；《AI Agent Book》则补充了主动服务、冲突和跨会话评估。对奕枢还必须加 privacy/scope/deletion 测试，因为这些不是回答分数能覆盖的。

## 七、对奕枢的落地建议

### 1. 统一语言

对外只说“奕枢记得了什么”；内部使用下面四个产品对象：

- **EvidenceLog**：原始事件和来源，只增不改，可审计；不是默认提示词；
- **ThreadState / TaskTruth**：当前会话与任务阶段，可暂停/恢复；
- **MemoryClaim**：经过提取/审核、带来源与有效期的语义/情景/程序记忆；
- **ContextCapsule**：给当前执行器的最小、带权限的上下文投影。

Clicky 是用户可见的入口和控制面；Kernel 拥有上述产品对象和策略；Pi 只执行一轮并产出 typed events/receipts。这样不会再出现“Clicky、Kernel、Yishu、Pi 都像是不同产品”的混乱：它们是入口、产品内核、用户身份和执行器四个职责，不是四套记忆。

### 2. 第一刀应该做什么

不应先实现“把所有 transcript 摘要成一条 memory”。第一刀应是一个**记忆契约和最小流水线**：

1. 明确 EvidenceLog、ThreadState、MemoryClaim、ContextCapsule 四种对象；
2. 给 MemoryClaim 定义 kind、source、subject、namespace、validity、confidence/status、sensitivity 和 retention；
3. 支持显式“记住/忘记”并让用户可见；
4. 先用后台抽取生成 candidate，默认不把原始 assistant 推理、工具 payload、截图或凭据写入 MemoryClaim；
5. 实现版本化的 add/update/supersede/retire/disputed，而不是覆盖字符串；
6. 用 Level 1/2/3、冲突、隔离、删除合规这几类 fixture 验收；
7. ContextCapsule 只注入经过权限和有效期过滤的少量结果，必要时附 source id 和“需确认”标志。

这条路线同时吸收了《AI Agent Book》的双层记忆、MemGPT/Letta 的分层与 paging、Mem0 的冲突更新、LangGraph/LangMem 的 thread/store 与 hot/background 分离，以及 OpenAI 产品对用户控制和删除边界的实践；没有把任何一家框架误当作奕枢的产品真相层。

## 参考资料（均为论文或官方文档）

1. [《深入理解 AI Agent：用户记忆和知识库》第 3 章](https://github.com/bojieli/ai-agent-book/blob/main/book/chapter3.md)
2. [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560)
3. [Letta context hierarchy](https://docs.letta.com/guides/core-concepts/memory/context-hierarchy)
4. [Letta memory blocks](https://docs.letta.com/guides/core-concepts/memory/memory-blocks)
5. [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413)；[HTML full text](https://arxiv.org/html/2504.19413v1)
6. [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
7. [LangGraph memory](https://docs.langchain.com/oss/python/langgraph/add-memory)
8. [LangMem conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
9. [LangMem memory manager API](https://langchain-ai.github.io/langmem/reference/memory/)
10. [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
11. [OpenAI Agents: running agents and sessions](https://developers.openai.com/api/docs/guides/agents/running-agents)
12. [OpenAI saved memories and chat history controls](https://help.openai.com/en/articles/11146739-how-does-reference-saved-memories-work)
13. [OpenAI Memory and new controls for ChatGPT](https://openai.com/index/memory-and-new-controls-for-chatgpt/)
