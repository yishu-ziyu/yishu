# AI Agent Book 可移植设计笔记

> 来源：`ai-agent-book` ch1 / ch2 / ch4 / ch10 关键实验与论述。  
> 用途：实现者速查。忠实于书，压缩为可落地规则，不扩写。

---

## 1. 核心循环（ReAct，TypeScript 风格）

书中定义：想 → 做 → 看 → 想… 直到无 `tool_calls`。  
模型只决策；框架执行工具并维护 `messages`。上下文 = **静态前缀**（system + tools）+ **轨迹**（user / assistant / tool）。

```typescript
// 忠实于 book/chapter2「用代码实现 Agent 的核心循环」
type Message =
  | { role: "system" | "user" | "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

async function agentLoop(
  messages: Message[],
  tools: ToolDef[],
  executeTool: (name: string, args: string) => Promise<string>,
  maxIterations = 30, // 生产必须 cap，防无限工具循环
): Promise<string> {
  for (let i = 0; i < maxIterations; i++) {
    // 可选：在末尾注入状态栏（user-role meta，不改 system，保 KV Cache）
    const response = await llm.chat({ messages, tools });
    const assistant = response.message;
    messages.push(assistant);

    if (!assistant.tool_calls?.length) {
      return assistant.content ?? ""; // 模型认为信息够了 → 最终回复
    }

    // 无依赖的 tool_calls 可并行执行
    for (const call of assistant.tool_calls) {
      const result = await executeTool(call.function.name, call.function.arguments);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
    // 回到循环顶：带着完整历史再调模型
  }
  throw new Error("max_iterations exceeded");
}
```

要点（ch1 + ch2）：

- 每次 API 调用无状态：必须回传完整历史；assistant 的 `tool_calls` 原样回放。
- `tool` 消息用 `tool_call_id` 对齐。
- **有 tool_calls → 执行并继续；无 → 输出并退出。**
- 轨迹是 Agent 的全部运行时状态（ch10：轨迹持久化 = 检查点）。

---

## 2. 工具五类（ch1 引入，ch4 表 4-1）

| 类型 | 调用方向 | 作用对象 | 例子 |
|------|----------|----------|------|
| 感知 | Agent 主动 | 获取信息 | web_search, read_file, grep, fetch_url |
| 执行 | Agent 主动 | 改变世界 | shell, write_file, code_interpreter, send_email |
| 协作 | Agent 主动 | 驱动其他 Agent/人 | spawn_subagent, send_message, cancel, list_agents |
| 用户沟通 | Agent 主动 | 向用户传信息 | reply_to_user, send_card, notification |
| 事件触发 | Agent 注册、外部触发 | 唤醒 Agent | set_timer, monitor_shell, connect_channel |

设计原则（可移植）：

- 通用基础能力（解释器 / 终端）用于组合探索；高风险操作用专用工具 + 审批。
- 描述写「何时用 / 不用」与反例；参数给具体例子；返回值结构写清。
- 静默改输入（引号转换、暗注参数）= 反模式。
- 能力形态二选一：专用 schema 工具 vs **Skill + 少量通用执行器**（参数复杂 / 变更少 / 弱模型 → 专用；反之 Skill）。

---

## 3. Skills 渐进式披露（ch2）

哲学：不要一次塞满；先目录，再按需加载。

| 层 | 内容 | 何时进上下文 | 规模 |
|----|------|--------------|------|
| L1 元数据 | `SKILL.md` frontmatter：`name` + `description` | 启动时注入（常驻） | 数百 token 级 |
| L2 核心流程 | 完整 `SKILL.md` 正文 | 模型判断需要后，经 Skill 工具加载 → tool result | 按需 |
| L3 细则 | 子文档 / 脚本 / 模板 | 再按需读引用文件 | 按需 |

规则：

1. **`description` 是路由条件**，不是功能广告。写法：`Use when / Don't use when` + **反例**（缺反例路由会漂）。
2. 生产形态（方式三）：元数据提前可见；全文不塞进 system（改 system 会打爆 KV Cache）。
3. 元数据注入角色（user / system-reminder / mid-system）是 harness 细节；机制要求是「不反复改写稳定前缀」。
4. Skill 可捆绑脚本与模板；审查第三方 Skill 内容（注入面）。
5. 与工具关系：少量通用工具 + Skill 文档，避免上百专用工具平铺。

---

## 4. 状态栏推荐字段（ch2 Agent Status Bar）

位置：上下文**末尾**的 user-role 元消息（Harness 借用 user 槽，非真人输入）。  
形态：键值对，可检索；不要散文。

| 类别 | 推荐字段 | 备注 |
|------|----------|------|
| 任务规划 | TODO 列表、当前步骤、原始目标与约束 | 防局部迷失 |
| 侧信道 | 当前时间、位置、距上次回复间隔 | 一经写入可尽量稳定 |
| 环境状态 | 工作目录、异常提醒、工具重复调用计数 | **代码维护**，勿让 LLM 批统计 |
| 可用能力 | 已安装 Skill 的 name+description 列表 | 变化最少，可走同一末尾通道 |

实践三条：

1. 状态用代码/确定性逻辑维护；LLM 只做逐条抽取再由代码汇总。
2. 删原文前确认状态栏覆盖所有会问到的维度（有损投影）。
3. 模型几乎无条件信任状态栏 → 只写真实观测，防投毒。

示例形状：

```xml
<agent_status>
Current State:
- Tool call summary: phone_call × 3 (Xfinity: 3/3 max)
- Current time: 2025-09-14 10:30:45
- TODO: [1] Cancel plan (in_progress)
</agent_status>
```

---

## 5. 提议者-审核者：工具成功 ≠ 任务完成（ch10）

过早终止三形态：

1. **偷懒式假完成**：写完代码未测就说完成。  
2. **过早放弃**：一条路失败就宣布整事失败。  
3. **假成功**：口头同意但闭环未走完（用户还要在 App 确认）。

根因：**验证前的「完成」只是模型宣称，不是证明。**

| 做法 | 是否引入新信息 | 效果 |
|------|----------------|------|
| 同一模型重读自己输出 | 否 | 常无效甚至有害 |
| 纯文本辩论（等算力） | 否 | 约等于单 Agent |
| Reviewer + 测试执行 | 是 | 显著提升 |
| Reviewer + 渲染截图 | 是 | 显著提升 |
| Reviewer + 外部工具核验 | 是 | 显著提升 |

可移植规则：

- **工具返回 ok ≠ 任务完成。** 完成判定交给验证器（测试、截图、外部状态查询、用户可见结果）。
- Proposer 生成；Reviewer 必须能接触 Proposer **生成时不存在**的反馈。
- 审查场景：两方模型能力应相近；Sidecar 安全分类看结构化 tool call 即可（ch4）。
- 循环瓶颈在验证器，不在模型（Loop 工程）。

---

## 6. 多 Agent：何时 Manager vs Peer（ch10）

**总判据**：协作是否引入单 Agent 生成时拿不到的新信息？否则先别上多 Agent。

| 模式 | 何时用 | 要点 |
|------|--------|------|
| **对等 Peer**（2–3 Agent） | 迭代改进、防过早终止、生成-验证分工 | 复杂度低；定义角色、通信、终止条件即可；经典 = Proposer-Reviewer |
| **管理者 Manager** | ≥5 子任务、动态调度、复杂依赖、需并行 | Manager 当「项目经理」；子 Agent 当工具；**最强模型给规划者**；子 Agent 回**结构化摘要**不回全轨迹 |
| **去中心化** | 职责对等、控制权需 handoff 流转 | 移交包：任务描述 + 事实约束 + 产物引用 |

上下文是否共享：

| | 共享 | 不共享 |
|--|------|--------|
| 子任务数 | 少（2–3 角色接力） | 多、要并行 |
| 隔离 | 不需要 | 需要（如安全审查不见原始思考） |
| 成本 | 单轨迹累积 | 总 token 常高数倍–一个数量级 |
| 经验法则 | 累计上下文将超窗口 ~50% → 改不共享 + 显式 handoff | |

Manager 反模式：把全文塞进 Manager；弱规划 + 强执行。  
Peer 反模式：无外部反馈的自我审查。

---

## 7. 30 分钟内不要移植

| 不做 | 原因 |
|------|------|
| 模型训练 / RL / 参数更新 | 书中属长周期进化（ch8），非 harness 首刀 |
| 完整 MCP 服务器集群 + 全量 schema 注入 | 数万 token 前缀；先 CLI/少量工具 + 按需发现 |
| 全双工语音管线（实时 ASR/TTS 闭环） | 产品壳能力，与核心循环解耦；先文本循环 + 验证 |
| 完整分层压缩生产栈（五层 + 熔断） | 先 max_iterations + 简单摘要/隔离子 Agent |
| 去中心化 swarm / A2A 跨组织协议 | 先 Peer 或单 Manager |
| 状态栏用 LLM 批统计维护 | 书证明显著更差；用代码 |

**30 分钟最小集：** while 循环 + max_iterations + tool 回传；感知/执行/一条用户沟通；Skill 元数据 + 按需 `SKILL.md`；末尾状态栏（时间/TODO/工具计数，代码写）；完成门至少一种外部验证。

---

*边界：细节以原书为准。本仓映射：任务真值 = typed `AgentRuntime` 事件 ≠ 工具成功；验证用户可见结果（§5）。*
