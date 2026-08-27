# 技术债台账

Type: debt
Status: current
Verified: dd5a362 2026-08-23
Review: 每个 PR merge 后检查是否命中条目；条目修复即删除

使用规则：

- 做出 defer 决策时即登记条目，写清 why deferred 与 revisit trigger。
- 修复 PR 必须同时删除对应条目。
- debt 是负资产台账，不得把 debt 当功能文档写。

## debt-001: god-file CompanionManager.swift

- what: `CompanionManager.swift` 4613 行，identity / relationship / cancellation / presentation / desktop execution 多职责集中于单文件。
- why deferred: 触及正式外壳核心路径，拆分无即时功能收益，留待职责边界变化时重构。
- evidence: `apps/clicky/leanring-buddy/CompanionManager.swift`（2026-08-23 实测 4613 行）
- revisit trigger: 需要改动 Companion 职责边界或新增职责域时。
- severity: medium

## debt-002: god-file yishu-store.ts

- what: kernel 证据存储单文件 3163 行。
- why deferred: 同上——行为稳定，拆分留待存储域扩张时。
- evidence: `packages/kernel/src/store/yishu-store.ts`（2026-08-23 实测 3163 行）
- revisit trigger: 新增证据类型或 backend 导致文件继续膨胀时。
- severity: medium

## debt-003: god-file product-kernel-runtime.ts

- what: runtime 产品内核单文件 4496 行。history、memory list/read-back/forget/visible hydration/recall、context-watch 推进/取消已分别通过 `ConversationLedger`、`MemoryLedger`、`ContextWatchLedger` 收回 Kernel；turn/task/delegation 等域仍直接访问 raw store。
- why deferred: 继续按真实独立演进的领域逐个抽取，不做一次性机械拆文件。
- evidence: `packages/runtime/src/product-kernel-runtime.ts`（2026-08-23 实测 4496 行）；边界棘轮中该文件 `kernel.store` 访问由 50 降至 37，门槛同步从 49 降至 37，没有放宽。
- revisit trigger: turn/task/delegation 任一域需要独立演进，或新增 raw-store 访问时；棘轮必须单调下降。
- severity: medium

## debt-005: 死代码（OpenAIAPI / ElementLocationDetector）

- what: `OpenAIAPI`（vision analysis helper）与 `ElementLocationDetector` 两个 class 无调用点。
- why deferred: 删除零风险但零收益，排队待清理。
- evidence: `apps/clicky/leanring-buddy/OpenAIAPI.swift:9` `OpenAIAPI`、`apps/clicky/leanring-buddy/ElementLocationDetector.swift:22` `ElementLocationDetector`，无外部调用点（2026-08-10 全库 grep）
- revisit trigger: 任何触及 OpenAI 集成或元素定位路径的 PR。
- severity: low

## debt-006: 命名债（ElevenLabsTTSClient / ClaudeAPI）

- what: `ElevenLabsTTSClient` 实际走 MiniMax；`ClaudeAPI` 仅为 `/chat` proxy 客户端，与 Claude 无关。
- why deferred: 改名波及正式外壳引用，留待触及对应文件时顺手改。
- evidence: `apps/clicky/leanring-buddy/ElevenLabsTTSClient.swift`、`apps/clicky/leanring-buddy/ClaudeAPI.swift`
- revisit trigger: 修改 TTS 或 /chat proxy 路径时。
- severity: low

## debt-007: HANAKO_* 环境变量残留

- what: `HANAKO_RUNTIME_MODE` / `HANAKO_USER_NAME` 作为 fallback 残留，与 ADR 0001 单一身份相悖。
- why deferred: 删除属行为变更（可能影响旧启动脚本），需确认无调用方。
- evidence: `packages/runtime/src/runtime-factory.ts:13`、`packages/runtime/src/persona.ts:1`
- revisit trigger: 确认无外部脚本引用后删除；或下次改 runtime-factory / persona 时。
- severity: low

## debt-008: 演示媒体进正式包

- what: `ff.mp3`（约 8MB）/ `eshop.mp3` / `steve.jpg` / `codex-add-project.png` 随正式 bundle 分发。
- why deferred: 移除需确认无运行时引用，属清理项。
- evidence: `apps/clicky/leanring-buddy/ff.mp3`（8,176,672 bytes）等同目录文件
- revisit trigger: 关注 bundle 体积或做发布打包时。
- severity: low

## debt-011: cancelTurn 对不存在 requestId 也发 turn.cancelled

- what: `cancelTurn` 不校验 requestId 是否存在，统一发 `turn.cancelled`。
- why deferred: 行为对调用方无害，修正属语义收紧，需评估兼容性。
- evidence: `packages/runtime/src/loop-adapter.ts` 的 `cancelTurn()`——`hasActiveRequest` 检查仅控制 `cancelledRequestIds` 登记，`turn.cancelled` 仍无条件 emit。
- revisit trigger: 有调用方依赖取消幂等语义，或协议 schemaVersion 演进时。
- severity: low

## debt-012: 纯工具回合被判 failed 的隐性规则

- what: `response.completed` 要求最终 `authoritativeText` 非空，纯工具回合（无文本输出）会被判 failed——隐性规则未显式表达。
- why deferred: 修正涉及 TaskTruth 语义，需与产品确认"纯工具回合"的终态定义。
- evidence: `packages/runtime/src/loop-adapter.ts` 的 `startTurn()`——`authoritativeText` 为空即抛出 `completed the turn without a user-visible response`，纯工具回合落入 failed 路径。
- revisit trigger: 出现纯工具回合误报，或定义任务终态语义时。
- severity: medium

## debt-013: 模型解析失败误命名为 invalid_model_preference

- what: 模型解析早期失败统一归因为 `invalid_model_preference`，覆盖非 preference 类失败，命名误导。
- why deferred: 改名影响错误码消费方，需区分失败类别后一次做。
- evidence: `packages/runtime/src/loop-adapter.ts` 的模型/会话准备 catch（模型解析早期失败统一发 `invalid_model_preference`）
- revisit trigger: 错误码消费方（UI / 日志分析）需要区分失败类别时。
- severity: low

## debt-014: runtime 类型检查未覆盖测试目录

- what: `packages/runtime/tsconfig.check.json`（extends `tsconfig.json`）只 include `src/**/*.ts`，测试目录无类型检查覆盖。
- why deferred: 纳入测试目录需先修既有类型错误，工作量单列。
- evidence: `packages/runtime/tsconfig.json`（`include: ["src/**/*.ts"]`）、`packages/runtime/tsconfig.check.json`
- revisit trigger: 测试因类型错误失效，或统一收紧各包 tsconfig 时。
- severity: low

## debt-015: AssemblyAI provider 集成未完成

- what: `AssemblyAIStreamingTranscriptionProvider` 被 `BuddyTranscriptionProvider.resolveProvider()` 的 `.assemblyAI` 分支实例化并使用，不是无调用点死代码；真正的问题是 token proxy URL 仍为模板值，集成未完成。
- why deferred: 需要"完成集成"或"完整移除"的明确决策；移除需同时处理 `PreferredProvider` enum、`resolveProvider()` 的 `.assemblyAI` 分支与相关配置路径，超出本轮范围。
- evidence: `apps/clicky/leanring-buddy/BuddyTranscriptionProvider.swift:72` `resolveProvider()`（实例化调用点）、`apps/clicky/leanring-buddy/AssemblyAIStreamingTranscriptionProvider.swift:22` `tokenProxyURL`（模板值 `your-worker-name.your-subdomain.workers.dev`）；`isConfigured` 恒 true（同文件 :27），配置 `VoiceTranscriptionProvider=assemblyai` 即可选择该路径。
- revisit trigger: 触及语音转写 provider 选择路径，或决定启用 / 移除 AssemblyAI 时。
- severity: low

## debt-016: Result Inbox 跨后端重开回归矩阵不完整

- what: Result Inbox 已从 Runtime 内存迁入 Kernel store，并有 SQLite / JSON 持久化、claim / ack / release 与 startup orphan fail-closed recovery；但尚缺一组具名回归，用同一契约逐一覆盖 memory / JSON / SQLite 的 reopen + claim / ack / release 矩阵。
- why deferred: 产品路径和现有全套 Kernel / Runtime 回归已通过；当前优先功能与短周期迭代，不为已有合同重复堆大量测试。
- evidence: `packages/kernel/src/store/yishu-store.ts` 与 `sqlite-store.ts` 的 delegated result API；`packages/runtime/src/product-kernel-runtime.ts` 的 terminal ack / failure release / startup recovery；现有 suite 覆盖 facade 和存储 reopen/migration，但不是完整三后端状态矩阵。
- revisit trigger: 修改 delegated result schema、store migration、claim 语义或重启交付路径时；或真实重启验收出现重复 / 丢失时。
- severity: low

## debt-017: delegated child session release 缺少穷举生命周期回归

- what: `DelegationCoordinator` 已在 child promise 的 `finally` 中按 conversationId 调用 `YishuLoopRuntimeAdapter.releaseConversationSession()`，实现终态后精确释放；但尚缺一项回归，穷举 success / failed / cancel / exception / dispose 后都断言 child cache 尺寸不增长。
- why deferred: 生产接线和全套 Runtime 回归已通过；保留一项聚焦的测试债，不扩展成重复的终态组合测试。
- evidence: `packages/runtime/src/delegation.ts` 的 child `finally`，`packages/runtime/src/loop-adapter.ts` 的 `releaseConversationSession()`；现有 suite 已跑通实际 child session 创建边界，但未穷举各类终态的 cache non-growth。
- revisit trigger: 修改 delegation 终态、cancel / dispose、model-loop session cache 或 child promise 生命周期时；或出现 session 累积证据时。
- severity: low

## debt-018: 循环内化后的残留命名

- what: ADR 0014 移除 Pi SDK 后的残留：(a) `YishuLoopRuntimeAdapter` 构造仍收 `workingDirectory`（引擎已不消费，仅测试 mkdtemp 用）；(b) capability 档位命名 `build`/`owner` 仍是 coding 词汇（引擎已无内置开发工具，四档语义退化为文档性）；(c) `YISHU_RUNTIME_MODE=pi` 作为兼容值保留（Clicky 仍发送）。历史背景见 [agent-book-product-alignment.md](../research/agent-book-product-alignment.md)。
- why deferred: 纯命名清理；`pi` 兼容值改动需同步 Clicky 与边界守卫字面量，单独一批做。
- evidence: `packages/runtime/src/loop-adapter.ts`（构造参数）、`packages/runtime/src/capability-profiles.ts`、`packages/runtime/src/runtime-factory.ts`
- revisit trigger: 触及 runtime-factory / capability 档位 / Clicky 启动环境变量时。
- severity: low

## debt-019: 巨型循环依赖组件（product-kernel-runtime hub）

- what: dependency-cruiser（`pnpm dep:check`）检出 326 条参与循环的边，集中在 `packages/runtime/src` 的巨型强连通组件。根因是 `product-kernel-runtime.ts`（4496 行 god-file）同时 import 大量模块又被其 import，形成辐辏式循环网；这不是若干独立小环，而是以 hub 为中心的一个大 SCC。
- why deferred: 拆 hub 是重构性工作，触达验证 / 桌面执行核心路径，无即时功能收益；机械一次性拆文件风险高，需按域逐个抽取（与 debt-003 同路径）。
- evidence: `pnpm dep:check`（2026-08-25）no-circular warn 326 条；跨包架构边界 0 error（已由 dependency-cruiser `forbidden` 规则锁定为 error 门禁）。两处直接小环 `delegation↔loop-adapter`（SessionToolPolicy 抽至 `session-policy.ts`）、`extraction-queue↔extraction`（ExtractionSnapshot 抽至 `extraction-types.ts`）已抽离，madge 清零，但边数主体未降——证明必须拆 hub 才治本。
- revisit trigger: 拆分 `product-kernel-runtime.ts` 或减少 raw store 访问时；或任何触达 Turn / Task / Delegation 域时。SCC 边数必须随 hub 拆分单调下降。
- severity: high

## debt-020: 循环第一刀 + 尺寸红线判定改进

- what: 第一刀拆出 `product-kernel-runtime.helpers.ts`（966 行模块级纯函数/常量层，无 this），`product-kernel-runtime.ts` 从 4499 → 3542 行；同关 loop `delegation↔loop-adapter`（抽 `session-policy.ts`）、`extraction-queue↔extraction`（抽 `extraction-types.ts`）已清零。同时把 `script/check-file-size-limit.cjs` 判定从"所有 >400 文件"收紧为"**含 class 定义**的 >400 文件"（14 个为基线，纯函数 helper 文件不计数，因其是拆分中间态且对改动传播风险低）。
- why deferred: 这是把 god-file 按"纯函数层 / class 本体"切分的第一步，帮助 hub SCC 根因定位；但 class 本体（turn/task/delegation 域方法）仍全部集中，是下一刀目标。
- evidence: `packages/runtime/src/product-kernel-runtime.helpers.ts`（新增，966 行）；`packages/runtime/src/product-kernel-runtime.ts` 3542 行；`script/check-file-size-limit.cjs`（BASELINE=14，按 class 判定）。
- revisit trigger: 继续拆 `product-kernel-runtime.ts` 的 class 方法域时；把 helpers 进一步拆到每文件 ≤400 后回调基线时。
- severity: medium
