# M3 脑子管线：验收卡

- 日期：草稿 2026-09-04；开工时改日期并转 active
- 状态：draft
- 上下文：`docs/ROADMAP.md` M3；内核页 B；NOTES 决定 7、8、18、19
- 前置：M1 已过（MCP 服务端暴露的就是操控能力）

## 一句话任务

深任务自动交给本机已登录的 Claude Code 等 CLI 去做；奕枢把自己的操控、看屏、记忆能力以 MCP 服务端暴露给它们和 Cursor；CLI 的每次许可请求都经奕枢的门。

## Change（用户能观察到什么）

说「帮我把桌面的截图按月份整理进文件夹」，奕枢先应答一句，随后任务芯片出现，进度用第一人称说；期间 Claude Code 要跑命令时，光球飞过来问「我要在终端执行 mv，去吗」；做完它用自己的声音说结果。模型列表里看到「本机 Claude Code（已登录）」。在 Cursor 里配一个 MCP 服务器指向奕枢，就能让 Cursor 调 `look_at_screen`。

## Not this

- 读 Claude Code 的 OAuth token 直接调 Anthropic API。
- 用 `--permission-mode bypassPermissions` 跑 CLI。
- 接 Cursor 的私有后端协议。
- MCP 服务端给一条绕过审批的路。
- 深任务路由靠关键词硬编码而无标注集验证。

## Goal / Hard bar / Improve

- Goal：一个真实深任务（整理文件夹 / 写并运行一个脚本 / 多页资料汇总）经 Claude Code 端到端完成，全程可见、可打断、许可都经门。
- Hard bar：任何一次 CLI 的不可逆动作未经门 = 失败；深任务期间静默 >20 s 无进展播报 = 失败。
- Improve：深任务应答延迟（松手→第一句）p50，目标 ≤1.5 s。

## 验收标准

| # | 标准 | evaluator | 证据 |
|---|---|---|---|
| 1 | 检测：扫已知路径找 `claude` 二进制与凭据文件；模型列表显示「本机 Claude Code（已登录 / 未登录 / 未安装）」 | 机器：探测单测（伪造路径三种状态）；`models.probe` 输出 | 测试 + 输出 |
| 2 | 调用：`claude -p --output-format stream-json --include-partial-messages --mcp-config <奕枢 MCP> --strict-mcp-config --permission-prompt-tool mcp__yishu__approve --max-turns N --no-session-persistence`；JSONL 事件映射到既有协议事件（`response.delta`、`tool.started/completed`、`turn.failed`） | 机器：用一个伪 `claude` 脚本（回放固定 JSONL）跑 runtime 单测，断言事件序列 | 测试输出 |
| 3 | 许可请求经门：`--permission-prompt-tool` 调到奕枢 MCP 的 `approve` 工具 → 按 `desktop-policy.ts` 分级：可逆自动放行并预告，不可逆等用户「去」 | 机器：伪 CLI 发 5 个许可请求（3 可逆 2 不可逆）→ 3 自动放行 + 2 `approval.requested`，用户拒后 CLI 收到 deny | 测试 + 日志 |
| 4 | 奕枢 MCP 服务端（stdio + loopback HTTP）暴露：`look_at_screen`、`computer_action`（同 `computerActionSchema`）、`recall_memory`、`approve`；schema 与协议一致 | 机器：MCP inspector 或自写客户端 `tools/list` + `tools/call` 全通；同一安全门单测 | 输出 |
| 5 | Cursor 作为 MCP 客户端能调奕枢的 `look_at_screen` 得到当前屏描述 | 人评：用户在 Cursor 里配一次并调一次 | 截图 |
| 6 | 深任务自动路由：意图分类把多步 / 文件操作 / 写代码 / 长资料汇总判为 `deep_task`；用户可用「认真做」强制 | 机器：40 条标注语句精确率 ≥90%、召回 ≥80% | 测试输出 |
| 7 | 深任务进度：任务芯片 + 对话流行；每 ≤20 s 无进展时模型说一句进展（沿用 grok-bot 规则） | 机器：日志静默间隔 p95 ≤20 s | 脚本输出 |
| 8 | 汇报口吻第一人称、不说「派了 / 后台任务已开始」 | 机器：`rg` 提示词；人评：一段真实深任务的口播 | rg + 人评 |
| 9 | Codex 路径回归不坏 | 机器：既有 OAuth / 模型循环测试通过 | 测试输出 |
| 10 | 网关作为深任务可选出口可切换（`chatExit`），实时对话档不受影响 | 机器：切换后 `turn.started.baseUrl` 变化 | 日志 |
| 11 | 真机：一个真实深任务端到端完成 | 人评：用户看全过程 | 录屏 |
| 12 | 全部检查绿 | 机器：门禁命令 | 输出 |

## 非目标

- MCP 客户端（M4）。
- Gemini CLI、Cursor agent 等其他 CLI（一个适配器一个 provider，见到再加）。
- 让 CLI 直接操作真实浏览器。

## 附加：Pi Agent SDK 一天 spike（用户 2026-09-04 批准）

问题：自研 `model-loop/`（约 2000 行）+ `loop-adapter.ts` 接线是否换成 `pi-agent-core` / `pi-ai`。只在 M3 做，一天，拿数据定。

硬门槛（全部满足才换）：同一套工具、可信回执、安全门、先应答提醒、POINT 修复、超时兜底在 Pi 循环下全部保留且 runtime 测试全过；实时对话档首字 p50 不退化；`packages/runtime/src` 行数至少减 30%；Context Frame 与记忆仍能每轮由我们在请求前组装（不是交给 SDK 的会话历史）；provider 登录复用不读别家 CLI 的 token。任一条不满足 → 不换，写进 devlog 与本卡。

## 未决（开工前主代理定）

- 本机 Claude Code 版本是否 ≥2.1.259（`--permission-prompts`）；低于则用 `--permission-prompt-tool` 老路。
- `approve` 工具的超时（用户不答时的默认：拒）。
