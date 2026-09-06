# Lifecycle Integrity 基线（main 入库夹具，观测窗校正后）

- 日期：2026-09-06
- 评估器：`node evals/observability/check-lifecycle-integrity.mjs`
- 头：`origin/main` `9f84fff`；评估器在 PR #37 观测窗/单位校正后
- 入库诊断 JSONL：只有 `evals/voice/fixtures/quality.sample.jsonl`（392 行）。未改该夹具。

## 命令

默认开放窗（本夹具是延迟样本，不是完整生命周期轨迹）：

```bash
node evals/observability/check-lifecycle-integrity.mjs evals/voice/fixtures/quality.sample.jsonl
```

对照：同一文件在显式闭合窗下会把 40 个仍打开的 Runtime start 判成语义失败。那是「若假定轨迹完整」的假说，不是本夹具的诚实读法。

```bash
node evals/observability/check-lifecycle-integrity.mjs --closed-window evals/voice/fixtures/quality.sample.jsonl
```

## 总表（开放窗，本夹具的诚实读法）

| 指标 | 值 | 单位 |
|---|---|---|
| observation_window | open | 评估调用 |
| logical_operations_count | 100 | 逻辑操作 |
| operations_reconstructed | 30 | 逻辑操作 |
| operations_unreconstructable | 70 | 逻辑操作 |
| reconstructability_rate | 0.3000 | reconstructed / (reconstructed+unreconstructable) |
| pending_operations | 40 | 逻辑操作（开放窗仍打开） |
| semantic_lifecycle_failures | 0 | 逻辑操作 |
| observability_integrity_failures | 30 | 逻辑操作 |
| lifecycle_integrity_failures | 30 | 逻辑操作（语义∪观测，各操作一次） |
| started_without_terminal_outcome | 40 | 事实计数（含 pending） |
| duplicate_terminal_outcomes | 0 | 事件 |
| terminal_without_start | 30 | 操作/终端 |
| uncorrelated_terminal_events | 0 | 事件 |
| low_fidelity_alias_events | 0 | 事件 |
| unique_observability_gaps | 2 | 缺口 |

`lifecycle_integrity_failures` 只计逻辑操作。pending 不是语义失败，也不进入主指标。`--expect-zero` 看语义，本夹具开放窗通过。

空日志：`reconstructability_rate = n/a (empty log)`。

## 为什么和上一版不同

上一版把文件结束当成「这些操作本该已经结束」，于是 40 次 `turn.start` 变成 `semantic_lifecycle_failures = 40`。`quality.sample.jsonl` 是延迟夹具，仓库没有证据说它是完整生命周期轨迹。EOF 不是语义失败的证明。

本版默认开放窗：

- 40 次 Runtime start 无终端 → **pending / incomplete window**，不是产品失败。
- 30 次 `asr.final` 仍是观测债（main 没有 utterance 级 start）。
- 主指标从 70 降到 30，是因为 pending 不再冒充失败，也因为无 id 事件不再偷偷加进操作计数。本夹具没有无 id 别名事件，所以后一项在这里不改分母。

不要保留「语义 40」。那个数依赖一个未声明的闭合窗。

对照闭合窗（仅作假说，不作为本夹具基线）：语义 40 / 观测 30 / pending 0 / 并集 70。

## 按家族（开放窗）

| family | reconstructed | unreconstructable | pending | semantic | observability | 说明 |
|---|---|---|---|---|---|---|
| voice_capture | 30 | 0 | 0 | 0 | 0 | `ptt.key_down` → `ptt.key_up` + `turnId` |
| asr | 0 | 30 | 0 | 0 | 30 | 有 `asr.final`，没有 utterance start；`request_sent` 不是 start |
| runtime_turn | 0 | 40 | 40 | 0 | 0 | 40 次 `turn.start` 在本延迟样本里还开着。开放窗 = pending |
| computer_result | 0 | 0 | 0 | 0 | 0 | 夹具无此类事件 |

`observability_gaps`：

1. `asr [quality.sample.jsonl]` 缺 utterance 级 ASR start。
2. `runtime_turn [quality.sample.jsonl]` 缺 complete observation window（EOF 时 start 仍开着）。

## 能还原

- 30 次 PTT 持麦。

## 不能还原

- 40 次 Runtime 轮次是否已经结束（开放窗：pending，不是语义崩溃现场）。
- 30 次 ASR 终稿从哪一次 utterance start 来（观测：main 没有独立 utterance start）。
- TTS 30 次 clip（无 clip id，未进主家族）。
- 桌面 result 投递（本文件没有；生产 sending/sent 无关联 id，不能指派逻辑操作）。

## 最大观测缺口（不是语义产品失败）

1. **ASR 缺 utterance 级 start。** `asr.request_sent` 不能当 start。需要独立的一句 start，或真正的 request id。
2. **延迟样本没有闭合观测窗。** 40 个 Runtime start 停在 pending。要证明「开始了却没结束」，必须显式 `--closed-window`，或换一份完整轨迹。
3. **`asr.completed` / `model.completed` 不带 `turnId`。** 低保真别名；不能当第二条生命周期，也不能加进操作级主指标。本夹具未出现。
4. **`computer.result.sending/sent` 无 requestId/traceId/receiptHash**；TTS 无 clip id。交错不可还原。
