# ADR 0007: SQLite 作为本地真相存储

Type: decision
Status: current
Verified: 21629d6 2026-08-10
Review: 该决策被重新讨论或推翻时（只能由新 ADR supersede）

## Status

Accepted

## Context

产品需要本地、单用户、可查询、零运维的持久化，承载会话、turn、trail 与证据存储。

## Decision

- 默认 SQLite（`node:sqlite` `DatabaseSync`，WAL，`BEGIN IMMEDIATE` 事务），目录 `~/Library/Application Support/Yishu/Store`。
- 测试用 InMemory；保留 `YishuStoreBackend` port 与 JSON backend（单进程开发回退）。
- 迁移为幂等 additive DDL + `user_version`。
- 敏感内容入库 fail-closed。

## Alternatives considered

- 外部数据库。
- 纯 JSON 文件。

## Why

本地单用户真相 + 可查询 + 零运维，三者同时满足的只有嵌入式 SQLite。

## Consequences

- `engines` 钉 Node ≥ 22.19（`node:sqlite` 可用性）。
- 非 additive 迁移需版本化框架（debt 待登记）。
- 多实例并发限制已知：ledger 尚非分布式执行租约。
