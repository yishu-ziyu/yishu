# ADR 0012: 奕枢只保留一套 macOS App 源码

Type: decision
Status: current
Verified: worktree 2026-08-12
Review: macOS App 入口、bundle identity 或 Swift package 边界变化时

## Status

Accepted 2026-08-12. Supersedes ADR 0002 and the `apps/macos` clause in ADR 0010.

## Context

仓库曾同时保留正式 `apps/clicky` 与可独立运行的 `apps/macos`。后者虽然被称为开发壳，
仍复制了语音、光标、菜单栏、上下文采集、Runtime client 和可见 presence，并拥有自己的
bundle ID、权限提示与打包脚本。同时，正式 Clicky 使用的 `YishuContext` 反而位于
`apps/macos` 目录下。这让源码结构表达出两个 App，也让日常开发入口和产品事实产生歧义。

不同的签名、权限或启动策略是构建配置问题，不需要第二套产品实现。TCC 授权始终由用户
授予；应用只能声明用途并发起请求，不能“默认全开”。

## Decision

- `apps/clicky` 是仓库中唯一的 macOS App 源码、构建、安装和可见验收入口。
- 删除 `apps/macos`、`com.yishu.yishu-lab` 与其独立打包脚本，不再维护第二套语音、光标、
  菜单栏、采集器或 Runtime client。
- `YishuContext` 是跨 App/Runtime 的 Swift 证据协议，放在根 Swift package 的
  `Sources/YishuContext`；它不属于任何 App。
- 单元测试可使用 mock、headless 或测试 target，但不得重新建立第二个 `.app`。
- 正式壳保留 `com.yishu.yishu-buddy`、`/Applications/奕枢.app`、签名身份、
  UserDefaults、登录项与现有 TCC 连续性。磁盘上的应用名是奕枢；`apps/clicky` 只是源码目录。

## Alternatives considered

- 继续维护“正式壳 + 开发壳”，靠文档解释二者区别。
- 同一份 App 源码增加第二个长期 bundle target。
- 把共享协议继续放在某个 App 目录下。

## Why

一个用户可见身份应对应一个 App 源码真相源。开发隔离应由测试 target、mock 和构建配置
完成，而不是复制一套可运行产品。删除第二个壳也消除了正式代码反向依赖实验目录的结构
错误。

## Consequences

- 日常修改、正式构建和用户可见验收都在 `apps/clicky` 完成。
- `swift test` 只验证共享 `YishuContext`；Clicky 行为由其 Xcode tests 验证。
- `pnpm product:verify` 运行产品边界、Kernel/Runtime、共享 Swift contract、Clicky Xcode
  tests 与正式构建脚本的无副作用 self-test。
- 若未来需要不同分发配置，只能从同一 Clicky 源码派生短生命周期构建配置，不得恢复第二套
  App 实现或第二个常驻身份。
