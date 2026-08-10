# 知识架构：仓库知识地图

Type: architecture
Status: current
Verified: 21629d6 2026-08-10
Review: 知识架构 RFC 修订时

## 原则

> "Git 保存知识，Teable 管理知识，Agent 检索并使用知识，CI/自动化检查知识是否过期。"

## 三个正交维度

每份知识用三个正交维度定位，不得混用：

- **Knowledge Type**（知识类型）：invariant / architecture / decision / runbook / debt / research / acceptance。
- **Epistemic Role**（认识角色）：current-fact / rationale / procedure / historical-evidence。
- **Lifecycle State**（生命周期）：draft / current / superseded / historical。

Type → Role 是固定映射，不允许自由组合：

| Type | Epistemic Role |
|------|----------------|
| invariant | current-fact（带规范力） |
| architecture | current-fact |
| decision | rationale |
| runbook | procedure |
| debt | current-fact（负资产） |
| research | historical-evidence |
| acceptance | historical-evidence |

## 头部约定

每篇文档在 H1 之后必须携带 canonical 头部。不同 status 的必填行：

- `current` → `Verified: <commit> <date>` + `Review: <触发条件>`
- `superseded` → `Superseded-by: <新文档路径>`
- `historical` → `As-of: <日期>`

规则：

- `Verified` 行只能由真实核验动作改写（人或自动化确实跑过核验），不允许随手刷新。
- research / acceptance 默认 `historical` + `As-of`，写入即冻结。
- `historical` 意为"当时的真实观察，不是现在的事实"——它不是垃圾，不得当作过期文件清理。

## 入库四问门禁

任何知识入库前必须回答四个问题，答不出不得入库：

1. 这是什么类型的知识？
2. 谁是它唯一的事实源？
3. 它什么时候失效？
4. 失效后如何被发现？

## Lesson 巩固管道

lesson 不是知识类型，是临时阶段。管道：

`Experience（git / PR / CI / .work）→ Lesson candidate → Consolidation（在 PR 中完成）→ 落到 ADR / Runbook / Invariant / Debt 之一`

同一事实只允许一份 canonical；consolidation 落地后，临时 lesson 即删除。

## 闭环

```text
Git (Canonical)
  → mirror metadata
  → Teable (Control Plane: Retrieval Routing / Staleness Detection / Review Queue)
  → Agent 使用知识
  → 发现矛盾 / 新经验
  → Knowledge Candidate
  → consolidation
  → branch → PR → merge
  → Git
```

## Teable Memory Registry 模型（仅模型，尚未建表）

17 字段：`memory_id` / `type` / `title` / `summary`（≤140字）/ `canonical_source` / `status` / `needs_review` / `verified_commit` / `last_verified_at` / `last_changed_commit` / `canonical_blob_sha` / `superseded_by` / `load_policy`（always / on-demand / never）/ `review_trigger` / `tags` / `origin_ref` / `owner`

写权限铁律：

- `verified_commit`、`last_verified_at`、`needs_review=false` 只能由核验事件写入。
- 自动化只能写 `last_changed_commit`、`canonical_blob_sha`、`needs_review=true`——代码变了 ≠ 知识已重新验证。

过期信号按强度排序：

1. `canonical_blob_sha` ≠ 当前 blob（最强）
2. `last_changed_commit` ≠ `verified_commit`
3. 时间超阈值（最弱）

## 目录地图

| 目录 | Type | 备注 |
|------|------|------|
| `docs/decisions/` | decision | ADR，只能被新 ADR supersede |
| `docs/runbooks/` | runbook | 操作程序 |
| `docs/debt/` | debt | 技术债台账 |
| `docs/research/` | research | 默认 historical |
| `docs/acceptance/` | acceptance | 默认 historical |
| `docs/agent-book/` | 混合 | 见各文件头 |
| 根级架构文档（`architecture.md` / `product-kernel.md` / `persona.md` 等） | architecture | 产品架构与身份 |
