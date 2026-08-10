# 验证 Runbook

Type: runbook
Status: current
Verified: 21629d6 2026-08-10
Review: 验证命令、CI workflow 或测试拓扑变化时

## 命令清单

```bash
pnpm test
pnpm run check
pnpm --filter @yishu/kernel test
swift test
./script/build_and_run.sh --verify
```

## CI

- Workflow：`.github/workflows/ci.yml`，runner `macos-15`。
- 顺序：install → check → build → test → swift test。
- `check` 刻意先于 `build`：看守 clean-checkout 状态下的类型检查，不依赖已有构建产物。

## 用户可见变更的验收

build 通过不等于产品验收。用户可见变更必须启动真实 App，检查真实的 floating presence 与交互。

## 测试规模参考

2026-08-10 参考值：约 400 个 node 测试 + 4 个 swift 测试。以 CI 实时结果为准，本数字不作长期事实。
