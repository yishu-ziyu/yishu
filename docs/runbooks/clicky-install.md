# Clicky 安装 Runbook

Type: runbook
Status: current
Verified: 21629d6 2026-08-10
Review: apps/clicky/scripts/ 或签名/TCC 流程变化时

## 全流程：run-local.sh

`apps/clicky/scripts/run-local.sh` 一次完成安装：

1. `xcodebuild` Debug 构建。
2. 固定签名身份 `Shangqiuko Local Code Signing`（保 TCC 连续性，绝不用 adhoc `-`）。
3. `pnpm build` + deploy：把 runtime 与 node 打包进 bundle，保留 V8/JIT entitlements。
4. 安装到 `/Applications/Clicky.app`。

脚本内含 voice proxy（8787）孤儿回收：只终止真正孤儿的 8787 listener；若 8787 被非孤儿进程占用，会阻断 install/open 并报告。

## TCC 权限

四项权限：辅助功能 / 屏幕录制 / 麦克风 / 语音识别。

- TCC 授权与 bundle identity + 签名身份绑定；换签名身份 = 全部重新授权。
- `apps/clicky/scripts/pin-local-permissions.sh` 用于修复 TCC 授权漂移。

## 登录项

SMAppService 登录项只由 Clicky.app 拥有。仓库不维护第二个 macOS App 或登录项。
