# Lifecycle Integrity 基线（main 入库夹具，语义校正后）

- 日期：2026-09-06
- 评估器：`node evals/observability/check-lifecycle-integrity.mjs`
- 头：`origin/main` `9f84fff`；评估器在 PR #37 校正后
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
| reconstructability_rate | 0.3000 |
| semantic_lifecycle_failures | 40 |
| observability_integrity_failures | 30 |
| lifecycle_integrity_failures | 70 |
| started_without_terminal_outcome | 40 |
| duplicate_terminal_outcomes | 0 |
| terminal_without_start | 30 |
| uncorrelated_terminal_events | 0 |
| equivalent_terminal_aliases | 0 |

`lifecycle_integrity_failures` = 语义失败 + 观测失败（各操作只计一次）。不再用「40 / 0.30」当产品已经坏了的证明。

空日志：`reconstructability_rate = n/a (empty log)`。

## 为什么和上一版不同

上一版把 `asr.request_sent` 当成按 `turnId` 的操作 start。main 上它是 **interim/final 网络请求观测**，一句可以多次，共用 `turnId`，没有 request id。健康生产形状会被误判成 `started_without_terminal_outcome`。

校正后：

- ASR 没有 utterance 级 start → 30 条 `asr.final` 是 **观测缺口**，不是语义产品失败。
- `asr.completed` / `model.completed` 无 id 是低保真别名，不制造第二条幽灵操作。
- `model.done` 与带 id 的 `model.completed` 是等价成功别名，不是双终端。
- `computer_result` 退出主家族，只报观测债。
- 仪器是否存在按 **source file** 计，不把现代文件的 start 泄漏到遗留文件的孤儿上。

`reconstructability_rate` 仍是 0.30，因为可还原的仍是 30 次 PTT，分母仍是 100 次操作。变的是 **失败分类**：40 语义 + 30 观测，并集 70。

## 按家族

| family | reconstructed | unreconstructable | semantic | observability | 说明 |
|---|---|---|---|---|---|
| voice_capture | 30 | 0 | 0 | 0 | `ptt.key_down` → `ptt.key_up` + `turnId` |
| asr | 0 | 30 | 0 | 30 | 有 `asr.final`，没有 utterance start；`request_sent` 不是 start |
| runtime_turn | 0 | 40 | 40 | 0 | 本夹具 40 次 `turn.start` 没有任何终端。这是这份有界轨迹里「有 start 无 terminal」，按语义失败计。夹具本身是延迟样本，不证明现网 Runtime 从不结束 |
| computer_result | 0 | 0 | 0 | 0 | 夹具无此类事件 |

`observability_gaps`：`asr [quality.sample.jsonl]` 缺 utterance 级 ASR start。

## 能还原

- 30 次 PTT 持麦。

## 不能还原

- 40 次 Runtime 轮次在本文件中如何结束（语义：看见 start，文件里没有终端）。
- 30 次 ASR 终稿从哪一次 utterance start 来（观测：main 没有独立 utterance start）。
- TTS 30 次 clip（无 clip id，未进主家族）。
- 桌面 result 投递（本文件没有；生产 sending/sent 无关联 id）。

## 最大观测缺口（不是语义产品失败）

1. **ASR 缺 utterance 级 start。** `asr.request_sent` 不能当 start。需要独立的一句 start，或真正的 request id。
2. **`asr.completed` / `model.completed` 不带 `turnId`。** 低保真别名；不能当第二条生命周期。
3. **`computer.result.sending/sent` 无 requestId/traceId/receiptHash**；TTS 无 clip id。交错不可还原。
