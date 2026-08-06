# PenguinHarness 自进化机制研究

来源：`/tmp/agent-research/penguin-harness`（https://github.com/Prism-Shadow/penguin-harness.git）  
结论：**自进化 = 可编辑的 Agent 状态文件 + 私有 rubric 的 Benchmark + 严格分数门禁 + 快照回滚**。不改模型权重；评测/优化是普通 Session + 普通文件编辑，由 Skill 编排。

---

## 1. 架构总览

```text
┌─ 步骤 A：Builder 顶层 Session ─────────────────────────────┐
│  agent-creation → 写 Target 的 AGENTS.md / 装 Skills       │
│  benchmark-design → 多 Case 题库 + Pilot 校准 → Freeze      │
│       └─ run_subagent → agent-evaluation（叶子）× Case×1  │
│            penguin CLI 在隔离 workspace 跑 Target            │
│  最低/达标 Pilot 记为 Formal Baseline → scoreboard.yaml    │
└────────────────────────────────────────────────────────────┘
                        用户确认后，新对话
┌─ 步骤 B：Optimizer 顶层 Session ───────────────────────────┐
│  agent-optimization                                        │
│    诊断 Trace/分数 → 假说 → Candidate 改 agent_state       │
│    改前 snapshots/vN.tar.gz                                 │
│    run_subagent → agent-evaluation × Case × runs（并行）  │
│    分数严格 > Reference → 接受并 append scoreboard         │
│    否则回滚文件 + version                                  │
└────────────────────────────────────────────────────────────┘
```

| 角色 | 职责 | Skill |
| --- | --- | --- |
| Builder | 创建 Target + 设计/校准 Benchmark | `agent-creation`, `benchmark-design` |
| Target | 只在自己 workspace 做题 | 被测对象 |
| Evaluator | 一次 Case 一次 Run：启动 Target + 私有打分 | `agent-evaluation` |
| Optimizer | 证据→假说→Candidate→评测→接受/回滚 | `agent-optimization` |

Skill 组：`agent-tuning` = 上述四个（`packages/skills/src/index.ts`）。

**运行时数据根**：`PENGUIN_HOME` 或 `~/.penguin/data`  
路径：`<root>/<project>/agents/<agentId>/...`（`packages/core/src/state/paths.ts`）。

行为注入：`system_config.yaml` 的 `system_prompt` 模板用 `{{AGENTS_MD}}` 注入 `AGENTS.md`；Skill 元数据用 `{{SKILL_METADATA}}`（`packages/core/src/state/agent-state.ts` → `assembleSystemPrompt`）。

---

## 2. 随时间改进什么

| 资产 | 是否进化 | 说明 |
| --- | --- | --- |
| **AGENTS.md** | 主通道 | 行为规则 / 约定 / 工作纪律；优化器最常改 |
| **Skills**（Target 自有 `agent_state/skills/`） | 可 | 可复用能力写成 focused Skill；禁止改库自带 Skill 做目标特化 |
| **system_config.yaml** | 有界 | 安全运行时字段；默认不改 `system_prompt`、不改 `model.thinking_level`（评测 runtime 锁在 scoreboard） |
| **memory/** | 非主路径 | 状态目录存在；优化契约不强调改 memory |
| **tools 配置** | 边缘 | `agent_state/tools/` 预留 |
| **模型权重** | **否** | 无 finetune；权重固定，只改可编辑状态 |

设计原则（文档原话意译）：行为全是磁盘上的数据，不是代码；优化器改的就是人手改的同一批文件。

---

## 3. 学习信号从哪来

1. **Deterministic / 私有 Rubric 分数**（0–100）：Evaluator 对照 `rubric/`，Target **永不可见** rubric。  
2. **Trace**：失分 Case 的 session / tool 轨迹（Optimizer 可读 statement + score-linked Trace，**不可读** rubric/gold/Evaluator 私域）。  
3. **多 Run 均值**：区分稳定行为与噪声（Candidate 用用户指定 `runs`；Baseline 常 1-run）。  
4. **通过范例 / 失败产物**（demo）：`examples/self-improving-agent` 用 rejected report + accepted reference(s) 做对比学习。  
5. **假说是否在预期 Case 上成立**：单独报告，**不替代**分数门禁（分数升就接受，即使假说未获支持）。

无 RL 奖励模型、无 preference dataset 默认路径。

---

## 4. 验证 / Promote 门禁

**Benchmark 侧（Builder）**

- Case 派发前：Statement 自洽、Rubric 与私有标准一致、计分项只依赖已定义前提。  
- Pilot：每 Case 1 run；达标可 early Freeze，否则在有效 Pilot 中选**最低分**有效版本 Freeze（难测才有信息量）。  
- Formal Baseline = 选中 Pilot 的单次结果直接落库，**不重跑补齐**。  
- 公开 Statement 可信息不足/冲突信号；**私有标准固定**，不因看到答案改写。

**优化侧（Optimizer）**

- 必须先有完整 Formal Baseline。  
- Candidate 仅当：改动可接受（无污染私评信息）+ 全矩阵 valid + **Evaluation 均分严格高于** Reference → 接受。  
- 首次对比允许 Candidate 多 run 均分 vs Baseline 单 run 分（不强制 backfill Baseline）。  
- Evaluator 回包必须是**纯协议 YAML**；格式坏则同 Session 重发 YAML，**不重跑 Target**。  
- `version_changed` / `benchmark_invalid` / runtime 三元组不一致 → 停或判矩阵无效。  
- 无效评测、修复重跑**不计入** round 上限。

**Demo 侧**（`self-evolve.ts`）：`mean(N+1) > mean(baseline)` 才 keep `AGENTS.md`。

---

## 5. 回滚与安全

| 机制 | 行为 |
| --- | --- |
| 轮前快照 | `snapshots/v<version>.tar.gz` 打包 `agent_state/`，**排除** `.vault.toml` |
| 轮内回滚 | 保留改前文件原文；拒绝则恢复 Reference 文件与 version，删 Candidate 新建文件 |
| 版本号 | Candidate version 只增不减；拒绝过的 version **不复用** |
| 成功后 | `system_config.yaml` 的 `version` 自增；接受记录 append scoreboard |
| 污染 | 私评信息进 Optimizer 上下文 → 恢复 Candidate 并停止 |
| 并发 | 他进程改了 State → 不覆盖，停止 |
| 导入快照 | 版本 ≤ 当前需显式 confirm（HTTP 409）；导入前自动 snapshot 当前 |
| 密钥 | vault 永不进 snapshot |
| 隔离评测 | Target workspace 只拷 `statement/`；rubric 仅 Evaluator 可见 |

实现：`packages/server/src/services/snapshot-service.ts`；契约：`agent-optimization/SKILL.md`。

---

## 6. 存储格式

```text
~/.penguin/data/<project>/agents/<agentId>/
├── agent_state/
│   ├── system_config.yaml    # version, system_prompt 模板, model.*
│   ├── AGENTS.md             # 可进化指令（{{AGENTS_MD}}）
│   ├── skills/<name>/SKILL.md
│   ├── memory/
│   ├── tools/
│   └── .vault.toml           # 密钥，不进快照
├── benchmarks/<benchmarkId>/
│   ├── benchmark_config.toml # title, description, runs
│   ├── <case-id>/
│   │   ├── statement/        # 题面（Target 可见）
│   │   └── rubric/           # 评分（Target 不可见）
│   └── scoreboard.yaml       # evaluations[] 权威聚合
├── snapshots/vN.tar.gz
├── traces/                   # Session 全轨迹
├── workspaces/               # 评测隔离目录
└── scratchpad/
```

- **scoreboard.yaml**：`time, version, provider, model_id, thinking_level, summary_title, summary, score, cost, duration_ms, cases[].runs[]`（含 `session_id`）。服务端/Web **信任已写聚合值，不重算**。满分固定 100，无 `max_score`。  
- **Evaluator 协议**（叶子唯一对外文本）：`status: ok|failed` + score 或 `failure_code`。  
- **示例种子**：`packages/core/src/state/example-benchmark.ts` → `default_agent` 的 `example-benchmark`。

---

## 7. 关键路径（一行职责）

| 路径 | 角色 |
| --- | --- |
| `packages/docs/content/self-improvement.{en,zh}.md` | 产品级自进化规范 |
| `packages/skills/skills/agent-creation/SKILL.md` | 需求 → AGENTS.md + 装 Skill |
| `packages/skills/skills/benchmark-design/SKILL.md` | Pilot 校准、Freeze、写 Baseline |
| `packages/skills/skills/agent-evaluation/SKILL.md` | 隔离 1 Case 1 Run + 私有打分 |
| `packages/skills/skills/agent-optimization/SKILL.md` | 假说循环、快照、严格 promote |
| `packages/skills/src/index.ts` | `agent-tuning` 技能组 |
| `packages/core/src/state/paths.ts` | 数据布局纯路径 |
| `packages/core/src/state/agent-state.ts` | 初始化状态 + prompt 占位符装配 |
| `packages/core/src/state/example-benchmark.ts` | 内置示例题库与 scoreboard 样例 |
| `packages/server/src/services/snapshot-service.ts` | tar.gz 快照导出/导入 |
| `packages/core/src/agent.ts` / `session.ts` | Agent/Session 运行时 |
| `examples/self-improving-agent/self-improve.ts` | 评分闭环（脚本硬编码 edit） |
| `examples/self-improving-agent/self-evolve.ts` | 单轮真自进化（Agent 写 AGENTS.md） |
| `examples/self-improving-agent/self-evolve-recursive.ts` | 多轮：结构 → 常量锁定 |
| `examples/self-improving-agent/README.zh.md` | 设计意图与诚实边界 |
| `changelog/0.1.5/2026-07-25-agent-tuning-pipeline.md` | 调优管线历史说明 |

---

## 8. 最小算法（忠实伪代码）

```text
# === 全产品（Skill 编排）===
build:
  create Target agent_state (AGENTS.md, skills, system_config version=1)
  design Benchmark (statement ⊥ rubric; max_score=100)
  for pilot in 1..K:
    for case in cases:
      score[case] = evaluate(target, case, runs=1)  # subagent
    if mean(score) >= desired: freeze this revision; break
    else: refine difficulty / cases (no leak rubric into statement)
  formal_baseline = selected_pilot_result  # no re-run
  append scoreboard(formal_baseline)

optimize(runs, rounds, target_score):
  require formal_baseline
  Ref = (state@v, scoreboard_entry)
  for r in 1..rounds:
    ensure snapshot tar.gz of Ref.v (no vault)
    diagnose from scores + public traces → falsifiable hypothesis
    Candidate = edit(AGENTS.md | target skills | safe config); version = Ref.v+1
    matrix = parallel evaluate(case × runs) under frozen (provider, model, thinking)
    if all valid and mean(matrix) > Ref.score:
      accept; append scoreboard; Ref = Candidate
      if Ref.score >= target_score: stop
    else:
      restore files to Ref; drop Candidate artifacts
  keep highest accepted Ref

# evaluate(case): workspace←statement only; run Target; score with private rubric; YAML only

# === Demo 递归（self-evolve-recursive.ts）===
agentsMd = ""
baseline = mean([run_task() × 5])
reflect(failed_report, [1 accepted]) → agent writes AGENTS.md   # structure
n1 = mean([run_task() × 5])
reflect(own_AGENTS.md, [3 accepted]) → lock constants            # recurse
n2 = mean([run_task() × 5])
# single-round self-evolve: keep iff n1 > baseline else agentsMd=""
```

信息论要点（demo）：单样本只能学**结构**；多样本交集才锁**字面常量**。  
`state_{n+1} = agent.reflect(state_n, new_evidence)`。

---

## 9. 移植到 Yishu `agent-core`：Port vs Skip

Yishu 已有：`eval/harness.ts`（pass/fail case）、`evolution/learning-signal.ts`、`evolution/skill-draft.ts`、`trajectory/*`、`skills/`。  
对标 Penguin 时按价值排序：

### 应 Port（对齐产品、代码量可控）

| 能力 | 落点建议 |
| --- | --- |
| **可版本化的指令文件**（AGENTS/persona 进 system prompt） | 显式 `agent_state` 或沿用 skills + 单一 `persona.md`；改动可 diff/回滚 |
| **statement ⊥ rubric** | `eval/` 扩展：题面与评分分离，被测 agent 上下文不含 check 源码语义 |
| **均值门禁 promote** | `eval` + evolution：多 run mean **严格提升**才写回 skill/persona |
| **轮前快照 / 轮内回滚** | 改 `skills/` 或 persona 前 copy/tar 或 git-like 备份；拒绝则 restore |
| **scoreboard 式记录** | JSON/YAML：version、score、runs、trajectory id（可挂现有 `data/trajectories/`） |
| **学习信号 → 可编辑状态** | 在 `learning-signal` 之上：信号驱动 **draft AGENTS 段落 / skill**，再走门禁，而非只记 lessons 文本 |
| **信息差 Case 设计** | 用「任务写不清、规则只在 persona」测自我进化（同 demo trick） |

### 可选 / 延后

| 能力 | 理由 |
| --- | --- |
| Skill 编排的四角色全套（Builder/Optimizer 全靠 LLM 遵守 SKILL.md） | 协议厚、靠 prompt 纪律；Yishu 宜先 **代码 orchestrator** 再考虑纯 Skill 自治 |
| Pilot 选**最低分** Freeze | 题库校准专用；先做固定 gold case |
| Web 评测中心 + tar 导入确认 UI | 服务端/壳层；core 只留文件契约 |
| Evaluator 纯 YAML 协议 + 格式修复环 | 可先 typed JSON 返回 |
| `run_subagent` + CLI 嵌套启动 | Yishu 已有 multi/orchestrator；不必抄 penguin CLI 细节 |

### 明确 Skip

| 项 | 原因 |
| --- | --- |
| 模型权重训练 / LlamaFactory 路径 | 与「文件态进化」正交；奕枢身份/权限不绑本地训权重 |
| 原样搬 Penguin 数据布局 / Web / Desktop | 产品边界是 Yishu + Pi harness |
| 信任「模型写入的聚合分、服务端不重算」 | 安全上偏松；Yishu 应用 **代码重算** scoreboard |
| 公司级 self-evolving（README roadmap 未完） | 上游未交付 |
| 评测时 `approve: allow-all` 全自动 | 奕枢要权限与可取消任务态 |

### 移植最小闭环（建议）

```text
1) 固定 EvalCase：content 分 + convention 分（convention 只在 persona）
2) baseline mean → agent/reflect 改 persona 或 skill draft
3) re-eval mean 严格更高 → promote + version++；否则 rollback
4) trajectory id 写入 scoreboard；人工可审计
```

对应现有模块：`eval/harness` 出分数，`skill-draft`/`learning-signal` 产候选，**缺的是 promote 门禁 + 快照**，不是再造一套 Agent 平台。

---

## 诚实边界（上游已承认）

- 弱模型会「写出规则却执行不稳」→ 分数倒退 → **回滚是正确行为**。  
- 证据不足时卡在中位分（单范例歧义）——提升来自**信息**，不是噪声。  
- 全产品优化依赖 LLM 严格遵守 Skill 协议；工程上协议/隔离/门禁比「自我意识」更关键。
