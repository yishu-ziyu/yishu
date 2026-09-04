# 实时档换非思考嘴：验收卡

- 日期：2026-09-04
- 状态：active（机器项 1/3/4 已有数；#2 人评口播待裁；未切产品默认）
- 上下文：`docs/NOTES.md` #23；资产目录 `~/Desktop/AI组件工作流库/docs/llm-service-asset-catalog.md`

## 一句话任务

用真提示量 `step-3.5-flash` 和 `grok-4.20-0309-non-reasoning` 的首个可见字；同时探清 Grok Voice（S2S realtime）能不能用现有 xAI 订阅 OAuth。

## Change

实时档若换模型：闲聊「在吗」从松手到首个可见字明显短于现在的 M2.5（离线可见字 p50 2.25 s，其中思考 1.6 s）。Grok Voice 能或不能接，用一次 WebSocket 握手的 HTTP 状态说话，不靠文档。

## Not this

- 只改 persona 让 M2.5 少想（已否，−7%）
- 没量真提示就切默认模型
- 把 Grok 网页 App 里的 Voice 当成 API 已通
- 打印 OAuth / 8317 key

## 验收标准

| # | 标准 | evaluator | 证据 |
|---|---|---|---|
| 1 | 两模型各 10 轮，交替「在吗」/「今天天气怎么样」，间隔 400 ms；记 sse 首字节、首个可见字、reasoningChars、visible−sse | 机器：表 + p50；与 M2.5 基线（sse 438 / visible 2248 / reasoningChars 196 / visible−sse 1603）同列 | `evals/voice/results/2026-09-04-mouth-candidates.md` |
| 2 | 换实时档默认的硬条：该模型「在吗」visible−sse p50 ≤ 500 ms，且 3 条抽查口播完整、无思考泄漏 | 机器：表；人评：3 条口播 | 同上 |
| 3 | Grok Voice：对 `wss://api.x.ai/v1/realtime?model=grok-voice-latest` 用订阅 OAuth access 做一次升级；记 HTTP 状态（101 / 401 / 403 / 其它）和是否收到 `session.created`。8317 同路径对照（预期不通） | 机器：探针输出，无 token | 同上「Grok Voice」节 |
| 4 | 不把密钥写入结果文件 | 机器：`rg -i "Bearer |access_token|sk-" evals/voice/results/2026-09-04-mouth-candidates.md` 0 命中 | rg |

## 非目标

- 不改产品默认模型（主代理看表再定）
- 不接 duplex 进 Swift
- 不测 kimi-k2（本轮不做）

## 基线与结果

M2.5 基线（卡 #23）：sse 438 / visible 2248 / reasoningChars 196 / visible−sse 1603。

| 模型 | 在吗 visible−sse p50 | t0→可见字 p50 | reasoningChars | 硬条 ≤500 ms |
|---|---:|---:|---:|---|
| MiniMax-M2.5 | 1603 | 2248 | 196 | 否 |
| step-3.5-flash | 2003 | 2341 | 160 | 否（仍思考；可见字会泄漏 `<tool_call>`） |
| grok-4.20-0309-non-reasoning | 0 | 1100 | 0 | 是（走 8317） |

Grok Voice（经 7897，订阅 OAuth）：WS 101 + `session.created`。8317 对照 400。工具调用未测。
