# EverOS 记忆系统研究报告（奕枢借鉴视角）

Type: research
Status: historical
As-of: 2026-08-15

> 对象：[EverMind-AI/EverOS](https://github.com/EverMind-AI/EverOS)（commit e5118c5，2026-08-03），Python local-first memory runtime。本地浅克隆 `/tmp/EverOS`，基于 `src/everos/` 全量源码通读。
> 用途：为奕枢记忆系统（[yishu-memory-system.md](./yishu-memory-system.md) P2-P4 阶段）提供工程参考；与书义方案（[ai-agent-book-memory.md](./ai-agent-book-memory.md)）互为印证。
> **修订 2026-08-15（同日）**：经九维度对判与产品决策，奕枢采用 EverOS 全构作为记忆层骨干（[ADR 0013](../decisions/0013-memory-everos-backbone.md)）。本文第三/四/五节中"不借鉴 Markdown 真相层 / 不借鉴覆盖语义 / OME 仅借模式"等保守结论已按 ADR 0013 重判，重判结果以节内"修订判定"标注；源码事实部分（一、二节）不变。

## 一、EverOS 一页纸

**定位**：面向 agents/makers 的记忆运行时。会话/文件/轨迹存为**可读 Markdown（唯一真相源）**，本地 SQLite（状态/队列）+ LanceDB（BM25+向量索引）全部可重建，零外部服务。

**架构**（`docs/architecture.md`，import-linter 强制单向依赖）：

```text
entrypoints (FastAPI API + CLI)
  → service (memorize / search / get / knowledge 编排)
    → memory (models / extract / cascade / reflection / strategies / search)
      → infra/persistence (markdown + sqlite + lancedb)
横切：component (LLM/embedding/rerank/parser 注入式 provider) / core / config
```

**八种记忆 kind，双轨分离**：

| kind | 轨 | 目录（~/.everos/<app>/<project>/ 下） | 写入策略 |
|---|---|---|---|
| episode | user | `users/<uid>/episodes/episode-<date>.md` | daily-log append |
| atomic_fact / foresight | user | 隐藏目录 daily-log | append（离线策略产） |
| profile | user | `users/<uid>/user.md` | 单文件整写 |
| agent_case | agent | `agents/<aid>/.cases/…` | append |
| agent_skill | agent | `agents/<aid>/skills/skill_<name>/SKILL.md` | 单文件覆盖（同名后写胜出） |
| knowledge_document / topic | 全局 | `knowledge/<cat>/…` | 知识树 |

## 二、核心管线（与奕枢映射）

### 2.1 写入：boundary → extract → append → cascade

```text
POST /api/v2/memory/add {session_id, messages[]}
  → per-session 锁 + 360s 超时
  → ingest 标准化（CanonicalMessage，多模态 content_items 保留）
  → boundary detection（unprocessed_buffer 累积 → LLM 切 MemCell）
      每个 cell 全量归档 SQLite memcell（payload_json）
  → UserMemoryPipeline：每 cell 一次 LLM 抽取 → 叙事化 Episode
      → per-sender 写 episodes/episode-<date>.md（原子写，entry_id 编号）
  → 返回（episode.md 已 fsync，强一致）
  → [异步] OME 策略：atomic_facts / foresight / profile / cases / skills
  → [异步] cascade watcher（FSEvents）→ md_change_state 队列（LSN 单调）
      → worker diff（content_sha256）→ 仅变更 entry 重嵌入 → upsert LanceDB
```

**对奕枢的映射**：

| EverOS 概念 | 奕枢对应物 | 差距/启示 |
|---|---|---|
| MemCell（会话边界切分） | Conversation/Turn 账本 | 奕枢 turn 粒度天然更细（每 turn 即 cell）；**边界问题奕枢已解决**——turn 终态即提取触发点 |
| Episode（叙事化情景） | ❌ 无（turn 账本是证据不是叙事） | **最大启示**：turn 之上加一层"叙事摘要"投影，才能被检索注入；raw turn 永不直接入 prompt（奕枢已做到） |
| memcell payload_json 全量归档 | Conversation/Turn/Event 账本 | 等价，奕枢已有 |
| cascade 队列 + LSN 重放 | ❌ 无（未来向量索引需要） | 引入 embedding 检索时的同步方案蓝本 |
| per-session / per-path / per-partition 三层锁 | 进程内 desktop lease（单进程） | 奕枢单 sidecar 下只需 per-scope 串行，简单得多 |
| OME 离线策略引擎 | ❌ 无 | **只借鉴"策略=独立幂等步骤+分区锁+审计记录"模式；实现为 Kernel typed action，不引入调度运行时**（ADR 0011） |

### 2.2 Reflection：Select → Merge → Re-extract → Deprecate

`ReflectionOrchestrator.run`（cron，默认关闭）：选成员 ≥2 的 episode 簇（向量聚类，threshold 0.65 / 窗口 7 天）→ LLM 合并叙事（INIT 或 UPDATE 模式，old_episode 传入）→ 写 merged episode（`parent_type=cluster`）→ 触发下游重抽取（等待 cascade 完成，120s 超时）→ **软删除**：原始 episode 与其 atomic_facts 标 `deprecated_by=merged_id`（md frontmatter 与 LanceDB 行双侧标记），search 自动过滤 `deprecated_by IS NULL` → 写 reflection_report 审计。

**对奕枢**：这正是 yishu-memory-system.md P4 的"episode 簇合并"。同构物已存在——mind suggestion（≥2 次 outcome 证据 → learned lesson）就是 micro 版 Reflection。扩展方向：把"同主题多轮对话"聚簇 → merged 叙事 claim + `supersedes` 链（奕枢的 supersedes 字段 = EverOS 的 deprecated_by，语义更完整因为奕枢还有版本方向）。**必须保留差异**：merged 结果是 candidate 状态，经 sensitive fail-closed 后才 active（EverOS 直接落盘生效）。

### 2.3 检索：正交硬过滤 + 混合召回 + 分层 fusion

- `compile_filters` **始终注入** owner_type/owner_id/app_id/project_id 四个硬分区键（RESERVED_FIELDS，调用方不可伪造）；user track 自动追加 `deprecated_by IS NULL`。
- 单次 LanceDB 查询 = BM25（jieba 预分词列）+ 向量 ANN + 标量过滤；episode 用层级 fusion（episode↔atomic_fact 层级 + RRF）；agent 轨用 rrf/lr + 可选 LLM rerank。
- profile 是 KV-by-owner 直取（无 query 相关性）；unprocessed_buffer 只按 session 查。
- 每行带 `md_path + entry_id` 可回链源文件。

**对奕枢**：奕枢 scope 模型（personal/project/private + `sessionScopesEqual` 硬过滤）与 EverOS 硬分区同构，且更严（private 双侧拒绝）。可借鉴的是：**检索入口永远先注入 scope 硬过滤**（已做到）+ **混合召回的渐进路径**（token → +向量 → +rerank，每步可独立评估）。EverOS 的"分层 fusion"（episode 层 + atomic_fact 层联动）对应奕枢未来的"claim 层 + episode 层"两路召回。

## 三、值得吸收的十个工程模式

1. **Markdown 真相层 + 索引全可重建**。~~奕枢无需引入双真相~~ **修订判定：采纳**。ADR 0013 第 1 条：episodes/facts/profile/skills 以 Markdown 为真相（`~/Library/Application Support/Yishu/Memory/<scope>/`）；SQLite 收窄为账本/任务/队列/索引（收窄 ADR 0007 适用范围）。"派生物永远可重建"原则随之采纳。Mind 保留 SQLite 现状。
2. **content_sha256 增量判定**：只对内容字段哈希，元数据变更不浪费 embedding 调用。奕枢未来向量索引直接复用。
3. **软删除 + 检索自动过滤**（deprecated_by ↔ 奕枢 supersedes/retiredAt）：失效可发现、可回滚、可审计——与奕枢"入库四问"的失效语义契合。
4. **cascade 持久队列 + LSN + 有限重试 + 死信**：索引同步不阻塞主路径、crash 可重放。奕枢若做异步提取/嵌入，用 SQLite 队列表同构实现。
5. **Write-ahead-then-async**：`/add` 返回前 episode.md 已 fsync（强一致），索引最终一致（亚秒~15s）。奕枢提取管线同构：turn 终态先落 candidate（强一致），整理/嵌入异步。
6. **单 cluster 失败不阻断周期 + 全程审计记录**（reflection_report）：P4 整理器的容错底线。
7. **分区锁**（`get_partition_lock(strategy, key)`）：同 key 串行、异 key 并行、无超时（避免把慢变丢数据）。奕枢多 scope 整理时按 `scopeKey` 分桶。
8. **三层 CWE-22 防御**（PathSafeId DTO + sanitize_dirname 单点 + `_ensure_within_root` resolve 校验）：奕枢若把 scope/user id 做目录段（如导出 markdown），整套复用。
9. **prompt slot 三层覆盖**（包内默认→app 级→runtime，算法包零 inline prompt）：奕枢 extractor prompt 应外置为可版本化资源，不硬编码在 adapter 里。
10. **loop 监督 + 退避重启 + 稳定运行重置预算**：长寿命后台 task 的稳健模式，适用于奕枢未来的整理 worker。

## 四、原"不借鉴"清单重判（按 ADR 0013，2026-08-15）

对判后重分类：原来标"冲突"的七条中，四条是教条或类别错误（已采纳/部分采纳），两条保留，一条改造采纳。

| EverOS 默认 | 初版判定 | 修订判定（ADR 0013） |
|---|---|---|
| LLM 抽取直接落盘，episode 无 confidence | 冲突 | **部分采纳**：自动提取落地（第 3 条），但产物必为 `candidate`，经敏感 fail-closed + scope 校验后 `active`；confidence 不再是必填门槛（第 9 条），status 承担真语义 |
| 全部会话默认落盘 | 冲突 | **采纳管线 + 保留 private 拒写**：提取触发点复用 `assertDurableSessionScope`；private 无记忆目录。产品特性与借鉴正交，非冲突 |
| api_key 明文存 toml | 冲突 | **保留不借**（真实工程差距，非教条）：密钥仍只存 worker 与 Pi 凭据存储 |
| profile/skill 同名后写覆盖 | 冲突 | **采纳（分层后不再冲突）**：证据层 episodes 恒 append-only；派生层 profile 允许整文件覆盖——初版把 MemoryClaim 既当证据又当现状的混用反向套人了 |
| OME 策略引擎 | 冲突（ADR 0011） | **改造采纳**：Reflection 为进程内后台数据加工 worker（分区锁/审计/单簇失败不阻断）；ADR 0011 约束 model-tool 执行循环，不管数据加工——初版属越界解释 |
| file_uri 默认可读任意文件 | 冲突 | 保留：默认拒绝、显式 allowlist（将来文件摄入再议） |
| 多租户通用正交维度 | 冲突 | **采纳思路**：硬分区注入式过滤（RESERVED_FIELDS）与奕枢 scope 硬过滤同构，语义按 personal/project/private 重定义 |

## 五、净增量结论（2026-08-15 修订版）

~~yishu-memory-system.md 的六对象模型与 P0-P4 顺序不需要推翻；EverOS 只补三块拼图~~。修订判定：**EverOS 全构成为记忆层骨干**（ADR 0013），六对象模型保留但落位方式改变：

- **存储**：episodes/facts/profile/skills → Markdown 真相层；Conversation/Turn/Event 账本、TaskTruth、cascade 队列、索引 → SQLite（原 P1 底座不动）。
- **写入**：显式"记住"热路径保留；普通对话 turn 终态自动提取（candidate → gate → active）补齐——原方案 P2 的具体形态由 EverOS 管线定义。
- **冲突**：`supersedes`（= deprecated_by 语义）接通全链路：设置 → 检索过滤 → md 留痕 → 审计。
- **异步骨架**：SQLite 队列表（LSN/重试/死信）+ 分区锁 + 幂等——提取、索引、Reflection 共用。
- **检索渐进**：token（现状）→ +向量（经 worker 代理，cascade 异步索引）→ +rerank，能力缺失降级运行；每步配 smoke 评估。
- **yishu-memory-system.md 的验收标准不降**：重启回忆、北京→上海版本链、scope 隔离、private 拒写、级联删除、secret 拒入——全部保留为 P1 验收门槛。

与书义方案（ai-agent-book-memory.md）的关系不变：EverOS 的 Select→Merge→Re-extract→Deprecate 与书第 8 章门控进化同构；奕枢差异收敛为两条真边界——candidate gate 与秘密隔离。

## 附：关键源码索引（/tmp/EverOS，浅克隆可复查）

- 写入编排 `src/everos/service/memorize.py`、边界 `service/_boundary.py`
- user 管线 `src/everos/memory/extract/pipeline/user_memory.py`
- cascade `src/everos/memory/cascade/{watcher,worker,scanner,orchestrator}.py`、队列表 `infra/persistence/sqlite/tables/md_change_state.py`
- reflection `src/everos/memory/reflection/orchestrator.py`、审计表 `sqlite/tables/reflection_report.py`
- 检索 `src/everos/memory/search/{manager,filters,recall/base}.py`
- frontmatter/entry 体系 `src/everos/core/persistence/markdown/{frontmatter,entries,writer,path_safety}.py`
- 分区锁 `src/everos/memory/_partition_locks.py`；进程锁 `core/persistence/locking.py`
- 配置 `config.example.toml`、`src/everos/config/default.toml`；架构文档 `docs/{architecture,how-memory-works,storage_layout,knowledge}.md`
