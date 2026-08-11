# Spike: Delegated Concurrent Execution

Type: research
Status: historical
As-of: 2026-08-10
Review: spike 结论被产品实现引用或推翻时

分支：`spike/delegation-concurrency`（实验分支，非产品 feature branch；不 merge、不发产品 PR）。
基线：verified main `122b7f5`（post-merge CI 全绿）。

纪律：先写 Question / Hypothesis / Experiment / Pass Criteria，再写代码。Observation 与 Decision 在实验后填写，事实与推断分开。

---

## Spike A — Pi Session Concurrency

### Question

同一个 `PiRuntimeAdapter` 能否同时运行两个不同 `conversationId` 的独立 execution，并保持 session、event、cancel 与 history 隔离？

### Hypothesis

1. Adapter 的 session cache key 包含 `conversationId`（`pi-runtime-adapter.ts:113-115`），不同 conversationId 会产生不同 `AgentSession`。
2. 事件发射按 `requestId` 路由（`runtimeEvent(type, requestId, ...)`），同一 adapter 上并发的两个 turn 不会跨 requestId 泄漏事件。
3. `cancelTurn` 只操作目标 requestId 的登记结构（`cancelledRequestIds` / `activeSessionByRequestId`），不影响其他进行中的 turn。
4. 两个 turn 可以在同一个 adapter 上时间重叠地执行并各自到达终态。
5. 真实 Pi harness（`createAgentSession`）层不存在隐藏的全局单 session 约束，使上述隔离在真实执行时同样成立。

### Experiment

**Layer 1（Yishu runtime concurrency semantics，deterministic fake）**

通过现有 DI seam 注入 fake harness：`PiRuntimeAdapterOptions.modelRuntimePromise` + `createSession`（复用 PR #1 建立的 `FakeAgentSession` 模式）。fake session 的 `promptHandler` 由测试用 deferred gate 精确控制，从而可以制造"A 挂起中、B 启动"的真实并发交错。

测试场景：

1. 并发启动：turn A（conversationId=conv-a）的 prompt 挂起期间，启动 turn B（conversationId=conv-b）。
2. session 隔离：断言两次 `createSession` 调用产生两个不同 session 对象与不同 sessionId。
3. 事件隔离：A/B 各自的事件 collector 中断言所有事件的 requestId 属于本 turn。
4. cancel 隔离：A/B 都在执行中时 cancelTurn(A)；断言 A 收到 `turn.cancelled` 且其 session 被 abort，B 无任何 cancelled 事件且随后正常完成。
5. 独立完成：两个 turn 各自收到自己的 `response.completed`。
6. dispose：两个 turn 执行中调用 `adapter.dispose()`；断言两个 session 均被 abort，且行为有明确记录。

**Layer 2（real Pi integration）**

使用默认（真实）`createAgentSession` 与 `ModelRuntime.create`，以两个独立 conversationId 并发执行两个简单、无 Desktop 操作的任务。记录 startedAt / completedAt / requestId / conversationId / sessionId / events / cancel 行为。

凭据前置检查：真实 OAuth provider 需要本机凭据；若不可用，则如实记录 `adapter verified / Pi integration unverified` 与原因，不做任何推断。

### Pass Criteria

Layer 1（全部满足才 PASS）：

- A1：A 的 prompt 尚未 resolve 时，B 的 session 已创建且 B 的 prompt 已开始（时间重叠有直接证据）。
- A2：A/B 使用不同 session 对象（两次 createSession 调用，不同 sessionId）。
- A3：A collector 中每条事件的 requestId == A.requestId；B 同理。
- A4：cancelTurn(A) 后 A 收 `turn.cancelled`、sessionA.abortCount ≥ 1；B 无 cancelled 事件，随后 B 收 `response.completed`。
- A5：A、B 各自收到以自身 requestId 标识的 `response.completed`。
- A6：dispose 使两个进行中 session 都被 abort，行为被明确记录。

Layer 2：

- A7：真实执行中 B.startedAt < A.completedAt（真实时间重叠）。
- A8：无 session/history/event 泄漏（两 turn 的 sessionId 不同，事件归属正确）。
- 若凭据或环境不满足：明确标记 `adapter verified / Pi integration unverified`，记录实际原因；不得推断成立。

### Observation

Layer 1（deterministic fake，测试 `packages/runtime/test/spike-a-adapter-concurrency.test.ts`，runtime 142/142 全绿）：

- Fact: B 的 prompt 开始时 A 的 prompt 仍挂起于 gateA（`promptStarted` 已 resolve、`gateA` 未 resolve），两 turn 时间重叠有直接证据。
- Fact: conv-a / conv-b 触发两次 `createSession` 调用，产生两个不同 session 对象与不同 sessionId（`spike-a-session-N` 递增）。
- Fact: eventsA 中每条事件 requestId == "req-a"，eventsB 中每条 == "req-b"；A 的 completed 文本不含 B 的内容，反之亦然。
- Fact: cancelTurn(req-a) 后 sessionA.abortCount ≥ 1、A 收 `turn.cancelled`；sessionB.abortCount == 0、B 无任何 cancelled 事件，随后 B 正常 `response.completed`。
- Fact: dispose 时两个进行中 session 的 abortCount 均 ≥ 1，两 turn 均未产生 `response.completed` / `turn.failed`（事件流随 cancelled 路径终止）。
- Fact: fake 层初版暴露一个测试自身缺陷——fake `abort()` 不 settle 挂起的 prompt 会导致 turn 悬挂；修正 fake 语义（abort 使 prompt 返回）后通过。这是 fake 保真度问题，不是 adapter 缺陷。

Layer 2（real Pi，探测日志 `.work/spike-a-l2-log.txt`，2026-08-11T03:04Z，provider `openai-codex/gpt-5.4-mini`）：

- Fact: 单 turn 预热以 "OK" 完成（凭据可用、链路真实）。
- Fact: req-real-a 启动 03:04:54.882Z、完成 03:04:58.691Z；req-real-b 启动 03:04:54.885Z、完成 03:04:58.936Z。**B 在 A 完成前 3.806 秒启动**——真实时间重叠。
- Fact: 两个真实 sessionId 不同（019feec7-bb61-… vs 019feec7-bb65-…）。
- Fact: a/b 事件列各 3 条（turn.started / response.delta / response.completed），requestId 归属全部正确，无交叉。
- Fact: 两 turn 均 `response.completed`，无 failed/cancelled。
- Inference: Layer 1 证实的 adapter 并发隔离语义在真实 Pi harness 上同样成立——但样本限于单 provider（openai-codex）、单模型、conversation profile、无 Desktop 操作、单 adapter 实例、两轮运行。推广到多 provider 混合或 computer-use profile 属于推断，本轮未验证。

### Decision

- Hypothesis 1–4（adapter 层隔离）：**证实**。
- Hypothesis 5（真实 Pi 层同等成立）：**证实（限定条件下）**。判定：`real Pi concurrent sessions = verified`（2026-08-11，openai-codex/gpt-5.4-mini，conversation profile）。
- 未验证域（保持 unknown，不得外推）：多 provider 混合并发；computer-use profile 并发时 Desktop 动作的互斥；真实进行中 turn 的 cancel 传播；session 复用跨多轮的 history 长期隔离；并发规模 >2 的行为。

---

## Spike B — Asynchronous Delegation

### Question

在不引入正式 Scheduler、不新增第二套 task status truth 的前提下，现有 kernel 语义能否支撑异步 delegation：`delegate()` 创建 child TaskTruth 后立即返回 accepted receipt，Main 继续处理后续 turn，child 独立到达终态且 result 进入最小 Result Inbox？

### Hypothesis

1. `TaskTruthProjector.record({ kind: "start", parentId })` 已能创建关联父任务的 child TaskTruth，无需新机制。
2. delegate 的 receipt 语义（`{ accepted: true, taskId }`）只是"已登记 + 已启动后台执行"的确认，不需要等待 child result——现有 store 写入是同步的，receipt 可以立即返回。
3. child 的 `failed` / `cancelled` 终态只作用于 child 自己的 TaskTruth；Main 的 TaskTruth 独立演进（ projector 按 taskId 分队列）。
4. 终态不可覆盖（`TERMINAL_TASK_STATUSES` 守卫）使 child 完成后的迟到事件不会污染 truth。
5. 一个最小 Result Inbox（只存 result payload，不存 status）即可承载 child result，不构成第二套 status truth。

### Experiment

不使用真实 Pi。fake worker = 一个持有 completion gate 的 deferred 函数；fake scheduler = 直接调用 worker 并负责把 worker 结局翻译成 `TaskTruthProjector` 信号的最小胶水（spike 专用，disposable 候选）。

场景（Main Turn 1 → delegate → Main Turn 2）：

1. Main task 进入 running；`delegate("research X")` 被调用。
2. 断言 child TaskTruth 创建且 `parentId == mainTaskId`，status == running。
3. 断言 delegate 在 worker gate 未 resolve 时已返回 `{ accepted: true, taskId }`。
4. Main Turn 2：child 仍 running 期间，Main 继续记录自己的 progress / verified；断言两者 TaskTruth 各自独立。
5. child failure：worker reject → child 进入 failed；断言 Main 的 TaskTruth 不为 failed。
6. （独立子场景）cancel child：child 进入 cancelled；Main 不受影响。
7. （独立子场景）child 成功：worker resolve → child 进入 done（verified）；result 进入 Result Inbox；断言 Inbox 可取回 result 且 inbox 不持有 status 字段。
8. 迟到的 child 事件（终态后再次 record）不改变 child 终态。

### Pass Criteria

- B1：delegate 返回时 child 处于 running，且 receipt 在 worker 完成之前返回（有时间顺序直接证据）。
- B2：child.parentId == main taskId。
- B3：child running 期间 Main 可继续推进自身 TaskTruth 至 done。
- B4：child failed 时 Main 的 TaskTruth 保持其自身状态（不是 failed）。
- B5：cancel child 不影响 Main。
- B6：child verified 后 TaskTruth 为 done，result 可从 Result Inbox 取回；Inbox 不含 status 字段（唯一 status truth 仍是 TaskTruth/store）。
- B7：终态后的迟到信号不改变 child 终态。

### Observation

测试 `packages/kernel/test/spike-b-async-delegation.test.ts`，kernel 111/111 全绿：

- Fact: `delegate()` 返回 `{ accepted: true, taskId }` 时，worker.settled == false 且 child TaskTruth 已为 running——receipt 先于 worker 完成，顺序证据直接。
- Fact: child.parentId == main taskId（`TaskTruthProjector` 原生 parentId 传递，无新机制）。
- Fact: child running 期间 Main 记录 verified → Main done，child 仍 running（B3）。
- Fact: worker reject → child failed；Main 保持 running（B4）。cancel child → child cancelled；Main 保持 running 且随后能自行 done（B5）。
- Fact: worker resolve → child done；result（"X findings"）可从 Result Inbox 取回；inbox 条目无 status 字段（B6）。
- Fact: child done 后再 record failed，状态仍 done（TERMINAL 守卫，B7）。
- Fact: fake scheduler 胶水（worker 结局 → projector 信号翻译 + inbox 写入）约 40 行，全部复用现有 kernel 原语，未新增任何 status 概念。
- Inference: 现有 kernel 原语足以支撑异步 delegation 的 TaskTruth 语义；生产化所需的真正设计点在别处（见下）。

### Decision

- Hypothesis 1–5：**全部证实**。
- 结论：异步 delegation 不需要新 task status truth；`{ accepted, taskId }` receipt 语义与现有 store 同步写入兼容；最小 payload-only Result Inbox 模式成立。
- Spike 未回答（保持 unknown）：worker 的宿主模型（进程内 promise / 独立 worker 线程 / 独立进程）；超时与重试策略；scheduler 崩溃后 running child 的恢复；result 如何重新进入 Main 的上下文（下一轮 turn 注入 vs 主动通知）；并发 child 的数量上限与排队策略。这些是正式 Scheduler / Execution Cell 的设计问题，不属于本轮 spike。

---

## 代码分类

- `packages/runtime/test/spike-a-adapter-concurrency.test.ts` → **reusable regression test**。覆盖的 A1–A6 是生产 adapter 的并发契约，建议产品化时去掉 spike 命名、并入正式 runtime 测试套件（可将重复的 fake harness 收敛进 fixtures）。
- `packages/kernel/test/spike-b-async-delegation.test.ts` → **部分 reusable**。TaskTruth 的 parentId / 终态守卫 / 作用域隔离断言值得进入正式 kernel 测试；fake `delegate()` / `FakeWorker` / `ResultInbox` 胶水是 **disposable experiment**，正式 Scheduler 设计出现时替换。
- `.work/spike-a-real-pi-probe.mjs`、`.work/spike-a-l2-log.txt` → **disposable experiment**（`.work` 本就不入库；probe 脚本仅作下次真实验证的参考模板）。
- `docs/spikes/2026-08-10-delegation-concurrency.md` → **保留**（research 类知识，Status 转 historical，As-of 2026-08-10）。
- 无 production-worthy code：本轮没有改动任何 `src/`。

第二轮（D/E/F）补充：

- `packages/kernel/test/spike-d-capsule-handoff.test.ts` → **部分 reusable**。D3/D4/D5（bannedKeys 硬拒、字段丢弃）与 D8（深拷贝隔离）值得并入正式 kernel 测试；`handoffReceive` 的 expiry 检查是 disposable 胶水，但其揭示的"kernel 无内建 expiry 执行点"必须在产品 handoff 设计中回答。
- `packages/runtime/test/spike-e-desktop-cell.test.ts` → **disposable experiment**（`ResourceLease` 是 spike 最小实现；产品 lease 需要正式的宿主与生命周期设计）。E1–E5 的语义断言可作为产品 lease 实现后的验收清单复用。
- `packages/kernel/test/spike-f-result-reentry.test.ts` → **部分 reusable**。F3/F6（active turn 不被 result 抢占）与 F5（单次 consume）是正式 inbox 实现后的关键验收；spike 的 `ResultInbox` / `delegate` 胶水 disposable。
- `docs/research/delegation-rfc.md` → **保留**（research 类，RFC v2 为当前设计基准）。
- 两轮累计：仍无 production-worthy code；`src/` 零改动。

---

## Promotion record（2026-08-11，Architecture Decision Gate）

RFC 已 Accepted（docs/research/delegation-rfc.md），决策锚点 ADR 0009。资产实际处置：

**Promoted（知识与长期契约）**

- RFC v2 → `docs/research/delegation-rfc.md`（Accepted）
- 本实验记录 → 保留（research / historical）
- Spike A 并发测试 → 转正为 `packages/runtime/test/pi-runtime-adapter-concurrency.test.ts`（3 个契约测试；fake harness 保持自包含）
- Spike B 的 parent-child truth invariant → 重写为 `task-truth.test.ts` 的 "keeps parent and child TaskTruth independent across child terminal states"（直接驱动生产 `TaskTruthProjector`，无 worker 胶水）
- Spike D 的 capsule 安全/隔离 invariant → 重写为 `packages/kernel/test/context-capsule.test.ts`（6 个测试，直接驱动生产 `capsule.ts`；含"parse 不执行 expiry"的 gap 钉住测试）
- ADR 0009 → `docs/decisions/0009-delegated-execution-architecture.md`

**Deleted（spike 胶水与一次性材料）**

- `spike-b-async-delegation.test.ts`（FakeWorker / delegate 胶水自测；invariant 已重写）
- `spike-d-capsule-handoff.test.ts`（handoffReceive 胶水；invariant 已重写）
- `spike-e-desktop-cell.test.ts`（spike `ResourceLease` 自测——无生产实现可保护；E1–E5 保留为未来产品 lease 的验收清单，见本文 Spike E 节）
- `spike-f-result-reentry.test.ts`（spike `ResultInbox` 自测——同上；F1–F7 保留为未来产品 inbox 的验收清单）
- `.work/spike-a-real-pi-probe.mjs`、`.work/spike-a-l2-log.txt`（disposable probe 与日志）

**遗留设计义务（已记录于 ADR 0009 Consequences）**

- 产品 handoff 实现必须在接收路径显式执行 capsule expiry validation（kernel 无内建执行点，`context-capsule.test.ts` 已钉住该 gap）。
- 产品 Desktop lease / Result Inbox 实现时，以本文 E1–E5 / F1–F7 为验收清单。

---

# 第二轮（2026-08-11）：Spike D / E / F

输入：RFC v2（docs/research/delegation-rfc.md）。同样先写标准再写代码。

## Spike D — ContextCapsule Handoff

### Question

Main Agent 能否把现有 `ContextCapsule` 作为最小、受控上下文交给独立 Child execution，而不复制完整 conversation？

### Hypothesis

1. `buildContextCapsule` 输出字段有限（intent / app / window / AX / projectHint / recentTrail 窗口），天然是最小上下文。
2. capsule 无 conversation turns 字段，handoff 不会复制完整 history。
3. screenshot bytes / credentials / hidden reasoning 已有三道防线：`buildContextCapsule` 不包含、`parseContextCapsule` 的 bannedKeys 硬拒、`sanitizePortableText` 消毒。
4. capsule 本身不携带 SessionScope；handoff envelope 需显式携带 scope，child 以此 scope 写 TaskTruth 时与 parent 一致。
5. **反假设**：`expiresAt` 字段存在但 kernel 内没有强制执行点——expiry 执行需要 handoff 边界的显式检查，当前可能不成立。
6. serialize → parse 是深拷贝投影，child 改自己的副本不会污染 Main 的 trail/frame。

### Experiment

deterministic child task：child 收到 capsule（经 serialize/parse 边界 + 最小 handoff 检查）后，仅根据 capsule 字段回答预设问题。对照组：过期 capsule、手工注入 bannedKeys 的 capsule、错 scope 的 TaskTruth 写入。

### Pass Criteria

- D1：child 仅凭 capsule 字段完成 deterministic task（intent/app/window/AX 摘要足够）。
- D2：capsule 不含 conversation turns；recentTrail 只含 recentMinutes 窗口（构造跨 1 小时的 trail，仅 5 分钟内条目进入）。
- D3：capsule 无 `base64Data`；手工注入的 capsule 被 `parseContextCapsule` 硬拒。
- D4：含 credential 样式的输入被消毒或拒绝；手工注入 `apiKey`/`accessToken` 字段被硬拒。
- D5：手工注入 `chainOfThought`/`systemPrompt` 被硬拒。
- D6：handoff envelope 携带的 SessionScope 使 child 的 TaskTruth 写入与 parent 同 scope；不同 scope 写入同 taskId 被 `task_scope_conflict` 拒绝。
- D7：过期 capsule 在 handoff 边界被拒绝（若 kernel 无内建执行点，如实记录并由 spike 胶水实现最小检查）。
- D8：child 修改自己 capsule 副本后，Main 的 trail entries / frame 原值不变。

### Observation

测试 `packages/kernel/test/spike-d-capsule-handoff.test.ts`，kernel 116/116 全绿（当时）：

- Fact: deterministic child 仅凭 capsule 字段（userIntent / frontmostApp / axElement / selectedText / projectHint）完成预设任务。
- Fact: 跨 1 小时的 6 条 trail 中，仅 5 分钟窗口内的 2 条进入 capsule；capsule 无 turns / conversation 字段。
- Fact: 序列化后的 handoff 不含 `base64Data`；手工注入 `base64Data` / `apiKey` / `accessToken` / `password` / `chainOfThought` / `systemPrompt` 的 capsule 全部被 `parseContextCapsule` 硬拒；`serializeContextCapsule` 丢弃手造对象的未知字段。
- Fact: handoff envelope 携带的 project scope 使 child 写入与 parent 同 scope 的 TaskTruth 成功；异 scope 写入同 taskId 被 `task_scope_conflict` 拒绝。
- Fact: **kernel 内没有 expiry 强制执行点**——`parseContextCapsule` 只验证结构，不检查 `expiresAt`。过期拒绝由 spike 胶水（`handoffReceive`）在 handoff 边界实现。这正是 Hypothesis 5 的反假设，被证实。
- Fact: child 把副本的 userIntent 改写、trail 清空、app 改名后，Main 的 trail entries / frame / 原 capsule 实例全部不变（serialize→parse 是深拷贝投影）。

### Decision

- Hypothesis 1–4、6：**证实**。Hypothesis 5（反假设）：**证实**——`expiresAt` 只是数据字段，expiry 执行是 handoff 边界的责任，kernel 当前不提供执行点。产品实现时，expiry 检查必须成为 handoff 接收路径的显式步骤，不能依赖 parse。
- 结论：现有 `ContextCapsule` 可直接作为 child 的最小受控上下文；handoff envelope = `{ capsule, sessionScope }`（scope 不进 capsule 本体）。

## Spike E — Exclusive Desktop Cell

### Question

两个独立任务都请求真实 macOS Desktop 时，系统能否确保同一时间只有一个任务拥有执行权？

### Hypothesis

1. 单 coordinator process 内，一个带 token/epoch 的最小 lease 即可保证互斥，无需 distributed lease。
2. owner 的 cancel/failed 路径都能释放 lease（终结即释放）。
3. 迟到的 stale release（旧 token）无法释放新 owner 的 lease。
4. lease 按资源命名（"desktop" 与其他 cell 独立），后台任务持有非 Desktop cell 不阻塞 Main 的 Desktop acquire。

### Experiment

spike 内实现最小 disposable `ResourceLease`（单进程、内存态、token 防 stale）。desktop action 用计数 fake port 守门：无 lease 不得执行。

### Pass Criteria

- E1：A 持有 Desktop 时 B acquire → B 为 queued/blocked，且 B 的 desktop action 调用计数为 0。
- E2：A cancel → lease 释放 → B acquire 成功并可执行。
- E3：A failed → lease 释放。
- E4：lease 易主后，A 的迟到 release（旧 token）不影响 B 的持有。
- E5：后台任务持有非 Desktop cell（如 "research"）时，Main 的 Desktop acquire 不受阻塞。

### Observation

测试 `packages/runtime/test/spike-e-desktop-cell.test.ts`，runtime 147/147 全绿（当时）：

- Fact: A 持有 desktop 时 B 的 `acquire` 返回 `{ granted: false }`，B 无 token 的 `perform` 被拒且 `desktop.executed` 中无 B 的记录（E1）。
- Fact: A cancel → `forceRelease(desktop, task-A)` 后 B acquire 成功并执行（E2）；failed 路径同样释放（E3）。
- Fact: 易主后 A 持旧 token 的 `release` 返回 false，B 仍是 owner 且 `holds` 为 true（E4）。
- Fact: 后台任务持有 "research" cell 时，Main 的 desktop acquire 立即成功（E5）。
- Fact: 全部互斥逻辑是单进程内存态 + token 匹配，约 40 行，无分布式设施。

### Decision

- Hypothesis 1–4：**全部证实**。
- 结论：单 coordinator process 下，token 防 stale 的最小 lease 足以保证 Desktop 互斥语义；cancel/failed 统一走 coordinator `forceRelease`（owner 已终结，不能依赖其自愿释放）。产品实现时，desktop action 执行路径必须先过 lease 守门，lease 本身可以是 kernel 或 runtime 的单例协调器。
- 未验证（保持 unknown）：真实 Pi 并发 desktop 执行时的 OS 层互斥（本 spike 只验证 lease 语义层）；lease 超时与死 owner 检测；跨进程 worker 持有 lease 的模型。

## Spike F — Result Re-entry

### Question

Child task 完成后，结果如何安全重新进入 Main Agent，而不抢占用户当前 interaction？

### Hypothesis

1. payload-only Result Inbox（条目关联 taskId/parentId，无 status 字段）足以承载 re-entry。
2. result envelope（succeeded/failed/cancelled）描述的是 result 的性质，不构成第二套 task status。
3. inbox 写入与 Main 当前 turn 完全解耦：active turn 的上下文不被修改、不被中断。
4. Main 在显式 presentation point consume；consume 是一次性的。

### Experiment

沿用 Spike B 的 fake worker/scheduler。Main 侧模拟一个 active turn（持有 turn 上下文对象），child 在其间完成。断言 turn 上下文 deep-equal 不变；turn 结束（presentation point）后 Main consume。

### Pass Criteria

- F1：inbox 条目可通过 taskId 检索，且携带 parentId。
- F2：条目无 status 字段；TaskTruth 仍是唯一 status 真相。
- F3：result 到达前后，Main active turn 的上下文对象 deep-equal。
- F4：Main 未 consume 时 result 留在 inbox；显式 consume 才取出。
- F5：同一 taskId 第二次 consume 返回空。
- F6：Main active turn 期间 child 完成只写 inbox，无任何对 turn 的注入/中断。
- F7：failed / cancelled 的 child 产生明确 result envelope（`{kind:"failed",error}` / `{kind:"cancelled"}`），可正常 consume。

### Observation

测试 `packages/kernel/test/spike-f-result-reentry.test.ts`，kernel 118/118 全绿：

- Fact: Main active turn 进行中 child 完成，turn 上下文对象（draft / pendingToolCalls / consumePointOpen）与快照 deep-equal，无任何 mutation 或中断（F3/F6）。
- Fact: inbox 条目按 taskId 检索并携带 parentId；条目无 status 字段（F1/F2）；TaskTruth 中 child 为 done，与 inbox 互不复制。
- Fact: 未 consume 时 result 留在 inbox；presentation point 打开后显式 consume 取出；第二次 consume 返回 undefined（F4/F5）。
- Fact: failed / cancelled child 分别产生 `{kind:"failed",error}` / `{kind:"cancelled"}` envelope，均可正常 consume；对应 TaskTruth 为 failed / cancelled；Main 的 TaskTruth 保持 running（F7）。

### Decision

- Hypothesis 1–4：**全部证实**。
- 结论：payload-only inbox + result envelope 语义成立；envelope 的 kind 描述 result 性质，不构成第二套 task status。re-entry 的安全模型是"child 只写 inbox，Main 在 presentation point 显式一次性 consume"——proactive notification 系统不需要为 V1 存在。
- 未验证（保持 unknown）：result 在 Main 下一 turn 的注入形式（context 摘要 vs 原文）；inbox 的持久化与重启恢复；多 child 同时完成的 consume 顺序策略。
