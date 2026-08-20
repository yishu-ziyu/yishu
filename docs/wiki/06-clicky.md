# 06 apps/clicky —— 奕枢 macOS App

Type: wiki
Status: current
Verified: 34c0eaa 2026-08-15
Review: apps/clicky 源码结构变化时

## 模块职责

`apps/clicky`（[apps/clicky](../../apps/clicky)）是奕枢唯一 macOS App 源码、构建、安装与可见验收入口（ADR 0012）。工程目录和 bundle id 仍用历史命名（`leanring-buddy.xcodeproj`、`com.yishu.yishu-buddy`、签名身份 `Shangqiuko Local Code Signing`）以维系 TCC 连续性；安装路径是 `/Applications/奕枢.app`。它是纯菜单栏应用（`LSUIElement=true`）：无 Dock 图标，状态栏驻留图标 + 浮动面板 + 屏幕级透明 overlay（跟随光标的 thinking-orb）。

```text
apps/clicky/
├── leanring-buddy/            # Swift 源码（~40 文件）
├── leanring-buddy.xcodeproj/  # Xcode 工程（scheme: leanring-buddy）
├── leanring-buddyTests/       # Swift Testing 单元测试
├── leanring-buddyUITests/     # UI 启动测试
├── scripts/                   # run-local.sh / pin-local-permissions.sh / sync-dev-vars-from-ai-providers.sh
└── worker/                    # 本机语音/模型代理（8787）
```

## 1. App 结构与生命周期

- [leanring_buddyApp.swift](../../apps/clicky/leanring-buddy/leanring_buddyApp.swift)：`@main` + `CompanionAppDelegate`。启动时 `YishuSingleInstanceLock`（`~/Library/Application Support/Yishu/clicky-instance.lock` 文件 flock）保证全局单例；`SMAppService.mainApp` 注册登录项（UserDefaults 标记一次成功后不再静默重开）。
- 三层窗口：
  - **菜单栏面板**：[MenuBarPanelManager.swift](../../apps/clicky/leanring-buddy/MenuBarPanelManager.swift)（`NSStatusBar` 自绘三角图标 + 非激活 `NSPanel`，内嵌 `CompanionPanelView`，外部点击关闭带 0.3s 延迟防误关）。
  - **屏幕 overlay**：[OverlayWindow.swift](../../apps/clicky/leanring-buddy/OverlayWindow.swift)（每屏一个 `.screenSaver` 级透明 click-through 窗口，渲染 `YishuPresenceView` 光标伴随）。
  - **后台任务气泡**：[AgentPresence.swift](../../apps/clicky/leanring-buddy/AgentPresence.swift)（anchor chip / pocket / label 三层 `NSPanel`，是 TaskTruth 的可见投影）。
- entitlements：非沙盒、Apple Events（备忘录自动化）、网络客户端、音频输入、ScreenCaptureKit picker mach-lookup 例外。`NSAppTransportSecurity` 允许连本机 8787。
- [AppBundleConfiguration.swift](../../apps/clicky/leanring-buddy/AppBundleConfiguration.swift)：统一读 Info.plist 键（`VoiceTranscriptionProvider` 默认 `stepfun` 等）。

## 2. 语音管线（PTT → ASR → turn）

```text
Ctrl+Option（GlobalPushToTalkShortcutMonitor，CGEvent tap）
  → BuddyDictationManager.startHybridTurn（AVAudioEngine 采集 + token/generation 会话）
  → HybridSpeechStepFunTranscriptionProvider
       ├─ Apple Speech：shadow partial（只显示，绝不进 submit 路径）
       └─ StepFun（经 8787 /transcribe）：authoritative final
  → BuddyHybridTranscriptionStateMachine（纯 reducer）
  → CompanionManager.submitVoiceTranscript
```

- [BuddyTranscriptionProvider.swift](../../apps/clicky/leanring-buddy/BuddyTranscriptionProvider.swift)：provider 协议族；factory 按 Info.plist 选 Hybrid（默认）/Apple/AssemblyAI/OpenAI。
- [BuddyHybridTranscriptionStateMachine.swift](../../apps/clicky/leanring-buddy/BuddyHybridTranscriptionStateMachine.swift)：token/sequence 校验、release 前 buffer StepFun final、超时降级（Apple fallback → 空提交"没听清"）。**shadow partial 永不跨 submit 边界**。
- 打断（barge-in，见 [02-architecture.md](02-architecture.md)）：`YishuBargeInPolicy` 只允许"旧轮是纯对话且无桌面效果"的同会话续话（steer）；否则 fresh start。

## 3. TTS 与句级流水线

- [ElevenLabsTTSClient.swift](../../apps/clicky/leanring-buddy/ElevenLabsTTSClient.swift)：类名历史保留，实际走本机代理 `/tts` → MiniMax `t2a_v2`；单物理通道、watchdog、错误不回显 upstream body。
- [YishuSentenceSpeechPipeline.swift](../../apps/clicky/leanring-buddy/YishuSentenceSpeechPipeline.swift)：把 presentation-safe 的 delta 切成严格串行句子流；最多念 2 个完整句（气泡仍收全文）；超约 80 字无句号当长墙、不流式念，改走 `speech.excerpt`；保守句号边界（拒绝小数点/URL 内句号）、markup 尾巴 hold、final 单调性校验（违反则退 final-only）；`YishuSentenceSpeechPolicy` 对含桌面效果动词的输入禁流式（语音不可逆）。`web_search` 开始时垫一句「好的，我去查查看。」（不算答案，可被答案或打断停掉）。
- [YishuSpeechSpeed.swift](../../apps/clicky/leanring-buddy/YishuSpeechSpeed.swift)：MiniMax 语速 [0.5, 2.0] 的 clamp/持久化（Swift/worker 共用范围）。

## 4. 运行时客户端与编排器

- [YishuAgentRuntimeClient.swift](../../apps/clicky/leanring-buddy/YishuAgentRuntimeClient.swift)（@MainActor）：spawn bundled node + `stdio-server.js`，NDJSON 双向通信。职责：
  - 会话身份：`currentConversationId` 持久 UserDefaults；`SessionScope`（personal/project/private，private 重启不恢复）；
  - turn 协议：`startTurn/interruptTurn/steerTurn/cancelTurn` + `YishuTurnProjectionReducer`（客户端 generation 闸，打断期间旧 delta 丢弃）；
  - RPC：task.list/cancel、历史/记忆列表与删除、`speech.excerpt`、OAuth；
  - `observeTrail`（每 5s 后台采样）与 `computer.action.result` 回填；
  - 崩溃恢复：`terminationHandler` 立即结束所有 pending 请求；`terminateForRecovery` 驱动有界重启。
- [CompanionManager.swift](../../apps/clicky/leanring-buddy/CompanionManager.swift)（~4100 行，@MainActor ObservableObject）：核心编排器——权限管理、PTT 绑定、voice proxy 启动、runtime 启动/重启（诚实报失败，不谎称进度）、`runVoiceTurnTask` 主响应流、后台任务安静窗口返回（3s 空闲后口播一次，不伪造 turn）、时间提醒送达回声、视觉状态路由、onboarding。

## 5. 上下文采集

- [YishuContextFrameCollector.swift](../../apps/clicky/leanring-buddy/YishuContextFrameCollector.swift)：`capture()`（cursor + frontmost app + active window + AX element + 截图，`expiresAt = +30s`，validate 失败降级无图）与 `captureTrailSample()`（**无截图字节**，private 会话 Swift 侧拦截）。
- [YishuPointerTrailMonitor.swift](../../apps/clicky/leanring-buddy/YishuPointerTrailMonitor.swift)：0.08s 光标采样 + 点击/滚动事件分类（上限 480 点）。
- [CompanionScreenCaptureUtility.swift](../../apps/clicky/leanring-buddy/CompanionScreenCaptureUtility.swift)：ScreenCaptureKit 多屏/单窗口采集（排除自身窗口、最长边 1280px、JPEG 0.8）。

## 6. 计算机使用：验证执行链

```text
采集（ScreenCaptureUtility）
  → 解析：YishuDirectClickResolver（本地 Vision OCR 快路径）或 ElementLocationDetector（Claude computer-use API）
  → 执行：YishuComputerUseActuator（AXPress 优先；自绘控件在确认前台一致后 Quartz 点击并保持/恢复光标）
  → 验证：read-back（AX 状态变化 / 窗口签名 / 64×40 灰度指纹 / Finder path 祖先 / Note 精确读回 / UN pending 读回）
  → typed receipt（computer.action.result）
```

- [YishuAction.swift](../../apps/clicky/leanring-buddy/YishuAction.swift)：`YishuComputerActionRequest/Result`、`YishuActionStatus`（verified/delivered/unverified/blocked/failed）、`YishuActionMethod`、`YishuActionCode`、`YishuActionPolicy`（**`allowsAutomaticRetry` 恒 false**——未知结果绝不自动重试；Quartz 退回仅限 `axLookupFailed/axPressUnsupported`）。
- 已接动作：`left_click`、Finder-only `finder_history_back`、聚焦可写 AX 元素的 `set_text`（secure 字段 fail-closed、receipt 只含长度/角色/匹配证据不含原文）、create-only Apple Notes 插入、系统通知定时提醒。
- `authorizedCommit` 把 cancel fence 紧贴不可逆调用；Quartz down 后 up 必须配对（防 stuck drag）。

## 7. 产品动作与路由（Swift 侧镜像）

- [YishuProductUtteranceRouter.swift](../../apps/clicky/leanring-buddy/YishuProductUtteranceRouter.swift)：Node kernel router 的客户端镜像（权威边界在 kernel）；相对时间提醒分类（schedule/question/incomplete）。
- [YishuVisualStateRouter.swift](../../apps/clicky/leanring-buddy/YishuVisualStateRouter.swift)：typed lifecycle 事件 → 9 个产品视觉态（breathing/listening/connecting/…/weaving/shaping）→ thinking-orb 几何（[YishuBreathingOrbGeometry.swift](../../apps/clicky/leanring-buddy/YishuBreathingOrbGeometry.swift)，golden vectors 校验）。
- [YishuTimeReminderDelivery.swift](../../apps/clicky/leanring-buddy/YishuTimeReminderDelivery.swift)：UNUserNotificationCenter 调度 + pending 精确读回验证 + 送达回声状态（跨会话不丢、只播一次）。

## 8. worker：本机语音/模型代理（apps/clicky/worker）

作用：**让 API key 永不进 Mac 二进制**。等价双实现：`local-server.mjs`（生产，node http，127.0.0.1:8787）与 `src/index.ts`（Cloudflare Worker 版）。

- 安全：≥32 字节 bearer token（`timingSafeEqual`）；拒绝带 `Origin` 的浏览器请求与 OPTIONS（防网页劫持本机能力）；限流 4 并发；body/响应/超时上限。
- 路由：
  - `/health`、`/config`（无 secret 的能力面，Swift 据此判 ready）；
  - `/chat`：Anthropic Messages ↔ OpenAI chat/completions 双向转换（含 SSE）；
  - `/v1/chat/completions`：Pi sidecar loopback，仅 `YISHU_RUNTIME_MODELS` 白名单模型，凭据只在 worker→8317 转发时注入；
  - `/tts`：MiniMax `t2a_v2`（hex → mp3）；
  - `/transcribe`：StepFun SSE ASR（热词经 `stepfun-hotwords.mjs` 校验：≤50 个、单条 ≤64 Unicode 字符、去重）。
- 凭据：`worker/.dev.vars`（本地）或 `wrangler secret`（部署）；[YishuVoiceProxySupervisor.swift](../../apps/clicky/leanring-buddy/YishuVoiceProxySupervisor.swift) 负责启动/健康探测/指数退避重启（≤3 次/分钟）/只回收真正孤儿 8787 占用者。

## 9. 脚本（apps/clicky/scripts）

| 脚本 | 作用 |
|------|------|
| `run-local.sh` | 构建签名 App + 打包 YishuRuntime（kernel/runtime 构建产物 + node 二进制，保留 V8/JIT entitlements 重签）+ 安装 `/Applications/奕枢.app` + 启动。模式：run/build/install/open/pin/self-test。严格只 quit 正式 App 树（禁 `pgrep/pkill -x` 产品名），内置自测 |
| `pin-local-permissions.sh` | 用 csreq blob 钉 TCC 权限（麦克风/屏幕录制/辅助功能），修复签名重授权漂移 |
| `sync-dev-vars-from-ai-providers.sh` | 从本机 provider 配置生成 `worker/.dev.vars`（绝不打印 secret 值） |

## 10. 测试（leanring-buddyTests/，Swift Testing）

覆盖：provider/model picker、runtime client 协议与重启、barge-in 与 generation 仲裁（YishuBargeInTests）、句级语音流水线、视觉状态路由、voice proxy 孤儿回收策略、语速、orb 几何、create_note 契约、ContextFrame 契约（XCTest）、时间提醒、响应连续性、后台任务返回策略。运行：`pnpm product:verify`（内含 xcodebuild test）。
