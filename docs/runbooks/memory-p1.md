# 记忆层 P1 操作手册

Type: runbook
Status: current
Verified: 34c0eaa 2026-08-15
Review: P1 交付物、队列行为或预筛白名单变化时

面向实现记忆层 P1（写入侧 PR-1 / 读取侧 PR-2）的工程师。决策依据 → [ADR 0013](../decisions/0013-memory-everos-backbone.md)（骨干）、[0015](../decisions/0015-turn-assembly-in-engine.md)（装配与 PR 切分）、[0016](../decisions/0016-memory-p1-implementation.md)（P1 实施决定）。本手册只写"怎么做、怎么验"。

## 目标与范围

P1 交付：turn 终态自动入队 → 异步 worker → episode 追加 + facts 模型提取 → markdown 真相层 + SQLite 索引；显式 `remember` 改走同一条通路；读取侧迁移到引擎 `assembleTurnMemory` 端口（PR-2）。

不做：Reflection、embedding/rerank、skills markdown 化、`supersedes` 自动矛盾决策、记忆管理 UI。

## 六条拍板（2026-08-15，已锁）

1. 显式 remember 一步到位走 markdown+索引，禁止双通路。
2. 入库门 `candidate → 敏感校验 → active`；confidence 非门槛。
3. 提取只发用户原话 + 可见回复；截图/AX/凭据/private 不进。
4. 提取模型 = 该 turn 的 provider/model（快照入队）。
5. 预筛 = 产品动作不入队 + 寒暄白名单跳过模型（episode 仍记）；无长度阈值。
6. 目录 `~/Documents/Yishu/Memory/`；Skills 本轮不进 markdown。

## 数据流

```
模型 turn 终态（PKR persistCompleted，turn.completed 已落盘）
  → enqueue extraction_queue（fire-and-forget，turn 不等）
worker（PKR 持有；启动扫 pending = 崩溃重放；级联消费）
  → ① episode 追加（确定性，永远做）
  → ② 预筛？寒暄白名单 → done(skipped_model)，否则：
       提取模型调用（同 turn provider/model，输入=utterance+回复+现有 active facts）
  → ③ 模型产物 candidate → assertPersistableMemoryFields（fail 即弃，计数）
  → ④ markdown facts 写（新条目 / confirmed_fact_ids bump）+ MemoryClaim 索引写
  → ⑤ 队列行 done / failed（限次重试后，重启可重放）
```

## 目录布局与条目格式

```
~/Documents/Yishu/Memory/            # YISHU_MEMORY_DIR 可覆盖
  personal/
    episodes/2026-08-15.md           # 按天，append-only
    facts/preferences.md             # semantic 事实（P1 只写此文件；profile 留 Reflection）
  project-<slug>/                    # scope id sanitize 成路径段
    episodes/…  facts/…
```

- episode 行（单行追加，幂等键 `turn:` id）：
  `- 10:42 [turn:abcd1234] U: <utterance 摘要≤120字> A: <回复摘要≤120字>`
- facts 条目（幂等键 `mem:` id；confirmed 时原地重写日期段）：
  `- [mem:abcd1234|2026-08-15|extraction] 用户偏好要点列表`
- 解析规则：只认带 `[turn:…]`/`[mem:…]` 标记的行；用户手写的无标记行**原样保留、永不改写**。原子写（tmp+rename）、per-path 串行锁。

## 队列表（三后端同构）

行：`turn_id`(PK) / `payload`(快照 JSON：utterance、replyText、providerId、modelId、conversationId、scopeKey、capturedAt) / `status`(pending|done|skipped_model|failed) / `attempts` / `last_error?` / `updated_at`。
- 入队幂等：同 turn_id 重复入队为 no-op。
- `attempts ≥ 3` → failed；重启扫 `pending|failed` 重放。
- episode 追加自身按 turn_id 幂等（写前扫当日文件标记），重放不产生重复行。

## 寒暄白名单（初始集，代码常量）

`你好 / 您好 / 嗨 / 哈喽 / 在吗 / 嗯 / 嗯嗯 / 好 / 好的 / OK / ok / okay / 谢谢 / 多谢 / 不客气 / 再见 / 拜拜 / 收到 / 明白了 / 知道了`
命中（整句 trim 后全等）→ 跳过模型提取，episode 照记。白名单调整改 `packages/kernel/src/memory/extraction.ts`。

## 提取模型端口

kernel 定义端口（kernel 无密钥）：

```ts
interface MemoryExtractionModel {
  extract(input: {
    utterance: string; replyText: string;
    existingFacts: readonly { id: string; claim: string }[];
  }): Promise<{ newFacts: string[]; confirmedFactIds: string[] }>;
}
```

runtime 提供实现：provider runtime 一次性 completions 调用（非流式），provider/model 取队列行快照；JSON 输出解析失败按可重试错误处理。prompt 明确：只提"关于用户的稳定事实/偏好"，不提任务状态、不提一次性信息。

## 测试（smoke，随 PR-1）

1. turn 终态入队后立即 settle（不等 worker）。
2. worker：episode 追加 + fact 入索引（落库即 active，truthRef 指向 md）。
3. 崩溃重放：pending 行重启后消费，episode/fact 无重复。
4. confirmed_fact_ids → bump 而非新建。
5. 寒暄 turn → skipped_model，episode 有、模型零调用；产品动作 turn 不入队；private 不入队。
6. 敏感 candidate → 弃，无 md 行无索引行，队列 done（计 discarded）。

## 测试（smoke，随 PR-2）

1. 普通 personal turn 召回相关 MemoryClaim → `memory.used` 照发；命令上不再挂 `__yishuRecalledMemories`。
2. 引擎 `assembleTurnMemory` 把 `<durable_memories>` 块并入该轮首条 user 消息；块只出现一次。
3. private turn 不发 `memory.used`，首条 user 消息不含记忆块。

## 验收

```bash
pnpm --filter @yishu/kernel test
pnpm --filter @yishu/runtime test
pnpm test && pnpm run check
```

用户可见验收：说两句话（一句偏好、一句寒暄）→ `~/Documents/Yishu/Memory/personal/episodes/当天.md` 出现两行；preferences.md 只出现偏好句对应条目。下一句相关问题时，该偏好应进入模型首条 user 消息（`<durable_memories>`），private 会话没有这块。

## 回滚

PR-1 全部为新增通路 + remember 写入路径替换；PR-2 是召回装配从命令挂接改到引擎端口。回滚 = revert 对应提交。旧 MemoryClaim 索引数据 additive 兼容（无 status 视作 active），无需迁移脚本。
