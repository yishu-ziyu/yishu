# Experience Recorder 候选要求（语义校正后）

不是实现。不是 PR #36。只写评估器量到的缺口。区分「缺埋点」和「证据证明操作做错」。

## 缺埋点（观测债）

| 候选 | 证据 |
|---|---|
| ASR 需要 **utterance 级 start**，不能复用 `asr.request_sent` | main：interim/final 多次 `asr.request_sent` 共用 `turnId`，无 request id。生产形夹具语义失败 = 0，观测失败 ≥ 1 |
| 若要做请求级 ASR，需要 **request id** | 同上。`turnId` 不是请求 id |
| `asr.completed` 与 `model.completed` 必须带同一操作 id | 生产二者都不写 `turnId`。交叉源夹具：`model.done(turnId)` 还原成功后，无 id 的 `model.completed` 只记观测债，不拆第二条操作 |
| `computer.result.sending/sent` 要 `requestId` 或 `traceId` 或 `receiptHash` | 生产只有 `receiptStatus`。当前形夹具：观测债，0 语义失败，0 成功关联 |
| TTS clip id | 排除 TTS：`first_audio`/`clip_done`/`stopped` 只有 `turnId`，一句多 clip |

## 本夹具里像产品失败、但是延迟样本

| 现象 | 怎么读 |
|---|---|
| `quality.sample.jsonl` 40 次 `turn.start` 无终端 | 评估器计 **语义** `started_without_terminal_outcome`，因为有界文件里看见了 start。这证明 **这份样本还原不了 Runtime 结束**，不是现网 40 次崩溃的现场证据 |

## 不写

app commit、provider 身份、取消原因分类：本轮没有量到它们造成的不可还原。
`asr.request_sent` 与 `asr.final` 共用 `turnId` 当 start：已否决，那会制造假语义失败。
