# PR #36 再审：连续句必须有终端 ASR 结果

- 日期：2026-09-06
- 状态：active
- 上下文：`docs/NOTES.md` 当前状态；GitHub PR #36 / Issue #35；真机头 `c35b55c15e9f51cbdd8d283f9cbb94dbd1fce7ba`

## 一句话任务

连续聆听每一句在本地收尾后必须落到恰好一个可观测的 ASR 终端结果；供应商失败不得假装成静音；同一句用同一个 voice trace ID 串起来。

## Change（用户能观察到什么）

打开连续聆听后说一句，这句话会变成产品轮次（或明确失败），不会只闪开口/收尾然后什么都不发生。Control+Option 在关掉连续听时仍发 `ptt.key_up`；连续听收尾不再冒充按键松开。

## Not this（不算数的替代）

- 新开 PR 或合并 #36
- 调开口/收尾能量阈值、Runtime、TTS、Memory、StepAudio Realtime
- 换 Step Plan / MiniMax
- 实现 Experience Recorder v0 / EverOS 记忆
- 把空字符串继续当成「没听清」来吞掉 HTTP/SSE 失败
- 宣称完整 #35 十句人评通过

## Goal / Hard bar / Improve

- Goal：真机三句烟测每句 `speech_onset → end_of_speech → ASR 终端成功 → duplex.final_accepted → turn.start → 口播`
- Hard bar：`node script/check-hands-free-voice-contract.cjs` 旧棘轮保持且 `continuous_utterances_without_terminal_asr_outcome = 0`；所列 Swift 测绿；三句真机烟测 3/3 产品轮次、0 再按键、0 PTT、0 缺终端
- Improve：无（零是上限）

## 真机失败证据（动手前，验收窗 `2026-09-06T11:00:19Z`）

来源：`~/Library/Application Support/Yishu/Diagnostics/proxy-asr.jsonl` 与 `quality.jsonl`。只读元数据，不读转写。

产品层：`duplex.speech_onset` 多次、`duplex.end_of_speech` 多次、`ptt.key_down = 0`、`turn.start = 0`、`duplex.final_accepted = 0`、`asr.first_partial = 0`、`asr.final = 0`、无 TTS；runtime-timing 行数未增。`ptt.key_up` 与收尾成对，来自通用 release 处理，不是 Control+Option。

代理层（窗内 168 条，interim 124 / final 44）：字段只有 `kind, audio_s, body_bytes, connect_ms, first_byte_ms, total_ms, reused, stream, body_read_ms, ts, route`。无 HTTP 状态、无 SSE 类型计数、无取消标记、无终端类别。`body_bytes` 与 PCM base64 请求体一致，不是响应体。

| 观察 | 能确定 | 不能确定 |
|---|---|---|
| 多数请求 `first_byte_ms` 有值（约 137–890）且 `total_ms` 约 160–900 | 上游对 2xx 流式路径写出了字节（`pipeAsrHttps` 只在 2xx 才设 first_byte） | 字节里是 delta/done/error/空 done |
| 少数 interim `first_byte_ms` 为空且 `total_ms` 很短（约 21–196） | 本地打断了仍在飞的 interim（下一窗/final 会 `abortInFlightInterim`） | 不能把这些当成全部失败原因；final 多数仍有 first_byte |
| 非 2xx 分支不设 `first_byte_ms` | 有 first_byte 的 final **不是**「完全没上游响应」 | 精确 status code 未记 |
| `asr.first_sse` 只出现 1 次 | 客户端至少成功 parse 过一次 SSE JSON；该事件 `once: true` 且连续听不 reset | 后续句是否 parse 到事件 |

## 根因（已证实 vs 加固）

**已证实（会把「有上游字节」变成「没有产品句」）：**

1. `StepPlanAudioTranscriptionSession.firstNonEmpty` / `valueWithin` 用 `(try? await ….value) ?? ""`，HTTP/超时/取消/解析失败都变成空串。
2. `parseSSEPayload` 只认 `transcript.text.delta` / `transcript.text.done` / 无类型 `text`；官方 `type: "error"` 被丢掉，流结束后仍返回空串。
3. 空串经 `onFinalTranscriptReady("")` → VoiceSession `.emptyOrNearSilence` → 连续听只恢复 listening，不 `turn.start`。供应商失败被报告成静音。
4. 4 秒 fallback 在没有非空中间稿时同样提交空串，走同一条静音路径；没有独立的 fallback 终端类别。
5. 连续听 `.released` 走 `trackPushToTalkReleased()`，冒出 `ptt.key_up`。
6. ASR / EOS / 终端事件没有 onset 的 voice trace ID；`sessionId` 恒为 `voice`。

**未证实（日志不够）：** 上游是否在发 `error` SSE、是否空 `done`、是否无法识别的事件类型。这正是代理缺 outcome 元数据的原因。

**次要加固（不是本失败的替代解释）：** 代理补 HTTP 状态类、SSE 类型计数、取消、终端类别、utterance id；`asr.terminal` 质量事件。

## 验收标准

| # | 标准 | evaluator | 证据 |
|---|---|---|---|
| 1 | 连续句关闭后恰好一个 ASR 终端 | 机器：fitness `continuous_utterances_without_terminal_asr_outcome` | 0 |
| 2 | 供应商失败 ≠ 静音 | 机器：Step Plan 缝测 B/C/D | 一次失败终端，0 成功终稿 |
| 3 | SSE `error` 进失败路径一次 | 机器：B | 0 空成功 |
| 4 | 成功空 done 是 genuine-empty | 机器：E | 不是 provider-error |
| 5 | fallback 先到：一次 fallback 终端，迟到供应商不双提交 | 机器：F | duplicate_auto_submissions 0 |
| 6 | disable 后迟到回调 0 产品提交 | 机器：G + 既有矩阵 G | lateFinal false |
| 7 | 同一 trace ID：onset → EOS → ASR → 终端 → final_accepted/失败 | 机器：H | ID 一致 |
| 8 | 十句夹具 0 `ptt.key_down` / 0 `ptt.key_up` | 机器：I + fitness | 0/0 |
| 9 | 既有 #35/#29/#31/#33 棘轮 | 机器：既有 checker | 保持 |
| 10 | 真机三句烟测 | 人+机器：装机后 3 句 | 3 `turn.start`；失败则停 |

## 非目标

- StepAudio Realtime；换 ASR/TTS 供应商；Kernel / Memory / CUA / Task-Run / IM / AgentIdentity
- Experience Recorder 实现
- 完整十句人评（三句烟测过了只报「可以进入完整验收」）

## 基线与结果

- 动手前：真机 `turn.start = 0`；代码空串吞失败；代理无 outcome 字段。
- 交付：见上表；PR 描述更新。不合并。

## 人评清单（交付时填）

- [ ] #10 三句烟测：每句都有口播/产品轮次；失败则交该句关联元数据并停

## Experience Recorder 证据（只记，不实现）

- 全局 `sessionId=voice` 不够
- 一句的 correlation 缺失
- PTT 松开与连续听收尾混在 `ptt.key_up`
- ASR 终端结果不可观测
- proxy-asr 没有 outcome/error 元数据
- 日常 quality 事件不带 app commit
