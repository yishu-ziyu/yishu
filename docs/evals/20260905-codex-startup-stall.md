# Codex 语音任务长时间无响应：验收卡

- 日期：2026-09-05
- 状态：active
- 上下文：用户真机计算器任务停留在转写浮层；续接 Codex 接入验收。

## 一句话任务

查清语音命令后长时间无响应的原因，修复已确认的启动等待。

## Change

奕枢直接使用这台机器可用的 Codex HTTP 传输，免去 WebSocket 超时重试；仍由官方 CLI 使用 ChatGPT 登录和 Computer Use。

## Not this

- 不能缩短超时并丢弃任务、改用 API key、由主聊天代算或只报测试绿。

## Goal / Hard bar / Improve

- Goal：计算器任务进入实际操作并回传结果。
- Hard bar：GUI 最小环境中不再出现约 96 秒 WebSocket 重试；官方账号仍为 chatgpt；实际界面读到 527。
- Improve：首条模型文字 / 首次工具 / 完成耗时分别记录。

## 验收标准

| # | 标准 | evaluator | 证据 |
|---|---|---|---|
| 1 | 已定位用户这轮停顿 | 机器：质量日志与同轮 Codex 进程日志时间线 | ASR 627 ms，首字 118681 ms；5 次 WebSocket 重试、约 96 s 后 HTTP 回退；另有 brilliant MCP 502 |
| 2 | GUI 环境中使用订阅 HTTP 直接返回 | 机器：最小环境 App Server 探针、检查该进程传输日志 | 通过；探针 6.195 s 首字、6.637 s 完成，account=chatgpt；产品实测确认 responses_http + Chatgpt |
| 3 | 正式 runtime 同句计算器操作并显示 527 | 机器：`check-codex-runtime.mts --gui --reported-command`，首工具 < 45 s、总时长 < 90 s；主代理 AX 回读 | 通过；清空至 0 后，6.240 s 首字、7.983 s 首工具、18.615 s 完成，2 次 CUA；AX 确认 31×17=527。`/tmp/yishu-codex-gui-http-cleared.log` |
| 4 | 协议、取消、构建无新增回归 | 机器：Codex 聚焦测试、runtime check、product:check、签名构建、diff check | 聚焦 6/6，check、签名 build 通过；`/tmp/yishu-codex-stall-{tests,typecheck,build}.log`。product:check 仍为预存 collector 880/856 |
| 5 | 正式安装 App 同入口的等待与结果 | 真机：主代理检查安装与任务结果；人评：用户自然口述体验 | 已安装 pid 71056；启动停在钥匙串授权，主线程采样证实 SecItemCopyMatching；用户完成系统授权后再做真实麦克风重试及口播 |

## 非目标

- 不修改用户全局 Codex 配置，不清理无关插件或 M1 未提交工作。

## 基线与结果

用户这轮松键到首字 118.681 s、口播 139.679 s。CUA 在启动后约 2 s 已就绪；主要时间花在模型 WebSocket 连接超时上。此前终端测试没有覆盖正式 App 的最小环境，放过了传输差异。

## 人评清单

- [ ] 原入口口述计算器任务，等待与反馈是否可接受。
