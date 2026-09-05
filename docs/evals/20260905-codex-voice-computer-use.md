# Codex 接入奕枢屏幕协作：验收卡

- 日期：2026-09-05
- 状态：active
- 上下文：NOTES 的 Codex App Server 烟测；用户要求回到真实项目推进。后续由主代理独立实施。

## 一句话任务

用本机 Codex 的 ChatGPT 登录与官方 Computer Use，执行奕枢发起的电脑操作任务。

## Change

奕枢屏幕协作可选 GPT-6 Astra；任务从原有入口进入，展示真实工具进度，返回模型结果；取消能停止本轮。实时对话保留当前快模型。

## Not this

- 独立 Python 烟测、主聊天代操作、只做 HTML 不算产品接入。
- 不读取 CLI token，不用付费 API 替代订阅，不把工具返回成功自动宣称为产品已验证。

## Goal / Hard bar / Improve

- Goal：正式 runtime 与 App 均能发起 Codex 任务。
- Hard bar：模型真实可用、现有登录可用、工具事件回传、错误不报完成、取消后不继续发新动作、桌面互斥。
- Improve：记录启动到工具开始和结果耗时。

## 验收标准

| # | 标准 | evaluator | 证据 |
|---|---|---|---|
| 1 | JSON-RPC 分片、交错请求、失败和进程退出正确处理 | 机器：`node --import tsx --test test/codex-*.test.ts`（runtime 目录） | 6/6，`/tmp/yishu-codex-focused-final.log` |
| 2 | 真实登录查询和模型选择不读凭据；审批仅当前轮可回、拒绝/取消正确终止 | 机器：Codex 聚焦测试 + App 双端解码测试 | 通过；Swift `/tmp/yishu-codex-swift-accounts.log` TEST SUCCEEDED；正式 App 识别账号并可选 GPT-6 |
| 3 | 与原生动作共用 desktop lease，取消清理进程和待审批 | 机器：Codex 聚焦测试；实机 `check-codex-runtime.mts --cancel` | 通过；真实轮首个工具开始后取消，19 ms 收到取消终态，0 次完成；`/tmp/yishu-codex-real-cancel.log` |
| 4 | 现有快速对话、协议与路由不回归 | 机器：runtime/kernel 相关测试、Swift 相关测试、typecheck | runtime 503/503、kernel 219/219、Swift 聚焦与 typecheck 通过 |
| 5 | 正式 stdio turn.start → GPT-6 → Calculator 实际点击 → 结果事件 | 机器：`pnpm --filter @yishu/runtime exec tsx ../../evals/hands/check-codex-runtime.mts --accept-calculator` | 两次 29 × 13 = 377，64.312 / 51.462 s，均 8 次工具开始；主代理独立截图/AX 回读。原生 0.153.3 日志 `/tmp/yishu-codex-real-native.log` |
| 6 | 签名安装后原有奕枢入口能选 GPT-6、发起并呈现结果 | 真机：主代理串行操作；语音自然度由用户裁 | 已安装 pid 45035，App 内订阅、GPT-6 选择、自动路由已验；真实麦克风发起与口播待用户试用，不算整条语音通过 |
| 7 | 工程门禁与改动卫生 | 机器：product:check、product:build:clicky、git diff --check | 签名 build、diff check 通过；product:check 仍只在预存 collector 880/856 失败，不称全门禁绿 |

## 非目标

- 不替换已有文件拖放实现，不推进尚待人评的 M1 上传验收。
- 不更改本机 Codex 全局配置或安装第二个 App。

## 基线与结果

基线：独立 App Server 已成功，正式 runtime 无客户端，Swift 无 GPT-6。M1 未提交工作保留。

结果：正式 runtime 与正式 App 接线已实现，自动模式下实时交流 MiniMax-M3、屏幕协作 GPT-6 Astra；深任务仍保留原配置。正式 App 界面直接完成配置，未写全局 Codex 配置。完整语音验收仍待用户。

实机发现并修复：GUI PATH 无 Node，npm CLI 包装器退出；改优先使用 ChatGPT.app 自带原生 Codex 0.153.3，并用空环境 + 系统 PATH 验证账号和模型。原账号查询同时等待 xAI，使 ChatGPT 被 10 s 超时一起判失败；改为各 provider 独立请求并单独投影失败，回归测试及真实界面均通过。macOS Settings 原为 EmptyView，本次复用同一个 CompanionManager 的既有控制面板填充。

待扩展：本轮没有验证不可逆业务提交、所有第三方 MCP 交互形式或通用 30 步 M1 剧本；不据此将 M1 标为完成。

## 人评清单

- [ ] 语音发起、进度与结果是否好理解；允许真实审批时是否清楚当前动作。
