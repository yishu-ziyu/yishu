# PR #36 再审：开口前缀、可执行健身、听写状态与可听播放

- 日期：2026-09-06
- 状态：active
- 上下文：`docs/NOTES.md` 当前状态；GitHub PR #36 / Issue #35；原卡 `docs/evals/20260906-issue-35-duplex-voice.md`

## 一句话任务

修 PR #36 的实现正确性与健身测量：开口到 ASR 就绪的 PCM 不得丢；健身函数必须跑生产 VoiceSession 行为；UI 不得在未真正 armed 时显示「正在听」；回声门跟真实可听播放走。

## Change（用户能观察到什么）

连续聆听打开且麦克风真正 armed 之后：开口第一段话能进 ASR；设置开关可以表示想要连续听，但面板只有实际在采麦时才写「正在听」；启动失败会说失败，不会留下假会话；奕枢还没出声时，正常说话阈值有效；出声后才抬回声门。真机 `duplex.speech_onset → tts.stopped` 有可跑命令，本轮不宣称真机通过。

## Not this（不算数的替代）

- 新开 PR 或合并 #36
- 只改文案、只加测试名、只 grep 源码符号让健身函数变 0
- 第二套麦克风 / 第二套状态机专供评测
- 开始 StepAudio Realtime 执行器
- 协议 schema、EverOS、IM / AgentIdentity / CUA 改点
- 把「请求已发出」当成扬声器在响

## Goal / Hard bar / Improve

- Goal：#35 的 Path A 在实现上保住整句用户话、状态诚实、健身函数量的是行为
- Hard bar：`node script/check-hands-free-voice-contract.cjs` 行为指标全 0（且反作弊夹具不能全 0）；所列 Swift 测绿；#29/#31/#33 保持；协议无 diff
- Improve：无（零是上限）

## 验收标准

| # | 标准 | evaluator | 证据 |
|---|---|---|---|
| 1 | 开口触发 + ASR 就绪延迟中的 PCM 按序进权威会话，恰好一次 | 机器：`YishuContinuousCapturePreRollTests` | TEST SUCCEEDED |
| 2 | 关掉连续聆听清掉未送出的 pre-roll；上一句不漏进下一句 | 同上 | TEST SUCCEEDED |
| 3 | pre-roll 有界，不长期留麦 | 同上 + 源码上限 | 时长/字节上限断言 |
| 4 | 健身六项来自执行生产 VoiceSession 缝的行为报告，不是测试名存在 | 机器：`node script/check-hands-free-voice-contract.cjs` | 打印六项 = 0；反作弊夹具非全 0 |
| 5 | 符号齐全但行为空的夹具不能让六项全 0 | 同上内置 anti-gaming | checker 证明夹具失败 |
| 6 | 权限/启动拒绝后 UI 不显示「正在听」，偏好不保持已启用，无幽灵会话 | 机器：`YishuHandsFreeVoiceContractTests` 启动失败矩阵 | TEST SUCCEEDED |
| 7 | 采麦未变成 active 同上 | 同上 | TEST SUCCEEDED |
| 8 | TTS 请求已发出但无音频 → 闲时开口阈值 | 机器：Swift TTS audible + VoiceSession 阈值测 | TEST SUCCEEDED |
| 9 | 真实可听播放中 → 回声阈值；停/完成回到闲时 | 同上 | TEST SUCCEEDED |
| 10 | 真机双工打断命令可读 quality log，报 n + p50/p95 | 机器：`node evals/voice/check-latency.mjs --metric duplex-interrupt --fixture evals/voice/fixtures/duplex-interrupt.sample.jsonl` | 夹具测绿；真机未跑、不宣称通过 |
| 11 | 连续听开启时面板不说可以按住 Control+Option | 机器：`YishuPanelHierarchyTests` | 无该句；「正在听」只在 armed |
| 12 | 既有健身与棘轮保持 | 机器：hands-free checker + #29/#31/#33 checker + `git diff -- packages/runtime/src/protocol.ts` | 全 0；#31 assembly 1；#33 paths 1；协议无 diff |
| 13 | 真机自然度 | 人评：原 #35 8 步 + 开口第一字是否进转写 | 待用户裁 |

## 非目标

- StepAudio Realtime 执行器/接入
- 新 PR、合并
- 第二套 AVAudioEngine
- 协议 / EverOS / IM / AgentIdentity / 现场 CUA

## 基线与结果

- 动手前：连续采麦 tap `appendingTo: nil`，ASR 会话就绪后才转发；健身检查器 grep 测试名；CompanionManager 在 capture 成功前发布并持久化 enabled；`speakText` 在请求开始就标播放中；延迟评估器只有 `ptt.key_down → tts.stopped`；面板在连续听时写「也可以按住 Control+Option」。
- 交付：
  - pre-roll 测绿：延迟 ASR 按序一次、上一句不漏、关掉清空、有界丢最旧
  - `node script/check-hands-free-voice-contract.cjs`：行为六项 0，采麦 1，realtime 0；符号夹具不能全 0
  - 权限拒绝 / 采麦未 active 不显示「正在听」
  - 可听播放：请求期闲时阈值；clip player 未播不标 audible
  - `node evals/voice/check-latency.mjs --metric duplex-interrupt --fixture evals/voice/fixtures/duplex-interrupt.sample.jsonl` 夹具绿；真机未跑
  - #29 0/0，#31 0/1，#33 0/0/1，协议无 diff，CompanionManager 4479/4609
  - collector 880/856 预存红线未动

## 人评清单（交付时填）

- [ ] #13 真机：开连续聆听后第一字进转写；失败权限不显示正在听；出声前插话不被回声门吃掉
