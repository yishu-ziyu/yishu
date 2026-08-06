# Yishu Project Instructions

## Product invariants

- 奕枢（Yishu）是唯一持续存在的用户可见身份。Hanako 是已吸收的人格设计来源，不是第二个产品或对外身份；专家 Agent 留在后台。
- 二开 Clicky 是当前唯一正式交互壳。保留其 bundle identity、TCC 权限、登录项、UserDefaults、鼠标伴随、语音与 TTS；本仓库的 macOS app 只是默认不占用全局快捷键的开发壳。
- Voice and spatial presence are primary interfaces, not add-ons.
- Context is evidence: every context item carries source, capture time, confidence, and expiry semantics.
- Keep the user cursor, Yishu's visible pointer, and background execution input as separate channels.
- Pi is the execution harness. Yishu identity, relationship memory, initiative policy, permissions, and task truth remain product-owned.
- The legacy Kairos bridge, SSE progress stream, `RunProgressPresenter`, and `forceKairosRouting` are failed experiments and must not be migrated into Yishu. Task state comes from typed Pi `AgentRuntime` events.
- A tool success is not task completion. Verify the final visible or externally observable result.
- Do not expose hidden chain-of-thought. User-visible reflections are short authored state, not raw reasoning.
- Never log raw credentials, screenshot payloads, private conversation memory, or selected personal content.

## Architecture boundaries

- The canonical Clicky macOS app owns shipping presence, voice, permissions, TTS, and user settings. `apps/macos` in this repository is an integration harness only.
- `YishuContext` owns the portable evidence model; the canonical app will supply its production collector.
- `packages/runtime` owns the Pi adapter and the versioned runtime protocol.
- Product code depends on `AgentRuntime`; Pi-specific types stay inside `PiRuntimeAdapter`.
- Runtime commands and events must remain versioned, typed, cancellable, and traceable.
- Mature Pi tools are retained through task capability profiles. Do not rebuild them without evidence.

## Verification

```bash
pnpm test
pnpm run check
swift test
./script/build_and_run.sh --verify
```

For user-visible changes, launch the app and inspect the real floating presence. A build alone is not product acceptance.
