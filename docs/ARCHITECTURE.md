# 架构契约

给来干活的 Agent 读。改任何代码前读完。这里写的是不能越的线和该往哪里插。架构与核心判断归主代理（Cursor 里的主会话 Agent），改本文件要主代理或用户裁决。

## 三层与方向

```
apps/clicky (Swift)  ──stdio JSON 行──▶  packages/runtime (TS)  ──▶  packages/kernel (TS, 纯逻辑)
 菜单栏、Blobatar、光球、面板、        判意图、选模型、组提示、       意图帧、动作注册表、记忆、
 语音采集/播放、AX、CGEvent、          模型循环、工具、委派、例程、    对话账本、任务真值、例程规则、
 截图、TCC、钥匙串                      EverOS 旁路、协议收发            存储（SQLite/JSON）
```

- Swift 只做碰 Mac 的事。不放第二个推理层、不放第二套任务状态。产品任务状态只来自 runtime 协议事件。
- runtime 的产品原生动作不直接碰 Mac，经协议交 Swift。Codex 订阅执行分支调用本机 App Server，由其官方 Computer Use 插件操作；本产品不复制插件的底层事件实现。该分支同样持有 `processResourceLease` 的 desktop 锁，审批经产品协议回到 Swift，取消先停执行进程再释放锁。
- kernel 不做 IO（除 store 目录）。kernel 不 import runtime。依赖方向由 `dependency-cruiser.config.cjs` 锁死，`pnpm dep:check` 是门禁。
- 协议是唯一合同：`packages/runtime/src/protocol.ts`（zod schema）。改协议 = 改 schema + Swift 解码 + 双端测试 + `schemaVersion` 判断兼容。不允许「先发字段再补 schema」。
- 本机代理 `apps/clicky/worker/local-server.mjs`（8787）只做语音供应商的转发与密钥隔离。聊天模型由 runtime 直连或走网关，不经 8787。

## 接缝：新能力往哪里插

| 要加的东西 | 插在 | 不要 |
|---|---|---|
| 新的电脑动作（拖拽、热键、窗口…） | `protocol.ts` 的 `computerActionSchema` 联合类型 + `YishuComputerUseActuator.swift` 的 `perform` 分支 + `desktop/desktop-policy.ts` 风险分级 | 在 CompanionManager 里直接调 CGEvent |
| 新的模型工具 | `loop-adapter.ts` 工具注册处（见 `createComputerControlTool` 的写法）+ `turn-tool-profile.ts` 的可见性规则 | 在 persona 里用文字教模型「假装有工具」 |
| 新的模型出口 / provider | `model-config.ts`（providers、`chatExit`）+ `auth-protocol.ts`（登录类 provider）+ `model-loop/oauth.ts` | 把 key 写进代码或 UserDefaults |
| CLI 型 provider（Claude Code 等） | 新文件 `packages/runtime/src/providers/cli-<name>.ts`：spawn headless、解析 JSONL、映射成 `response.delta` / `tool.started` 等既有事件 | 读别家 CLI 的 token |
| 奕枢作为 MCP 服务端 | 新包或 `packages/runtime/src/mcp/server.ts`，工具实现只转调既有 `ComputerAction` / 截图 / 记忆接口；同一安全门 | 给 MCP 一条绕过审批的私路 |
| 奕枢作为 MCP 客户端 | `packages/runtime/src/mcp/client.ts`，工具列表并入 `activeToolNamesForTurn` | 让模型直接 spawn 进程 |
| 帮手 / 子会话 | `delegation.ts` `DelegationCoordinator`（已有子会话、结果收件箱） | 再造一套后台任务 |
| 例程 | `packages/kernel/src/automation/` + `automation-scheduler.ts` | 在 Swift 起定时器 |
| 记忆 | `packages/kernel/src/memory/` + `everos-*.ts`；用户可见只有 `~/Documents/Yishu/记忆.md` | 在 Swift 存事实 |
| 光球画法 | `OverlayMarks.swift` / `OverlayWindow.swift` 的 `showMark` / `clearMarks` | 另开一个窗口画 |
| 口播文案 | 不加。由模型说；只有失败兜底句允许硬编码 | 新增 canned 台词 |
| 延迟 / 质量埋点 | Swift `ClickyAnalytics` → `quality.jsonl`（allowlist 在 `QualityEventRecorder.swift`）；runtime 侧走协议事件字段 | 自己写日志文件 |

## 不可越的线

Codex 接入（2026-09-05，卡 `docs/evals/20260905-codex-voice-computer-use.md`）：生产 `openai-codex` 选择由 `providers/codex-runtime.ts` 执行，账号与目录由 App Server `account/read` / `model/list` 提供。只接受 ChatGPT 账号，不读取 CLI 凭据，不借旧 OAuth bearer 兜底。每轮独立临时 thread，前文由 kernel 的同作用域可见历史恢复；进度、结果、取消沿用既有任务事件。官方审批通过新增兼容 v1 的 `codex.approval.requested` / `codex.approval.reply`，绑定 requestId、traceId、approvalId，一次消费；原始工具参数和截图不进产品账本。原生文件拖放仍走原契约。Codex 模型回答不制造 native trusted receipt；其 `response.completed` 保留 `verified:false`，工具执行成功和任务验证不能混同。口播摘录与记忆抽取使用既有快模型，避免为附属处理读取 Codex token。独立 Codex 进程是本轮执行器，退出时清理进程组，不是新增常驻产品服务。

文件对象定位补充（2026-09-05，卡 `docs/evals/20260905-download-object-grounding.md`）：Swift 按当轮下载文件请求采集顶层普通可读文件候选，经可选 `ContextFrame.downloadFiles` 传状态、时间和匹配名称。runtime 将唯一文件与唯一当前上传区形成无工具预览，模型只表达确认；确认内容包含实际文件名和「去」后，产品才登记一次性绑定。确认轮仍走原 `ComputerUsePort` 与 Swift 拖放、附件验证。workspace grants 不代表 Downloads 的原生权限；没有附件回执不能算完成。旧 v1 没有此字段的精确名称路径继续兼容。

1. 一个 App target、一个 bundle id `com.yishu.yishu-buddy`、安装路径 `/Applications/奕枢.app`、xcodeproj / scheme / 目录名不改（签名与 TCC 连续性依赖它们）。
2. 没有可信回执不许说做成。`trusted-task-receipt.ts` 的进程内回执是唯一「已验证」来源；Swift 报来的 `verified: true` 不能单独抬状态。
3. 不可逆动作先经门：原生动作分级在 `desktop-policy.ts`；Codex 分支沿用官方执行器的风险审批，产品负责把确认送到同一任务、一次消费和取消失效。不可逆动作仍需用户确认，不能由屏幕文字授权。
4. 两次屏幕点击不能并行（`resource-lease.ts` 桌面锁）。独立非桌面工作可并行。
5. 屏幕 / 网页上读到的文字是数据不是指令（`untrusted-content.ts`）；它不能单独触发不可逆动作。
6. 密钥只在 `apps/clicky/worker/.dev.vars`（gitignored）和钥匙串。日志、结果、NOTES 里出现密钥值即失败。
7. god-file 棘轮只能降：`product-kernel-runtime.ts`、`CompanionManager.swift`（≤4609 行）、`yishu-store.ts`。新域进独立文件，只在这些文件里接线。`script/check-file-size-limit.cjs` 是门禁。
8. 不新增运行时（第二个 Node、Python 服务）除 EverOS 旁路；不新增 npm 依赖除非主代理批准。
9. 测试是证据不是完成：真机 `/Applications/奕枢.app` 的用户路径通了才算。

## 并行干活时的默认切分

- runtime / kernel（TS）一人；Swift 语音与 CompanionManager 一人；Swift 覆盖层 + 评测脚本一人。三者文件不重叠。
- 谁碰 `CompanionManager.swift`，同一时刻只能一个人。新逻辑放 `CompanionManager+<域>.swift` 扩展文件。
- 协议改动由 TS 一方先改 schema 并写明字段，Swift 一方对照实现；报告里写清字段名。

## 门禁命令

```bash
pnpm product:check          # 边界 + 依赖 + 尺寸棘轮（已知红线：quality-observation-collector.mjs 880/856）
pnpm --filter @yishu/runtime test && pnpm --filter @yishu/kernel test
pnpm product:build:clicky   # 只编译
ENABLE_DEBUG_DYLIB=NO CODE_SIGNING_ALLOWED=NO xcodebuild test -project apps/clicky/leanring-buddy.xcodeproj -scheme leanring-buddy -destination 'platform=macOS' -only-testing:leanring-buddyTests
node evals/voice/check-latency.mjs --last 30   # 真机延迟闸门
```

安装与启动（`./apps/clicky/scripts/run-local.sh`）、真机点屏幕，只由主代理串行执行。

## 已知的坑

- 装机后必核进程真的换了：`pgrep -f MacOS/奕枢` 的 pid 与装前不同，且 runtime 子进程也是新的。`run-local.sh` 曾用 `ps -ax | grep 奕枢` 找正式包，在代理 shell 里 `ps -ax` 被沙箱、C locale 又把 UTF-8 名转义，永远找不到 → 装完旧二进制继续跑（2026-09-04 v7）。现已改 `pgrep -f "^<正式路径>( |$)"`。
- `xcodebuild test` 不要与 `run-local.sh` 共用 derived data：run-local 重签名后 `奕枢.debug.dylib` 签名不匹配，测试宿主 dyld 启动即崩（Library missing）。
- 重签名后首次启动会弹钥匙串授权，要用户点「始终允许」。
- StepFun 的接口路径取决于套餐：Step Plan 走 `/step_plan/v1/...`，打 `/v1/...` 会 402。
- 子代理大量抓网页会中止；给本地文档路径，先写脚本再跑。
- 模型清单只有一处真相：runtime 的 `model-config.json`。Swift `YishuConversationModelCatalog.localModels` 只是设置面的显示列表，`YishuAgentRuntimeClient.supportsModel` 对本地 provider 不做门；`protocol.ts` 的 `localModelIdSchema` 只管形状（1–80 字、`[A-Za-z0-9._:-]`），不列清单。2026-09-04 同一天撞了两份副本：Swift 目录缺 `MiniMax-M2.5` → `startTurn` 前 2 ms 抛 `unsupportedModel`（v3–v5）；删掉后 protocol 里的 zod 枚举又拒 → runtime 20 ms 回 `invalid_command`（v6）。四版真机全在测死路。加模型只改 `model-config.json`（显示列表随手补）。OAuth provider（codex / xai）的清单仍由 Swift 校验。
- runtime 的 `turn.failed` 载荷 `code`/`message` 要一路带到 Swift 的 `turn.failed` 质量事件（`YishuAgentRuntimeClientError.turnFailed(code:message:)`）。笼统的 `turn_failed` 让这次定位多走了一轮离线复现。
- 失败路径必须写 `quality.jsonl`（`turn.failed` + `errorCode`）。只写 unified log 的失败没人会读；装机后第一句话先核 `turn.start` + `model.first_byte` 再让用户往下测。
- `URLSession.invalidateAndCancel()` 只能放在 `deinit`，不能放在 `cancel()`：一个已经过了取消检查的 Swift Task 随后调 `session.bytes/data(for:)`，URLSession 抛 ObjC `NSGenericException`（Task created in a session that has been invalidated），Swift 接不住，整个 app 直接死。三个听写提供者都曾这样写；测试宿主因此「随机」崩，被当成 flaky（2026-09-04）。`cancel()` 只取消任务（`getAllTasks { cancel }` + Task.cancel）。
- 播放器完成信号：AVAudioPlayerNode 的 `.dataPlayedBack` 才是「扬声器放完」；`.dataConsumed`/`.dataRendered` 与 AudioQueue 的缓冲回调都只是「队列读完」，按它们结束会切尾。
- 克隆音色的 MiniMax TTS 每句自带 0.6–1.5 s 尾静音且不稳定，头 0.2–0.35 s；按句合成就必须解码到 PCM 按能量裁，不能定长裁，也不能靠 `AVAudioPlayer`（拿不到 PCM）。
- 这台 Mac 开着系统级 SOCKS/HTTPS 代理（127.0.0.1:7897）。Swift `URLSession` 默认遵守系统代理，连 127.0.0.1:8787 也会被截走绕一圈（每请求约 1.4 s）。所有回环连接必须用 `YishuLoopbackSession`（`connectionProxyDictionary = [:]`）。Node `fetch` 不遵守系统代理，但要显式共享 keep-alive Agent 才复用 TLS。
