# Yishu Project Instructions

Type: invariant
Status: current
Verified: 23b2e07 2026-08-11
Review: 产品不变量、架构边界或验证拓扑变化时

## Product invariants

- 奕枢（Yishu）是唯一持续存在的用户可见身份；Hanako 是已吸收的人格设计来源，不是第二个产品或对外身份；专家 Agent 留在后台。 → docs/decisions/0001-yishu-single-identity.md
- `apps/clicky` 是奕枢唯一 macOS App 源码、构建、安装与可见验收入口，保留其 bundle identity、TCC 连续性、登录项、UserDefaults、鼠标伴随、语音与 TTS；不得重建第二个 macOS App。 → docs/decisions/0012-single-macos-app-source.md
- Voice and spatial presence are primary interfaces, not add-ons.
- Context is evidence: every context item carries source, capture time, confidence, and expiry semantics. → docs/decisions/0006-context-is-evidence.md
- Keep the user cursor, Yishu's visible pointer, and background execution input as separate channels.
- Pi 是唯一正式 Agent 核心循环；`packages/agent-core` 只保留为独立实验室，不是 `AgentRuntime` 模式或 `packages/runtime` 依赖；mock 只是协议测试替身。 → docs/decisions/0011-pi-single-agent-loop.md
- Kairos 只在 Kairos 历史仓库保留旧 bridge 的历史记录；Kairos bridge、SSE progress stream、`RunProgressPresenter` 和 `forceKairosRouting` 都不是 Yishu 的依赖、回退或运行路径，禁止迁入、调用或恢复；task state comes from typed Pi `AgentRuntime` events. → docs/decisions/0004-no-kairos.md
- Agent Native 只提供 Action 设计方法论，不是 Yishu 的 Swift 或 Node 依赖，也不是第二个运行时；可吸收模式：单一 typed Action、fresh target/observation、执行前 revalidate、结构化 receipt、可见 read-back。 → docs/decisions/0008-agent-native-methodology-only.md
- A tool success is not task completion. Verify the final visible or externally observable result.
- Do not expose hidden chain-of-thought. User-visible reflections are short authored state, not raw reasoning.
- Never log raw credentials, screenshot payloads, private conversation memory, or selected personal content.

## Architecture boundaries

- The Clicky macOS app at `apps/clicky` owns presence, voice, permissions, TTS, user settings, source, installation, and visible acceptance. Tests and build configurations must not create a second App implementation. → docs/decisions/0012-single-macos-app-source.md
- `YishuContext` owns the portable evidence model in the root Swift package; Clicky supplies its production collector.
- `packages/kernel` owns the product layer above turns: `YishuAction` registry, `ContextTrail`, evidence store (`MemoryClaim` / Learning / Skill / Mandate / TaskTruth), and `ContextCapsule`; Voice / UI / initiative / MCP / CLI / Pi share product actions, not fork handlers. → docs/decisions/0011-pi-single-agent-loop.md
- `packages/runtime` owns the Pi adapter and the versioned runtime protocol (`AgentRuntime` remains turn-centric execution).
- Product code depends on `AgentRuntime` for turns and on `@yishu/kernel` for product capabilities; Pi-specific types stay inside `PiRuntimeAdapter`.
- Runtime commands and events must remain versioned, typed, cancellable, and traceable.
- Pi remains the only shipping model-tool loop; Swift remains the macOS actuator through Accessibility and Quartz; Agent Native patterns may shape the product-owned protocol, but no Agent Native or AgentCore runtime code is imported into kernel or runtime. → docs/architecture.md
- Mature Pi tools are retained through task capability profiles. Do not rebuild them without evidence.

## Verification

```bash
pnpm test
pnpm run check
pnpm --filter @yishu/kernel test
swift test
pnpm product:verify
```

For user-visible changes, launch the app and inspect the real floating presence. A build alone is not product acceptance.

→ docs/runbooks/verification.md

## Lessons

- Teable Grok poller: never stop/delete/disable the Loop unless the human explicitly says so（关掉 Loop / 取消定时；subagent cost is not permission）; Codex rework = Grok work（可领取带下一步 notes 或进行中带 Codex rework bullets 时必须实现，不得 idle-skip）; claimable = 记录类型=执行任务 ∧ 负责人=Grok ∧ 执行状态=可领取（each fire full-table reads all fields; deep-read 下一步/验收方法 before coding）。Full field map + ops → docs/runbooks/teable-grok-poller.md

## Knowledge map

- 知识架构与生命周期约定 → docs/README.md
- 架构决策记录（ADR）→ docs/decisions/
- 操作流程 → docs/runbooks/
- 技术债登记 → docs/debt/technical-debt.md
- 入库四问：类型？唯一事实源？何时失效？失效如何被发现？答不出不得入库。
