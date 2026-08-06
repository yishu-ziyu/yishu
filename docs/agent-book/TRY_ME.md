# 三分钟试用 · 奕枢 agent-core

基于书中公式：**Agent = LLM + 上下文 + 工具**。

默认离线、规则 LLM（`DeterministicLlm`），不需要 API Key。

证据（本机，2026-08-06）：

- `pnpm agent:test` → **153** 通过
- `pnpm agent:eval` → **7/7**（含 knowledge + knowledge-write）
- `pnpm agent:judge` → gold 7/7 + judge 7/7 + Wilson/bootstrap CI
- `pnpm agent:evolve` → 离线自进化一轮（gate + scoreboard）
- runtime 单测 → **22** 通过

## 1. 安装

在仓库根目录：

```bash
cd /Users/mahaoxuan/Documents/我的agent
pnpm install
```

需要 Node.js ≥ 22.19。

## 2. 跑通验收

```bash
pnpm agent:test
pnpm agent:eval          # 7/7
pnpm agent:judge          # 黄金集 + 离线 judge + Wilson/bootstrap
pnpm agent:demo           # 含 knowledge + mcp-list
pnpm agent:status         # 可选：离线路径与计数（无 LLM）
pnpm agent:evolve         # 可选：自进化一轮
pnpm agent:mcp            # 可选：列出离线 MCP 工具
pnpm agent:heartbeat      # 可选：EventBus 心跳 demo
pnpm agent:experience     # 可选：回放 experience.jsonl
```

等价写法（filter 包名）：

```bash
pnpm --filter @yishu/agent-core test
pnpm --filter @yishu/agent-core cli -- eval
pnpm --filter @yishu/agent-core cli -- judge-eval
pnpm --filter @yishu/agent-core cli -- demo
pnpm --filter @yishu/agent-core cli -- evolve
pnpm --filter @yishu/agent-core cli -- mcp-list
pnpm --filter @yishu/agent-core cli -- heartbeat-demo
pnpm --filter @yishu/agent-core cli -- experience
```

## 3. CLI 全命令

根脚本 `pnpm agent -- <cmd>` 等价 `yishu-agent <cmd>`（包 bin → `dist/cli.js`；开发可用 `pnpm --filter @yishu/agent-core cli -- …`）。

根快捷脚本：`agent:test` / `agent:eval` / `agent:demo` / `agent:status` / `agent:evolve` / `agent:judge` / `agent:mcp` / `agent:heartbeat` / `agent:experience`。

```bash
# 单 Agent ReAct（默认审核）
pnpm agent -- run "计算 17*19+3"
pnpm agent -- run "记住：我偏好 tokyonight 主题"
pnpm agent -- run "列目录 ."
pnpm agent -- run "搜索 agent memory"
pnpm agent -- run "写文件 try.md 内容 hello-yishu"
pnpm agent -- run "关于 ReAct 模式"          # knowledge_search
# 也可：pnpm agent -- run "搜索知识库 ReAct"
pnpm agent -- run "创建工具 greeter kind=const body=hello-from-dynamic"  # Ch5 create_tool

# 多 Agent
pnpm agent -- multi "搜索 react agent 并计算 10+5"
pnpm agent -- peer "计算 17*19+3"
pnpm agent -- staged "列目录 . 并写 summary.md"

# 评估 / Judge / 演示
pnpm agent -- eval
pnpm agent -- judge-eval
pnpm agent -- judge-eval --judge=heuristic
# 需要真实模型时：
# pnpm agent -- --llm=openai judge-eval --judge=llm
pnpm agent -- demo
# 或：pnpm agent:eval / pnpm agent:demo / pnpm agent:judge

# 事件驱动（EventBus + AsyncAgent）
pnpm agent -- serve-events
pnpm agent:heartbeat      # timer.tick + 两条用户消息

# 离线自进化（书 Ch8）
pnpm agent:evolve
# 或：pnpm agent -- evolve

# 离线状态（路径 + 计数，无 LLM）
pnpm agent:status
# 或：pnpm agent -- status

# 经验回放（Ch8 experience.jsonl）
pnpm agent:experience
# 或：pnpm agent -- experience [--n=10]

# 离线 MCP 适配工具列表
pnpm agent:mcp
# 或：pnpm agent -- mcp-list

# 轨迹回放 / 校验 / Skill 晋升（路径从仓库根即可解析）
pnpm agent -- replay packages/agent-core/data/trajectories/<id>.json
pnpm agent -- verify packages/agent-core/data/trajectories/<id>.json
# Skill 草稿晋升到 live skills/（先有轨迹；--dry-run 只打印）
pnpm agent -- promote-skill --dry-run packages/agent-core/data/trajectories/<id>.json
pnpm agent -- promote-skill packages/agent-core/data/trajectories/<id>.json
```

帮助与 LLM 开关：

```bash
pnpm agent -- --help
pnpm agent -- --llm=mock run "计算 1+1"
# 需要真实模型时（另配密钥）：
# pnpm agent -- --llm=openai run "计算 1+1"
```

## 4. 你应该看到什么

- 终端有 `tool` / `result` / `final` 行；`run` 末尾有 `accepted=` 与 `trajectory=<id>`。
- 计算走 `code_exec`，答案含 `326`（17×19+3）。
- 记忆写入 `packages/agent-core/data/memory.json`。
  - 分层：`working` | `session` | `long_term` | `profile`（默认 `session`）。
  - 工具：`memory_write` / `memory_search` / `memory_promote`（晋升 layer）。
  - 搜索排序：profile > long_term > session > working。
- 知识库在 `packages/agent-core/data/knowledge/index.json`（`knowledge_search` / `knowledge_ingest`）。
- 轨迹落在 `packages/agent-core/data/trajectories/<id>.json`。
- 同目录可有 `<id>.signal.json`、`<id>.verify.json`、`<id>.skill.json`（自动草稿旁路）。
- 自动 Skill 草稿进 `packages/agent-core/data/skill-drafts/`（**不**写 live `skills/`）；`promote-skill` 才晋升。
- `create_tool` 持久化到 `packages/agent-core/data/dynamic-tools.json`；下次 init 重载（仅 echo/const/template）。
- `run` 可向 `packages/agent-core/data/evolution/experience.jsonl` 追加经验行；`experience` 回放最近 N 条。
- 工作区在 `packages/agent-core/workspace/`。
- 审核未通过时 `accepted=false`：工具成功不等于任务完成。
- `multi` 打印子任务角色与交接摘要。
- `peer` 打印 Proposer / Critic 轮次与是否 ACCEPT。
- `staged` 打印 planner → worker → checker 各阶段输出。
- `serve-events` 打印事件 drain 与最终回答。
- `heartbeat-demo` 打印 heartbeats 与 results（timer.tick + 消息）。
- `judge-eval` 每条既有 GOLD-PASS/FAIL，也有 `judge=0.xx PASS|FAIL (heuristic|llm)`，并打印 Wilson / bootstrap CI。
- `evolve` 打印 baseline/candidate mean、diagnosis、gate、scoreboard 与 snapshot。
- promote 后可读 `packages/agent-core/data/evolution/state/identity/INSTRUCTIONS.md`。
- `mcp-list` 打印 `data/mcp/` 下已注册的 `mcp_<server>_<tool>` 名称。
- `status` 打印 data 路径与 memory / trajectories / experience 计数。
- `replay <traj.json>` 打印轨迹时间线（不重跑工具）；路径从仓库根可解析。
- `verify` 打印 `ok` / `score` / `issues`，失败 exit code 2。
- `promote-skill` 打印 skill name 与 written 路径；`--dry-run` 可放在路径前或后，只打印草稿正文。

## 5. 可选：接 OpenAI 兼容 API

默认 mock。要走真实模型：

```bash
export YISHU_AGENT_LLM=openai
export OPENAI_API_KEY=sk-...
# 或 OPENROUTER_API_KEY=...
# 可选：OPENAI_BASE_URL  OPENAI_MODEL  OPENAI_TIMEOUT_MS
pnpm agent -- --llm=openai run "计算 17*19+3"
pnpm agent -- --llm=openai judge-eval --judge=llm
```

没有 Key 时不要设 `YISHU_AGENT_LLM=openai`，否则会报错退出。

## 6. 产品 Runtime 切 agent-core

`packages/runtime` 的 `createAgentRuntime` 支持三种模式：`pi`（默认）/ `mock` / `agent-core`。

```bash
export YISHU_RUNTIME_MODE=agent-core
# 之后 createAgentRuntime() → AgentCoreRuntime（包装 YishuAgent）
```

实现：`packages/runtime/src/agent-core-runtime.ts`。
产品代码仍只依赖 `AgentRuntime` 协议，不直接 import agent-core 类型。

## 7. 文档

- 能力对照：`docs/agent-book/CAPABILITY_MAP.md`
- 书中模式笔记：`docs/agent-book/BOOK_PATTERNS.md`
- 进化环设计：`docs/agent-book/research/EVOLUTION_LOOP.md`
- 切片验收：`docs/acceptance/v0-agent-book-harness.md`
- 包说明：`packages/agent-core/README.md`
- 当日冲刺记录：`docs/agent-book/SPRINT_2026-08-06.md`
