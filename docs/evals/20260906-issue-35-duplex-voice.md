# Duplex Voice 1A：免按键多轮聆听与抢音频地板

- 日期：2026-09-06
- 状态：active
- 上下文：GitHub Issue #35；starting main `9f84fff`；`docs/NOTES.md` 当前状态

## 一句话任务

打开一次连续聆听之后，用户不用再按 Control+Option 也能多轮说话；开口即停 TTS；开口本身不取消 Runtime；PTT 在关闭连续聆听时保持原样。

## Change（用户能观察到什么）

设置里打开「连续聆听」（默认关）后：连说多句不必再按键；奕枢说完仍在听；用户开口时它立刻停声；关掉后不再自动送句；关掉后 Control+Option 与现在一样。

## Not this（不算数的替代）

- 只加开关、仍要每句按键
- 开口就 `cancel`/`settle` Runtime
- 用 StepAudio Realtime 当第二个脑子
- 第二套 `AVAudioEngine` 采麦
- 整段 TTS 期间把麦克风关掉来假装没有自回声
- 为了接 realtime 放宽 `#31` 上下文对等
- OpenAI / Gemini / xAI / Moshi / 新付费语音供应商
- IM、AgentIdentity、Task/Run、现场 CUA 改点

## Goal / Hard bar / Improve

- Goal：连续 VoiceSession 能免按键多轮、切句一次、开口抢地板、Runtime 寿命独立
- Hard bar：`hands_free_voice_contract_failures == 0` 且其余支持指标到目标；PTT 回归 0；`#29/#31/#33` 保持
- Improve：主健身函数越低越好，目标 0

## 供应商路径（动手前）

比较只限当前付费通道：Step Plan + MiniMax Token Plan。OpenAI Realtime / Gemini realtime 不是本 slice 依赖。

### Path A — 现有组合栈（选用）

麦克风（`BuddyDictationManager`）→ Step Plan 流式 ASR → Yishu Product Kernel / Runtime → MiniMax Speech TTS → 现有播放。连续聆听用本地能量切句；开口用本地能量抢地板。

### Path B — StepAudio 2.5 Realtime（本 slice 不用）

麦克风 → StepAudio Realtime WebSocket / Server VAD → 供应商自动推理。

证据与否决见卡内「供应商门」和下表。把它接到与 Pi/Codex 同一份 `TurnExecutionContext` 会把 #35 扩成新执行器任务；不接则会变成第二个脑子。按 Issue 要求：停，记下，不绕过 #31。

### 供应商门

| # | 问题 | Path A | Path B（Step Plan `stepaudio-2.5-realtime`） |
|---|---|---|---|
| 1 | 免按键多轮 | 本地切句 + 会话保持 armed | Server VAD 可切句，但会自动推理 |
| 2 | 开口延迟 | 本地能量，与现有 PTT 同路径停声 | 文档 `speech_started`；exp4 S8 ~945 ms，S4 2556–9550 ms |
| 3 | 打断 | 现有 `stopPlayback` 同步 | `response.cancel`；实测停声远超 100 ms |
| 4 | 切句质量 | 本地静音 700 ms + ASR final 互斥 | Server VAD `silence_duration_ms` 默认 100 ms，过短 |
| 5 | 用户转写 | 现有 Step Plan ASR 终稿 | 有转写字段，但会话会同时生成模型回复 |
| 6 | 自回声 | 本机 voice processing + 播放期更高阈值 | 仍要把扬声器送回麦；供应商也会当用户话 |
| 7 | 是否自动语义推理 | 否。只有终稿走现有路由 | 是。文档：Server VAD 下 `input_audio_buffer.append` 触发大模型推理；`commit` 同样推理 |
| 8 | Yishu 是否保有语义/任务权威 | 是。Kernel → Runtime | 否。exp4/S6：屏幕/记忆句 0 次 `ask_yishu`，模型自己答 |
| 9 | 与 VoiceSession 集成 | 扩展现有控制器 | 第二套 WS 会话与 Conversation 真相 |
| 10 | 当前套餐 | Step Plan ASR + MiniMax TTS 已是生产路径 | Step Plan realtime 能 `session.created`；Token Plan `/v1/realtime` 曾 402 |

选用 Path A：满足产品合同的最小架构。不因行数少而选 B。

### 供应商权威（Path A）

| 所有者 | 允许 | 不允许 |
|---|---|---|
| `BuddyDictationManager` | 唯一麦克风 `AVAudioEngine`、voice processing、把 PCM 送给 ASR | Runtime、TTS、记忆、授权 |
| `YishuHandsFreeListeningPolicy` | 开口/收尾/回声门限；一句一个终界 | 产品动作 |
| `YishuVoiceSessionController` | 连续 VoiceSession 开关、一句的 generation、去重提交 | Runtime cancel/steer |
| Step Plan ASR | 中间稿与终稿文本 | 切句主权（可作终稿，不得与本地收尾双提交） |
| MiniMax Speech TTS | 口播音频 | 抢地板；停声由产品 `stopPlayback` |
| Product Kernel / Runtime | 记忆、意图、任务合同、安全门、执行 | 开口时被停声牵连取消 |
| StepAudio Realtime | 本 slice **不拥有任何产品职责** | 不得当 Main 执行器、不得写 Conversation、不得授权 |

## 验收标准

没有 evaluator 的句子不算标准。机器项跑到全绿再交付；人评项单列。

| # | 标准 | evaluator | 证据 |
|---|---|---|---|
| 1 | 主健身函数 0 | 机器：`node script/check-hands-free-voice-contract.cjs`（执行 `YishuHandsFreeFitnessHarness`，不靠测试名） | `hands_free_voice_contract_failures: 0` |
| 2 | 十句免再按键 | 同上 + Swift 矩阵 B | `manual_rearm_actions_per_10_utterances: 0` |
| 3 | 开口不停 Runtime | 同上 + 矩阵 D（执行 `YishuDuplexAudioFloor.takeFloorOnSpeechOnset` 注入缝） | `speech_onset_runtime_cancellations: 0` |
| 4 | 自回声 0 句 | 同上 + 矩阵 E | `assistant_self_triggered_user_turns: 0` |
| 5 | 一句不双提交 | 同上 | `duplicate_auto_submissions: 0` |
| 6 | 静音不成轮 | 同上 + 矩阵 F | `silence_false_turns: 0` |
| 7 | PTT 不回退 | 同上 + 矩阵 H + 既有会话/barge-in 测 | `ptt_regressions: 0` |
| 8 | 无第二脑子 | 同上 | `realtime_semantic_authority_bypasses: 0` |
| 9 | 只有一个采麦主人 | 同上 | `parallel_microphone_capture_owners: 1` |
| 10 | 开口停声同步，不等 ASR/Runtime | 机器：Swift 矩阵 C + `YishuDuplexAudioFloorTests`；呈现 stop 在 `takeFloorOnSpeechOnset` 同步发生 | 测试绿；`presentationStopped=true` 且 `hasFinal=false` |
| 11 | 三轮免按键 | 机器：`… YishuHandsFreeVoiceContractTests` 矩阵 A | 3 次 finalized，0 次 shortcut |
| 12 | 十轮免按键 | 同上矩阵 B | 10 次 finalized |
| 13 | 关掉后迟到 final 不提交 | 同上矩阵 G | 0 次 late submit |
| 14 | 既有 PTT 会话测仍绿 | 机器：`YishuVoiceSessionControllerTests` | TEST SUCCEEDED |
| 15 | barge-in / 前台执行测仍绿 | 机器：`YishuBargeInTests` + `YishuForegroundRuntimeExecutionTests` | TEST SUCCEEDED |
| 16 | `#29/#31/#33` 保持 | 机器：既有 checker | 0/0、0/1、0/0/1 |
| 17 | 协议未改；CompanionManager 棘轮不升；collector 棘轮不抬 | 机器：`git diff -- packages/runtime/src/protocol.ts`；`pnpm size:check`；`pnpm product:check` | 无协议 diff；停在预存 880/856 |
| 18 | 真机连续聆听自然度、误切句、停声手感 | 人评：PR 列出的 8 步；本轮不装真机 | 待用户裁 |

## 非目标

- OpenAI Realtime、Gemini realtime、xAI voice、Moshi、新付费语音供应商
- 把 StepAudio Realtime 接成第三个 Main 执行器
- IM / AgentIdentity / 持久帮手 / 现场 CUA 改点 / Task-Run / EverOS 重做
- M0 #17 停顿哼声
- 无关的口播质量优化、换 TTS 供应商（MiniMax 保持基线）

## 基线与结果

- 动手前（`9f84fff`）：无连续 VoiceSession / 本地切句 / `speechOnset` 停声路径。Issue 预期主健身函数 ≥4。按矩阵 A–G 缺失、H（PTT）仍在，表征为 7。
- 交付（本分支）：
  - `hands_free_voice_contract_failures: 7 → 0`
  - `manual_rearm_actions_per_10_utterances: 10 → 0`
  - `speech_onset_runtime_cancellations: 1 → 0`
  - `assistant_self_triggered_user_turns: 1 → 0`
  - `duplicate_auto_submissions: 0`
  - `silence_false_turns: 0`
  - `ptt_regressions: 0`
  - `realtime_semantic_authority_bypasses: 0`
  - `parallel_microphone_capture_owners: 1`
- `#29` 0/0，`#31` 0/1，`#33` 0/0/1。协议无 diff。CompanionManager 4476/4609。`product:check` 越过本检查器，停在预存 collector 880/856。

## 人评清单（交付时填）

- [ ] #18 真机：开一次连续聆听 → 十句免按键 → 五次插话停声 → 静听几句不误触发 → 关掉不再自动送 → Control+Option 仍可用
