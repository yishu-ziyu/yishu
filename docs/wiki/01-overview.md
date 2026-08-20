# 01 项目概述

Type: wiki
Status: current
Verified: 34c0eaa 2026-08-15
Review: 仓库顶层结构变化时

## 产品是什么

奕枢（Yishu）是一款**上下文原生的个人 Agent Super App**（macOS）。用户按住 `Control+Option` 对着光标说话，奕枢采集鼠标指向的证据上下文（光标、前台应用、辅助功能元素、屏幕截图），由 Pi Runtime 生成可流式、可取消的回应，再以浮层与 TTS 呈现；并能执行经过验证的桌面动作（点击、Finder 返回、输入文本、新建备忘录、定时提醒）。

产品的三条根本约束（见根 [README.md](../../README.md) 与 [AGENTS.md](../../AGENTS.md)）：

- **一个身份**：奕枢是唯一用户可见人格；Hanako 是已被吸收的人格设计来源，不是第二个产品。
- **一个常驻应用**：`apps/clicky` 是唯一 macOS App 源码/构建/安装/验收入口（bundle id `com.yishu.yishu-buddy`，安装于 `/Applications/奕枢.app`）。
- **一条任务真相**：任务状态只来自 typed Pi `AgentRuntime` 事件经 Kernel `TaskTruth` 的投影；工具成功不等于任务完成。

## 技术栈

| 层 | 技术 |
|----|------|
| macOS App | Swift 5 / SwiftUI / AppKit，macOS 14+，Xcode 16+，Manual signing（`Shangqiuko Local Code Signing`） |
| 共享 Swift 协议 | Swift Package `Yishu`（`YishuContext` library） |
| Node 包 | TypeScript ESM（`NodeNext`、strict + `exactOptionalPropertyTypes`），Node ≥ 22.19 |
| Monorepo | pnpm 10 workspace（`packages/*`） |
| 数据 | SQLite（`node:sqlite` 内置，默认后端）、JSON / 内存后端（测试与开发回退） |
| Schema | Zod v4（kernel 动作输入、runtime 线协议） |
| Agent 循环 | Pi（`@earendil-works/pi-coding-agent`），唯一正式执行 harness |
| ASR / TTS | StepFun ASR（经本机代理 8787）、MiniMax TTS；Apple Speech 作 shadow partial |
| CI | GitHub Actions `macos-15`，`pnpm product:verify` + agent-core 独立验收 |

## 仓库布局

```text
我的agent/
├── apps/clicky/                  # 唯一 macOS App（Swift 源码 + Xcode 工程 + worker + 脚本）
│   ├── leanring-buddy/           # Swift 源码（历史命名，勿改）
│   ├── leanring-buddy.xcodeproj/ # Xcode 工程（scheme: leanring-buddy）
│   ├── leanring-buddyTests/      # Swift Testing 测试
│   ├── scripts/                  # run-local.sh / pin-local-permissions.sh / sync-dev-vars...
│   └── worker/                   # 本机语音/模型代理（local-server.mjs + Cloudflare Worker）
├── Sources/YishuContext/         # 根 Swift 包：可移植证据协议 ContextFrame
├── Tests/YishuContextTests/      # Swift 契约测试
├── packages/
│   ├── kernel/                   # @yishu/kernel：产品动作、ContextTrail、证据存储
│   ├── runtime/                  # @yishu/runtime：版本化协议、Pi 适配器、产品投影、stdio server
│   └── agent-core/               # @yishu/agent-core：独立离线实验室（非产品依赖）
├── docs/                         # ADR、runbooks、架构文档、研究、验收记录
├── script/                       # verify-product.sh / check-product-boundaries.sh
├── Package.swift                 # 根 Swift 包（Yishu / YishuContext）
├── package.json                  # workspace 根脚本
└── pnpm-workspace.yaml           # packages/* workspace
```

## 源码与运行时归属（五层）

| 代码 | 归属 | 不拥有 |
|------|------|--------|
| `apps/clicky` | 用户可见常驻存在、语音、TTS、权限、设置、bundle 身份、安装与验收 | 第二个 App、产品真相 |
| `Sources/YishuContext` | 跨 App/Runtime 的 Swift 证据协议 | UI、权限、生命周期 |
| `packages/kernel` | 对话、记忆、规则、Action、Skill、TaskTruth、Result Inbox（唯一产品真相） | 模型循环 |
| `packages/runtime` | Pi `AgentRuntime` 适配器与版本化协议 | 产品身份/记忆/任务真相 |
| `packages/agent-core` | 离线实验室（ReAct/评估/自进化实验） | 任何产品路径（ADR 0011 禁止接入） |

## 明确排除项

- **Kairos**：只保留历史记录。`KairosBridgeClient`、SSE progress stream、`RunProgressPresenter`、`forceKairosRouting` 不得进入任何源码或安装边界（ADR 0004；边界守卫强制）。
- **Agent Native**：只作为 Action 设计方法论来源（typed Action、fresh target/observation、执行前 revalidate、结构化 receipt、可见 read-back），不导入其 Swift/Node 运行时（ADR 0008）。
- **AgentCore 运行时**：`AgentCoreRuntime` / `@yishu/agent-core` 不得被 `apps/clicky` 或 `packages/runtime` 依赖（ADR 0011；边界守卫强制）。

## 关键文档索引

| 主题 | 文档 |
|------|------|
| 架构 | [docs/architecture.md](../architecture.md) |
| 架构决策（ADR 0001–0012） | [docs/decisions/](../decisions/) |
| 九阶段 Agent 循环 | [docs/agent-loop.md](../agent-loop.md) |
| 产品内核设计 | [docs/product-kernel.md](../product-kernel.md) |
| 人格契约 | [docs/persona.md](../persona.md) |
| Clicky 集成 | [docs/clicky-integration.md](../clicky-integration.md) |
| 本地开发 / 验证 / 安装 runbook | [docs/runbooks/](../runbooks/) |
