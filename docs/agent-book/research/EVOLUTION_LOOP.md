# 奕枢自进化闭环（SSOT）

Type: research
Status: historical
As-of: 2026-08-06

本文件是设计真源。不是用户随口说的「调研→验证→验收→复盘」。
依据：

1. 《AI Agent Book》第 8 章：学习信号 → 四种更新载体 → 候选 → 验证/发布/回滚
2. PenguinHarness：`EVALUATE → REFLECT → RE-EVALUATE → KEEP|ROLLBACK`，改前快照，分数不升则回滚
3. SkillOpt / RHO 类研究：冻结评测、对照基线、只接受严格改进

## 公式

```text
保存轨迹 ≠ 学习
学习 = 评价 + 对照 + 归纳 + 验证后改变下一轮行为
```

## 循环（唯一主路径）

```text
┌─────────────┐
│ 1. RUN      │  执行任务，写轨迹（不可变审计层）
└──────┬──────┘
       ▼
┌─────────────┐
│ 2. SIGNAL   │  三层信号：结果 / 过程 / 质量（Rubric）
└──────┬──────┘
       ▼
┌─────────────┐
│ 3. DIAGNOSE │  失败族聚类 → 根因 → 该改哪种载体
└──────┬──────┘
       ▼
┌─────────────┐
│ 4. PROPOSE  │  生成候选（知识 / 指令·Skill / 程序 / 不碰参数默认）
└──────┬──────┘
       ▼
┌─────────────┐
│ 5. SNAPSHOT │  改前快照；失败绝不半残
└──────┬──────┘
       ▼
┌─────────────┐
│ 6. EVAL     │  边界集 + 保留集；与 Baseline 同 runtime
└──────┬──────┘
       ▼
┌─────────────┐
│ 7. GATE     │  严格改进才 promote；否则 restore
└──────┬──────┘
       ▼
┌─────────────┐
│ 8. RECORD   │  scoreboard + 版本号 + 证据路径
└─────────────┘
```

## 门禁（硬规则）

1. **无快照不修改**
2. **无冻结评测集不发布**
3. **边界集必须改善，保留集不得退化**
4. **平均分不升 → 强制回滚**
5. **金标/Rubric 不对被测 Agent 可见**（评估侧隔离）
6. **高风险维度一票否决**（安全/隐私/无证据宣称）优先于总分
7. **参数训练默认关闭**；本 harness 先做指令/Skill/程序层

## 四种更新载体（书 ch8）

| 载体 | 何时 | 本仓库落点 |
|------|------|------------|
| 知识文档 | 可检索的领域/行动经验 | `data/evolution/knowledge/` |
| 指令 / Skill | 可语言化的策略 | `identity/INSTRUCTIONS.md` + `skills/` |
| 程序 / Harness | 可精确执行的流程 | 未来：生成工具脚本候选 |
| 模型参数 | 高维风格/隐式策略 | 不做（Pi/外部训练） |

## 与错误循环的对照

| 随意说法 | 问题 | 本闭环 |
|----------|------|--------|
| 调研→验证→验收→复盘 | 缺「改什么载体」与「分数门禁」 | 诊断选载体 + GATE |
| 有轨迹就算学习 | 书明确否定 | SIGNAL 后必须对照归纳 |
| 直接覆盖当前版本 | 不可回滚 | SNAPSHOT + 候选版本 |

## 可证伪成功标准

离线 demo 中：Baseline 均分 < 门槛，进化一轮后 Candidate 均分 **严格更高**，且 scoreboard 记录 promote；故意注入坏候选时必须 rollback。

## 实现状态（2026-08-06）

| 项 | 状态 |
|----|------|
| 闭环代码 | `packages/agent-core/src/evolution/*` |
| CLI | `pnpm agent:evolve` |
| 门禁测试 | promote + bad-candidate rollback |
| 在线经验 | `run` → `data/evolution/experience.jsonl` |
| 晋升指令注入 | `buildSystemPrompt` 读取 `evolution/state/identity/INSTRUCTIONS.md` |
| 实测 | baseline 50% → candidate 100% → promote v2 |

双循环（调研 landscape 共识）：

- **在线**：执行 + 不可变轨迹 + signal/experience（不改正式能力）
- **离线**：`evolve` 诊断/候选/快照/评测/门禁/scoreboard