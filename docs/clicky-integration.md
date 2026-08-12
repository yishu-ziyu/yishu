# Clicky integration: one Yishu Super App

Type: architecture
Status: current
Verified: c268654 2026-08-13
Review: apps/clicky 与 runtime/sidecar 接线变化时

## Decision

`apps/clicky` is Yishu's only formal Clicky source, installation source, and canonical interaction shell. It owns the interaction details that users can feel: the small cursor companion, menu bar panel, Control+Option push-to-talk, StepFun transcription, model selector, pointing animation, and MiniMax speech output.

The work in this repository is not a replacement shell or a second Clicky source. It contributes three product capabilities to `apps/clicky`:

1. the Yishu identity and relationship policy, absorbing the Hanako persona preset;
2. an evidence-bearing `ContextFrame` for shared attention;
3. a versioned `AgentRuntime` implemented through the Pi SDK.

The repository has no second development shell. Portable Swift protocol code
lives in the root package, while all visible integration work and acceptance
remain in `apps/clicky`.

## Target turn path

```text
Control+Option
      |
Clicky PTT + StepFun ASR
      |
YishuTurnCoordinator
      /                                                    \
explicit named click                               general/complex turn
      |                                                    |
local OCR + verified desktop action          ContextFrameCollector
      |                                                    |
verified action result                       AgentRuntimeClient + Pi
      \                                                    /
       Clicky response overlay --- safe text / point / result
                              |
existing Clicky overlay + MiniMax TTS
```

## What stays

- Clicky's app delegate, menu bar panel, overlay windows, pointer animation, push-to-talk monitor, and onboarding.
- `BuddyDictationManager` and the StepFun transcription provider through local port 8787.
- The existing model picker and Grok proxy route through port 8317.
- Point conversion, Stop/cancel behavior, and the existing visual presentation primitives. Their state will be driven directly by typed Pi `AgentRuntime` events.
- The current MiniMax-backed TTS client and its interruption behavior.
- Bundle ID `com.yishu.yishu-buddy`, signing identity, installation path, TCC grants, login item, and current UserDefaults domain.

## Excluded historical experiment

Kairos belongs only to the historical bridge in the Kairos project. It is not a
Yishu dependency, fallback, or runtime path. `apps/clicky` and the Yishu runtime
must not import or start `KairosBridgeClient`, the Kairos SSE progress stream,
`RunProgressPresenter`, or `forceKairosRouting`; they must not expose Kairos
control or task-progress UI. Any old bridge source stays with Kairos history,
not in the Yishu source or installation boundary.

Pi `AgentRuntime` is the only task event source. Clicky's existing overlay may render `turn.started`, tool progress, cancellation, failure, and verified completion, but it must not depend on Kairos compatibility events.

## Current port boundary

- `CompanionManager.runVoiceTurnTask` coordinates final transcript, one ContextFrame capture, Pi streaming, pointing, and MiniMax output. Conversation failures remain on the Pi/Kernel spine: one bounded sidecar restart is allowed, then Clicky reports the failure rather than invoking a second provider conversation.
- Before that general path, `YishuDirectClickResolver` handles an explicit click on a visually named control locally: position hints constrain Vision OCR, the actuator performs one verified click, and the result becomes a short spoken confirmation. It prefers AXPress, then uses a guarded pointer-preserving Quartz click for self-drawn controls such as Codex's sidebar. A miss falls through to the normal ContextFrame and Pi path.
- `YishuContextFrameCollector` adapts `apps/clicky`'s production ScreenCaptureKit output and adds pointer trail, frontmost application/window, accessibility element, source, capture time, confidence, expiry, and warnings.
- `YishuAgentRuntimeClient` starts the bundled Node/Pi sidecar, sends the captured frame once, and maps typed runtime events back to the existing response overlay.
- `YishuAgentRuntimeClient` owns one stable `conversationId` in Clicky's existing
  UserDefaults domain. A request ID is the turn ID; cancellation reuses the
  original trace ID. Starting a new conversation rotates the ID only when no
  turn is active.
- `ProductKernelRuntime` writes the turn into Kernel's durable conversation
  ledger before invoking the execution harness. Pi session history is a
  temporary cache; a newly created Pi session receives an exact-scope bounded
  window of completed visible turns from Kernel. Clicky no longer owns a
  parallel conversation-history cache.
- Clicky explicitly selects `personal`, a stable named `project`, or `private`
  before starting a conversation. A scope change rotates `conversationId` and
  the Pi session cache is keyed by conversation and scope.
- Kernel rejects cross-scope reuse of a conversation, turn, or task. Fact and
  learning writes use `personal` or `project:<UUID>` namespaces. Private turns
  run live but skip memory, ledger, ContextTrail, and TaskTruth persistence, and
  private mode is never restored after restart.
- Product-action cancellation distinguishes the commit point. Before commit it
  leaves no durable side effect; after commit it records the action and a
  stable failed-turn reconciliation code, while suppressing success text and
  TTS.
- `computer.action.requested` and `computer.action.result` keep Pi tool use separate from visible assistant text. Clicky executes verified left-click, Finder history-back, and focused writable-field text actions through Accessibility; every effect revalidates its live target, and text receipts omit the entered value.
- The runtime quarantines fenced code and legacy `<computer_control>` blocks. A direct click request stays visually buffered until the action result is known, then resolves to a short success, unverified, or failure message.
- Legacy `[POINT]` responses remain useful for guidance. When the user's original intent is a direct click, Clicky upgrades the coordinate to the same verified action path and replaces the model wording, so neither `[POINT]` nor “请自己点” reaches the overlay or TTS.
- Model selection is explicit runtime input. The selected Clicky model resolves to Pi's fixed `yishu-local-grok` provider backed by loopback port 8787 and the existing 8317 OpenAI-compatible upstream.
- The local `/chat` helper is limited to the onboarding pointing demo. It is not a conversation fallback; Kairos is not a fallback either.
- Clicky samples screenshot-free recent context metadata about every five seconds. Exact SessionScope is mandatory end to end, and private mode stops collection before the Swift collector runs.
- Terminal delegated work returns once after a three-second quiet window through the existing overlay and TTS. The durable Result Inbox remains untouched until an ordinary Main turn consumes it, so a natural follow-up still sees the result.

## Implemented first slice

The seam now sits after StepFun returns the final transcript and before response presentation:

1. One typed ContextFrame is captured for the turn and reused by the controlled fallback.
2. Pi deltas stream into Clicky's existing cursor-adjacent response overlay. 普通纯对话按安全句界串行送入 MiniMax，首句不再等待完整回答；可能产生桌面副作用的意图与实际 action 都保持 final-only，PTT/cancel 会立即清空待播队列。
3. A second push-to-talk press cancels the active runtime request, response overlay, and TTS.
4. The nine `apps/clicky` Grok choices map to a strict runtime allowlist with no caller-supplied URL or headers.
5. The installed bundle contains its own Node executable and deployed Pi runtime; ordinary installation preserves existing TCC grants and does not request administrator access.
6. The conversation profile retains the product-owned `computer_control` tool while generic built-in shell and file tools remain disabled; clicks round-trip through the typed macOS action port.
7. Clicky and the runtime share a stable conversation ID; ordinary dialogue,
   product actions, and execution receipts enter one Kernel-owned ledger.
   Completed request IDs replay from that ledger instead of executing twice.

Local acceptance covers the signed installed app, live bundled sidecar, a real Grok 4.5 streaming completion through 8787/8317, synthetic StepFun transcription, and MiniMax audio generation. A spoken Control+Option turn through the physical microphone remains the final manual whole-path check.

## Migration order

1. **Done, Preserve:** retain Clicky's voice, pointer, panel, identity, signing, and TCC surfaces.
2. **Done, Ground:** collect one evidence-bearing ContextFrame per turn.
3. **Done, Port:** add a bundled `AgentRuntimeClient` and event-to-overlay mapping.
4. **Done, Connect:** map the current Grok selector through Pi to 8787/8317.
5. **Done, Act:** connect direct left-click requests to the product-owned macOS Accessibility port with result verification and safe presentation.
6. **Done, Accelerate:** route explicit, visually named clicks through local Vision OCR and the shared verified Accessibility actuator before invoking Pi.
7. **Done, Establish Truth:** add stable conversation/turn/trace identity and a
   Kernel-owned conversation ledger for visible turns and safe typed events.
8. **Done, Scope:** add explicit personal/project/private session boundaries,
   stable project identity, scoped fact/learning/task truth, and live-only
   private turns before automatic memory extraction is enabled.
9. **Done, Continue:** restore and browse conversations from Kernel; rehydrate
   cold Pi sessions from bounded exact-scope visible history; remove Clicky's
   fallback conversation cache; inject bounded recent context and explicit
   same-scope Learning before ordinary turns.
10. **Done, One App:** retire the duplicate macOS development shell and keep shared `YishuContext` as a protocol-only root Swift package.
11. **Done, Return:** restore delegated task truth after restart and return a
    terminal result once when the user is quiet, without manufacturing a turn
    or losing follow-up grounding.
11. **Later, Retire:** remove any dormant Kairos references from Yishu and the direct-model fallback only after audible parity and recovery checks.

The current production deployment remains one Clicky instance managing one
SQLite-backed sidecar. Multi-runtime exactly-once execution still needs a
durable lease; the JSON backend must not be shared by independent processes.

## Non-goals for the first slice

- Renaming or replacing the shipping bundle identity.
- Rebuilding StepFun ASR, MiniMax TTS, or the Clicky overlay.
- Migrating or reviving the Kairos bridge and task-progress experiment.
- Treating a tool event as task completion.
- Persisting raw screenshots, audio, secrets, or private conversation content.

## Action methodology boundary

Agent Native is a design-methodology source only. Yishu does not import its
Swift/Node runtime or copy its implementation. The product-owned action seam
absorbs five patterns: one typed Action contract, a fresh target/observation
reference, execution-time revalidation, a structured receipt, and visible
read-back. Pi remains the execution harness; the Swift side remains responsible
for Accessibility/AXPress, guarded Quartz fallback, pointer preservation, and
visible verification.
