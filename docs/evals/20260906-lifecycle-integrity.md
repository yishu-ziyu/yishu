# Lifecycle Integrity evaluator：验收卡

- 日期：2026-09-06
- 状态：active
- 上下文：独立质量工程，从 `origin/main` `9f84fff` 开分支 `feat/lifecycle-integrity`。不碰 PR #36，不改产品行为，不需要真机。

## 一句话任务

做一个只读、隐私安全的生命周期完整性评估器：能量出「有开始、后来无法还原怎么结束」的次数，并诚实基线现有诊断。

## Change（用户能观察到什么）

一条命令读诊断 JSONL，打出 `lifecycle_integrity_failures` 和分项；确定性夹具全绿；现网夹具的基线报告写明能还原什么、缺什么。不是 Experience Recorder。

## Not this（不算数的替代）

- 改语音 / ASR / TTS / Runtime / Memory / CUA / EverOS / 协议
- 实现 Experience Recorder
- 依赖 PR #36 未合并事件（`asr.terminal`、`duplex.*`、`handsfree.armed`）
- 把空日志报成 100% 可还原
- 没看到错误就当成功
- 用「最后一次 start」去猜交错操作
- 改已有夹具把分数做漂亮
- 合并；更新 PR #36

## Goal / Hard bar / Improve

- Goal：评估器 + 夹具矩阵 + 反作弊 + 基线报告 + 由缺口推出的 Experience Recorder 候选要求
- Hard bar：确定性夹具 `lifecycle_integrity_failures` 符合矩阵；反作弊变异不能全绿；空日志不得报完美还原；产品代码无 diff
- Improve：无（本 slice 是测量，不是把现网打到 0）

## Primary Fitness Function

分解后的主指标：

- `semantic_lifecycle_failures`：证据证明操作做错（有 start 无终端、冲突终端、同一 canonical 终端重复）
- `observability_integrity_failures`：无法知道（缺关联 id、家族没有 start 埋点、低保真无 id 别名、观测-only 家族）
- `lifecycle_integrity_failures` = 两者之和（操作不双计）

`--expect-zero` 只看 **语义** 失败。

确定性好夹具：语义 = 0。不宣称现网已经是 0。没报错 ≠ 成功。

## 纳入的生命周期家族

只收 `main` 上已经有成对语义的。PR #36 新事件不当契约。

| family | 模式 | start | 观测（不是 start） | 成功（等价别名） | failure / cancel | 关联 |
|---|---|---|---|---|---|---|
| `voice_capture` | 语义 | `ptt.key_down` | — | `ptt.key_up` | — | `turnId` |
| `asr` | 语义，但 **无 utterance start** | （无；`asr.request_sent` 是 per-request 观测） | `asr.request_sent` / `asr.first_partial` / `asr.first_sse` | canonical `asr.final`；低保真别名 `asr.completed` | 无 | `turnId`（不是 request id） |
| `runtime_turn` | 语义 | `turn.start` | — | `model.done` 与带 id 的 `model.completed` 等价 | `turn.failed`；`errorCode=cancelled` → cancelled | `turnId` |
| `computer_result` | **仅观测** | 生产 sending/sent **无** requestId/traceId/receiptHash，不能当主家族 | | | | |

仪器是否存在按 **source file** 计。跨文件只在 **同一显式 id** 时配对（quality `turn.start` + timing `model.done`）。

## 排除的家族（缺什么）

| 候选 | 不收的原因 |
|---|---|
| 连续聆听 / duplex 开口 | start→armed/failed 与 `asr.terminal` 在 PR #36，未进 main |
| TTS clip | `tts.first_audio` / `tts.clip_done` / `tts.stopped` 共用 `turnId`，没有 clip id；一句多 clip，无法确定性配对 |
| `computer.action.completed` | 只有终端，没有 start |
| 委派任务 | quality 白名单无任务 start/terminal 对 |
| 提醒投递 | 没有成对质量事件 |
| 记忆 remember/forget | 点事件，不是 start→terminal |
| ASR proxy `proxy-asr.jsonl` | 无 turnId / request id，无法并入 asr |
| 运行时阶段 `recall.done` 等 | 阶段点，不是轮次终端 |
| 把 `asr.request_sent` 当 start | 一句多次 interim+final，共用 `turnId`，会造假语义失败 |

## 验收标准

| # | 标准 | evaluator | 证据 |
|---|---|---|---|
| 1 | 好路径 start→success 失败数 0 | 机器：`node evals/observability/check-lifecycle-integrity.mjs evals/observability/fixtures/good-success.jsonl --expect-zero` | 退出 0 |
| 2 | start→failure 是合法终端，失败数 0 | 机器：explicit-failure 夹具 `--expect-zero` | 退出 0 |
| 3 | start→cancelled 失败数 0 | 机器：cancellation 夹具 `--expect-zero` | 退出 0 |
| 4 | 缺 terminal → failures≥1 且 `started_without_terminal_outcome`≥1 | 机器：missing-terminal 夹具 | 断言 |
| 5 | 双 terminal → `duplicate_terminal_outcomes`≥1 | 机器：duplicate-terminal 夹具 | 断言 |
| 6 | 孤儿 terminal → `terminal_without_start`≥1 | 机器：orphan-terminal 夹具 | 断言 |
| 7 | 交错 start + 无 id 的 terminal → `uncorrelated_terminal_events`≥1 | 机器：missing-correlation 夹具 | 断言 |
| 8 | 3 个交错操作都正确结束 → 0 | 机器：concurrent 夹具 `--expect-zero` | 退出 0 |
| 9 | 空日志不得报完美还原 | 机器：empty 夹具 `reconstructability_rate===null` | 断言 |
| 10 | 遗留残缺日志出 `observability_gaps`，不静默全绿 | 机器：legacy-incomplete 夹具 | 断言 |
| 11 | 反作弊：删 terminal / 复制 terminal / 去掉 id / 终端改 unknown / 无关 success 不能让原操作变绿 | 机器：`node --test evals/observability/check-lifecycle-integrity.test.mjs` | 全过 |
| 12 | 基线报告存在 | 机器：文件 `docs/evals/20260906-lifecycle-integrity-baseline.md` | 路径 |
| 13 | 产品行为未改 | 机器：相对 `origin/main`，`apps/` `packages/` 无 diff | git |

## 测量命令

```bash
node evals/observability/check-lifecycle-integrity.mjs <files...>
node evals/observability/check-lifecycle-integrity.mjs --json <files...>
node --test evals/observability/check-lifecycle-integrity.test.mjs
```

## 夹具矩阵

见 `evals/observability/fixtures/`。空夹具是空文件。遗留夹具模拟「有 asr.final 无 asr.request_sent」。

## 隐私

评估器忽略 transcript / audio / screenshot / prompt / memory / key 等字段，只读时间、事件名、id、status、duration、outcome、provider/model、版本。

## 非目标

Experience Recorder 实现；给现网打补丁；把 `product:check` 改成以本门为硬失败。

## 停止条件

夹具矩阵 + 反作弊过；基线写完；Experience Recorder 候选只来自缺口；产品代码未改；不开进 PR #36；本任务单独 PR 到 main，不合并。

## 基线与结果

- 动手前：没有评估器。
- 确定性夹具：`node --test evals/observability/check-lifecycle-integrity.test.mjs`（含生产形与反作弊）。
- 入库夹具 `evals/voice/fixtures/quality.sample.jsonl`：语义 40 / 观测 30 / 并集 70；reconstructed 30；rate 0.30。详见 `docs/evals/20260906-lifecycle-integrity-baseline.md`。
- 产品代码相对 `origin/main` 无 diff。

## 人评清单（交付时填）

- 无。本 slice 无人评。
