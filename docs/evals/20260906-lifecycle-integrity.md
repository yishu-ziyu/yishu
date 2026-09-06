# Lifecycle Integrity evaluator：验收卡

- 日期：2026-09-06
- 状态：active
- 上下文：独立质量工程，从 `origin/main` `9f84fff` 开分支 `feat/lifecycle-integrity`。不碰 PR #36，不改产品行为，不需要真机。

## 一句话任务

做一个只读、隐私安全的生命周期完整性评估器：能量出「有开始、后来无法还原怎么结束」的次数，并诚实基线现有诊断。不是 Experience Recorder。

## Change（用户能观察到什么）

一条命令读诊断 JSONL，打出操作级 `lifecycle_integrity_failures` 和分项；确定性夹具全绿；现网夹具的基线报告写明能还原什么、缺什么、哪些只是观测窗未闭合。不是 Experience Recorder。

## Not this（不算数的替代）

- 改语音 / ASR / TTS / Runtime / Memory / CUA / EverOS / 协议
- 实现 Experience Recorder
- 依赖 PR #36 未合并事件（`asr.terminal`、`duplex.*`、`handsfree.armed`）
- 把空日志报成 100% 可还原
- 没看到错误就当成功
- 用「最后一次 start」去猜交错操作
- 改已有夹具把分数做漂亮
- 把任意 JSONL 的 EOF 当成操作本该结束的证据
- 把账目违规钳成合法值
- 把事件级缺口算进操作级主指标
- 用现网基线分数当 `product:check` 硬失败
- 合并；更新 PR #36

## Goal / Hard bar / Improve

- Goal：评估器 + 夹具矩阵 + 反作弊 + 观测窗语义 + 操作级主指标 + 永久 CI 接线 + 基线报告 + 由缺口推出的 Experience Recorder 候选要求
- Hard bar：`node --test evals/observability/check-lifecycle-integrity.test.mjs` 全绿；live tail 语义 0 且 pending≥1；同一事件在 `--closed-window` 下语义≥1；无 id 别名不抬主指标；注入非法账目抛错不钳制；`script/verify-product.sh` 含该测试命令且不对 `quality.sample.jsonl` 做 `--expect-zero`；产品代码无 diff
- Improve：无（本 slice 是测量，不是把现网打到 0）

## Observation window

默认 **open / live / incomplete**。评估器不能假定任意 JSONL 已经把该结束的操作都结束了。

| 窗 | 证据 | `start` 且无 terminal |
|---|---|---|
| open（默认） | 没有「本窗应已闭合」的证据 | pending / unknown / observability-incomplete。不抬语义失败。`--expect-zero` 通过 |
| closed（`--closed-window`） | 调用方显式声明观测窗完整 | 语义失败 `started_without_terminal_outcome` |

确定性完整夹具（missing-terminal、反作弊删 terminal）必须带 `--closed-window` 或 `evaluate(..., { closedWindow: true })`。

## Primary Fitness Function

主指标是 **操作级**：

- `logical_operations_count`：能指派到逻辑操作的条数
- `semantic_lifecycle_failures`：证据证明该操作做错（闭合窗内有 start 无终端、冲突终端、同一 canonical 终端重复）
- `observability_integrity_failures`：该操作存在，但无法还原（缺关联 id 的 start、家族没有 start 埋点、观测-only 且已形成操作）
- `lifecycle_integrity_failures` = 语义 + 观测（**每个逻辑操作最多计一次**）
- 不变量：`lifecycle_integrity_failures <= logical_operations_count`
- 不变量：`reconstructed + unreconstructable == logical_operations_count`

不能指派到逻辑操作的事件 **不得** 进入主指标。它们走事件/缺口计数：

- `uncorrelated_terminal_events`
- `low_fidelity_alias_events`
- `unique_observability_gaps`
- `pending_operations`

`--expect-zero` 只看 **语义** 失败。pending 不是语义失败。

账目必须构造即合法。`assertAccountingInvariants` 发现负数、rate 越出 [0,1]、主指标超过操作数时 **抛错**，不得钳成合法值。

确定性好夹具：语义 = 0。不宣称现网已经是 0。没报错 ≠ 成功。

## 纳入的生命周期家族

只收 `main` 上已经有成对语义的。PR #36 新事件不当契约。

| family | 模式 | start | 观测（不是 start） | 成功（等价别名） | failure / cancel | 关联 |
|---|---|---|---|---|---|---|
| `voice_capture` | 语义 | `ptt.key_down` | — | `ptt.key_up` | — | `turnId` |
| `asr` | 语义，但 **无 utterance start** | （无；`asr.request_sent` 是 per-request 观测） | `asr.request_sent` / `asr.first_partial` / `asr.first_sse` | canonical `asr.final`；低保真别名 `asr.completed` | 无 | `turnId`（不是 request id） |
| `runtime_turn` | 语义 | `turn.start` | — | `model.done` 与带 id 的 `model.completed` 等价 | `turn.failed`；`errorCode=cancelled` → cancelled | `turnId` |
| `computer_result` | **仅观测** | 生产 sending/sent **无** requestId/traceId/receiptHash，不能指派逻辑操作 | | | | |

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
| 4 | 缺 terminal：闭合窗语义≥1；开放窗语义 0 且 pending≥1 | 机器：missing-terminal 有/无 `--closed-window` | 断言 |
| 5 | 双 terminal → `duplicate_terminal_outcomes`≥1 | 机器：duplicate-terminal 夹具 | 断言 |
| 6 | 孤儿 terminal → `terminal_without_start`≥1 | 机器：orphan-terminal 夹具 | 断言 |
| 7 | 交错 start + 无 id 的 terminal → `uncorrelated_terminal_events`≥1 | 机器：missing-correlation 夹具 | 断言 |
| 8 | 3 个交错操作都正确结束 → 0 | 机器：concurrent 夹具 `--expect-zero` | 退出 0 |
| 9 | 空日志不得报完美还原 | 机器：empty 夹具 `reconstructability_rate===null` | 断言 |
| 10 | 遗留残缺日志出 `observability_gaps`，不静默全绿 | 机器：legacy-incomplete 夹具 | 断言 |
| 11 | 反作弊：删 terminal / 复制 terminal / 去掉 id / 终端改 unknown / 无关 success 不能让原操作变绿 | 机器：`node --test evals/observability/check-lifecycle-integrity.test.mjs` | 全过 |
| 12 | 基线报告存在 | 机器：文件 `docs/evals/20260906-lifecycle-integrity-baseline.md` | 路径 |
| 13 | 产品行为未改 | 机器：相对 `origin/main`，`apps/` `packages/` 无 diff | git |
| 14 | live tail：`turn.start(t1)` + EOF，开放窗语义 0、pending≥1、`--expect-zero` 通过 | 机器：live-tail 夹具 | 断言 |
| 15 | 同一事件、`--closed-window`：语义≥1 | 机器：closed-window 夹具 | 断言 |
| 16 | 无 id 别名事件不抬操作级主指标 | 机器：asr-production-shape；`lifecycle_integrity_failures <= logical_operations_count` | 断言 |
| 17 | 注入非法账目抛 `EvaluatorAccountingError`，原值不被钳制 | 机器：`injectInvalidAccounting` 缝 | 断言 |
| 18 | 确定性套件永久进 CI 验证路径，且不要求 quality.sample 语义 0 | 机器：`script/verify-product.sh` 含 `node --test evals/observability/check-lifecycle-integrity.test.mjs`，不含 `quality.sample.jsonl --expect-zero` | 断言 |

## 测量命令

```bash
node evals/observability/check-lifecycle-integrity.mjs <files...>
node evals/observability/check-lifecycle-integrity.mjs --json <files...>
node evals/observability/check-lifecycle-integrity.mjs --closed-window <files...>
node --test evals/observability/check-lifecycle-integrity.test.mjs
```

永久 CI 路径：`script/verify-product.sh`（`pnpm product:check` / `pnpm product:verify`）在 `size:check` 之前跑上述 `--test`。不把 `quality.sample.jsonl` 的失败数当硬门。

## 夹具矩阵

见 `evals/observability/fixtures/`。空夹具是空文件。遗留夹具模拟「有 asr.final 无 asr.request_sent」。`live-tail.jsonl` 与 `closed-window.jsonl` 事件相同，差别只在观测窗。

## 隐私

评估器忽略 transcript / audio / screenshot / prompt / memory / key 等字段，只读时间、事件名、id、status、duration、outcome、provider/model、版本。

## 非目标

Experience Recorder 实现；给现网打补丁；把 `product:check` 改成以现网基线分数为硬失败。

## 停止条件

夹具矩阵 + 反作弊过；live/closed 窗语义正确；主指标单位一致；非法账目致命；评估器测试永久进 CI；基线诚实重写；Experience Recorder 候选只来自缺口；产品代码未改；不开进 PR #36；本任务单独 PR 到 main，不合并。

## 基线与结果

- 动手前：没有评估器。
- 确定性夹具：`node --test evals/observability/check-lifecycle-integrity.test.mjs`（35 项，含观测窗、主指标单位、账目抛错、CI 接线）。
- 入库夹具 `evals/voice/fixtures/quality.sample.jsonl` 按 **开放窗** 重跑：语义 0 / 观测 30 / pending 40 / 并集 30；PTT 30/30；rate 0.30。详见 `docs/evals/20260906-lifecycle-integrity-baseline.md`。
- 产品代码相对 `origin/main` 无 diff。

## 人评清单（交付时填）

- 无。本 slice 无人评。
