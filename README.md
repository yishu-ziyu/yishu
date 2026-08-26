# yishu 0.0.1

奕枢（Yishu）是一款上下文原生的个人 Agent Super App。产品只有一个持续身份、一个常驻应用和一条任务真相。

`apps/clicky` 是奕枢唯一正式 Clicky 源码与安装源，保留鼠标伴随、菜单栏面板、Control+Option 按住说话、StepFun ASR、现有模型选择、指向动画与 TTS。这个仓库提供接入该正式壳的产品内核：奕枢人格、证据化 `ContextFrame`、版本化 `AgentRuntime` 协议和奕枢自有 model-tool 循环。正式 Clicky 从最终 StepFun 文本进入 ContextFrame 与 Runtime，再由原有光标浮层和 MiniMax 输出。

仓库只保留这一套 macOS App 源码。共享的 Swift `YishuContext` 位于根 Swift Package；测试通过 test target、mock 和无副作用脚本完成，不再维护第二个 `.app`、bundle ID 或开发壳。

## Source and runtime ownership

- `apps/clicky`：唯一正式 Clicky 源码、签名产物和安装入口，拥有用户可见的常驻存在、语音、TTS、权限与设置。
- `Sources/YishuContext`：跨 App/Runtime 的 Swift 证据协议，不拥有 UI、权限或启动生命周期。
- `packages/kernel`：唯一产品核心，拥有对话、记忆、规则、Action、Skill、TaskTruth 与持久化 Result Inbox。
- `packages/runtime`：版本化 `AgentRuntime` 协议、奕枢自有 model-tool 循环及其适配器。它是唯一正式 Agent 循环；产品身份、关系记忆、权限、主动性和任务真相仍由 Kernel 拥有。
- `packages/agent-core`：离线实验室，不是第二个产品核心，也不是正式 Clicky 的产品真相源。
- Kairos：只保留在 Kairos 历史仓库中的旧 bridge 记录；Yishu 不依赖、不回退、不运行 Kairos，也不允许 `KairosBridgeClient`、SSE progress stream、`RunProgressPresenter` 或 `forceKairosRouting` 进入正式路径。
- Agent Native：只作为 Action 方法论来源，不是 Swift 或 Node 依赖。Yishu 只吸收单一 typed Action、fresh target/observation、执行前 revalidate、结构化 receipt 和可见 read-back；不导入或复制其运行时。

## First integration slice

第一条纵向切片已经打通：

> 用户继续通过熟悉的奕枢光标按住说话；现有 StepFun ASR 产出文本，奕枢采集鼠标指向的证据上下文，自有 Runtime 生成可流式、可取消的回应，再由现有浮层与 TTS 呈现。

<!-- CAPABILITY_MATRIX:START -->

Only `accepted` and above appear here. The full truth table is [docs/capabilities/CAPABILITY_MATRIX.md](docs/capabilities/CAPABILITY_MATRIX.md).

No capability currently meets `accepted`. Implemented protocol paths are listed in the matrix with mock evidence only.

<!-- CAPABILITY_MATRIX:END -->

## Requirements

- macOS 14.0 or newer
- Xcode 16 or newer
- Node.js 22.19 or newer

## Setup and verification

```bash
pnpm install
pnpm product:check  # Kernel + Runtime + Swift 的日常统一内环
pnpm product:verify # 再加正式 Clicky Xcode 测试与构建脚本 self-test
```

完整工作区测试（包括 AgentCore 实验室）仍可运行 `pnpm test && pnpm run check`。
正式本地 Clicky 构建统一使用 `pnpm product:build:clicky`。

构建正式 Clicky（不安装、不启动）：

```bash
pnpm product:build:clicky
```

构建、安装到 `/Applications/奕枢.app` 并启动真实产品：

```bash
./apps/clicky/scripts/run-local.sh
```

模型提供方身份验证保留在 Runtime 的专用凭据存储中。奕枢不复制或打印凭据。

## Current boundary

对外能力状态只以生成表为准（见上）。下面是架构接线，不是 `accepted` 宣称。

这条切片已经把人格、证据上下文、执行边界和**产品层**接到 `apps/clicky` 的语音与空间交互里。

`packages/kernel`（`@yishu/kernel`）经 Runtime `ProductKernelRuntime` 默认启用：

- 语音 ASR → 产品话术路由（`记住刚才…` / `交给 Codex` / `记住：…` / Learning）→ `YishuAction`，否则走自有 model-tool 循环
- `turn.start` + 后台 `trail.observe`（约 5s 元数据采样）喂养按 personal / project 严格隔离的 `ContextTrail`；private 在 Swift 采集前就被拒绝
- 默认 SQLite store（Application Support `Yishu/Store`）
- Runtime 冷启动会从 Kernel 回填同 scope、同 conversation 的有界可见历史；最近现场与用户明确纠正也会进入下一个普通 turn，不再因 sidecar / App 重启“失忆”
- `remember_how` 用 trail-replay 验证后再晋升 Skill；`run_skill` / `share_context` 生成 Context Capsule
- 每个 request 带一份不可变 `TaskExecutionContract`，只允许一次产品级 attempt；真人点击“从头重试”会创建新 request，不伪装续跑原任务
- Runtime 只有在真实工具或电脑动作开始后才创建 Kernel `TaskTruth`；只读任务交付非空结果即记 `completed`，外部改变只接受进程内可信执行器 receipt / fresh read-back 为 `verified`，其余留在 `blocked`
- 后台任务结果以 SQLite（默认）或 JSON 持久化：Main turn 领取后，只在该 turn 终态落盘成功后确认交付，失败或取消会释放领取；Runtime 重启遇到孤立 running 子任务时 fail closed，不自动续跑
- 后台任务终态在用户空闲 3 秒后主动显示并口播一次；不伪造新 turn、不提前消费 Result Inbox，所以“第二条为什么？”仍能沿同一结果继续
- 已有两种一次性提醒：明确说“下次切回这个应用时提醒我…”会在离开后等待返回；明确说“X分钟/小时后提醒我Y”（分钟 1–1440、小时 1–24）则交给系统负责睡眠、退出和重启后的到点提示。首次通知权限未决定时只引导授权并明确尚未设置；只有系统待处理提醒精确读回才确认成功，未知不自动重复；前台横幅后安静 3 秒口播一次，切会话不丢、点击历史不重播、PTT 中断不重播。绝对日期、重复、列表/编辑/删除仍未支持，真实语音到点链待真人验收
- 普通纯对话按句串行 TTS，首句无需等待模型终态；再次按下 PTT 会立即停掉旧语音并撤下旧显示。只有旧轮是纯对话且尚未产生桌面动作时，新话才在同一会话中接续；涉及屏幕、动作或判断不清时，会重新采集现场并另起一轮。运行层和 Clicky 两层分别拦住旧回答与旧动作
- 当前插话不是让底层模型在任意字词处立即停下：模型在安全的回答边界切换，但用户听到和看到的切换是立即的；真人 Control + Option PTT 整链仍待人工验收
- 桌面闭环除 verified click 外，已接通 Finder 返回、当前输入框写字，以及一句话新建一条 Apple 备忘录；明确说“把当前页面需要我做的三件事整理成一条备忘录”时，只依据当前活动窗口的一张可见画面提炼 1–3 条，并只新建一条。它不滚动、不看其他窗口，也不编辑、追加或删除旧备忘录；只有精确读回标题和正文后才报告完成，未知结果不自动重试，页面内容不进入审计记录。页面语义整理仍待真人演示验收
- Clicky 只保留一套自有对话大脑；Runtime 失败有界重启后会如实报失败，不再绕过 Kernel 切到独立 `/chat` 会话

奕枢自有 model-tool loop 是唯一正式执行 harness；AgentCore 与 Runtime 完全解耦，Agent-Native 只作方法论。Desktop 执行已有进程内、无队列的独占 lease。当前已是“看见 → 记住 → 行动 → 等条件 → 主动回来 → 继续追问”的最小持续伴侣闭环；分布式 / 多 Runtime exactly-once、真正 checkpoint resume、通用外部状态与日程调度、完整 browser/file/desktop skill 面与底层模型任意字词级的即时中断仍是下一阶段边界。

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
通过正式 Clicky 验收后才算产品能力。`packages/runtime/src/model-loop/` 是唯一正式 Agent 循环。

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

See [Nine-stage agent loop](docs/agent-loop.md), [Own model-tool loop decision](docs/decisions/0014-own-model-tool-loop.md), [Unified product spine](docs/decisions/0010-unified-product-spine.md), [Product kernel](docs/product-kernel.md), [Architecture](docs/architecture.md), [Clicky integration](docs/clicky-integration.md), [persona contract](docs/persona.md), [Clicky presence research](docs/research/clicky-presence.md), and [vertical-slice acceptance](docs/acceptance/v0-context-voice.md).
