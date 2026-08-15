# 05 packages/runtime —— @yishu/runtime 运行时层

Type: wiki
Status: current
Verified: 34c0eaa 2026-08-15
Review: packages/runtime 源码结构变化时

> **修订 2026-08-15（ADR 0014）**：本文写作时循环尚由 `@earendil-works/pi-coding-agent` SDK 提供；现已内化为奕枢自有 `src/model-loop/`（会话引擎 + provider 注册表 + OAuth + OpenAI-completions/Codex-responses 双通道），`pi-runtime-adapter.ts` 更名 `loop-adapter.ts`（类 `YishuLoopRuntimeAdapter`）。协议层与 AgentRuntime 接口不变。文中 "PiRuntimeAdapter/Pi SDK" 字样按历史理解即可。

## 模块职责

`@yishu/runtime`（[packages/runtime](../../packages/runtime)）拥有两件事：

1. **版本化运行时协议**（protocol.ts）：Clicky 与 runtime sidecar 之间的 NDJSON 命令/事件契约。
2. **Pi 适配器**：把 Pi（`@earendil-works/pi-coding-agent`）封装成 turn-centric 的 `AgentRuntime` 接口，并用 `ProductKernelRuntime` 在外层做产品投影（持久账本、ContextTrail、TaskTruth、记忆召回）。

它是 private 包，不被任何 workspace 包作为库依赖；作为**独立 stdio sidecar 进程**被 Clicky spawn。依赖：`@yishu/kernel`（workspace）、Pi SDK、typebox、zod。

```text
packages/runtime/src/
├── protocol.ts            # 线协议（zod schema）：命令、事件、computer action
├── runtime-port.ts        # AgentRuntime 接口（ports-and-adapters 边界）
├── runtime-factory.ts     # 装配门禁：mock | pi，外层包 ProductKernelRuntime
├── mock-runtime.ts        # 确定性协议测试替身（无凭据）
├── pi-runtime-adapter.ts  # Pi 封装：会话缓存、能力映射、generation 仲裁
├── product-kernel-runtime.ts # 产品投影：Kernel 账本 + TaskTruth + 路由
├── stdio-server.ts        # sidecar 进程入口（stdin/stdout NDJSON）
├── capability-profiles.ts # conversation/observe/build/owner 四档
├── computer-control-tool.ts / computer-use-port.ts # typed 桌面动作工具与端口
├── web-search-tool.ts     # 搜索工具
├── delegation.ts / task-contract.ts / task-progress.ts / trusted-task-receipt.ts
├── suggestion-loop.ts / resource-lease.ts / trail-source.ts
├── auth-protocol.ts / auth-service.ts / auth-store.ts / auth-watchdog.ts
├── assistant-output.ts    # 模型输出投影与流式发布闸
├── context-prompt.ts / persona.ts / untrusted-content.ts
└── index.ts               # 公共导出（内部模块不导出）
```

## 1. 协议层（protocol.ts）

- `PROTOCOL_VERSION = 1`；每条命令/事件带 requestId、traceId、schemaVersion、timestamp。
- **模型网关唯一化**：`LOCAL_GROK_PROVIDER = "yishu-local-grok"` 固定 `http://127.0.0.1:8787/v1`，`LOCAL_GROK_MODEL_IDS` 白名单（grok-4.5 / 4.3 / 4.20-* / grok-3-mini 等）。协议上没有远程 endpoint 字段——turn 不能把 Pi 重定向到任意 URL；Clicky 只发送允许清单内的 `{provider, model}` 偏好。
- `sessionScopeSchema`：personal / project(uuid) / private 的 discriminated union（"runtime 不得推断项目身份"）。
- Computer action schema（typed，非 provider 工具语法）：
  - `left_click`（x/y/screen/label）；
  - `finder_history_back`（targetBundleId 固定 Finder + targetPid，语义动作不暴露给 model 的 computer_control 工具）；
  - `set_text`（text + targetBundleId/targetPid——目标身份由 runtime 从 turn 的 ContextFrame 附加，**绝不接受 model 工具参数**）；
  - `create_note`（content/title + 完整 source 五元组可选）；
  - `schedule_reminder` 等。

## 2. AgentRuntime 接口（runtime-port.ts）

```ts
interface AgentRuntime {
  startTurn(command: TurnStartCommand, emit: RuntimeEventSink): Promise<void>;
  interruptTurn?(command: TurnInterruptCommand, emit): Promise<void>;
  steerTurn(command: TurnSteerCommand, emit): Promise<void>;
  cancelTurn(command: TurnCancelCommand, emit): Promise<void>;
  dispose(): Promise<void>;
}
```

严格 turn-centric；产品状态不得存 Pi 事件对象或 Pi 会话类型。

## 3. 装配（runtime-factory.ts）

- `RuntimeMode = "mock" | "pi"`（`YISHU_RUNTIME_MODE`；Pi 是唯一生产循环，Mock 只是测试替身）。
- `createAgentRuntime(mode, ports)`：内层 `MockAgentRuntime` 或 `PiRuntimeAdapter`；`YISHU_PRODUCT_KERNEL ≠ 0`（默认开）时外层包 `ProductKernelRuntime`。
- Clicky 正式启动固定注入 `YISHU_RUNTIME_MODE=pi` + `YISHU_PRODUCT_KERNEL=1`（边界守卫检查这两个字面量）。

## 4. PiRuntimeAdapter（pi-runtime-adapter.ts）

- 封装 Pi SDK：会话作为**内存延迟缓存**（非产品真相）；冷启动时 ProductKernelRuntime 只注入同一 durable conversation/scope 的有界可见 turn。
- `PiTurnGenerationState`：同步 latch 保证 interrupt 与效果派发的原子性——acceptance floor（`minimumAcceptedGeneration`）、`effectDispatchGeneration`、steer cycles；已排队的旧 provider 回复无法再发布文本或成为权威完成。
- 完成 turn 的复用会重放 Kernel 记录而非重执行工具；被中断的 open turn fail-closed 恢复。
- 能力档位（capability-profiles.ts）映射 Pi 工具面；成熟的 Pi 工具经任务能力档案保留，不重建。

## 5. ProductKernelRuntime（product-kernel-runtime.ts）

外层产品投影，是 kernel 的主消费方（`createDefaultProductKernel`、`routeProductUtterance`、`recallRelevantMemories`、`selectRelevantMindLessons`、`createTaskExecutionContract`…）：

- turn 开始前创建 open Kernel turn；只把可见输入/最终输出/安全 typed 事件写入账本（`sanitizeClientEvent` 白名单化所有出站事件）。
- 产品话术路由命中 → 调 `YishuActionRegistry`；否则走内层 Pi。
- `TaskTruthProjector` 投影任务状态；`task.presence.updated` 事件驱动 Clicky 的后台任务气泡。
- 委托（delegation.ts）：child 会话无 computer_control/delegate（结构性排除递归）；handoff 经 ContextCapsule 序列化-解析-过期-untrusted 包装；Result Inbox payload-only、keyed to main conversation。
- 恢复（recovery）：重启时 claimed result 的领取 turn 已持久完成则确认，否则释放；孤立 running 子任务标失败，绝不自动重跑。
- `initialize()` 由 stdio-server 有界等待（10s 超时，失败即退出，不留 immortal 进程）。

## 6. stdio-server.ts（进程入口）

Clicky spawn `packages/runtime/dist/stdio-server.js`：

- `createInterface` 按 `\n` 分行解析 `clientCommandSchema`；每条命令严格 zod 校验、requestId UUID 规整。
- `StdioComputerUsePort`：收到 `computer.action.requested` 后经 stdout 发给 Clicky，等待 `computer.action.result` 回填——**直接动作 turn 缓冲到结果到达**。
- auth 事件（auth-service）与 watchdog（auth-watchdog）管理 provider OAuth；凭据存 `auth-store`（0700/0600 + 文件锁 + 原子写）。
- 有界 dispose（2.25s）与 stdout drain；所有 cleanup 路径都有 bounded timeout。

## 7. 其余模块速查

| 模块 | 职责 |
|------|------|
| `assistant-output.ts` | `AssistantOutputStreamProjector`（增量只发稳定可见前缀）/ `AssistantOutputGenerationProjector`（每 provider generation 一个 projector，interrupt 推进 acceptance floor）；`incompleteHiddenBlockStart` 绝不发布半截 XML token；`isDirectComputerActionUtterance` 高精度直接点击判定 |
| `computer-control-tool.ts` | Pi 侧 `computer_control` typed 工具（typebox schema） |
| `computer-use-port.ts` | `ComputerUsePort` 接口 + `StdioComputerUsePort` 实现 |
| `web-search-tool.ts` | 搜索工具，结果经 `wrapUntrustedContent` 包装 |
| `task-contract.ts` / `task-progress.ts` / `trusted-task-receipt.ts` | 不可变契约、进度观察、可信回执（wire 自称 verified 不信任） |
| `resource-lease.ts` | 进程内桌面动作 token/epoch 独占 lease（冲突即 busy，不排队） |
| `suggestion-loop.ts` | 产品建议环（record/settle suggestion） |
| `trail-source.ts` | `contextFrameToTrailSource`：wire ContextFrame → kernel trail 形状 |
| `context-prompt.ts` | 组装 context_frame / conversation_history / recent_context_trail / delegated_results 等上下文块 |
| `persona.ts` | 奕枢人格 system prompt |
| `untrusted-content.ts` | 注入风险扫描（12 条规则）+ `<untrusted>` 包装（启发式分层，非授权边界） |
| `auth-*` | OAuth-only provider 策略（删除 apiKey 路径）、凭据隔离、watchdog |

## 8. 环境变量

| 变量 | 作用 |
|------|------|
| `YISHU_RUNTIME_MODE` | `mock` / `pi`（Clicky 固定 `pi`） |
| `YISHU_PRODUCT_KERNEL` | 默认开；`0/false/off` 关闭产品投影 |
| `YISHU_STORE_BACKEND` / `YISHU_SQLITE_PATH` / `YISHU_STORE_DIR` | Kernel store 选择（默认 sqlite） |
| `YISHU_USER_NAME` | 用户身份 |
| `YISHU_AUTH_WATCHDOG_MS` | auth watchdog 超时 |
| `YISHU_VOICE_PROXY_TOKEN` | 访问 8787 worker 的 bearer token |
| `YISHU_RUNTIME_MODELS` | loopback 允许的模型集合 |

## 9. 测试（test/，17 个文件）

覆盖 protocol、runtime-factory、pi-runtime-adapter（含并发）、product-kernel-runtime、mock、stdio-server、delegation、task-contract、resource-lease、suggestion-loop、computer-use-port、web-search-tool、assistant-output、auth-service、untrusted-content、runtime-recovery-acceptance。运行：`pnpm --filter @yishu/runtime test`（pretest 自动先构建 kernel）。
