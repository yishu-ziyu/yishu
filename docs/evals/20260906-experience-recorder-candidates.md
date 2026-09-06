# Experience Recorder 候选要求（只来自 Lifecycle Integrity 缺口）

不是实现。不是 PR #36。条目都对应评估器在入库夹具或家族契约上量到的缺口。

| 候选 | 证据 |
|---|---|
| 同一 `turnId` 上 Runtime 必须有恰好一个终端：`model.completed` 或 `turn.failed` | `quality.sample.jsonl`：40 次 `turn.start`，0 次终端；`runtime_turn` failures=40 |
| ASR 必须有 start：`asr.request_sent`，且与 `asr.final` 共用 id | 同夹具 30 条 `asr.final` 无 start；gap `asr: missing start:asr.request_sent` |
| 终端事件必须带关联 id | 生产 `asr.completed` 不写 `turnId`（家族契约）；无 id 的 terminal 会计 `uncorrelated_terminal_events` |
| ASR 需要失败/取消类终端 | main 上 asr family 的 failure/cancel 列表为空；供应商失败无法与静音区分 |
| `computer.result.sending` / `sent` 必须带 `requestId` 或 `traceId` 或 `receiptHash` | 生产这两条只有 `receiptStatus`；无 id 则交错不可还原 |
| TTS 需要 clip id | 排除 TTS 家族：`first_audio`/`clip_done`/`stopped` 只有 `turnId`，一句多 clip |
| `sessionId` 不能是恒定 `voice` | 夹具与生产质量事件 `sessionId=voice`，不能区分 app 会话 |

不写：app commit、provider 身份、取消原因分类——本轮评估器没有量到它们造成的不可还原。
