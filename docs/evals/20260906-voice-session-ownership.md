# Phase 0A：从 CompanionManager 抽出语音输入会话所有权

- 日期：2026-09-06
- 状态：active
- 上下文：GitHub Issue #25（parent #24）；`docs/NOTES.md` 当前状态

## 一句话任务

把键盘 PTT / 听写会话生命周期从 `CompanionManager` 抽到独立所有者，用户可见的 Control+Option 行为保持等价。

## Change（用户能观察到什么）

按住 Control+Option 说话、中间稿、松手终稿、空录「没听清」、插话停声、按住即采场景，与抽之前同一条路径。用户看不出这次是重构。

## Not this（不算数的替代）

- 只把方法挪到 extension、生命周期仍由 `CompanionManager` 持有
- 包一层只转发、自己不拥有状态的 wrapper
- 为了拆文件改 barge-in / 预热 / TTS / 口播
- 做全双工、免按键聆听、IM、后续 Phase 0 issue

## Goal / Hard bar / Improve

- Goal：低层 PTT/听写会话有唯一所有者；`CompanionManager` 只消费类型化会话事件并保留现有产品行为
- Hard bar：Issue #25 的五条会话单测全绿；现有 barge-in / held-scene 测试不回退；`CompanionManager` 不再直接持有已迁出的 PTT/听写生命周期状态
- Improve：无

## 验收标准

| # | 标准 | evaluator | 证据 |
|---|---|---|---|
| 1 | pressed → partial(s) → released → final 只提交一次 | 机器：`xcodebuild test … -only-testing:leanring-buddyTests/YishuVoiceSessionControllerTests ENABLE_DEBUG_DYLIB=NO CODE_SIGNING_ALLOWED=NO ENABLE_HARDENED_RUNTIME=NO` | TEST SUCCEEDED；`pressedPartialsReleasedFinalEmitsOneSubmission` 绿 |
| 2 | 异步 start 未 settle 就松手，不会卡在 holding | 同上 | `quickReleaseBeforeStartSettlesDoesNotStickHeld` 绿 |
| 3 | 过期 / 被替代会话的回调不能提交 | 同上 | `staleAndSupersededCallbacksAreIgnored` 绿 |
| 4 | cancel 之后迟到的 final 不能提交 | 同上 | `cancellationPreventsLaterFinalSubmission` 绿 |
| 5 | 空 / 近静音终稿走失败捕获事件，不是成功终稿 | 同上 | `emptyFinalIsUnsuccessfulCaptureNotFinalTranscript` 绿 |
| 6 | 现有 barge-in 与 held-scene 行为测试不回退 | 机器：同次 `xcodebuild test` 加 `-only-testing:leanring-buddyTests/YishuBargeInTests -only-testing:leanring-buddyTests/YishuHeldScenePolicyTests` | TEST SUCCEEDED |
| 7 | 听写状态机既有覆盖仍绿（不重复造内部测试） | 机器：`… -only-testing:leanring-buddyTests/leanring_buddyTests` | TEST SUCCEEDED；transcription reducer / dictation submit 条绿 |
| 8 | `CompanionManager` 不再直接拥有键盘 PTT/听写生命周期状态 | 机器：`rg -n "pendingVoiceTurnOrigin|pendingKeyboardShortcutStartTask|handleShortcutTransition|startPushToTalkFromKeyboardShortcut|consumeVoiceTurnOrigin" apps/clicky/leanring-buddy/CompanionManager.swift` 无命中 | 无命中 |
| 9 | 产品能编译；CompanionManager 行数棘轮不升 | 机器：`pnpm product:build:clicky`；`node script/check-file-size-limit.cjs` | build 退出 0；CompanionManager 4453/4609（原 4507） |
| 10 | 插话停声、按住采场景、没听清 仍由 CompanionManager 接线 | 人评：对照 PR「Intentionally unchanged」；本轮不装真机 | |

## 非目标

- 全双工 / 免按键麦克风
- 改 runtime 取消、steer、电脑动作、TTS、overlay 所有权
- 改 BuddyDictationManager / BuddyTranscriptionStateMachine 内部职责
- 实现 #24 的后续子 issue

## 基线与结果

- 动手前：`CompanionManager.handleShortcutTransition` 同时拥有 PTT 监听、听写 start/stop、origin、中间稿/终稿回调，以及 TTS/插话/held-scene/overlay。CompanionManager 4507 行。
- 交付：`YishuVoiceSessionController` 拥有 monitor 订阅、键盘听写 start/stop/cancel、pressed/released、origin 一次性消费、partial/final/empty/cancel 事件。CompanionManager 只消费事件并保留 runtime/TTS/overlay/barge-in/held-scene/prewarm。CompanionManager 4453 行。会话 6 测、barge-in、held-scene、leanring_buddyTests 均 TEST SUCCEEDED。`product:build:clicky` 退出 0。预存 collector 880/856 红线仍在。

## 人评清单（交付时填）

- [ ] #10 PR 描述写清迁出/未迁出边界，且无用户可见行为改动声称
