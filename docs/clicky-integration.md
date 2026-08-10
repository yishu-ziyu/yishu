# Clicky integration: one Yishu Super App

## Decision

`apps/clicky` is Yishu's only formal Clicky source, installation source, and canonical interaction shell. It owns the interaction details that users can feel: the small cursor companion, menu bar panel, Control+Option push-to-talk, StepFun transcription, model selector, pointing animation, and MiniMax speech output.

The work in this repository is not a replacement shell or a second Clicky source. It contributes three product capabilities to `apps/clicky`:

1. the Yishu identity and relationship policy, absorbing the Hanako persona preset;
2. an evidence-bearing `ContextFrame` for shared attention;
3. a versioned `AgentRuntime` implemented through the Pi SDK.

`apps/macos` is only the development and integration shell in this repository.
It is not a second product, login item, signing source, or installation path.

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

- `CompanionManager.runVoiceTurnTask` coordinates final transcript, one ContextFrame capture, Pi streaming, fallback, history, pointing, and MiniMax output.
- Before that general path, `YishuDirectClickResolver` handles an explicit click on a visually named control locally: position hints constrain Vision OCR, the actuator performs one verified click, and the result becomes a short spoken confirmation. It prefers AXPress, then uses a guarded pointer-preserving Quartz click for self-drawn controls such as Codex's sidebar. A miss falls through to the normal ContextFrame and Pi path.
- `YishuContextFrameCollector` adapts `apps/clicky`'s production ScreenCaptureKit output and adds pointer trail, frontmost application/window, accessibility element, source, capture time, confidence, expiry, and warnings.
- `YishuAgentRuntimeClient` starts the bundled Node/Pi sidecar, sends the captured frame once, and maps typed runtime events back to the existing response overlay.
- `YishuAgentRuntimeClient` owns one stable `conversationId` in Clicky's existing
  UserDefaults domain. A request ID is the turn ID; cancellation reuses the
  original trace ID. Starting a new conversation rotates the ID only when no
  turn is active.
- `ProductKernelRuntime` writes the turn into Kernel's durable conversation
  ledger before invoking the execution harness. Pi session history and
  Clicky's bounded `conversationHistory` remain temporary caches, not product
  truth.
- Clicky explicitly selects `personal`, a stable named `project`, or `private`
  before starting a conversation. A scope change rotates `conversationId` and
  clears fallback history; the Pi session cache is also keyed by conversation.
- Kernel rejects cross-scope reuse of a conversation, turn, or task. Fact and
  learning writes use `personal` or `project:<UUID>` namespaces. Private turns
  run live but skip memory, ledger, ContextTrail, and TaskTruth persistence, and
  private mode is never restored after restart.
- Product-action cancellation distinguishes the commit point. Before commit it
  leaves no durable side effect; after commit it records the action and a
  stable failed-turn reconciliation code, while suppressing success text and
  TTS.
- `computer.action.requested` and `computer.action.result` keep Pi tool use separate from visible assistant text. Clicky executes a left click through Accessibility and returns visible-state evidence without moving the physical cursor.
- The runtime quarantines fenced code and legacy `<computer_control>` blocks. A direct click request stays visually buffered until the action result is known, then resolves to a short success, unverified, or failure message.
- Legacy `[POINT]` responses remain useful for guidance. When the user's original intent is a direct click, Clicky upgrades the coordinate to the same verified action path and replaces the model wording, so neither `[POINT]` nor “请自己点” reaches the overlay or TTS.
- Model selection is explicit runtime input. The selected Clicky model resolves to Pi's fixed `yishu-local-grok` provider backed by loopback port 8787 and the existing 8317 OpenAI-compatible upstream.
- The direct Grok path is invoked only when Pi cannot start or complete a voice turn. Kairos is not a fallback.

## Implemented first slice

The seam now sits after StepFun returns the final transcript and before response presentation:

1. One typed ContextFrame is captured for the turn and reused by the controlled fallback.
2. Pi deltas stream into Clicky's existing cursor-adjacent response overlay; only final text is sent to MiniMax.
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
9. **Next, Make It Usable:** restore and browse conversations from Kernel,
   remove the bounded Clicky history's remaining fallback role, and assemble
   reviewed scoped memory before new turns.
10. **Later, Retire:** remove any dormant Kairos references from Yishu and the direct-model fallback only after audible parity and recovery checks; keep `apps/macos` as the development harness.

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
