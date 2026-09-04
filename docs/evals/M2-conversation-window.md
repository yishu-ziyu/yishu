# M2 对话窗：验收卡

- 日期：草稿 2026-09-04；开工时改日期并转 active
- 状态：draft
- 上下文：`docs/ROADMAP.md` M2；内核页 E、J；grok-bot 交互层清单（对话骨架 T1）
- 前置：M0 已过（先应答规则、说话规则）

## 一句话任务

给奕枢一个原生对话窗：能打字也能说，看得到流式回答、可展开的思考与工具行，例程和后台结果进同一条对话流，窗口不在前台时有系统通知，重启后历史还在。

## Change（用户能观察到什么）

按快捷键（默认 Cmd+Shift+Y，可改）弹出一个 SwiftUI 窗口，从菜单栏也能开；底部输入框可打字回车发送，也可点麦克风按住说；回答一字一字流出来；每轮上面有一行灰色可折叠的「想了什么 / 用了什么工具」；例程到点跑完，结果作为一条消息出现在同一流里；窗口失焦时回答完成弹系统通知；退出重开 App，最近 50 轮还在。

## Not this

- 用 WebView / Electron 嵌网页。
- 对话窗自己存一份历史（历史只能来自 kernel `ConversationLedger`）。
- 打字走另一条通道而不是 `turn.start`。
- 把 M5 的多帮手侧栏塞进来。
- 只做了 UI 没接例程与后台结果。

## Goal / Hard bar / Improve

- Goal：用户在窗口里连续对话 20 轮（打字与语音混合），全程无需菜单栏面板。
- Hard bar：打字与语音的任何一轮不经同一 `turn.start` = 失败；重启后历史丢失 = 失败；runtime 重启后后台结果送两次或不送 = 失败。
- Improve：`response.delta` 到 UI 渲染的延迟 p95（目标 ≤100 ms）。

## 验收标准

| # | 标准 | evaluator | 证据 |
|---|---|---|---|
| 1 | 打字入口走 `turn.start`，payload 标 `inputSource: "typed"`，不拍现场（用户说「看屏幕」类才按需拍） | 机器：runtime 协议单测 + 日志检查 20 轮 | 测试 + 日志 |
| 2 | 流式渲染：每个 `response.delta` 到 UI 更新 ≤100 ms p95 | 机器：Swift 埋点 `ui.delta_rendered` 与 `response.delta` 时间差 | `check-latency.mjs --metric delta→render` |
| 3 | 思考 / 工具行来自协议事件（`tool.started` / `tool.completed` / thinking 段），默认折叠，可展开 | 机器：Swift 单测（事件→行模型）；人评：展开体验 | 测试 + 截图 |
| 4 | 先应答再工具行：每轮第一个可见项是模型的一句话，不是工具行 | 机器：日志 `ack-before-tool` 100%（沿用 M0 #9） | 脚本输出 |
| 5 | 例程结果进对话流：`automation.run.finished` → 一条带来源标记的消息 | 机器：建一个 1 分钟后的例程 → 消息出现；单测事件映射 | 日志 + 截图 |
| 6 | 后台帮手结果进对话流，且 runtime 重启后恰好送一次 | 机器：派后台任务 → kill runtime → 重启 → 结果 1 条；Result Inbox claim/ack 单测 | 日志 |
| 7 | 失焦通知：窗口非 key 时 `response.completed` → `UNUserNotification`；点通知回到窗口 | 机器：日志 `notification.posted`；人评 | 日志 + 人评 |
| 8 | 历史恢复：重启后最近 50 轮从 `ConversationLedger` 读回，顺序与内容一致 | 机器：写 60 轮 → 重启 → 读 50 轮比对 | 测试输出 |
| 9 | 语音与打字共用一条对话，语音轮的气泡与窗口内消息同源 | 机器：同一 `turnId` 出现在两处日志 | 日志 |
| 10 | 键盘：Cmd+Shift+Y 开 / 关，Esc 关，回车发送，Shift+回车换行；VoiceOver 可读消息与按钮 | 人评：逐项勾 | 勾选表 |
| 11 | 视觉：与 Blobatar / 光球同一设计语言（`DesignSystem.swift`），深浅色都对 | 人评：用户裁 | 截图 |
| 12 | 1000 条历史滚动不卡（按需加载） | 机器：写 1000 轮 → 滚动帧率埋点 ≥55 fps；人评 | 埋点 |
| 13 | `CompanionManager.swift` 不增长；窗口逻辑在新文件 `ConversationWindow*.swift` | 机器：`product:check` 棘轮 | 输出 |
| 14 | 全部检查绿 | 机器：门禁命令 | 输出 |

## 非目标

- 表情回应、选择卡片、图片拖入、线程、搜索（M4）。
- 多帮手侧栏、群组（M5）。
- 富文本编辑器。

## 基线与结果

开工时填：现状只有只读历史窗 `YishuConversationHistoryWindow`。
