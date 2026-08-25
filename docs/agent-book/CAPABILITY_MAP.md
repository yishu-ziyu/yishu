# AI Agent Book × 奕枢能力对照

Type: architecture
Status: current
Verified: dd5a362 2026-08-23
Review: agent-core 能力对照变化时

本书（《深入理解 AI Agent》，bojieli/ai-agent-book）与本仓库的对照。
书讲通用 Agent 公式与工程；奕枢是个人桌面 Agent Super App。
本表只写**现在磁盘上有什么**。AgentCore 实验室以 `packages/agent-core/src/**/*.ts` 与 `packages/agent-core/test/*.ts` 为准；正式产品能力以 `packages/kernel`、`packages/runtime/src/model-loop/` 和 `YishuLoopRuntimeAdapter` 接线为准。

证据（本机，2026-08-06）：

- `pnpm --filter @yishu/agent-core test` / `pnpm agent:test` → **153** 通过（含 knowledge / mcp / judge / stats / significance / dynamic / auto-skill / memory layers）
- `pnpm agent:eval` → **7/7**（100%；含 knowledge + knowledge-write）
- `pnpm agent -- judge-eval` / `pnpm agent:judge` → gold 7/7 + heuristic judge 7/7 + Wilson CI + bootstrap 均值 CI
- `pnpm agent:evolve` → 离线自进化一轮（gate promote/rollback + scoreboard）
- `pnpm agent -- mcp-list` / `pnpm agent:mcp` → 从 `data/mcp/*.json` 注册离线 MCP 工具
- `pnpm agent -- experience` / `pnpm agent:experience` → 回放 `experience.jsonl` 学习信号
- `pnpm agent -- heartbeat-demo` / `pnpm agent:heartbeat` → EventBus + timer.tick 心跳 demo
- `pnpm agent -- run "创建工具 greeter kind=const body=hello-from-dynamic"` → `create_tool`（Ch5）
- `pnpm agent -- promote-skill <traj.json>` → 草稿晋升到 `skills/`
- `pnpm product:check`（2026-08-23）→ 边界、Kernel、Runtime 与 Swift 核心验证通过；奕枢自有 model-tool loop 为唯一正式 Agent 循环

## 1. 公式

```text
Agent = LLM + 上下文 + 工具
```

生产可靠时再包一层：

```text
Agent = Model + [上下文 + 工具 + 约束 + 验证 + 纠正]
```

| 部件 | 书中含义 | 本仓库现状 |
|------|----------|------------|
| LLM | 决策与工具选择 | `agent-core`：默认 `DeterministicLlm`（离线规则路由）；可选 `OpenAiCompatibleLlm`（`llm-openai.ts`），仅作实验。产品：`packages/runtime` 只装配自有 model-tool loop 与 Clicky 模型路由。 |
| 上下文 | 每步模型可见信息 | `agent-core` 实验室：消息列表 + 状态栏 + 压缩 + Skills + 知识库检索结果 + 分层记忆 + 已晋升的 `INSTRUCTIONS.md`。产品：证据化 `ContextFrame` + Kernel memory/trail，经 Runtime 注入自有循环。 |
| 工具 | 可执行动作 | `agent-core` 实验室：内置 12 个 + 元工具 + 离线 MCP + 动态工具。产品：自有循环只装配产品 tools、能力档案、委派与桌面 `computer.action.*`，不带旧引擎内置开发工具。 |
| 约束 / 验证 / 纠正 | 不越界、可检、可恢复 | `agent-core` 实验室：步数上限、路径沙箱、proposer–reviewer、轨迹校验与 evolve gate。产品：Kernel authority/TaskTruth、Runtime capability profiles、typed cancellation、fresh verification 和可见回执。 |

**工具成功 ≠ 任务完成**：实验室 `run` 用 reviewer/trajectory 验证；正式产品由 Kernel `TaskTruth` 和 fresh evidence 判定，模型停止生成不等于任务完成。

## 2. `packages/agent-core` 源码布局（现存）

```text
packages/agent-core/src/
  harness.ts                 YishuAgent（run/multi/peer/staged/eval；knowledge + MCP + dynamic tools 初始化）
  cli.ts                     yishu-agent CLI
  llm.ts                     DeterministicLlm
  llm-openai.ts              OpenAI 兼容客户端 + 环境变量工厂
  types.ts                   消息 / 轨迹 / 配置
  loop/react.ts              ReAct 循环
  loop/verify.ts             proposer–reviewer
  tools/registry.ts          工具注册表（含 subset）
  tools/builtin.ts           内置工具（含 knowledge_search / knowledge_ingest）
  tools/discovery.ts         活跃工具发现 + discover_tools
  tools/mcp-adapter.ts       离线 MCP JSON → ToolDefinition
  tools/dynamic.ts           create_tool（echo/const/template）+ DynamicToolStore
  knowledge/store.ts         FileKnowledgeStore（token 重叠检索，非向量库）
  memory/store.ts            JSON 记忆卡（layers: working|session|long_term|profile；promoteMemory）
  context/status-bar.ts
  context/compress.ts
  context/skills.ts
  trajectory/recorder.ts
  trajectory/verifier.ts     轨迹规则校验（落盘 + CLI verify）
  multi/orchestrator.ts      Manager + 专员
  multi/peer-review.ts       Proposer + Critic 隔离协作
  multi/staged-roles.ts      planner → worker → checker
  eval/harness.ts            黄金任务 7 条（含 knowledge + knowledge-write）
  eval/judge.ts              heuristic / llm judge + runEvalWithJudge
  eval/stats.ts              Wilson 比例 CI + comparePassRates
  eval/significance.ts       bootstrap 均值 CI / 配对 diff
  events/bus.ts
  events/async-agent.ts      serve-events / heartbeat-demo
  evolution/learning-signal.ts
  evolution/skill-draft.ts   轨迹 → Skill 草稿；writeSkillDraft
  evolution/loop.ts          自进化一轮
  evolution/benchmark.ts
  evolution/diagnose.ts
  evolution/propose.ts
  evolution/gate.ts
  evolution/snapshot.ts
  evolution/scoreboard.ts
  evolution/types.ts
  security/injection-guard.ts
  index.ts
```

AgentCore 不再有 `packages/runtime` 适配器。正式 Runtime 只提供 `YishuLoopRuntimeAdapter`，另保留不含模型工具循环的 `MockAgentRuntime` 协议测试替身。

数据目录（相对 `packages/agent-core/`）：

```text
data/
  memory.json
  knowledge/index.json       # FileKnowledgeStore
  mcp/*.json                 # 离线 MCP 服务器描述（例：example-server.json）
  dynamic-tools.json         # create_tool 持久化（echo/const/template）
  skill-drafts/              # 自动 Skill 草稿（不进 live skills/）
  trajectories/<id>.json | .signal.json | .verify.json | .skill.json
  evolution/
    experience.jsonl
    scoreboard.json
    state/identity/INSTRUCTIONS.md
    snapshots/v*/
    work/{baseline,candidate}/
```

内置工具（`tools/builtin.ts`）+ 元工具 + 动态 + MCP：

| 工具 | 类别 | 作用 |
|------|------|------|
| `web_search` | perception | 离线罐装检索 |
| `list_dir` | perception | 列工作区 |
| `read_file` | perception | 读工作区文件 |
| `write_file` | execution | 写工作区文件（不可逃逸） |
| `code_exec` | execution | 安全算术（非任意代码） |
| `memory_write` | execution | 写记忆卡 → `data/memory.json`（默认 layer=`session`） |
| `memory_search` | perception | 按关键词搜记忆（可按 layer 过滤；排序 profile > long_term > session > working） |
| `memory_promote` | execution | 将记忆卡晋升到目标 layer（working → session → long_term → profile） |
| `knowledge_search` | perception | 知识库 token 重叠检索 |
| `knowledge_ingest` | execution | 写入知识库条目 |
| `ask_user` | communication | 离线占位：需要用户输入 |
| `delegate` | collaboration | 记录交接请求（不真正 spawn） |
| `discover_tools` | meta | 按需列出工具 catalog |
| `create_tool` | meta | 动态注册 echo/const/template → `data/dynamic-tools.json` |
| `mcp_<server>_<tool>` | 视配置 | `data/mcp/*.json` 注册的适配工具 |
| 动态工具名 | 视落盘 | 下次 `init` 从 `dynamic-tools.json` 重载 |

Skills 目录：

- 直播：`packages/agent-core/skills/{coding,memory,research}/SKILL.md`
- 自动草稿：`packages/agent-core/data/skill-drafts/`（**不**写进 live `skills/`）
- 晋升：`pnpm agent -- promote-skill <trajectory.json>` → 写入 `skills/`

CLI 子命令（`cli.ts` + 根脚本）：

| 命令 | 作用 | 根脚本 / 调用 |
|------|------|----------------|
| `run` | 单 Agent ReAct（默认审核；可走 create_tool） | `pnpm agent -- run "…"` |
| `multi` | Manager + 专员 | `pnpm agent -- multi "…"` |
| `peer` | Proposer + Critic | `pnpm agent -- peer "…"` |
| `staged` | planner → worker → checker | `pnpm agent -- staged "…"` |
| `eval` | 黄金任务 7 条 | `pnpm agent:eval` |
| `judge-eval` | 黄金集 + heuristic/llm judge + Wilson/bootstrap | `pnpm agent:judge` |
| `demo` | 固定演示序列（含 knowledge + mcp-list） | `pnpm agent:demo` |
| `serve-events` | EventBus + AsyncAgent demo | `pnpm agent -- serve-events` |
| `heartbeat-demo` | timer.tick + 两条消息的心跳/异步 demo | `pnpm agent:heartbeat` |
| `evolve` | 离线自进化一轮 | `pnpm agent:evolve` |
| `mcp-list` | 列出已注册 MCP 工具 | `pnpm agent:mcp` |
| `experience` / `replay` | 回放 `experience.jsonl` 最近 N 条学习信号 | `pnpm agent:experience` |
| `verify <path>` | 离线校验轨迹 JSON | `pnpm agent -- verify <traj>` |
| `promote-skill <path>` | 轨迹草稿晋升到 live skills/（`--dry-run` 只打印） | `pnpm agent -- promote-skill <traj>` |

## 3. 章节能力对照表

状态：

- **已有（agent-core）**：包内有源码与测试；主路径、CLI 或导出 API 可用。
- **已有（产品）** / **已有（产品接线）**：Clicky / `packages/runtime` / 根 Swift contract。
- **未做**：磁盘上无对应实现。

| 书中能力 | 状态 | 路径 | 怎么试 |
|----------|------|------|--------|
| Ch1 公式：LLM + 上下文 + 工具 | 已有（agent-core） | `harness.ts`；`llm.ts` / `llm-openai.ts` | `pnpm agent:demo` |
| Ch1 ReAct | 已有（agent-core） | `loop/react.ts` | `pnpm agent -- run "计算 17*19+3"` |
| Ch1 编排 | 已有（产品 + agent-core） | `loop/react.ts`、`multi/*` | `run` / `multi` / `peer` / `staged` |
| Ch1 Harness | 已有（agent-core） | `loop/verify.ts`；沙箱；`trajectory/verifier.ts`；`evolution/gate.ts` | `pnpm agent:eval`；`verify`；`evolve` |
| Ch2 消息列表 | 已有（agent-core） | `loop/react.ts` + `types.ts` | `run` 轨迹 JSON |
| Ch2 状态栏 | 已有（agent-core） | `context/status-bar.ts` | 轨迹 `kind=status` |
| Ch2 上下文压缩 | 已有（agent-core） | `context/compress.ts` | `test/compress.test.ts` |
| Ch2 Agent Skills | 已有（agent-core） | `context/skills.ts`；`skills/*/SKILL.md` | 任务含 coding/memory/research 关键词 |
| Ch2 提示注入防护 | 已有（agent-core） | `security/injection-guard.ts` | `injection-guard.test.ts` |
| Ch2 桌面证据上下文 | 已有（产品） | `apps/clicky`；`Sources/YishuContext`；`packages/runtime` context 协议 | [v0-context-voice](../acceptance/v0-context-voice.md) |
| Ch3 用户记忆（分层） | 已有（agent-core，文件级） | `memory/store.ts`：layers `working` \| `session` \| `long_term` \| `profile`；`memory_write` / `memory_search` / `memory_promote` → `data/memory.json` | `run "记住：…"`；单测 `memory` store（layer 排序 / promote） |
| Ch3 知识库 / 轻量 RAG | 已有（agent-core，文件级 token 检索） | `knowledge/store.ts`；`knowledge_search` / `knowledge_ingest`；`data/knowledge/index.json` | `run "关于 ReAct 模式"`；`eval` knowledge + knowledge-write |
| Ch3 向量库 / embedding 索引 | 未做 | 当前无 embedding / ANN；是 token 重叠打分 | — |
| Ch4 工具分类与 ACI | 已有（agent-core） | `tools/builtin.ts`；`tools/registry.ts` | `run` 观察工具名 |
| Ch4 活跃工具发现 | 已有（agent-core） | `tools/discovery.ts` | `discovery.test.ts` |
| Ch4 MCP 互操作 | 已有（agent-core，离线适配） | `tools/mcp-adapter.ts`；`data/mcp/*.json`；无网络 MCP SDK | `pnpm agent -- mcp-list` |
| Ch4 执行安全（沙箱） | 已有（agent-core，部分） | `resolveWorkspacePath`；`code_exec` 仅算术 | 写文件不可逃逸 workspace |
| Ch4 事件驱动异步 Agent | 已有（agent-core） | `events/bus.ts`；`events/async-agent.ts` | `pnpm agent -- serve-events`；`pnpm agent:heartbeat` |
| Ch5 Coding Agent / 文件系统 | 已有（仅 agent-core 窄实验） | `list_dir`/`read_file`/`write_file`/`code_exec`；产品循环不带旧引擎内置开发工具 | `run "列目录 ."` |
| Ch5 代码元能力自举 | 已有（agent-core，离线安全子集） | `tools/dynamic.ts`：`create_tool` 仅 echo/const/template；落盘 `data/dynamic-tools.json`；下次 `init` 重载 | `run "创建工具 greeter kind=const body=hello"`；单测 `dynamic-tool.test.ts` |
| Ch6 评估环境与黄金任务 | 已有（agent-core） | `eval/harness.ts`；7 用例（含 knowledge + knowledge-write） | `pnpm agent:eval`（7/7） |
| Ch6 LLM-as-Judge | 已有（agent-core） | `eval/judge.ts`：`heuristicJudge` / `llmJudge` / `runEvalWithJudge` | `pnpm agent -- judge-eval`；`--judge=llm` 需真实模型 |
| Ch6 统计显著性 | 已有（agent-core） | `eval/stats.ts` Wilson 比例 CI + `comparePassRates`；`eval/significance.ts` bootstrap 均值 CI / 配对 diff | `judge-eval` 打印 Wilson + bootstrap；单测 `stats.test.ts` / `significance.test.ts` |
| Ch7 模型后训练 | 未做 | 奕枢不训练底座 | — |
| Ch8 轨迹记录 | 已有（agent-core） | `trajectory/recorder.ts` | 任意 `run` 后看 `data/trajectories/` |
| Ch8 轨迹校验 | 已有（agent-core） | `trajectory/verifier.ts` | `pnpm agent -- verify <traj>` |
| Ch8 轨迹 → 学习信号 | 已有（agent-core） | `evolution/learning-signal.ts`；`.signal.json`；`experience.jsonl` | `run` 后查看旁路文件；`pnpm agent:experience` / `replay` |
| Ch8 轨迹 → Skill 草稿 | 已有（agent-core） | `evolution/skill-draft.ts`；自动草稿进 `data/skill-drafts/` + `<id>.skill.json` | `run` 后看 `data/skill-drafts/`；单测 `auto-skill.test.ts` |
| Ch8 草稿晋升 live Skill | 已有（agent-core） | CLI `promote-skill`；写 `skills/<name>/SKILL.md` | `pnpm agent -- promote-skill <traj.json>`（`--dry-run` 只打印） |
| Ch8 自进化环 | 已有（agent-core） | `evolution/loop.ts` + gate/snapshot/scoreboard | `pnpm agent:evolve` |
| Ch8 晋升回馈进 prompt | 已有（agent-core） | `harness.ts` 读 `INSTRUCTIONS.md` | promote 后再 `run` |
| Ch8 运行时自动挂载 Skill | 已有（agent-core，gated 草稿） | `harness.maybeAutoDraftSkill`：`enableAutoSkillDraft` 默认 true；验证通过 + 有生产工具 → **只写** `data/skill-drafts/` + `<id>.skill.json`（`promoted:false`）；**不**污染 live `skills/` | 单测 `auto-skill.test.ts`；晋升用 `promote-skill`（eval/judge 路径显式关掉 auto draft） |
| Ch9 语音实时交互 | 已有（产品） | 二开 Clicky PTT + ASR + TTS | 正式壳按住说话 |
| Ch9 Computer Use | 已有（产品，窄） | `packages/runtime` computer-use 端口 | 点名控件点击 |
| Ch9 机器人 / VLA | 未做 | 产品范围外 | — |
| Ch10 Manager 编排 | 已有（agent-core） | `multi/orchestrator.ts` | `pnpm agent -- multi "…"` |
| Ch10 Peer 协作 | 已有（agent-core） | `multi/peer-review.ts` | `pnpm agent -- peer "…"` |
| Ch10 分阶段角色 | 已有（agent-core） | `multi/staged-roles.ts` | `pnpm agent -- staged "…"` |
| 产品身份 / 人格 | 已有（产品） | `docs/persona.md`；`packages/runtime/src/persona.ts` | 可见身份是否始终为「奕枢」 |
| 产品正式 Agent 循环 | 已有（产品） | `packages/runtime/src/model-loop/` + `packages/runtime/src/loop-adapter.ts` | `pnpm product:check` |

说明：

- `@yishu/agent-core` 是可独立跑的书义 harness，**不是**产品 Runtime 模式或依赖。
- 正式交互与可见验收都在 Clicky；共享 Swift package 只承载 ContextFrame 协议与测试。
- 产品侧接入只允许经 `AgentRuntime`，禁止 Kairos 类旁路。
- 知识库是 **文件 JSON + token 重叠打分**，不是向量 RAG。
- MCP 是 **本地 JSON 描述 + 进程内 handler/stub**，不是连远端 MCP 服务器的完整 SDK 客户端。
- `judge-eval` 的默认路径是 **heuristic**；`--judge=llm` 才走 LLM-as-Judge，解析失败会回退 heuristic。
- 自动 Skill 草稿与 live Skills 分离：草稿在 `data/skill-drafts/`，人工/CLI `promote-skill` 才进 `skills/`。

## 4. 分层关系

```text
书义 AgentCore 实验室
  CLI: run / multi / peer / staged / eval / judge-eval /
       demo / serve-events / heartbeat-demo / evolve /
       mcp-list / experience|replay / verify / promote-skill
  根脚本: lab:agent:test | lab:agent:eval | lab:agent:demo
  与正式 Runtime 无依赖或模式接线

正式产品
  Clicky → Kernel → packages/runtime
  AgentRuntime 协议
  ├── YishuLoopRuntimeAdapter（唯一正式 Agent 循环；mode=pi 是兼容值）
  └── MockAgentRuntime（协议测试替身，mode=mock）
        │
        ▼
  Clicky（语音、光标、ContextFrame、TTS）+ 根 Swift contract tests
```

## 5. 验收与试用入口

```bash
pnpm agent:test                                    # 153/153
pnpm agent:eval                                    # 7/7
pnpm agent:judge                                   # gold + heuristic judge + Wilson/bootstrap
pnpm agent:demo
pnpm agent:evolve
pnpm agent:mcp
pnpm agent:heartbeat
pnpm agent:experience
pnpm agent -- run "计算 17*19+3"
pnpm agent -- run "关于 ReAct 模式"
pnpm agent -- run "创建工具 greeter kind=const body=hello-from-dynamic"
pnpm agent -- multi "搜索 react agent 并计算 10+5"
pnpm agent -- peer "计算 17*19+3"
pnpm agent -- staged "列目录 . 并写 summary.md"
pnpm agent -- serve-events
pnpm agent -- verify packages/agent-core/data/trajectories/<id>.json
pnpm agent -- promote-skill packages/agent-core/data/trajectories/<id>.json
pnpm product:check                                 # 正式 Kernel + Yishu Runtime + Swift
# AgentCore 只能通过 lab/agent CLI 独立试验，不能切为产品 Runtime
```

通过标准：[v0-agent-book-harness](../acceptance/v0-agent-book-harness.md)。
三分钟上手：[TRY_ME.md](./TRY_ME.md)。
进化设计真源：[research/EVOLUTION_LOOP.md](./research/EVOLUTION_LOOP.md)。

## 6. 明确未做（不要写进「已有」）

- Ch7 模型后训练（奕枢不训练底座）
- 向量 embedding / ANN 索引（当前知识库是 token 重叠，不是向量 RAG）
- 远端 MCP SDK 会话（仅本地 JSON + 进程内 handler/stub）
- 机器人 / VLA
- agent-core 内全双工语音环（语音在产品 Clicky）
