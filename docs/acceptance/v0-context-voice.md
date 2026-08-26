# V0 context and voice acceptance

Type: acceptance
Status: historical
As-of: 2026-08-09

> Historical snapshot only. Do not read this page as current runtime ownership.
> Current fact (ADR 0014): the Yishu-owned model-tool loop at `packages/runtime/src/model-loop/` is the only shipping loop; `@earendil-works/pi-coding-agent` is removed; `YISHU_RUNTIME_MODE=pi` is a compatibility value that maps to `YishuLoopRuntimeAdapter`.

## User path

1. Launch the Yishu development harness explicitly when testing that historical
   surface. Normal `--verify` runs headlessly and must not show its `✿` presence
   beside the canonical Clicky app.
2. Move the pointer over a visible interface element.
3. Hold Control+Option after authorizing Input Monitoring, or choose “开始说话” from the menu-bar `✿`, then say a phrase containing “这个” or “这里”.
4. Release the shortcut or choose “停止并发送”.
5. Yishu visibly changes through listening and thinking states.
6. The runtime receives a fresh context frame with cursor, app/window, available element metadata, pointer trail, and a cursor-screen image when permission allows.
7. Yishu streams a response, speaks it, and remains interruptible for the next turn.

## Pass conditions

- The floating window is non-activating and does not become the frontmost app.
- The cursor companion is click-through, tracks at roughly 60 Hz, and does not enlarge into a persistent avatar.
- Context schema validation passes on both Swift and TypeScript sides.
- Screenshot payloads and selected content are absent from logs.
- Runtime errors are visible and do not become false successful replies.
- Mock mode completes the full visible path without external credentials.
- ~~Pi mode uses `@earendil-works/pi-coding-agent` through `PiRuntimeAdapter`.~~ Struck as a current claim. As of this snapshot the product still had a Pi adapter; ADR 0014 later removed that SDK. Current shipping path is `YishuLoopRuntimeAdapter` + `packages/runtime/src/model-loop/`; `YISHU_RUNTIME_MODE=pi` is only a compatibility value.

## Not yet accepted

- continuous full-duplex barge-in;
- proactive background triggers;
- Cua background actions;
- task-cell isolation;
- durable relationship memory;
- Skill generation and replay.
