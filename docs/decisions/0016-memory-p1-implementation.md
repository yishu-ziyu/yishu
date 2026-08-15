# ADR 0016: 记忆层 P1 实施决定（用户可见真相层 + 同 turn 提取模型）

Type: decision
Status: current
Verified: 34c0eaa 2026-08-15
Review: P1 记忆实施范围、提取策略或真相层布局变化时（只能由新 ADR supersede）

## Status

Accepted 2026-08-15

## Context

ADR 0013 定了 EverOS 骨干（markdown 真相层、candidate→敏感校验→active、cascade 队列），ADR 0015 #3 约定读写两侧按两个连续 PR 交付，但 P1 的实施细节未定：目录在哪、显式 remember 走哪条通路、提取用哪个模型、哪些 turn 值得提取。产品决策（2026-08-15）六条拍板：① 显式 remember 一并改走 markdown+索引，禁止双通路；② 入库门是 candidate→敏感校验→active，不用 confidence 当门槛；③ 提取只发用户原话+可见回复；④ 提取模型跟该 turn 同 provider/model，不钉 local-grok；⑤ 预筛用产品动作+寒暄白名单，不用"短于 N 字"；⑥ 目录用户可见可改，Skills 本轮不进 markdown。

## Decision

1. **真相层根目录修订 ADR 0013 #1**：`~/Documents/Yishu/Memory/`（用户可见、可直读、可直编），env `YISHU_MEMORY_DIR` 覆盖（测试必用）。scope 子目录沿用 0013：`personal/`、`project-<slug>/`（scope id sanitize 成路径段，CWE-22 三层防御照 0013 Consequences）；private 无目录。
2. **单一写入通路**：显式 `remember` 动作与自动提取同走"markdown 真相写 + SQLite MemoryClaim 索引写"。`MemoryClaim` 增 `truthRef`（`<相对路径>#<条目id>`）；`candidate` 是管线内存态，落库行即 `active`（无独立 status 字段）。recall 读索引不变。禁止任何绕过 markdown 直写索引的记忆通路。
3. **提取管线**：模型执行的 turn 在 `persistCompleted`（turn.completed 已落盘）后入 `extraction_queue`（turn_id 幂等、载荷含 utterance/回复文本/provider/model 快照）；worker 异步消费，turn 返回不等提取。episode 条目确定性生成（零模型）；facts 提取调模型。
4. **提取模型跟 turn**：worker 用队列行快照的 provider/model 经 provider runtime 调用（快照自 `TurnStartCommand.payload.modelPreference`）。provider 不可用（如 OAuth 过期）时限次重试后置 `failed`，重启可重放。不钉 local-grok。
5. **预筛**：产品动作 turn（product action 路由命中）不入队——账本 receipt 已是它们的真相；寒暄白名单（`你好/嗯/好的/谢谢…` 等确定性列表，见 runbook）跳过模型提取但仍记 episode。不用长度阈值。
6. **入库门**：模型产物为内存态 `candidate`；经 `assertPersistableMemoryFields` 敏感校验（fail-closed，失败即弃、计数不落库）后以 `active` 落 markdown+索引。`confidence` 仅为证据元数据，非门槛（对齐 0013 #9）。
7. **提取数据边界**：prompt 仅含用户 utterance、可见回复文本、现有 active facts 清单（id+claim，供 confirm）。截图、AX valuePreview、凭据、private 会话内容一律不进提取；private scope 在入队前拒绝。
8. **事实确认与去重（P1 最小）**：现有 facts 清单进提取 prompt，模型返回 `confirmed_fact_ids`（该 turn 再次印证的既有事实）→ bump `lastConfirmedAt`；新事实经敏感校验后新增。显式矛盾 `supersedes` 留 P2（0013 #4 的自动决策部分）。
9. **Skills 本轮不进 markdown**：`VerifiedSkill` 留 SQLite 唯一事实源（0013 #1 的 skills 演进段推迟，P2 评估）。入库四问对 Skills 的答案不变。

## Alternatives considered

- 显式 remember 暂留 SQLite 原样、仅自动提取走新通路。拒绝：双真相源过渡期，产品决策①明令禁止。
- 提取钉 local-grok（零成本离线）。拒绝：产品决策④；turn 用的模型即用户为该对话质量选择的模型，提取质量应一致；本地 turn 自然落本地提取。
- confidence 门槛（低置信 candidate 缓存待确认）。拒绝：产品决策②；敏感校验才是安全门，confidence 排序留给 recall。
- 短文本预筛。拒绝：产品决策⑤；长度与记忆价值无关，误伤中文短句。

## Consequences

- kernel 新增 `memory/truth-layer.ts`（markdown 读写：原子写、per-path 锁、追加幂等按 turn_id/条目 id）与 `memory/extraction.ts`（管线+预筛+`MemoryExtractionModel` 端口）；store 三后端（memory/json/sqlite）新增 extraction_queue CRUD。
- `remember.ts` 重写为 markdown+索引单通路；`MemoryClaim` schema 加可选 `truthRef`（additive）。`candidate` 只存在于提取管线内存，落库行即 active，不另加 status 字段。
- PKR 在 `persistCompleted` 后 fire-and-forget 入队，并持有 worker（启动扫 pending 实现崩溃重放）；dispose 停止。
- 读取侧（PR-2）：PKR 仍做 scoped recall 并发 `memory.used`，结果缓存在 turn ledger；引擎经 `assembleTurnMemory` 把 `formatTurnMemoryBlock` 并入首条 user 消息。禁止再把 `__yishuRecalledMemories` 挂到命令上（双装配）。private 直接返回 undefined。
- 失效发现（入库四问）：markdown 可 diff + git；队列 `failed` 行在重启时重放。
