# PR #36 再审：生产音频地板必须被永久门执行

- 日期：2026-09-06
- 状态：active
- 上下文：`docs/NOTES.md` 当前状态；GitHub PR #36 / Issue #35；前卡 `docs/evals/20260906-pr36-duplex-correctness.md`

## 一句话任务

让 #35 永久健身门真正执行生产开口抢地板：同步停呈现、不等终稿/Runtime 回执、开口本身不结束前台 Runtime；并把审阅关键回归放进同一次干净树 xcodebuild。

## Change（用户能观察到什么）

开口时奕枢立刻停声，不必等转写终稿或 Runtime 点头；正在跑的前台 Runtime 继续活着。干净检出的 `product:check` / `product:verify` 若有人删停声、开口 cancel/settle/supersede Runtime、或把停声推迟到终稿，门必须红。真机命令仍是 `node evals/voice/check-latency.mjs --metric duplex-interrupt`，本轮不宣称真机通过。

## Not this（不算数的替代）

- 新开 PR 或合并 #36
- 用 `shouldCancelRuntimeOnSpeechOnset() == false` 当 `speech_onset_runtime_cancellations = 0`
- 只证明 VoiceSession 发出 `.speechOnset`，不证明呈现真的停
- 大改 CompanionManager；第二套麦克风；StepAudio Realtime
- 把 `quality.sample.jsonl` 假装成双工打断夹具
- 宣称真机通过

## Goal / Hard bar / Improve

- Goal：永久门量的是生产开口路径的所有权，不是常量
- Hard bar：`node script/check-hands-free-voice-contract.cjs` 指标全目标；四类反作弊变异不能全 0；同一次 xcodebuild 跑完 pre-roll / VoiceSession 诚实 / 可听播放 / 音频地板缝
- Improve：无（零是上限）

## 验收标准

| # | 标准 | evaluator | 证据 |
|---|---|---|---|
| 1 | 开口同步停句管道与 MiniMax 播放，发生在终稿之前 | 机器：`YishuDuplexAudioFloorTests` + fitness C | 呈现 stop 计数 > 0 且 `hasFinal=false` |
| 2 | 开口不等 Runtime 回执才停声 | 同上，调用时 `runtimeAcknowledged=false` | 仍同步停 |
| 3 | 开口不 cancel / settle / supersede 前台 Runtime | 机器：fitness D 实跑注入边界；`speech_onset_runtime_cancellations` | 三项记录均为 0 |
| 4 | 删停声、加 Runtime 终止、推迟到终稿，永久门红 | 机器：checker 内置变异夹具 | 不能全 0 |
| 5 | 生产 `handleDuplexSpeechOnset` 走该缝，且自身不结束 Runtime | 机器：checker 所有权守卫 | 守卫过 |
| 6 | 永久 xcodebuild 含 pre-roll / 听写诚实 / 可听播放 | 机器：checker 一次 `xcodebuild` 多 `-only-testing` | TEST SUCCEEDED |
| 7 | 健身九项保持 | 机器：`node script/check-hands-free-voice-contract.cjs` | 全 0，采麦 1 |
| 8 | 双工打断夹具命令可绿 | 机器：`node evals/voice/check-latency.mjs --metric duplex-interrupt --fixture evals/voice/fixtures/duplex-interrupt.sample.jsonl` | PASS；真机未跑 |
| 9 | #29/#31/#33 与协议保持 | 机器：既有 checker + `git diff -- packages/runtime/src/protocol.ts` | 0/0、0/1、0/0/1；无协议 diff |
| 10 | 真机自然度 | 人评：原 #35 8 步 | 待用户裁 |

## 非目标

- StepAudio Realtime；新 PR；合并；协议 / EverOS / IM / AgentIdentity / 现场 CUA
- 宣称真机通过
- 放宽既有健身函数

## 基线与结果

- 动手前：`speech_onset_runtime_cancellations` 来自常量；C 只证明 `.speechOnset`；永久 xcodebuild 只跑 `YishuHandsFreeFitnessTests`；PR 写的 `quality.sample.jsonl` 没有 `duplex.speech_onset`
- 交付：
  - `node script/check-hands-free-voice-contract.cjs`：九项目标；C `presentationStopped=true` 且 `hasFinal=false`；D cancel/settle/supersede=0 且 Runtime 仍 active
  - 变异夹具（删停声 / 加 cancel / settle / supersede / 推迟终稿）不能全 0；Runtime 终止变异会抬 `speech_onset_runtime_cancellations`
  - 一次 xcodebuild 含 Fitness / VoiceContract / PreRoll / AudibleHook / AudiblePolicy / DuplexAudioFloor / PanelHierarchy，TEST SUCCEEDED
  - `node evals/voice/check-latency.mjs --metric duplex-interrupt --fixture evals/voice/fixtures/duplex-interrupt.sample.jsonl` PASS p50/p95 50；真机未跑
  - #29 0/0，#31 0/1，#33 0/0/1，kernel 236，runtime 526，dep 0，协议无 diff，CompanionManager 4493/4609
  - `product:check` 越过本门，停在预存 collector 880/856

## 人评清单（交付时填）

- [ ] #10 真机：开口即停声；开口不打断正在跑的 Runtime 任务；第一字进转写
