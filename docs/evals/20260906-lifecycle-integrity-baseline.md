# Lifecycle Integrity 基线（main 入库夹具）

- 日期：2026-09-06
- 评估器：`node evals/observability/check-lifecycle-integrity.mjs`
- 头：`origin/main` `9f84fff`
- 入库诊断 JSONL：只有 `evals/voice/fixtures/quality.sample.jsonl`（392 行）。未改该夹具。

## 命令

```bash
node evals/observability/check-lifecycle-integrity.mjs evals/voice/fixtures/quality.sample.jsonl
```

## 总表

| 指标 | 值 |
|---|---|
| operations_reconstructed | 30 |
| operations_unreconstructable | 70 |
| lifecycle_integrity_failures | 40 |
| reconstructability_rate | 0.30 |
| started_without_terminal_outcome | 40 |
| duplicate_terminal_outcomes | 0 |
| terminal_without_start | 30 |
| uncorrelated_terminal_events | 0 |
| ambiguous_terminal_outcomes | 0 |

不是 0。不宣称现网日志已满足完整性。

空日志对照：`reconstructability_rate = n/a (empty log)`，不是 100%。

## 按家族

| family | reconstructed | unreconstructable | failures | 说明 |
|---|---|---|---|---|
| voice_capture | 30 | 0 | 0 | `ptt.key_down` → `ptt.key_up` 且带 `turnId`，这份夹具能还原 |
| asr | 0 | 30 | 0 | 30 条 `asr.final` 没有 `asr.request_sent`。计观测缺口，不把「夹具年代没埋 start」写成产品违约 |
| runtime_turn | 0 | 40 | 40 | 40 条 `turn.start`（10 条 listen-mode + 30 条 PTT 轮）没有任何 `model.completed` / `turn.failed` / timing `model.done` |
| computer_result | 0 | 0 | 0 | 夹具里没有这类事件 |

`observability_gaps`：`asr` 缺 `start:asr.request_sent`。

## 能还原

- 按住/松开麦克风：30 次 PTT 持麦都能配对。

## 不能还原

- 前台 Runtime 轮次如何结束（成功、失败、取消、未知）——最大缺口，40 次 start 零终端。
- ASR 请求何时开始——只有终稿点，没有 `asr.request_sent`。
- 桌面动作结果投递——这份夹具没有；生产 `computer.result.sending/sent` 也没有 requestId/traceId。
- TTS clip——未纳入家族：`tts.first_audio` 30、`tts.clip_done` 30、`tts.stopped` 30 共用 `turnId`，无 clip id。

## 最大观测缺口

**runtime_turn 缺终端。** 若每条 `turn.start` 带同一 `turnId` 的恰好一个 `model.completed` 或 `turn.failed`（或 timing `model.done`），本夹具的 `lifecycle_integrity_failures` 会从 40 降到 0，并可还原 40 次 Runtime 轮次。

次大：ASR 补 `asr.request_sent`（同一 `turnId`）能消化 30 条孤儿 `asr.final`。

第三：TTS clip id，或 `computer.result.*` 的 requestId。没有它们，这两类操作即使写入日志也无法交错还原。
