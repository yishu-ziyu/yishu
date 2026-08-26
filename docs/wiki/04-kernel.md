# 04 packages/kernel —— @yishu/kernel 产品内核

Type: wiki
Status: current
Verified: 34c0eaa 2026-08-15
Review: packages/kernel 源码结构变化时

## 模块职责

`@yishu/kernel`（[packages/kernel](../../packages/kernel)）是产品层：**turn 之上的产品真相**——`YishuAction` 注册表、`ContextTrail`、证据存储（MemoryClaim / Learning / Skill / Mandate / TaskTruth / Conversation 账本）、`ContextCapsule`。它不替代执行循环、不依赖 `@yishu/runtime`（依赖方向：runtime → kernel）。运行时依赖仅 `zod`；Node ≥ 22.19（SQLite 后端用内置 `node:sqlite`）。

入口 `src/index.ts`：`KERNEL_VERSION = "0.0.1"`，导出产品动作、上下文、存储、Mind，以及 conversation / memory / context-watch 三个窄账本与顶层产品模块。

```text
packages/kernel/src/
├── action/        # 动作定义、授权、注册表（defineYishuAction / YishuActionRegistry）
├── actions/       # 14 个默认产品动作（remember、delegate、create_note…）
├── conversation/  # ConversationLedger：history list/open/archive 策略
├── context/       # sanitize（净化）/ trail（滚动轨迹）/ capsule（短命上下文包）
├── context-watch/ # ContextWatchLedger：精确 scope 推进与按任务取消
├── memory/        # MemoryLedger + 受控记忆召回 + 唯一可见记忆文件
├── mind/          # Yishu Mind 文档（策略上下文 + learned lessons）
├── store/         # JSON/内存/SQLite 三后端 + 账本安全 + 状态机辅助
├── kernel.ts      # 装配（createYishuKernel / createDefaultProductKernel）
├── intent-frame.ts
├── session-scope.ts
├── task-contract.ts
├── task-truth.ts
└── utterance-router.ts
```

## 1. action 子系统（src/action/）

### 核心类型（types.ts）

| 类型 | 取值/字段 |
|------|-----------|
| `CallerKind` | `voice / ui / initiative / mcp / cli / pi / system` |
| `AuthorityLevel` | `automatic / reversible / standing_mandate / explicit_approval` |
| `ActionRisk` | `low / medium / high / critical` |
| `ActionContextMode` | `none / current-frame / trail / capsule` |
| `ActionReceiptStatus` | `ok / needs_approval / denied / failed / cancelled / cancelled_after_commit / verified`（**verified 仅由 post-condition 校验产生**） |
| `ActionReceipt` | `actionName / receiptId / status / caller / input / output / authority / risk / reversible / verification? / auditId / occurredAt / message` |
| `YishuActionDefinition<TInput, TOutput>` | 冻结定义：`name / description / inputSchema(Zod) / authority / risk / reversible / context / run / verify?` |
| `ActionRunContext` | 含 `input / caller / contextFrame? / sessionScope? / trail? / deps? / signal? / markCommitted() / now` |

设计要点：

- **审计无内容**：`ActionAuditEntry` 只记录值的 shape（null/scalar/object/…），永不复制 input/output/verification/abort reason（上限 500 条，`getAuditLog()` 读取）。
- **取消语义**：动作抛 `ActionCancelledError`；run 内 durable 副作用落地后必须调 `ctx.markCommitted()`——取消时据此区分 `cancelled` 与 `cancelled_after_commit`。

### 关键函数

- `defineYishuAction(config)`（define.ts）：构建冻结的动作定义；`reversible` 默认取 `authority === "reversible"`。
- `evaluateAuthority({definition, caller, approved?, mandates?})`（authority.ts）授权规则：
  1. `approved === false` → denied；`risk === "critical"` → 必须 explicit approved；
  2. `automatic` 仅 low risk 放行；`reversible` 非 critical 放行；
  3. `standing_mandate` 需匹配 Mandate（scope = 动作名或 `"*"`）；`explicit_approval` 恒 needs_approval。
- `YishuActionRegistry.invoke(name, options, deps?)`（registry.ts）执行管线：
  `查定义 → inputSchema.safeParse → 解析 mandates → evaluateAuthority → abort 检查 → run（markCommitted 边界）→ abort 再检查 → 可选 verify → ActionReceipt`。任何失败/取消路径都产出定型 receipt 而非抛裸异常。

## 2. 默认产品动作（src/actions/，14 个）

| 动作 | authority / risk | 行为要点 |
|------|------------------|----------|
| `remember` | reversible / low | 写 `MemoryClaim`（claim/scope/confidence/supersedes/tags），verify 重查写入存在 |
| `forget` | reversible / medium | 软删除记忆（`retireMemory`） |
| `remember_how` | reversible / low | 从 `ContextTrail.recentMinutes` 提取 `SkillCandidate`（`extractProcedureFromTrail`），可选 trail-replay 验证后晋升 `VerifiedSkill`；私会话拒绝 |
| `share_context` | automatic / low | 构建 15 分钟 TTL 的 `ContextCapsule`（无截图字节/凭据） |
| `record_learning` | reversible / low | 写 `Learning` 规则（用户纠正） |
| `run_skill` | reversible / low | 匹配 verified skill 并对当前 trail 重验；未命中可兜底 share_context |
| `finder_history_back` | reversible / low | 透传到 `deps.finderHistoryBack` executor（macOS 侧 Swift 实现），verify 取 output.verified |
| `create_note` | explicit_approval / medium（不可逆） | 透传到 `deps.createNote`；verified 要求 native command + verified accessibility |
| `schedule_time_reminder` | explicit_approval / medium（不可逆） | 透传到 `deps.scheduleTimeReminder`；verified 要求精确读回 pending system notification |
| `record_suggestion` / `settle_suggestion` | automatic / reversible | 建议记录的提出与结算（adopted/ignored/succeeded/failed） |
| `learn_mind_from_pattern` | reversible / low | 同 patternKey 累计 ≥2 次 outcome 证据后把 lesson 追加进 Mind 文档 |
| `watch_app_return` | reversible / low | 原子创建 Mandate+TaskTruth+ContextWatch 三件套（"下次切回这个应用时提醒我"）；要求新鲜 contextFrame（≤30s、前台 app 匹配、confidence ≥ 0.8） |
| `delegate` | automatic / low | **只注册子 TaskTruth 并 ack，不启动执行**（ADR 0009 委托架构） |

所有动作共享模式：每个可取消 await 前后 `throwIfAborted(signal)`；durable 副作用成功后立即 `markCommitted()`。

## 3. context 子系统（src/context/）

模块箴言：**"Evidence in, sanitized trail out. No screenshot bytes leave this module."**

- `sanitize.ts`：`toTrailEntry(frame, {sessionScope})` 把 ContextFrame 净化为 `ContextTrailEntry`（appName/bundleId/windowTitle/axRole/axValuePreview ≤200 字符/cursorRegion/warnings/hasScreenshot 标记）——**剥离所有 base64Data**；`cursorRegionFromFrame` 做多屏坐标系映射。
- `trail.ts`：`ContextTrail` 类，内存滚动轨迹（默认 500 条 / 20 分钟保留 / 截图元数据 TTL 30s）。`append(frame, sessionScope)` 私会话抛错；`query({sessionScope, sinceMs, limit, query})` 严格 scope 隔离；`recentMinutes` / `summarize`（人类可读时间线，永不含图像字节）。
- `capsule.ts`：`buildContextCapsule`（默认 TTL 15min）+ `serializeContextCapsule`（序列化后再 parse 验证，防夹带）+ `parseContextCapsule`（严格结构校验，**硬拒绝**含 `base64Data/password/apiKey/credential/screenshot/systemPrompt/chainOfThought` 等键名的 JSON，错误码固定 `SENSITIVE_CONTENT_REJECTED`）。

## 4. memory / mind 子系统

- `memory/ledger.ts`：`MemoryLedger` 统一 list/read-back/forget/visible hydration/recall；Runtime 不接触这些操作背后的 store 查询与可见文件同步策略。
- `memory/recall.ts`：`recallRelevantMemories(store, query, {scope})`——只用现有 MemoryClaim 表（不引入第二个记忆产品），双向 token 命中打分（CJK 双字 bigram），最多 3 条 / 单条 200 字 / 总计 480 字；敏感 claim（`sk-`、JWT、`data:image/`、PEM 等）跳过。
- `memory/visible-file.ts`：`~/Documents/Yishu/记忆.md` 是唯一用户可见记忆文件。删除一行会写入指纹和语义键墓碑，压制相同或相近的 EverOS 候选；面板对过期草稿做三路合并，不覆盖之后追加的条目。
- `mind/document.ts`：单一 sectioned markdown 文档，5 个固定 section（`Who you are` 与 `Inference discipline` 为 protected）；`LEARNED_HEADING = "What you've learned"` 是自动 outcome lesson 落地区；`applyMindUpdate` / `writeMindSection` / `revertMindSection`。
- `mind/recall.ts`：`selectRelevantMindLessons`（最多 3 条 / 600 字符）。
- 学习门槛：`MIND_LEARN_MIN_EVIDENCE = 2`（"Once is coincidence; twice is a pattern"）。

## 5. store 子系统（src/store/）

### 实体模型（types.ts，全部 evidence-based：source/capturedAt/confidence/scope）

| 实体 | 说明 |
|------|------|
| `MemoryClaim` | 记忆断言（supersedes 链、retiredAt 软删除） |
| `Learning` | 用户纠正规则 |
| `SkillCandidate` / `VerifiedSkill` | 流程技能（candidate 经 trail-replay 验证后 promote，默认 confidence 0.8） |
| `Mandate` | 长期授权（actionName 或 `"*"`，expiresAt） |
| `TaskTruth` | 任务真相（status/evidence/parentId/contract） |
| `ContextWatch` | 一次性应用返回提醒状态机（waiting_for_departure → armed → fired / cancelled） |
| `DelegatedResultRecord` | Result Inbox 行（payload-only，claim/delivery 字段绝不复制 TaskTruth status） |
| `Conversation / ConversationTurn / ConversationEvent` | 持久对话账本（turn 终态不可回 open；event payload 只允许 flat scalars，≤32 字段） |
| `YishuMindState` / `SuggestionRecord` | Mind 文档与建议状态机 |

### 账本安全（ledger-safety.ts）——所有持久化文本的守卫

- `SECRET_PATTERNS`：7 条正则（api_key=、bearer、sk-、ghp_、xox*、JWT、中文"密码:…"）。
- `sanitizeVisibleText`：对话文本保留、secret 替换 `[redacted]`。
- `sanitizePortableText`：trail/capsule 有损净化（data URI / base64 / 凭据赋值 → `[omitted]`）。
- `assertPersistableSafeText / assertPersistableMemoryText / ...`：durable memory **fail-closed**——redact 变化即抛 `SENSITIVE_CONTENT_REJECTED`。
- `assertPersistableEventType`：拒绝 `response.delta`（瞬时事件不可入账本）。

### 三种后端

| 类 | 文件 | 说明 |
|----|------|------|
| `YishuStoreCore` | yishu-store.ts | 全部同步 mutation 逻辑基类（约 50 个方法的 `YishuStorePort`） |
| `YishuStore` | yishu-store.ts | JSON 文件后端（`~/.yishu/yishu-store.json`，temp+rename 原子写，Promise 链串行化） |
| `InMemoryYishuStore` | yishu-store.ts | 内存测试后端 |
| `SqliteYishuStore` | sqlite-store.ts | **默认生产后端**（`node:sqlite`，WAL，0600/0700 权限，`BEGIN IMMEDIATE` 事务，schema user_version 0..6） |

SQLite 表：`memories`、`learnings`、`skill_candidates`、`verified_skills`、`mandates`、`tasks`、`context_watches`、`delegated_results`、`conversations`、`conversation_turns`、`conversation_events`、`mind_state`（单行）、`suggestions`。

### 辅助模块

- `context-watch.ts`：`buildContextWatchCreation`（Mandate+TaskTruth+ContextWatch 原子三件套）；`contextWatchObservationIsNew` 防旧观测推进状态机。
- `extract-procedure.ts`：`extractProcedureFromTrail` 从轨迹启发式提取流程步骤（resolve/observe/act 分段），**不是鼠标坐标回放**。
- `skill-verify.ts`：`verifyProcedureAgainstTrail`（coverage + ordered + 多 app + 条件满足打分，默认阈值 0.7）。
- `mind-store.ts`：Mind 状态 + Suggestion 状态机 + `learnMindFromPattern`。

## 6. 顶层模块

- `conversation/ledger.ts`：`ConversationLedger` 统一 history list/open/archive，返回用户可见投影而非 raw event。
- `context-watch/ledger.ts`：`ContextWatchLedger` 统一 waiting → armed → fired 的精确 scope/CAS 推进，以及取消前的 task + conversation 归属校验；Runtime 只提供新鲜前台应用证据并投影 presence。
- `kernel.ts`：
  - `createYishuKernel(...)` 装配 store + 三个窄账本 + trail + taskTruth + registry，并按固定顺序注册 14 个动作。
  - `createDefaultProductKernel(env)`：读 `YISHU_STORE_BACKEND`（默认 sqlite）、`YISHU_SQLITE_PATH`、`YISHU_STORE_DIR`。
- `session-scope.ts`：`SessionScope = personal | project(projectId, projectLabel) | private`；`normalizeSessionScope`（legacy → personal）、`sessionScopeKey`（`"project:<uuid>"`）、`memoryScopeForSession`（private → null）、`assertDurableSessionScope`（private 抛 `private_session_not_persistable`）。
- `intent-frame.ts`：`deriveTurnIntentFrame` 为每个 turn 产出唯一不可变 `TurnIntentFrame`（objective / speechAct / route / effect / successMode / authority / risk / steerable）；`resolveTurnIntentCandidate` 把规则或未来模型候选与产品权限政策解耦；Runtime 的任务合同、产品动作路由、插话和工具 effect 准入共用同一帧，工具只能收紧参数权限，不能扩大 effect 边界。
- `task-contract.ts`：`createTaskExecutionContract`——objective ≤160 字符、**强制 `maxAttempts === 1`**、`Object.freeze`；`evaluateTaskCompletion`（read_only_delivery 看 responseText / external_effect 看外部验证）；`evaluateActionBoundary` / `decideTaskRetry`（authority 变化或 risk 升级 → escalate，不消耗 attempt）。
- `utterance-router.ts`：`routeProductUtterance(utterance, contextFrame?)` 把短语音映射到产品动作（优先级：相对时间提醒 0.99 → 新建备忘录 0.99 → Finder 返回 0.99 → 应用返回提醒 0.99 → 记住流程 0.95 → 交给 Codex/分享上下文 0.9 → 记录学习 0.85 → 记住事实 0.88），不命中返回 null 落回 Yishu-owned loop；`formatProductActionSpeech` 生成动作回执后的中英文口语播报；`classifyRelativeTimeReminder` 单分类器（schedule/question/incomplete——question 与 incomplete 永远产品自留，不落执行循环）。
- `task-truth.ts`：`TaskTruthProjector`——runtime 只报 observation，kernel 决定持久 status（no tool → no task；verified → done；completed without verification → blocked；terminal 不可被 late event 覆盖）。

## 7. 测试（test/）

覆盖 action-registry、context-capsule、context-trail、context-watch store + ledger、conversation-ledger、create-note、delegate-action、finder-history-back、intent-frame 冻结语料、memory-ledger/recall、mind-loop、mind-recall、product-actions、schedule-time-reminder、sqlite-store、store、task-truth、utterance-router。运行：`pnpm --filter @yishu/kernel test`（或 `pnpm kernel:test`）。

## 关键不变量（本模块强制）

1. `verified` 仅由 post-run verify 产生——tool success ≠ task completion。
2. 审计日志无内容；错误码稳定无细节。
3. `markCommitted` 后取消 → `cancelled_after_commit`。
4. 跨 scope 读取永不允许；private 永不入 trail / 永不持久化。
5. 截图字节永不离开采集模块；capsule 硬拒绝敏感键。
6. durable memory fail-closed：redacted 值不是可信记忆。
7. delegate 只注册不执行；ContextWatch 三件套原子创建。
8. Skill 晋升需 trail-replay 验证；Mind 学习需 ≥2 次证据。
