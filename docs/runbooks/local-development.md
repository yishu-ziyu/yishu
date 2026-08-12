# 本地开发 Runbook

Type: runbook
Status: current
Verified: 21629d6 2026-08-10
Review: 环境要求或 Clicky 本地构建/启动流程变化时

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

## 运行与测试

- `pnpm product:check`：无凭据的日常产品内环，包含共享 Swift contract tests。
- `pnpm product:verify`：增加 Clicky Xcode tests 与构建脚本 self-test，不安装或启动第二个 App。
- `pnpm product:build:clicky`：构建正式 Clicky，不安装、不启动。
- `./apps/clicky/scripts/run-local.sh`：构建、安装并启动 `/Applications/Clicky.app`；Pi 凭据留在 Pi 自己的凭据存储，不进入本仓库。

## 常用验证

见 `docs/runbooks/verification.md`。
