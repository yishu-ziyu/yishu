# 验证 Runbook

Type: runbook
Status: current
Verified: 2cfddf1 2026-08-11
Review: 验证命令、CI workflow 或测试拓扑变化时

## 命令清单

日常产品内环统一从一个入口运行：

```bash
pnpm product:check
```

合并前或修改正式 Clicky、Runtime 协议、Kernel 边界时运行：

```bash
pnpm product:verify
```

`product:check` 包含产品边界守卫、Kernel/Runtime check + test 和 `swift test`。
`product:verify` 额外运行正式 Clicky Xcode 测试与开发壳 headless 打包验证。
完整工作区（含 AgentCore 实验室）仍运行 `pnpm test && pnpm run check`。

需要生成带稳定本地签名并内嵌 Runtime 的正式 Clicky bundle 时运行：

```bash
pnpm product:build:clicky
```

## CI

- Workflow：`.github/workflows/ci.yml`，runner `macos-15`。
- 顺序：install → `pnpm product:verify` → AgentCore laboratory check/test。
- 正式产品由同一个公共入口覆盖边界守卫、Kernel/Runtime、Swift Package、Clicky Xcode 测试和开发壳打包。
- AgentCore 被单独验收为实验室，失败不会被正式产品验证悄悄掩盖，也不会重新成为第二个产品核心。

## 用户可见变更的验收

build 通过不等于产品验收。用户可见变更必须启动真实 App，检查真实的 floating presence 与交互。

统一核心变更还必须检查最终用户行为是否始终经过：

`Clicky → versioned protocol → Kernel truth/action → executor → verified receipt → visible presence`。

测试或实验模式可以替换 executor，但不得建立第二份产品真相。

## 测试规模参考

2026-08-10 参考值：约 400 个 node 测试 + 4 个 swift 测试。以 CI 实时结果为准，本数字不作长期事实。
