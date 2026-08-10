# 本地开发 Runbook

Type: runbook
Status: current
Verified: 21629d6 2026-08-10
Review: 环境要求、启动模式或 script/build_and_run.sh 变化时

## 环境要求

- macOS 14+
- Xcode 16+
- Node 22.19+
- pnpm 10

## 启动

```bash
pnpm install
```

无 `.env`，无外部数据库。

## 运行模式

- `YISHU_RUNTIME_MODE=mock`：默认值，无凭据即可运行。
- `YISHU_RUNTIME_MODE=pi`：接 Pi harness；Pi 凭据留在 Pi 自己的凭据存储，不进入本仓库。
- `YISHU_ENABLE_DEV_SHORTCUT=1`：仅用于独立调试开发壳（`apps/macos`），正式 Clicky 不需要。

## 常用验证

见 `docs/runbooks/verification.md`。
