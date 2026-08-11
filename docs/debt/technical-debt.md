# 技术债台账

Type: debt
Status: current
Verified: 21629d6 2026-08-10
Review: 每个 PR merge 后检查是否命中条目；条目修复即删除

使用规则：

- 做出 defer 决策时即登记条目，写清 why deferred 与 revisit trigger。
- 修复 PR 必须同时删除对应条目。
- debt 是负资产台账，不得把 debt 当功能文档写。

## debt-001: god-file CompanionManager.swift

- what: `CompanionManager.swift` 约 3004 行，identity / relationship / cancellation / presentation 多职责集中于单文件。
- why deferred: 触及正式外壳核心路径，拆分无即时功能收益，留待职责边界变化时重构。
- evidence: `apps/clicky/leanring-buddy/CompanionManager.swift`（2026-08-10 实测 3004 行）
- revisit trigger: 需要改动 Companion 职责边界或新增职责域时。
- severity: medium

## debt-002: god-file yishu-store.ts

- what: kernel 证据存储单文件约 2324 行。
- why deferred: 同上——行为稳定，拆分留待存储域扩张时。
- evidence: `packages/kernel/src/store/yishu-store.ts`（2026-08-10 实测 2324 行）
- revisit trigger: 新增证据类型或 backend 导致文件继续膨胀时。
- severity: medium

## debt-003: god-file product-kernel-runtime.ts

- what: runtime 产品内核单文件约 2084 行，宜按 history / memory / turn 域拆分。
- why deferred: 拆分是纯结构改动，待域边界稳定后一次做。
- evidence: `packages/runtime/src/product-kernel-runtime.ts`（2026-08-10 实测 2084 行）
- revisit trigger: 任一域（history / memory / turn）需要独立演进或独立测试时。
- severity: medium

## debt-004: pi-coding-agent 0.x pin

- what: `@earendil-works/pi-coding-agent` pin 在 0.83.0；0.x 语义下升级可能 breaking。
- why deferred: 升级需跑一次完整 conformance pass，无证据不升级。
- evidence: `packages/runtime/package.json:16`
- revisit trigger: 需要上游新能力或安全修复时；升级必须附 conformance 结果。
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

## debt-009: apps/clicky/worker 不在 pnpm workspace

- what: `apps/clicky/worker` 自带 package.json 与 test/，但 `pnpm-workspace.yaml` 只含 `packages/*`，其测试无人运行。
- why deferred: 接入 workspace 需处理其独立依赖与 CI 顺序，待排期。
- evidence: `apps/clicky/worker/`、`pnpm-workspace.yaml:1-2`
- revisit trigger: worker 逻辑变更或 voice proxy 路径演进时。
- severity: medium

## debt-010: clicky xcodebuild 测试未接入 CI

- what: CI 的 `swift test` 只覆盖 `apps/macos`；`apps/clicky` 的 xcodebuild 测试无 CI 守护。
- why deferred: xcodebuild 测试需签名身份与更长时长，接入成本高。
- evidence: `.github/workflows/ci.yml`（install → check → build → test → swift test）
- revisit trigger: clicky 侧出现回归逃逸，或 CI 时长预算放宽时。
- severity: medium

## debt-011: cancelTurn 对不存在 requestId 也发 turn.cancelled

- what: `cancelTurn` 不校验 requestId 是否存在，统一发 `turn.cancelled`。
- why deferred: 行为对调用方无害，修正属语义收紧，需评估兼容性。
- evidence: `packages/runtime/src/pi-runtime-adapter.ts:411` `cancelTurn()`——`hasActiveRequest` 检查仅控制 `cancelledRequestIds` 登记，`turn.cancelled` 事件于 :422 无条件 emit。
- revisit trigger: 有调用方依赖取消幂等语义，或协议 schemaVersion 演进时。
- severity: low

## debt-012: 纯工具回合被判 failed 的隐性规则

- what: `response.completed` 要求 `streamedText` 非空，纯工具回合（无文本输出）会被判 failed——隐性规则未显式表达。
- why deferred: 修正涉及 TaskTruth 语义，需与产品确认"纯工具回合"的终态定义。
- evidence: `packages/runtime/src/pi-runtime-adapter.ts:367` `runTurn()`——`streamedText` 为空即 `throw "Pi completed the turn without a user-visible response."`，纯工具回合落入 failed 路径。
- revisit trigger: 出现纯工具回合误报，或定义任务终态语义时。
- severity: medium

## debt-013: 模型解析失败误命名为 invalid_model_preference

- what: 模型解析早期失败统一归因为 `invalid_model_preference`，覆盖非 preference 类失败，命名误导。
- why deferred: 改名影响错误码消费方，需区分失败类别后一次做。
- evidence: `packages/runtime/src/pi-runtime-adapter.ts:255`（模型解析早期失败统一发 `invalid_model_preference`）
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

## debt-016: Result Inbox 为内存态，重启后丢失

- what: Delegated Execution V1 的 `ResultInbox` 保存在进程内存中；App 重启后，已完成但尚未被 Main turn 消费的 child result 会丢失（TaskTruth 中的任务终态仍在，但结果摘要不会再注入对话）。
- why deferred: V1 只需证明异步 delegation 语义成立；持久化 inbox 涉及跨重启交付语义与 scheduler crash recovery，属下一阶段。
- evidence: `packages/runtime/src/delegation.ts` `ResultInbox`（`private readonly entries = new Map<string, DelegatedResult[]>()`，无持久化后端）
- revisit trigger: 需要跨重启交付结果，或实现 scheduler crash recovery 时。
- severity: medium
