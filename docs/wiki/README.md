# Code Wiki：奕枢（Yishu）代码导览

Type: wiki
Status: current
Verified: 34c0eaa 2026-08-15
Review: 对应模块源码结构变化时同步修订

本目录是奕枢仓库的 Code Wiki，面向需要快速理解代码结构的开发者。每篇聚焦一个模块，包含模块职责、关键类型与函数、内部数据流和文件索引。

规范与真相源说明：产品不变量、架构决策的操作性描述以 [docs/architecture.md](../architecture.md)、[docs/decisions/](../decisions/) 为准；本 Wiki 是代码结构的导览投影，两者冲突时以 ADR 与架构文档为准。

## 文档地图

| 文档 | 内容 | 对应代码 |
|------|------|----------|
| [01-overview.md](01-overview.md) | 项目定位、技术栈、仓库布局、源码归属 | 整个仓库 |
| [02-architecture.md](02-architecture.md) | 整体架构、产品主线路径、运行时边界、核心不变量 | 跨模块 |
| [03-yishucontext-swift.md](03-yishucontext-swift.md) | 根 Swift 包：可移植证据协议 `ContextFrame` | `Sources/YishuContext` |
| [04-kernel.md](04-kernel.md) | `@yishu/kernel`：产品动作、ContextTrail、证据存储 | `packages/kernel` |
| [05-runtime.md](05-runtime.md) | `@yishu/runtime`：版本化协议、Pi 适配器、产品投影 | `packages/runtime` |
| [06-clicky.md](06-clicky.md) | `apps/clicky`：macOS App、语音管线、执行器、语音代理 | `apps/clicky` |
| [07-agent-core.md](07-agent-core.md) | `@yishu/agent-core`：独立离线实验室 | `packages/agent-core` |
| [08-dependencies.md](08-dependencies.md) | 包间依赖、外部依赖、边界守卫 | 全仓库 |
| [09-build-and-run.md](09-build-and-run.md) | 环境要求、构建、测试、安装与验收命令 | 全仓库 |

## 推荐阅读顺序

1. 新成员入门：01 → 02 → 09（先看懂地图和怎么跑起来）
2. 改产品内核：04 → 05 → 02 的「Task truth 边界」
3. 改 App 交互/语音：06 → 03 → 02 的「运行时边界」
4. 做算法实验：07（注意：实验室能力不得直接接入产品路径，见 ADR 0011）

## 一句话架构

`Clicky（身体） → ContextFrame（证据） → Kernel（产品真相/动作） → Runtime/Pi（执行 harness） → verified receipt → presence（可见呈现）`
