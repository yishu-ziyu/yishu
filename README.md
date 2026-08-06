# yishu 0.0.1

奕枢（Yishu）是一款上下文原生的个人 Agent Super App。产品只有一个持续身份、一个常驻应用和一条任务真相。

二开 Clicky 是奕枢已经成熟的交互本体，保留鼠标伴随、菜单栏面板、Control+Option 按住说话、StepFun ASR、现有模型选择、指向动画与 TTS。这个仓库提供已接入该本体的产品内核：奕枢人格、证据化 `ContextFrame`、版本化 `AgentRuntime` 协议和 Pi SDK 适配器。二开 Clicky 现在从最终 StepFun 文本进入 ContextFrame 与 Pi，再由原有光标浮层和 MiniMax 输出。此前的 Kairos 进度桥属于失败的历史试验，不进入奕枢目标架构。

`apps/macos` 只是用于验证这些新能力的开发壳，不是第二个需要常驻的产品。它使用独立的 `com.yishu.yishu-lab` bundle ID，默认不占用全局语音快捷键。正式整合继续沿用二开 Clicky 的 bundle identity、权限、登录项和用户配置。

## First integration slice

第一条纵向切片已经打通：

> 用户继续通过熟悉的奕枢光标按住说话；现有 StepFun ASR 产出文本，奕枢采集鼠标指向的证据上下文，Pi Runtime 生成可流式、可取消的回应，再由现有浮层与 TTS 呈现。

当前组合包含：

- 光标轨迹、前台应用/窗口、辅助功能元素与屏幕截图的 `ContextFrame`；
- 版本化、可追踪、可取消的 Runtime 协议；
- 带能力档案的 Pi SDK 适配器；
- 从 Hanako 预设吸收而来的温暖、判断力、主动性与可成长人格；
- 一个默认不注册全局快捷键的 macOS 开发壳，以及打进正式 Clicky bundle 的 Node/Pi runtime；
- 无需模型凭据即可验证 UI 的确定性 mock 模式。

## Requirements

- macOS 14.0 or newer
- Xcode 16 or newer
- Node.js 22.19 or newer

## Setup and verification

```bash
pnpm install
pnpm test
pnpm run check
swift test
./script/build_and_run.sh --verify
```

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

这条切片已经把人格、证据上下文和 Pi 边界接到二开 Clicky 的语音与空间交互里。Cua Driver、隔离任务单元、长期关系记忆、主动触发与 Skill 沉淀继续挂接在这些端口之后。

## Agent-core（书义 Harness）

仓库另有可独立运行的教学环包 `@yishu/agent-core`（`packages/agent-core`）。
它实现书中公式 **LLM + 上下文 + 工具** 的 ReAct 循环、沙箱工具、文件记忆、多 Agent、eval 与轨迹落盘。
默认离线规则 LLM，不依赖 macOS App，也不是第二个对外产品身份。

```bash
pnpm agent:test
pnpm agent:demo
pnpm agent:eval
pnpm agent -- run "计算 17*19+3"
```

说明与验收：

- [packages/agent-core/README.md](packages/agent-core/README.md)
- [能力对照](docs/agent-book/CAPABILITY_MAP.md)
- [三分钟试用](docs/agent-book/TRY_ME.md)
- [v0-agent-book-harness 验收](docs/acceptance/v0-agent-book-harness.md)

See [Product kernel](docs/product-kernel.md), [Architecture](docs/architecture.md), [Clicky integration](docs/clicky-integration.md), [persona contract](docs/persona.md), [Clicky presence research](docs/research/clicky-presence.md), and [vertical-slice acceptance](docs/acceptance/v0-context-voice.md).
