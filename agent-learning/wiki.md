# Yishu Codex Experience Wiki

这里保存 Codex 开发过程跨任务成立的模式，不是奕枢产品 Memory，也不改变 Kernel / EverOS 的记忆权威。

## Pattern index

| ID | 问题 | 根因 | 已验证处理 | Run records |
|---|---|---|---|---|

## Skill impact

| 日期 | 目标 Skill | 原子修改 | 固定验证集前 → 后 | 决定 | 原因 |
|---|---|---|---|---|---|

## Rejected proposals

记录被拒绝的 diff 摘要、退化指标和适用环境，避免重复试错。

## 晋升门槛

- 至少 4 份相关运行记录，并同时包含成功与失败。
- 写清问题、根因、动作协议、适用与不适用条件。
- 一次只 create 或 patch 一个 Skill。
- 在目标模型、macOS/App 构建和工具环境运行固定验证集、`pnpm product:check`、`pnpm product:verify`；可见行为检查真实 App。
- 未提高主指标或造成产品门槛退化时回滚 Skill；Wiki 与拒绝记录保留。
