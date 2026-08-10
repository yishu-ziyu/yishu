# 同类个人 Agent 的记忆机制基准

Type: research
Status: historical
As-of: 2026-08-09

> 核对日期：2026-08-08
>
> 范围：ChatGPT、Claude（含 Claude Desktop）、Gemini（含 Android/Chrome 助手形态）、Microsoft Copilot（Windows/macOS 及 Microsoft 365 Copilot）、Perplexity Computer/Brain。
> 证据原则：只采用厂商官方帮助中心、官方产品文档或官方博客；功能仍在分批发布的，按“官方文档明确写出的范围”记录，不把某个账户看到的开关推断成全局默认值。

## 结论先行

行业没有把“记忆”实现成一份永远增长的聊天摘要，而是逐渐分成几层：

1. **持久偏好/个人事实**：名字、偏好、沟通方式、稳定的工作背景。
2. **历史会话检索**：需要时从过去会话中找证据，而不是把所有原文常驻上下文。
3. **项目/工作区记忆**：把某一项目的聊天、文件、决策与全局个人记忆隔离。
4. **Agent 工作上下文**：项目、人物、文件、决定、开放环节等带来源的结构化工作图。
5. **隐私逃生舱**：Temporary/Incognito 等模式不读、不写长期记忆。

对 Yishu 最重要的不是照搬某一家的字段，而是保留这条边界：**记忆是产品拥有的、可检查和可撤回的长期证据；原始会话是历史来源；Runtime/Agent 只能按权限检索它们，不能自行把一次执行结果变成长期事实。**

其中，与桌面个人助理最接近的是 Perplexity Computer 的 Brain：它在后台从任务、连接器、文件、产物和用户修正中构建带来源的工作图，并标记变化或过时内容；但它仍把 Brain 限定为“维护记忆”，不直接执行动作或发送消息。这和 Yishu 的 Kernel/Runtime 分离很接近。

## 五个关键维度逐项比较

下表把“记忆”拆成五个产品合同，而不是只比较一个 Memory 开关。核对日期均为 **2026-08-08**；“未见官方承诺”表示在对应官方页面中没有找到，不代表底层一定不存在。

| 产品 | 结构化保存 vs 过去聊天检索 | 项目/范围隔离 | 临时/隐身模式 | 可见 / 可编辑 / 可导出 | 删除是否级联 |
| --- | --- | --- | --- | --- | --- |
| **ChatGPT** | 两层：Saved memories（会自动合并/更新的高层条目）+ Reference chat history（按需引用历史聊天）；项目还可引用项目聊天/文件。 | 账户级；新建项目可选 `project-only`，只读项目内上下文；共享项目自动 project-only。 | Temporary Chat 不读、不写 memory，也不进历史。 | 可问“你记得什么”、在 Memory summary/Manage memories 查看、编辑、逐条/全部删除；可做账户数据导出，但官方未承诺“Memory 单独导出”格式。 | **不级联**：删原聊天不删 Saved memory；完整移除要分别删 memory 与原聊天。项目 memory 无独立清单，需删/移出对应聊天。 |
| **Claude（含 Desktop）** | 新版为分类 memory entries（实时读写更新）+ past-chat search（RAG 工具调用）；两者独立。 | 账户 memory；每个 Project 有独立 memory/summary，past-chat search 不跨项目。 | Incognito chat 不进历史、不读写 memory。 | Settings > Memory 显示全部分类条目，可编辑/删除；可在聊天中修改；past-chat 有原聊天引用；官方支持 Memory 导入/导出。 | **默认不级联**（新版）：原聊天删除/过期不自动删 memory entry；Reset memory 才整体删除。 |
| **Gemini** | 主要以 Gemini Apps Activity 为历史底座，Memory 按需引用；回答显示 `Previous chats`；另有 Saved instructions/Connected Apps。 | 个人账户级；Gems/Live 等功能有能力边界；截至核对页面未见通用的项目级 Memory。 | Temporary Chat 或关闭 Keep Activity；关闭后仍可能保留 72 小时以提供服务。 | 可查/删 Activity、切换 Memory、编辑/删 Instructions、管理 Connected Apps；官方页面未见独立 Memory 导出入口。 | **部分级联**：删聊天会删对应 Activity、停止其个性化使用（可能延迟）；Connected Apps 必须同时删聊天与断开连接。 |
| **Microsoft Copilot（个人）** | 账户级显式/隐式 Memory + 会话历史推断 + 可选 Microsoft usage data（Bing/MSN/Edge）。 | 账户级，跨 Web、Windows/macOS、mobile、Edge；未提供普通用户项目级 Memory。 | 官方个人 Copilot 文档未使用统一“Incognito”名称；关闭 personalization/memory 可停止使用/写入个性化，但普通对话历史仍可见。 | 可问“你知道我什么”、remember/forget、逐条/全部删除；可删除历史；未见独立 Memory 导出。 | **不级联**：关个性化忘记 memory，但不删历史；删特定会话用于阻止该会话个性化。 |
| **Perplexity Computer / Brain** | Memory 是偏好/兴趣；Brain 是从 sessions、连接器、文件、产物、修正构建的带来源工作图；不是把所有原文塞入上下文。 | Computer 跨会话；Project memory 默认只在该项目，需显式打开才能引用个人会话；只学习本人的活动。 | Incognito 永不读写 Memory/Brain。 | Memory 中可浏览 Concepts/Entities/Workstreams、点回来源、编辑/删除；Brain/History/Connected sources 独立开关；官方未见独立导出入口。 | **按来源而非简单级联**：关闭 Brain 停止新写入；用户删除 entry；后台标记 stale；Enterprise 关闭可删除已有 memory。 |

这五个维度揭示了一个共同事实：**“过去聊天搜索”不能替代“结构化记忆”；“项目隔离”不能靠 UI 名称代替；“临时模式”必须同时控制读和写；用户应能看见派生记忆及来源；删除关系必须是明确、可验证的产品合同。**

## 横向对比

| 产品 | 默认与写入 | 作用域与检索 | 过期、删除与原对话关系 | 用户可见控制 | 敏感信息处理 |
| --- | --- | --- | --- | --- | --- |
| **ChatGPT** | 官方当前文档只承诺由设置控制，未承诺所有计划/地区统一默认值。`Saved memories` 可由“记住……”显式写入，也可能从有用信息中自动写入；`Reference chat history` 是另一条按需引用过去聊天的通道。 | 默认是账户级；Projects 可选 `default` 或 `project-only`。后者只读同项目聊天/文件，不读个人记忆或其他项目。相关记忆会作为上下文使用；历史聊天另有搜索入口。 | Saved memory 独立于聊天，删除聊天不会删除它；完整删除需要同时删除 memory 和原聊天。关闭开关不等于删除已存在 memory；已删除 memory 的日志最长可保留 30 天。Temporary Chat 不读/不写 memory。 | Memory summary/Manage memories，可询问“你记得什么”、逐条修改/删除/清空；可以关闭 saved memory 与 chat history。项目记忆没有独立 memory 清单，想排除一条项目聊天要删除或移出。 | 官方 FAQ 明确：用户分享的敏感信息可能出现在 memory；Temporary Chat 是隔离方式。早期官方博客说会尽量避免主动记住健康信息，但不能把它当作硬保证。 |
| **Claude（含 Desktop）** | 新版 memory 正在分批迁移：新用户默认采用新版，free/Pro/Max 逐步迁移；历史聊天搜索在已推出账户中默认开启。Memory 在 web、Claude Desktop、mobile 可用；聊天搜索目前限 paid plans。新版会实时读写“分类条目”，可自动写入，也可要求记住/修改。 | 账户级 memory + 每个项目独立 memory/summary。过去聊天检索使用 RAG 并显示为工具调用；搜索范围为项目外全部聊天，或单个项目内聊天，不跨项目。 | 新版中，删除/过期原聊天**不会自动删除**由它产生的 memory entry，需单独删除；Pause 保留已有 memory 但停止使用/写入；Reset 永久删除全部 memory（含 project memory）。Incognito 不进历史也不进 memory。Memory 可导出。 | Settings > Memory 展示按类别的全部条目，可逐条编辑/删除；聊天中也可直接改；历史聊天引用带回源聊天链接；可独立关闭 memory 与 past-chat search；支持导入/导出 memory。 | Memory 文档只说聚焦工作角色、项目、沟通/技术偏好，没有承诺普遍的敏感信息排除。Claude Desktop 的 1Password 集成明确保证密码和一次性码不会进入 Claude context、memory 或 Anthropic 系统，说明凭据应走外部注入通道。 |
| **Gemini** | 过去聊天 Memory 要求个人 Google Account、18+、`Keep Activity` 开启；Google 明确说 18+ 用户 Keep Activity 默认开启，但没有承诺 Memory 开关在所有账户默认开启。可隐式利用过去聊天，也可直接纠正；另有 `Instructions for Gemini` 和 Connected Apps。 | 过去聊天可按主题/时间段询问；若使用，会在回答的 Sources 中标记 `Previous chats`。可跨 web、mobile、Gemini in Chrome、smartwatch；暂不适用于 Gems/Live（文字聊天可引用过去 Live）。没有公开的项目级 Memory 机制。 | Gemini Apps Activity 默认 18 个月自动删除，可选 3/36 个月或不自动删除；关闭 Keep Activity 后，聊天仍最多保存 72 小时用于提供服务。删除聊天会删除 Activity 并停止用于个性化（可能有短延迟）。Connected App 数据则需同时删除聊天、断开应用；只做其中一个不够。Temporary Chat/关闭 Activity 用于不产生长期个性化。 | Memory 开关、Activity 查看/逐条或批量删除、Instructions 编辑/删除、Connected Apps 连接管理；可询问“你是否使用了过去聊天”。 | Google 明确提醒：Memory 开启时可能使用聊天中的敏感信息；应使用 Temporary Chat，删除包含该信息的全部聊天。 |
| **Microsoft Copilot（个人 Windows/macOS）** | 若账户/地区可用，个性化默认开启；Copilot 可从会话及 Bing/MSN/Edge 等 Microsoft usage data 推断偏好，也可用“记住/忘记”。 | 账户级，跨 copilot.com、Windows/macOS、mobile、Edge Sidebar；官方未提供类似 ChatGPT/Claude 的项目 Memory。以近期会话、账户活动和显式记忆生成个性化响应。 | 个人 Copilot 对话历史默认保留 18 个月，可删单条或全部。关闭 personalization/memory 会忘掉对话 memory，但不删历史。 | 设置中的 Memory/Personalization；询问“你知道我什么”、要求 remember/forget、Delete all Memory；可单独关闭 Microsoft usage data。 | 官方 FAQ 说个人 Copilot 不记住 demographic 或其他敏感数据；健康信息仅在用户主动开启的 Copilot Health 中使用。 |
| **Microsoft 365 Copilot（工作/学校账户）** | Copilot Memory 默认开启；重要信息可能先询问是否保存，也可显式让它记住。还会从历史聊天生成 inference，并叠加 custom instructions。 | 工作账户级；聊天历史和工作数据按 Microsoft 365 tenant/组织策略处理。没有面向普通用户的项目 Memory，但 Temporary Chat 可限制一次聊天。 | Saved memory 与 chat-history inference 是两种数据：须分别删除。关闭 Chat history personalization 会删除其推断，系统在 30 天后移除；30 天内重新开启可能恢复。Temporary Chat 不进入历史/记忆，但管理员仍可能按组织保留策略访问。 | Saved memories 面板逐条/全部删除；Chat history 开关；Temporary Chat；custom instructions。 | 文档强调按工作数据同等保护，具体敏感信息过滤由组织/租户政策决定，不应推断为个人 Copilot 的同等保证。 |
| **Perplexity Computer / Brain** | Brain 是 Max/Enterprise Max 使用 Computer 的 Research Preview；官方只说有独立 Brain 开关，没有承诺统一默认值。后台从 sessions、connected tools、files/artifacts、user corrections 学习。 | 最接近桌面 Agent：Memory 记录偏好/兴趣，Brain 把项目、人物、文档、决定、开放环节组织成 Concepts/Entities/Workstreams 图；Computer 可跨会话恢复项目工作。Projects 内 memory 默认只属于该项目，个人会话可显式授权引用。 | 未公布固定 TTL；每次后台运行会强化仍有效内容、更新变化、标记 stale。关闭 Brain 只停止新写入；用户可编辑/删除条目。Incognito 永不读写。Enterprise 管理员关闭时会删除已有 memory；清除日志最长 30 天。 | Settings > Memory 中可浏览图、查看来源、编辑/删除条目；Brain、Search History、Connected sources 各有独立开关。每条 entry 链接回 session/file/source。 | Brain 使用 AI 过滤，降低 credentials/passwords 进入 memory 的概率；用户仍可审查/清除。Brain 写入的内容不用于模型训练（Enterprise 明确保证）。 |

## 各产品的关键证据

### 1. ChatGPT：两条记忆通道 + 项目隔离

OpenAI 将 `Saved memories` 和 `Reference chat history` 分开：前者是长期的显式/隐式个人事实，后者是对历史会话的动态引用，后者不保证保留每个细节，且信息可能随时间更新。[Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)；[Reference saved memories](https://help.openai.com/en/articles/11146739-how-does-reference-saved-memories-work)

项目又有 `default` 与 `project-only` 两种边界。`project-only` 不读取个人 saved memories，也不读取项目外聊天；项目共享后会自动使用 project-only。项目记忆没有可单独浏览的清单，排除上下文要删除或移出对应聊天。[Projects in ChatGPT](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)

账户级数据可以从 Data Controls 导出，但这不是一个承诺包含“独立 Memory 导出文件”的记忆迁移接口。[Data Controls FAQ](https://help.openai.com/en/articles/7730893-chatgpt-memory-faq)

这给 Yishu 的直接启发是：**长期记忆和历史检索必须是两种不同的读取策略；项目隔离应是创建时的明确选择，而不是靠提示词约定。**

### 2. Claude：分类条目 + RAG 搜索 + project memory

Claude 新版 memory 把记忆做成分类条目，实时读、写、更新；past-chat search 则使用 RAG，并把检索显示为工具调用。项目拥有独立 memory/summary，过去聊天搜索不跨项目。[Use Claude’s chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)

它对“删除原文是否删除派生记忆”的处理与 ChatGPT 相反：新版文档明确说原聊天删除/过期不会自动删除相关 memory entry，需要用户单独删除。这个决定有利于持续协作，但会形成用户必须理解的两条删除路径。Claude 提供了 Memory 面板、聊天中修改、past-chat 引用回链以及导入/导出，控制面比单纯“记住/忘记”更完整。[Import and export your memory from Claude](https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude)

### 3. Gemini：Activity 作为底座，删除源聊天是主要遗忘动作

Gemini 的 Memory 建立在 Gemini Apps Activity 之上。使用过去聊天时，回答会显示 `Previous chats`，用户可按主题或时间段发起检索。[Find & manage recent chats](https://support.google.com/gemini/answer/13666746?co=GENIE.Platform%3DDesktop&hl=en)

Google 把历史保留和个性化开关绑得更紧：删除包含某事实的全部聊天是删除“Gemini 记住的东西”的主要办法；Connected Apps 还要求“删聊天 + 断开应用”两步。[Personalization with memory](https://support.google.com/gemini/answer/16598469?co=GENIE.Platform%3DDesktop&hl=en)；[Gemini Privacy Hub](https://support.google.com/gemini/answer/13594961?hl=en)

这是一种简单但耦合较强的设计：**源数据、个性化推断和连接器数据的删除关系必须在产品内明确显示，否则用户无法知道删掉了哪一层。**

### 4. Copilot：个人个性化与组织记忆分成两套产品合同

个人 Copilot 在 Windows/macOS 上提供 Memory/Personalization，并允许用户查看、编辑、删除；关闭个性化会忘掉 memory，但保留对话历史。[Copilot privacy controls](https://support.microsoft.com/en-US/microsoft-copilot/microsoft-copilot-privacy-controls)；[Copilot privacy FAQ](https://support.microsoft.com/en-us/Microsoft-Copilot/privacy-faq-for-microsoft-copilot)

Microsoft 365 Copilot 的工作合同更细：Saved memories 与 chat-history inferences 分开删除；关闭历史个性化的数据会在 30 天后移除，30 天内重新开启可能恢复。[Manage Copilot Memory](https://support.microsoft.com/en-us/Microsoft-365-Copilot/manage-copilot-memory-in-microsoft-365-copilot)；[Turn off chat-history personalization](https://support.microsoft.com/en-us/Microsoft-365-Copilot/how-microsoft-365-copilot-chat-history-works)

它证明了一点：**同一品牌的个人助手和组织助手，不能共用一个模糊的 Memory contract；数据归属、管理员可见性、保留和删除必须随作用域一起定义。**

### 5. Perplexity Computer/Brain：从“偏好记忆”走向“带来源的工作图”

Perplexity 将 Memory 与 Brain 分开：Memory 让 Computer“认识你”，Brain 把工作对象、决定和开放环节连成图，后台从任务、连接器、文件、产物和修正中学习，并给每个 entry 保留来源链接。它会在后续运行中更新变化、标记 stale，而不是只追加摘要。[What is Brain?](https://www.perplexity.ai/help-center/en/articles/19700001-what-is-brain)

Brain 只维护记忆，不执行动作或主动发消息；主动功能另有控制面。这是目前最贴近 Yishu 的边界：**工作图可以服务 Agent，但不能成为 Agent 的执行权限本身。** [What is Computer?](https://www.perplexity.ai/help-center/en/articles/13837784-what-is-computer)

Perplexity 的 Memory 页面还把 `Use search history`、`Notes`、项目级 memory 和 `Manage memories` 分成独立控制；项目中的 memory 默认不流入全局 memory，个人会话可显式授权项目引用。[Memory for Enterprise Organizations（其中“individual users”部分同样描述个人行为）](https://www.perplexity.ai/help-center/en/articles/13654357-memory-for-enterprise-organizations)

## 对 Yishu 的设计结论

### A. 不再把“持久记忆”定义成一个摘要字段

建议至少有四个可独立开关、可独立删除的存储面：

| Yishu 存储面 | 保存什么 | 典型读取 | 必须带的元数据 |
| --- | --- | --- | --- |
| `MemoryClaim` | 稳定偏好、身份、关系事实 | 每轮开始的轻量个性化 | source、capturedAt、confidence、scope、expiry、status |
| `ConversationArchive` | 原始会话或受保护的历史索引 | 用户明确要求“找我们之前聊过的” | conversationId、参与者、删除状态、访问审计 |
| `ProjectContext` | 项目决策、文件、任务和局部摘要 | 项目内对话/任务 | projectId、sourceRef、lastVerifiedAt、freshness |
| `WorkingGraph` | 人物、文件、决定、开放环节、任务证据 | Agent 需要恢复工作或验证事实 | 节点/边、来源链、置信度、stale/expiry、可见性 |

原始会话不应默认变成长期 MemoryClaim；由提取器提出候选，再经过隐私过滤、作用域判定、冲突/新鲜度判定后落盘。

### B. 写入采用“低风险隐式、高风险显式、敏感默认拒绝”

- **低风险稳定事实**（语言偏好、输出格式、长期项目名）：可以从会话中隐式候选写入，但必须在用户可见的 Memory 面板中出现。
- **用户明确说“记住”**：允许写入，但仍要经过凭据、健康、金融、身份等敏感过滤；显式请求不是绕过安全策略的通行证。
- **任务状态/执行结果**：只能由带证据、可验证的 `TaskTruth`/`ActionReceipt` 写入，不能由模型文本自报完成。
- **屏幕、音频、剪贴板、密码、一次性码**：默认不进入长期记忆；需要时只作为短期、授权、可过期 evidence。

### C. 检索必须可解释、可撤回

每次使用长期记忆都应能回答：用了哪条 entry、来自哪段会话/文件、当前是否过期、为什么在这个作用域可见。Perplexity 的 source link、Gemini 的 `Previous chats`、Claude 的原聊天引用，都是可借鉴的用户体验；ChatGPT 项目 memory 没有独立清单，则是应避免的盲区。

### D. 原文删除与派生记忆采用 Yishu 的更严格合同

竞品有两种做法：ChatGPT 要求分别删 memory 和原聊天；Claude 新版原聊天删除不自动删 entry；Gemini 主要通过删源聊天消除个性化。Yishu 不应让用户猜：

1. 删除原始会话时，默认撤销或删除由它唯一支撑的派生记忆；
2. 若一条记忆有多个来源，保留 entry 但显示剩余来源，并重新计算置信度；
3. 用户删除 memory 时，同时阻止未来检索，但是否删除原文由单独的“删除来源”动作决定；
4. 每个删除操作产生可验证的 tombstone，防止下游缓存继续召回。

### E. 桌面 Agent 需要“工作图 + 新鲜观察”，不是“历史截图当事实”

Perplexity Brain 说明长期工作图对恢复任务有价值，但 Yishu 仍应坚持：历史 Context 只能作为 evidence；真正执行前必须重新采集当前窗口/元素，经过权限判断和可见 read-back。Brain/Memory 可以帮助 Pi 找到相关背景，但不能直接提供坐标、点击目标或执行许可。

## 当前资料的限制

- ChatGPT、Claude、Gemini、Copilot、Perplexity 都在分批发布或按计划/地区改变功能；本文只记录官方页面明确写出的当前行为。
- “记忆是否默认开启”在多个产品上依赖账户、地区、计划和 rollout，Yishu 不应把竞品的“默认”直接复制成自己的默认值。
- 竞品文档多描述产品行为，较少公开底层模型、索引、冲突合并和删除后台的实现细节；这里的架构建议是基于公开行为的产品推断，不是对其内部实现的断言。
