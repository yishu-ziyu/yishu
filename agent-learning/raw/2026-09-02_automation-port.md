# Yishu Codex Run Record

> 不可变去敏运行记录。

- Date: 2026-09-02
- Task ID / state file: 20260902-automation-port / runtime/tasks/20260902-automation-port.md
- Commit / Git context: main @ 2bfdfb9（前置：77e3643 会话历史/邮件/语音批）
- Model and tool environment: TraeCode 会话 + node/pnpm/xcodebuild + Computer Use 真 App 实测
- Task: 将 grok-bot 0.18 的 Automation（Routines）体系移植进奕枢，展示层与现有产品结合；用户口径「能搬的直接搬」
- Result: pass
- Verification commands:
  - `cd packages/kernel && pnpm test && pnpm check`（218 通过）
  - `cd packages/runtime && pnpm test && pnpm check`（435 通过）
  - `pnpm product:check` / `pnpm product:verify`（仅预存棘轮违规 quality-observation-collector 880/856，与本任务无关）
  - `./apps/clicky/scripts/run-local.sh build|install|open`
- Test evidence: packages/kernel/test/automation-port.test.ts、packages/runtime/test/automation-scheduler.test.ts
- Visible App evidence location: 真 App 面板「设置→例程」区；~/Documents/Yishu/routines/ 文件账本

## 成功动作

- 范围先对齐再动手：gap 表（已做/部分做/未做）交用户拍板，避免再次「自作主张缩小范围」。
- cron 引擎与 store 行为级直搬（单文件自包含），wake turn 用独立 conversationId + private scope：不 supersede 用户 turn、不进历史账本。
- 重启 rearm 免费获得：nextRunAt 由 lastRunAt 派生，无需额外 pending-wake 账本。
- 结果可见性复用现有通道：scheduler 自带 emit sink 收 response 文本 → automation.run.finished 带 summary → Swift 浮层+TTS。
- 真 App 闭环实测两条路径：写盘例行到点触发（runs.json 记 ok）；UI 新建→立即运行→「上次成功」→删除回空态。
- 顺带修复预存破窗：product-actions 测试遗漏 open_email 期望项。

## 失败动作与根因

- 首版把 routines 方法误追加进文件尾部的 enum（类体早已闭合），Swift 报「no dynamic member」；根因是未核对类边界就追加。修正：移入类体末尾。
- delegate/child-task 路径依赖 active main turn，不能复用为 wake 通道；改独立 turn 后解决。
- Computer Use 点不到系统状态栏（坐标为窗口相对）；改用 AppleScript `click menu bar item 1 of menu bar 2`。
- exactOptionalPropertyTypes 与 contextFrame 必填字段（coordinateSpace/nullable 观察值）导致三轮 tsc 返工。

## 可复现条件

- 参考源码在 /tmp/grok-bot-ref（tmp，可能已清理；结论以本记录与代码为准）。
- 例行存储目录 ~/Documents/Yishu/routines/，agent 与 UI 均可读写（grok-bot 哲学）。
- 调度 tick 15s；wake turn 超时 5min；并发上限 2。

## 候选模式

- 「gap 表 → 用户勾选范围 → 分里程碑验收」对复刻类任务有效，防止范围漂移。
- 后台自发 turn 的三约束：独立 conversationId、private scope、自带 emit sink 收结果。
- 单次任务只给 wiki 增证据，不扩 Skill（本次不晋升，样本不足）。
