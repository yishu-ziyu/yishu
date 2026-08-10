# V0 验收：AI Agent Book 最小 Harness（agent-core）

Type: acceptance
Status: historical
As-of: 2026-08-06

## 切片名称

`v0-agent-book-harness`

## 用户路径

用户不打开 macOS App。
在仓库根目录用 CLI 验证：**LLM + 上下文 + 工具** 能转完一轮，并用黄金任务自动判分。

1. 安装依赖：`pnpm install`
2. 单测：`pnpm agent:test`（当前期望 **144** 通过）
3. 固定演示：`pnpm agent:demo`（含 knowledge + mcp-list）
4. 单任务：`pnpm agent -- run "计算 17*19+3"`
5. 多 Agent：`pnpm agent -- multi "搜索 react agent 并计算 10+5"`
6. 评估：`pnpm agent:eval`（**6/6**）

对照文档：

- [能力地图](../agent-book/CAPABILITY_MAP.md)
- [三分钟试用](../agent-book/TRY_ME.md)
- [包 README](../../packages/agent-core/README.md)
- [进化环设计](../agent-book/research/EVOLUTION_LOOP.md)

## 通过条件

### 行为

- 存在工作区包 `@yishu/agent-core`；根目录 `pnpm agent` / `pnpm --filter @yishu/agent-core …` 可解析。
- Agent 循环为 ReAct：`packages/agent-core/src/loop/react.ts` 中模型可发起工具调用，结果写回消息列表，在 `maxIterations`（默认 8）内结束。
- 内置工具至少包含：`code_exec`、`write_file`、`read_file`/`list_dir`、`web_search`、`memory_write`/`memory_search`；另有 `knowledge_search`/`knowledge_ingest`、元工具 `discover_tools`/`create_tool`；路径限制在 `workspaceDir` 内，不可任意 shell。
- `run "计算 17*19+3"`：最终可见文本含 `326`，轨迹中有 `code_exec` 的 `tool_call` / `tool_result`。
- `run` 默认 `enableReview=true`：输出含 `accepted=true|false`；审核步骤写入轨迹 `kind=review`。
- `multi "搜索 react agent 并计算 10+5"`：打印子任务（含 researcher / coder / reviewer 之一或多个）与最终汇总；退出码 0。
- `demo` 无需用户手写 prompt 即可完成多条 `run`、一条 knowledge、`mcp-list` 与一条 `multi`。
- `eval` 对内置黄金集（math / memory-cycle / list-workspace / search / write-file / knowledge）输出每条 PASS/FAIL 与通过率；默认 mock 下不得长期全红却声称切片完成。
- 达到最大步数时轨迹状态为 `max_iterations`（或等价结束），不得死循环。
- 工具错误以 `ok=false` / 错误内容回注上下文或写入轨迹，不得把失败伪装成任务成功。
- 跑过 `run` 后，`packages/agent-core/data/trajectories/` 下存在对应 `<id>.json`；可有旁路 `<id>.signal.json`、`<id>.verify.json`、`<id>.skill.json`。

### 工程

- `pnpm agent:test` 退出码 0（当前 **144/144**）。
- 不记录原始模型凭据、不把截图二进制打进日志。
- 不引入 Kairos / SSE 进度旁路；本切片不把正式 Clicky 语音主路径改成硬依赖。
- 文档路径真实：`docs/agent-book/CAPABILITY_MAP.md`、`docs/agent-book/TRY_ME.md`、本文件、`packages/agent-core/README.md`。

### 命令清单（验收员逐条跑）

在仓库根目录：

```bash
pnpm install
pnpm agent:test
pnpm agent:demo
pnpm agent:eval
pnpm agent -- run "计算 17*19+3"
pnpm agent -- multi "搜索 react agent 并计算 10+5"
pnpm agent -- run "记住：我偏好 tokyonight 主题"
pnpm agent -- run "列目录 ."
```

全部退出码 0，且满足上文行为条款，本切片记为 **通过**。
任一失败：记录命令、stdout/stderr 末段、相关测试文件名；记为 **未通过**。
不得删测试、注释断言或改检查条件放水。

### 可选（不阻塞 V0）

真实 OpenAI 兼容模型：

```bash
YISHU_AGENT_LLM=openai OPENAI_API_KEY=… pnpm agent -- --llm=openai run "计算 17*19+3"
```

无 Key 时跳过；失败只记为可选路径问题，不单独否决离线切片。

多 Agent 变体与事件驱动：

```bash
pnpm agent -- peer "计算 17*19+3"
pnpm agent -- staged "列目录 . 并写 summary.md"
pnpm agent -- serve-events
```

知识库与 Judge + 统计：

```bash
pnpm agent -- run "关于 ReAct 模式"
pnpm agent -- judge-eval
pnpm agent -- judge-eval --judge=heuristic
# 可选 LLM judge（需 Key）：
# pnpm agent -- --llm=openai judge-eval --judge=llm
```

期望 `judge-eval` 打印 gold 通过率、judge 通过率、Wilson 比例 CI、bootstrap 均值 CI。

离线 MCP 适配：

```bash
pnpm agent -- mcp-list
# 配置目录：packages/agent-core/data/mcp/*.json
```

动态工具（书 Ch5 安全子集）：

```bash
pnpm agent -- run "创建工具 greeter kind=const body=hello-from-dynamic"
# 落盘：packages/agent-core/data/dynamic-tools.json
```

轨迹离线校验（需已有轨迹文件）：

```bash
pnpm agent -- verify packages/agent-core/data/trajectories/<id>.json
```

自动 Skill 草稿与晋升（书 Ch8）：

```bash
# run 成功后：data/skill-drafts/ 有草稿；trajectories/<id>.skill.json 旁路
# 不污染 live skills/（coding/memory/research 除外的 generated 不应由 auto 写入）
pnpm agent -- promote-skill packages/agent-core/data/trajectories/<id>.json --dry-run
pnpm agent -- promote-skill packages/agent-core/data/trajectories/<id>.json
```

自进化一轮（书 Ch8 离线环；产物写入 `packages/agent-core/data/evolution/`）：

```bash
pnpm agent:evolve
# 或：pnpm agent -- evolve
```

期望可观察：baseline/candidate mean、gate 决策（promote 或 rollback）、`scoreboard.json` 追加、`state/identity/INSTRUCTIONS.md` 在 promote 后有内容。
`gate.decision !== promote` 时 CLI 可能 exit 2（例如当前状态已满分、无提升空间）；这不否决 V0 主路径，但应记录 stdout。

## 未纳入本切片

以下在磁盘上仍**未实现**（或明确不在 agent-core 范围），不要写进本切片通过条件：

- 向量库 / embedding 索引（当前知识库是文件 JSON + token 重叠打分，不是向量 RAG）。
- 远端 MCP 网络客户端 / 完整 MCP SDK 会话（当前是本地 JSON + 进程内 handler/stub）。
- Coding Agent 全能力、任务单元隔离（书 Ch5 全量；当前仅窄文件工具 + create_tool 安全子集）。
- 模型后训练（书 Ch7；奕枢不训练底座）。
- agent-core 内全双工语音环（语音在产品 Clicky / 开发壳，见 `v0-context-voice`）。
- 机器人 / VLA（书 Ch9；产品范围外）。
- 将 `agent-core` 接到 Clicky 正式语音回合的产品验收（接线类代码可有，不在本切片强制路径）。
- 运行时**自动**把草稿写进 live `skills/`（auto 只写 `data/skill-drafts/`；live 晋升靠 `promote-skill`）。

**已从「未纳入」移出（磁盘上已有）：**

- 书 Ch3 轻量知识库：`knowledge/store.ts` + `knowledge_search` / `knowledge_ingest`。
- 书 Ch4 离线 MCP 适配：`tools/mcp-adapter.ts` + CLI `mcp-list`。
- 书 Ch5 动态工具安全子集：`tools/dynamic.ts` + `create_tool` + `data/dynamic-tools.json`。
- 书 Ch6 heuristic / optional LLM judge：`eval/judge.ts` + CLI `judge-eval`。
- 书 Ch6 统计：`eval/stats.ts` Wilson CI + `eval/significance.ts` bootstrap；`judge-eval` 打印。
- 书 Ch8 自进化环：`evolution/loop.ts` + CLI `evolve` / `pnpm agent:evolve`。
- 书 Ch8 自动 Skill 草稿（隔离目录）+ CLI `promote-skill`。
- Peer / staged 多 Agent：`multi/peer-review.ts`、`multi/staged-roles.ts`。
- 事件驱动 CLI demo：`serve-events`。
- 轨迹规则校验：`trajectory/verifier.ts` + CLI `verify` + 旁路 `.verify.json`。

## 与 v0-context-voice 的边界

| 切片 | 验证什么 | 入口 |
|------|----------|------|
| `v0-context-voice` | 桌面证据上下文 + 语音/浮层 + Runtime 协议 | `./script/build_and_run.sh`、Swift/TS 测试 |
| `v0-agent-book-harness` | 书义最小 Agent 环 + CLI + eval + multi | `pnpm agent…` / `@yishu/agent-core` |

两者都通过，才同时具备「产品交互切片」与「书义 Agent 公式可跑」。
只过其一不算另一侧完成。

## 残余风险

- 默认 `DeterministicLlm` 按中文/英文关键词路由工具；换表述可能漏工具 → 用 `eval` 与固定 demo 句式验收环本身。
- 真实模型路径依赖网络与 Key，稳定性与 mock 不同。
- `packages/agent-core` 与 `packages/runtime` 若日后合并，必须保持 `AgentRuntime` 为产品任务真相边界。
- `multi` / `peer` / `staged` 是角色协作教学环，不是第二个产品身份；用户可见汇总仍以「奕枢」教学 CLI 呈现。
- `evolve` 会改写 `data/evolution/state/` 并写 snapshot；重复跑时 baseline 可能已是满分，gate 可能 rollback（无提升），属预期而非环损坏。
- reviewer 规则若只认 `web_search` 为「搜索」，`knowledge_search` 完成的任务可能出现 `accepted=false` 但仍有正确最终文本；以 eval 黄金断言与可见答案为准，不要单靠 `accepted` 否决知识库路径。
- 历史可能残留 `skills/generated-*`（早期 auto 写 live 的产物）；当前实现 auto 只写 `data/skill-drafts/`，验收以当前代码与单测为准。
