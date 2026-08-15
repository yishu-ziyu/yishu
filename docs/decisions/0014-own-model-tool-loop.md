# ADR 0014: 内化 model-tool 循环，移除 Pi SDK 依赖

Type: decision
Status: current
Verified: 34c0eaa 2026-08-15
Review: 执行循环、provider 通道或 OAuth 流变化时（只能由新 ADR supersede）

## Status

Accepted 2026-08-15

## Context

ADR 0011 确立"Pi 是唯一正式 model-tool 循环"时，Pi 的角色是**进程内嵌引擎库**（npm import，非 CLI 转发）。但产品决策（见 [agent-book-product-alignment.md](../research/agent-book-product-alignment.md) 修订二版）要求把引擎循环彻底变为奕枢自有代码：消除 0.x pin 升级风险（debt-004）、消除 coding-agent 形状泄漏（debt-018）、让 Skills 注入/上下文压缩/检索装配等记忆层能力（ADR 0013）可以直接进循环而不经过外部 SDK 的扩展点。

使用面调查结论（2026-08-15）：全包仅 5 个 Pi 运行时值 import，全部集中在 `pi-runtime-adapter.ts`；generation 仲裁、会话缓存 key、工具 fence、计算机动作执行全部是产品自有代码；产品路径零 Pi 内置工具依赖（委托子任务也用 `conversation` 档）；线协议与 `AgentRuntime` 接口不触 Pi 类型。

## Decision

1. 新增 `packages/runtime/src/model-loop/`：奕枢自有 model-tool 循环引擎（`YishuModelSession`），实现适配器消费的会话契约（`subscribe` 事件 / `prompt(text, {preflightResult, images, streamingBehavior})` / `abort` / `dispose` / per-turn 工具激活）。
2. 两条模型通道，均为产品自有 HTTP 客户端：
   - `openai-completions`：LOCAL_GROK（经 8787 worker，bearer sentinel）与 xai（`api.x.ai/v1`，OAuth bearer）；
   - `codex-responses`：openai-codex（`chatgpt.com/backend-api/codex/responses`，OAuth bearer + `chatgpt-account-id`）。
3. OAuth（xai 设备码流；openai-codex 设备码流 + 浏览器流含 localhost:1455 回调与 manual_code 兜底）与 token 刷新自研，凭据继续存 `ProductCredentialStore`（`Yishu/Auth/auth.json`，0700/0600）。无 ambient API-key 路径——provider 注册表结构上只有 OAuth。
4. Pi 能力中明确不内化（产品路径无使用证据）：内置开发工具（read/bash/edit/write/grep/find/ls）、compaction、Pi skills/extensions 资源加载、`SessionManager` 持久化。capability 档位保留协议语义：引擎无内置工具，四档差异退化为文档性（`conversation` = 仅产品自定义工具，其余档同）。
5. `AgentRuntime` 接口与 `protocol.ts` 线协议不变；Clicky 不动。`YISHU_RUNTIME_MODE=pi` 保留为兼容值，映射到内化引擎。
6. 从 `packages/runtime/package.json` 移除 `@earendil-works/pi-coding-agent`。`PiRuntimeAdapter` 更名为 `YishuLoopRuntimeAdapter`。
7. 本 ADR 修订 ADR 0011 的表述：唯一正式 model-tool 循环现在是奕枢自有的 `model-loop`；"不建第二套循环"的不变量不变，`packages/agent-core` 实验室边界与边界守卫全部保留。

## Alternatives considered

- 继续 pin Pi 0.83 并写适配层扩展点。拒绝：记忆层（ADR 0013）需要的 Skills 目录注入、检索装配、状态栏都要绕 Pi 的 resource loader/prompt 组装，每项都是对抗性扩展。
- 保留 Pi 作为 OAuth provider 可选路径。拒绝：半内化状态最差——两套真相、两套错误语义。

## Consequences

- streaming/工具调用/steer 语义由本仓代码与测试（原有 Fake 契约测试全部保留）定义；对真实 provider 的 OAuth 流与 codex-responses 流无法在本仓集成验证，风险显式接受并在真人验收（Clicky 真机登录 + 一次真实 turn）时关闭。
- 上下文压缩暂缺（Pi compaction 未内化）：会话历史按消息上限裁剪，超窗行为待记忆层（ADR 0013 检索装配）接管。
- `verify-product` 边界守卫中 `YISHU_RUNTIME_MODE = "pi"` 字面量检查保留（兼容值仍由 Clicky 发送）。
