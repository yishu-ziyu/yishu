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
