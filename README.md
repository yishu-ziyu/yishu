# yishu 0.0.1

奕枢（Yishu）是一款上下文原生的个人 Agent Super App。产品只有一个持续身份、一个常驻应用和一条任务真相。

`apps/clicky` 是奕枢唯一正式 Clicky 源码与安装源，保留鼠标伴随、菜单栏面板、Control+Option 按住说话、StepFun ASR、现有模型选择、指向动画与 TTS。这个仓库提供接入该正式壳的产品内核：奕枢人格、证据化 `ContextFrame`、版本化 `AgentRuntime` 协议和 Pi SDK 适配器。正式 Clicky 从最终 StepFun 文本进入 ContextFrame 与 Pi，再由原有光标浮层和 MiniMax 输出。

`apps/macos` 只是用于验证这些新能力的开发壳，不是第二个需要常驻的产品。它使用独立的 `com.yishu.yishu-lab` bundle ID，默认不占用全局语音快捷键。正式整合只回到 `apps/clicky` 的源码、bundle identity、权限、登录项和用户配置。

## Source and runtime ownership

- `apps/clicky`：唯一正式 Clicky 源码、签名产物和安装入口，拥有用户可见的常驻存在、语音、TTS、权限与设置。
- `apps/macos`：本仓库的开发壳和集成验证面；不得作为第二个常驻产品、登录项或正式安装源。
- `packages/kernel`：唯一产品核心，拥有对话、记忆、规则、Action、Skill 与 TaskTruth。
- `packages/runtime`：Pi `AgentRuntime` 适配器和版本化协议。Pi 是执行 harness，产品身份、关系记忆、权限、主动性和任务真相仍由奕枢拥有。
- `packages/agent-core`：离线实验室，不是第二个产品核心，也不是正式 Clicky 的产品真相源。
- Kairos：只保留在 Kairos 历史仓库中的旧 bridge 记录；Yishu 不依赖、不回退、不运行 Kairos，也不允许 `KairosBridgeClient`、SSE progress stream、`RunProgressPresenter` 或 `forceKairosRouting` 进入正式路径。
- Agent Native：只作为 Action 方法论来源，不是 Swift 或 Node 依赖。Yishu 只吸收单一 typed Action、fresh target/observation、执行前 revalidate、结构化 receipt 和可见 read-back；不导入或复制其运行时。

## First integration slice

第一条纵向切片已经打通：

> 用户继续通过熟悉的奕枢光标按住说话；现有 StepFun ASR 产出文本，奕枢采集鼠标指向的证据上下文，Pi Runtime 生成可流式、可取消的回应，再由现有浮层与 TTS 呈现。

当前组合包含：

- 光标轨迹、前台应用/窗口、辅助功能元素与屏幕截图的 `ContextFrame`；
- 版本化、可追踪、可取消的 Runtime 协议；
- 带能力档案的 Pi SDK 适配器；
- 从 Hanako 预设吸收而来的温暖、判断力、主动性与可成长人格；
- 一个默认不注册全局快捷键的 macOS 开发壳，以及由 `apps/clicky` 安装源携带的 Node/Pi runtime；
- 无需模型凭据即可验证 UI 的确定性 mock 模式。

## Requirements

- macOS 14.0 or newer
- Xcode 16 or newer
- Node.js 22.19 or newer

## Setup and verification

```bash
pnpm install
pnpm product:check  # Kernel + Runtime + Swift 的日常统一内环
pnpm product:verify # 再加正式 Clicky Xcode 测试与开发壳打包验证
```

完整工作区测试（包括 AgentCore 实验室）仍可运行 `pnpm test && pnpm run check`。
正式本地 Clicky 构建统一使用 `pnpm product:build:clicky`。

Run the visible development slice without model credentials:

```bash
YISHU_RUNTIME_MODE=mock ./script/build_and_run.sh
```

Run against the locally configured Pi model runtime:

```bash
YISHU_RUNTIME_MODE=pi ./script/build_and_run.sh
```

仅在独立调试开发壳时启用冲突快捷键：

```bash
YISHU_ENABLE_DEV_SHORTCUT=1 ./script/build_and_run.sh
```

Pi 身份验证保留在 Pi 自己的凭据存储中。奕枢不复制或打印凭据。

## Current boundary

这条切片已经把人格、证据上下文、Pi 边界和**产品层**接到 `apps/clicky` 的语音与空间交互里。

`packages/kernel`（`@yishu/kernel`）经 Runtime `ProductKernelRuntime` 默认启用：

- 语音 ASR → 产品话术路由（`记住刚才…` / `交给 Codex` / `记住：…` / Learning）→ `YishuAction`，否则走 Pi
- `turn.start` + 后台 `trail.observe`（约 15s 元数据采样）喂养 `ContextTrail`
- 默认 SQLite store（Application Support `Yishu/Store`）
- `remember_how` 用 trail-replay 验证后再晋升 Skill；`run_skill` / `share_context` 生成 Context Capsule
- Pi / AgentCore 只有在真实工具或电脑动作开始后才创建 Kernel `TaskTruth`；可见结果验证通过才记 `done`，未验证留在 `blocked`，纯对话不制造任务

Pi 仍是执行 harness；Agent-Native 只作方法论。Cua 隔离任务单元、主动性引擎、完整 desktop skill 重放执行仍继续挂接。

验收：

- [v0-product-kernel](docs/acceptance/v0-product-kernel.md)
- [packages/kernel/README.md](packages/kernel/README.md)

```bash
pnpm --filter @yishu/kernel test
pnpm --filter @yishu/runtime test
pnpm test
```

## AgentCore 实验室

仓库另有可独立运行的 `@yishu/agent-core`（`packages/agent-core`），用于验证 ReAct、
沙箱工具、多 Agent、eval、轨迹和自我改进等实验。它不是奕枢的产品核心，也不拥有
正式对话、记忆、任务或关系状态。成熟能力必须迁入 Kernel Action 或 Runtime adapter，
通过正式 Clicky 验收后才算产品能力。Pi 仍是正式执行 harness。

```bash
pnpm lab:agent:test
pnpm lab:agent:demo
pnpm lab:agent:eval
pnpm agent -- run "计算 17*19+3"
```

说明与验收：

- [packages/agent-core/README.md](packages/agent-core/README.md)
- [能力对照](docs/agent-book/CAPABILITY_MAP.md)
- [三分钟试用](docs/agent-book/TRY_ME.md)
- [v0-agent-book-harness 验收](docs/acceptance/v0-agent-book-harness.md)

See [Unified product spine](docs/decisions/0010-unified-product-spine.md), [Product kernel](docs/product-kernel.md), [Architecture](docs/architecture.md), [Clicky integration](docs/clicky-integration.md), [persona contract](docs/persona.md), [Clicky presence research](docs/research/clicky-presence.md), and [vertical-slice acceptance](docs/acceptance/v0-context-voice.md).
