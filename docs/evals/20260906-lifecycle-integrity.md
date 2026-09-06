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

`lifecycle_integrity_failures`

一条有明确 start/terminal 语义的操作，出现任一条即计 1（按操作计，不按事件重复加）：

1. 有 start 无 terminal
2. 多于一个 terminal
3. 有 terminal 无对应 start（且该 family 的 start 事件在这份日志的契约里是应有的；纯观测缺失另见 `observability_gaps`）
4. terminal 无法关联到操作
5. terminal 无法分成 success / failure / cancelled / unknown 之外的已知类，落入 unknown

确定性「好」夹具目标：`lifecycle_integrity_failures = 0`。

不宣称现网 `quality.jsonl` 已经是 0。

产品违约与观测不足分开：后者进 `observability_gaps`，不把「历史上没埋 start」说成操作本身失败。

## 纳入的生命周期家族（4）

只收 `main` 上已经有成对语义的。PR #36 新事件只作对照，不当契约。

| family | start | success | failure | cancel | 关联 | 所有者 |
|---|---|---|---|---|---|---|
| `voice_capture` | `ptt.key_down` | `ptt.key_up` | （无） | （无） | `turnId` | VoiceSession / ClickyAnalytics PTT |
| `asr` | `asr.request_sent` | `asr.final` 或 `asr.completed` | （无；main 没有失败类） | （无） | `turnId` | 听写提供者 / ClickyAnalytics |
| `runtime_turn` | `turn.start`（别名 `turn.started`） | `model.completed`（status≠failed）；runtime-timing `model.done` | `turn.failed`；`model.completed` status=failed | `turn.failed` 且 `errorCode=cancelled` | `turnId` | `YishuForegroundRuntimeExecution` |
| `computer_result` | `computer.result.sending` | `computer.result.sent` | （无） | （无） | `requestId` / `traceId` / `receiptHash` | `YishuAgentRuntimeClient.completeComputerAction` |

没有关联 id 的事件不得靠全局「上一次 start」配对。

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
- 确定性夹具：`node --test evals/observability/check-lifecycle-integrity.test.mjs` 22/22。
- 入库夹具 `evals/voice/fixtures/quality.sample.jsonl`：`lifecycle_integrity_failures=40`，reconstructed 30 / unreconstructable 70，rate 0.30。详见 `docs/evals/20260906-lifecycle-integrity-baseline.md`。
- 产品代码相对 `origin/main` 无 diff。

## 人评清单（交付时填）

- 无。本 slice 无人评。
