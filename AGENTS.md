# Yishu Project Instructions

## Product invariants

- 奕枢（Yishu）是唯一持续存在的用户可见身份。Hanako 是已吸收的人格设计来源，不是第二个产品或对外身份；专家 Agent 留在后台。
- `apps/clicky` 是奕枢唯一正式 Clicky 源码与安装源，保留其 bundle identity、TCC 权限、登录项、UserDefaults、鼠标伴随、语音与 TTS；本仓库的 `apps/macos` 只是默认不占用全局快捷键的开发壳。
- Voice and spatial presence are primary interfaces, not add-ons.
- Context is evidence: every context item carries source, capture time, confidence, and expiry semantics.
- Keep the user cursor, Yishu's visible pointer, and background execution input as separate channels.
- Pi is the execution harness. Yishu identity, relationship memory, initiative policy, permissions, and task truth remain product-owned.
- Kairos 只在 Kairos 历史仓库保留旧 bridge 的历史记录；Kairos bridge、SSE progress stream、`RunProgressPresenter` 和 `forceKairosRouting` 都不是 Yishu 的依赖、回退或运行路径，禁止迁入、调用或恢复。Task state comes from typed Pi `AgentRuntime` events.
- Agent Native 只提供 Action 设计方法论，不是 Yishu 的 Swift 或 Node 依赖，也不是第二个运行时。可吸收的模式是单一 typed Action、fresh target/observation、执行前 revalidate、结构化 receipt 和可见 read-back。
- A tool success is not task completion. Verify the final visible or externally observable result.
- Do not expose hidden chain-of-thought. User-visible reflections are short authored state, not raw reasoning.
- Never log raw credentials, screenshot payloads, private conversation memory, or selected personal content.

## Architecture boundaries

- The canonical Clicky macOS app at `apps/clicky` owns shipping presence, voice, permissions, TTS, user settings, source, and installation. `apps/macos` in this repository is an integration harness only.
- `YishuContext` owns the portable evidence model; the canonical app will supply its production collector.
- `packages/kernel` owns the product layer above turns: `YishuAction` registry, `ContextTrail`, evidence store (`MemoryClaim` / Learning / Skill / Mandate / TaskTruth), and `ContextCapsule`. Voice / UI / initiative / MCP / CLI / Pi should share product actions, not fork handlers.
- `packages/runtime` owns the Pi adapter and the versioned runtime protocol (`AgentRuntime` remains turn-centric execution).
- Product code depends on `AgentRuntime` for turns and on `@yishu/kernel` for product capabilities; Pi-specific types stay inside `PiRuntimeAdapter`.
- Runtime commands and events must remain versioned, typed, cancellable, and traceable.
- Pi remains the execution harness; Swift remains the macOS actuator through Accessibility and Quartz. Agent Native patterns may shape the product-owned protocol, but no Agent Native package or code is imported into kernel or runtime.
- Mature Pi tools are retained through task capability profiles. Do not rebuild them without evidence.

## Verification

```bash
pnpm test
pnpm run check
pnpm --filter @yishu/kernel test
swift test
./script/build_and_run.sh --verify
```

For user-visible changes, launch the app and inspect the real floating presence. A build alone is not product acceptance.

## Lessons

- Never stop, delete, or disable the Teable Grok poller Loop unless the human explicitly says so (关掉 Loop / 取消定时). Subagent cost is not permission. Full field map + ops: `.work/teable-grok-poller.md` (also in scheduler prompt).
- Codex rework is Grok work: when 可领取 returns with 下一步 notes, or 进行中 carries Codex rework bullets, implement them; do not idle-skip.
- Teable claimable = 记录类型=执行任务 ∧ 负责人=Grok ∧ 执行状态=可领取. Each poller fire full-table reads all fields; deep-read 下一步/验收方法 before coding.
