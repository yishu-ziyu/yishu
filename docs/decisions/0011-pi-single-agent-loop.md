# ADR 0011: Pi 是唯一正式 Agent 核心循环

Type: decision
Status: current
Verified: 23b2e07 2026-08-11
Review: 该决策被重新讨论或推翻时（只能由新 ADR supersede）

## Status

Accepted 2026-08-11

## Context

仓库曾同时提供 Pi 正式 Runtime 和 `AgentCoreRuntime`。后者把 AI Agent Book 的离线
`YishuAgent` 再包装为 `AgentRuntime`，形成可由环境变量选择的第二套 ReAct、工具、记忆和
轨迹循环。即使正式 Clicky 固定使用 Pi，这条接线仍让实验室与产品执行边界相互依赖，
使“Agent 核心”到底位于 Pi、AgentCore 还是 Kernel 变得不清楚。

沿已确认的九阶段任务流程核验 Pi 0.83 SDK 后，Pi 已原生提供 model-tool 循环、会话、
工具结果回注、streaming、steering、follow-up、cancel、retry、compaction、Skills、custom
tools 和 extensions。缺少的部分主要是奕枢的目标、现场证据、授权、现实验证、任务完成、
用户呈现、长期记忆和能力治理。这些本来就应由 Clicky/Kernel 拥有，而不是再造一套循环。

## Decision

- Pi 是唯一正式 model-tool Agent 循环。
- `packages/kernel` 是循环外唯一产品核心，拥有 `YishuAction`、`ContextTrail`、
  Memory/Learning/Skill/Mandate/TaskTruth、`ContextCapsule` 及九阶段中的产品政策和真相。
- `packages/runtime` 只装配 Pi、产品 tools/ports 和 typed events，不得依赖 `@yishu/agent-core`。
- `RuntimeMode` 只保留 `pi` 与 `mock`。mock 是协议测试替身，不是第二个 Agent harness。
- 删除 `AgentCoreRuntime` 和 `YISHU_RUNTIME_MODE=agent-core`。旧值或未知值安全回落到 `pi`。
- `packages/agent-core` 继续作为独立实验室。实验能力必须脱离其 ReAct/session 真相，迁入
  Kernel/Runtime 正式端口并通过产品验收，才算奕枢能力。
- Runtime 已使用的轻量注入扫描与 untrusted delimiter 迁入 Runtime 自有模块，避免为一个
  独立算法重新依赖整个实验室。
- 产品边界检查必须拒绝 Runtime 重新导入 `@yishu/agent-core` 或 `AgentCoreRuntime`。

完整九阶段能力归属见 [`docs/agent-loop.md`](../agent-loop.md)。

## Alternatives considered

- 保留 `agent-core` 作为隐藏 fallback。拒绝，因为 fallback 会永久保留第二套任务行为和状态语义。
- 把 AgentCore 的循环并入 Pi。拒绝，因为 Pi 已提供成熟循环，重复实现没有产品证据。
- 删除整个 AgentCore 包。拒绝，因为 eval、Judge、统计、轨迹验证和 evolution gate 仍有实验价值。

## Consequences

- 正式产品只有 `Clicky → Kernel → Runtime/Pi` 一条 Agent 路径。
- AgentCore 测试不再是 Runtime 的 pretest，也不能通过环境变量进入正式协议服务器。
- AgentCore 的成熟成果以后按算法或产品能力逐项迁移，不能整包接回 Runtime。
- 这项决策更新 ADR 0005 中旧的 `kernel ← runtime → agent-core` 依赖描述；Kernel 真相所有权不变。
