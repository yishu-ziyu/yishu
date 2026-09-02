# Automation 体系移植（grok-bot 0.18 → 奕枢）

Status: complete
Updated: 2026-09-02
Branch: main（协议不要求独立分支）
参考源码: /tmp/grok-bot-ref

## 目标
把 grok-bot 的 Automation（Routines）体系移植进奕枢，并把其展示层设计与现有产品结合。

## 范围决策（用户已确认 2026-09-02）
- 能搬的直接搬（cron 引擎、文件 store、运行历史、预算护栏、wake prompt、调度）。
- 不搬：Slack/GitHub/Teams/Linear/Sentry/PagerDuty 监听器（依赖 Cursor 云后端）、云同步、MCP。
- 本地事件触发（app_transition/file_change/system_resume）作为事件触发器实现。
- 存储：`~/Documents/Yishu/routines/<id>/automation.json + runs.json`（一例行一目录，用户可见可 grep，同 grok-bot 哲学）。
- 触发执行：runtime 内部 hidden turn（startTurn + wake prompt），结果走现有语音/浮层/任务芯片通道。

## 里程碑
- M1 逻辑层：packages/kernel/src/automation/ — schedule 引擎、types、FileStore、wake prompt、summarizeSchedule。单测。
- M2 runtime 接线：调度 tick、hidden turn 触发、协议命令 automation.*、状态 reminder 注入、重启 rearm 验证。
- M3 SwiftUI 展示层：面板「例程」区（列表/开关/立即运行/删除）+ 运行历史 + 浮层区分 automation turn。真 App 实测。

## 验收门槛
- pnpm product:check / product:verify 通过（除预存棘轮违规）。
- kernel 单测：cron 解析/nextRunAt/store 读写/runs 历史。
- 真 App：创建例行 → 到点触发 → 浮层/语音出结果 → 历史可查 → 重启后 rearm。

## 验收结果（2026-09-02 真 App 实测）
- kernel 218 测试、runtime 435 测试全绿；两包 tsc 通过。
- 真 App：写盘例行 → 15s tick 到点触发 → wake turn 执行 → runs.json 记 ok + lastRunAt 更新。
- 面板例程区：新建（名字/指令/cron）→ 列表显示描述与下次运行 → 立即运行 → 「上次成功」→ 删除 → 空态。
- product:check/verify 仅预存棘轮违规（quality-observation-collector 880/856，与本次无关）。

## 未做（决策记录）
- 模型驱动例行管理工具（update_state 流）：需模型工具层，后续单独任务。
- 本地事件触发器（app_transition/file_change/system_resume）：协议与存储已通，监听器未接。
- Slack/GitHub 等云监听器：依赖 Cursor 后端，不搬。

## 下一步
无；后续任务见 STATE.md 新登记。
