# ADR 0001: 奕枢是唯一用户可见身份

Type: decision
Status: current
Verified: 21629d6 2026-08-10
Review: 该决策被重新讨论或推翻时（只能由新 ADR supersede）

## Status

Accepted

## Context

奕枢的人格设计有历史来源（Hanako），内部还存在多个专家 Agent。用户需要的是一个稳定、可持续相处、可问责的对话主体，而不是一组人格。

## Decision

- 奕枢（Yishu）是唯一持续存在的用户可见身份。
- Hanako 是已吸收的人格设计来源，不是第二个产品或对外身份。
- 专家 Agent 留在后台，不直接面向用户。

## Alternatives considered

- Hanako 独立身份。
- 多 Agent 面向用户。

## Why

单一身份 = 单一信任关系、单一记忆主体与单一责任面。多身份会稀释信任、割裂记忆、模糊责任。

## Consequences

- 人格可从证据演进，但必须可检查、可逆；核心诚实与用户主权不漂移。
- 统一 persona 由 `docs/persona.md` 承载。
