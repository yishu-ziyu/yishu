# 07 packages/agent-core —— @yishu/agent-core 独立实验室

Type: wiki
Status: current
Verified: 34c0eaa 2026-08-15
Review: packages/agent-core 源码结构变化时

## 模块职责

`@yishu/agent-core`（[packages/agent-core](../../packages/agent-core)）是**书义教学与验收 harness / 独立算法实验室**，用于验证 ReAct、沙箱工具、多 Agent、评估、轨迹与自我改进等实验。它：

- **不是**第二个产品核心，不拥有正式对话/记忆/任务/关系状态；
- **不是** `AgentRuntime` 的模式之一，不被 `packages/runtime` 或 `apps/clicky` 依赖（ADR 0011；边界守卫 grep 拒绝 `@yishu/agent-core` / `AgentCoreRuntime` 出现在产品路径）；
- 完全**离线可复现**：默认 `DeterministicLlm`（规则路由），无需 API Key；
- 成熟能力只能按"独立算法或产品端口"**逐项**迁入 Kernel/Runtime（runtime 的 untrusted-content 防护即从此迁出）。

```text
packages/agent-core/src/
├── types.ts / llm.ts / llm-openai.ts   # 类型 / DeterministicLlm / OpenAI 兼容端
├── harness.ts / cli.ts / index.ts      # YishuAgent 组装 / 15+ CLI 命令
├── loop/react.ts / loop/verify.ts      # ReAct 循环 / 规则 Reviewer
├── tools/  (registry/builtin/dynamic/mcp-adapter/discovery)
├── memory/store.ts / knowledge/store.ts
├── evolution/ (loop/gate/benchmark/diagnose/propose/snapshot/scoreboard/learning-signal/skill-draft)
├── eval/   (harness/judge/stats/significance)
├── multi/  (orchestrator/peer-review/staged-roles)
├── security/injection-guard.ts
├── trajectory/ (recorder/verifier)
├── events/ (bus/async-agent)
└── context/ (compress/skills/status-bar)
```

## 1. LLM 端口

- `LlmPort.complete(messages, tools?) → {type:"text"} | {type:"tool_calls"}`。
- `DeterministicLlm`（llm.ts）：关键词路由的离线大脑（计算→code_exec、记住→memory_write、知识库→knowledge_search…），工具执行后 `synthesizeFromTools()` 合成最终文本（含多跳 RAG 判断）。
- `OpenAiCompatibleLlm`（llm-openai.ts）：OpenAI/OpenRouter/本地代理；`createLlmFromEnv`（`YISHU_AGENT_LLM` / `OPENAI_API_KEY` / `OPENAI_BASE_URL`…）。

## 2. YishuAgent（harness.ts）

中央组装点：注入 workspace/skills/memory/knowledge/trajectories 目录与可选 LLM；`init()` 加载记忆、知识库、动态工具与 MCP 目录。核心方法：

- `run(task)`：注入防护扫描 →（可选）Reviewer 循环 → ReAct → `persistTrajectory`。
- `persistTrajectory`：写轨迹 JSON → 抽学习信号（`extractLearningSignal` → experience.jsonl）→ 轨迹校验 → 满足条件时自动起草 Skill（写 `data/skill-drafts/`，**不污染 live skills/**）。
- `multi/peer/staged/eval`：多 Agent 与评估入口。
- `buildSystemPrompt`：匹配 skills + 注入自进化 promote 后的耐久指令（`data/evolution/state/identity/INSTRUCTIONS.md`）。

## 3. ReAct 循环与 Reviewer

- `runReactAgent`（loop/react.ts）：每轮注入状态栏、`compressMessages`（12k 上限）、工具调用循环、`taskNeedsTools` 守卫（需要工具却没调用 → system nudge 再来一轮）；`TrajectoryRecorder` 全程记录。
- `reviewProposal`（loop/verify.ts）：规则 reviewer——计算任务必须有 code_exec、写文件必须有 write_file 等，拒绝"声称完成但无工具证据"；`runWithReviewer` Proposer-Reviewer 循环（默认 2 轮）。

## 4. 工具子系统

| 模块 | 内容 |
|------|------|
| `registry.ts` | `ToolRegistry`：register/get/list/subset/execute（异常返回 `{ok:false}`） |
| `builtin.ts` | 12 个内置工具：web_search（离线罐头）、list_dir、read_file、write_file、code_exec（安全算术子集）、memory_search/write/promote、knowledge_search/ingest、ask_user、delegate；路径不可逃逸 workspace |
| `dynamic.ts` | 元引导 `create_tool`：echo/const/template 三类（**无任意 JS eval**），持久化 `data/dynamic-tools.json` |
| `mcp-adapter.ts` | 离线 MCP 适配：JSON 描述 → `mcp_<server>_<tool>` 前缀工具（无网络 SDK，无 handler 时返回 stub） |
| `discovery.ts` | 活跃工具发现：`selectToolsForTask` 按任务关键词筛选子集（安全默认全量）；`discover_tools` meta 工具 |

## 5. 记忆与知识库

- `FileMemoryStore`（memory/store.ts）：四层记忆 `working/session/long_term/profile`（LAYER_RANK 排序），JSON 持久化。
- `FileKnowledgeStore`（knowledge/store.ts）：token 重叠打分的轻量 RAG（无向量 DB），空库自动播种 3 条种子文档。

## 6. 自进化闭环（evolution/，最有特色的部分）

`runSelfEvolveRound`（loop.ts）一轮完整闭环（Penguin gate 模式）：

```text
baseline eval（冻结 benchmark）
  → diagnoseFromEval（失败维度 → rootCause + 更新载体 carrier）
  → proposeCandidate（knowledge/instruction/skill 三种载体的最小更新）
  → createSnapshot（mutate 前快照，失败即停）
  → applyCandidate → candidate eval
  → decideGate（boundary：candidate 严格优于 baseline；retention case 不得退化）
  → promote（写 VERSION）/ rollback（restoreSnapshot）
  → appendScoreboard
```

- 可变面 `MUTABLE_PATHS` 仅 3 个文件（identity 指令 / skill / knowledge）。
- benchmark：冻结的 `report-aurora`（+ retention）两条 case，10 维 rubric（内容 + 约定）。
- 在线半环：experience.jsonl 学习信号 → `draftSkillFromTrajectory` Skill 草稿。

## 7. 评估体系（eval/）

- `runEval` + 7 条内置黄金用例（gate：agent-core ≥ 0.75）。
- `judge.ts`：heuristicJudge（离线规则打分）/ llmJudge（JSON score+reasons，失败回退 heuristic）。
- `stats.ts`：Wilson 分数区间；`significance.ts`：mulberry32 确定性 PRNG + bootstrap CI。

## 8. 多 Agent 对照（multi/）

| 模式 | 结构 |
|------|------|
| `ManagerOrchestrator` | 确定性拆分 researcher/coder/reviewer，隔离上下文 + 结构化 handoff |
| `runPeerReviewLoop` | Proposer + Critic 隔离上下文，仅结构化 critique（`ACCEPT:` / `REVISE:`）跨界，≤3 轮 |
| `runStagedRoles` | planner → worker → checker **共享**一条消息历史，仅 system prompt 按阶段切换 |

## 9. 安全 / 轨迹 / 事件 / 上下文

- `injection-guard.ts`：11 条注入规则 + `<untrusted>` 包装 + highRiskReminder（自述"非完整安全边界，只是降低意外指令覆盖"）。
- `trajectory/`：recorder（步骤记录）+ verifier（5 条规则族：空步骤、completed 无 final、数学无 code_exec…）。
- `events/`：优先级队列 EventBus + AsyncAgent（订阅 user.message/task.request/timer.tick，heartbeat 不调 LLM）。
- `context/`：compressMessages（超预算折叠中段）、skills（SKILL.md frontmatter 渐进披露）、status-bar。

## 10. CLI 命令（cli.ts）

| 命令 | 作用 |
|------|------|
| `run "task"` / `multi` / `peer` / `staged` | 单/多 Agent 模式 |
| `eval` / `judge-eval [--judge=heuristic\|llm]` | 评估（+judge 与 CI） |
| `demo` / `serve-events` / `heartbeat-demo` | 演示 |
| `evolve` | 一轮自进化 |
| `status` / `mcp-list` / `experience` | 状态查看 |
| `replay` / `verify` / `promote-skill` | 轨迹回放/校验/Skill 晋升 |

根 package.json 提供 `pnpm agent -- <cmd>`、`pnpm lab:agent:test` 等快捷方式。

## 11. data/ 与 skills/ 目录

- `skills/`：live skills（coding/memory/research 三条手工 SKILL.md）；`promote-skill` 写入处；自动草稿只写 `data/skill-drafts/`。
- `data/`：memory.json、knowledge/index.json、dynamic-tools.json、trajectories/*、evolution/（experience.jsonl、scoreboard.json、state/、snapshots/、work/）、sprint/ 验收记录。

## 12. 测试（test/，28 个文件）

覆盖 agent 核心、async-agent、auto-skill、compress、discovery、dynamic-tool、eval（含扩展）、events、evolution-loop、injection-guard、judge、knowledge、learning-signal、llm-openai、mcp-adapter、memory、multi、peer-review、react、reviewer、sandbox、significance、skills、staged-roles、stats、trajectory-verify。运行：`pnpm agent:test`。
