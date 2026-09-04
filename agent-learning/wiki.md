# Yishu Codex Experience Wiki

这里保存 Codex 开发过程跨任务成立的模式，不是奕枢产品 Memory，也不改变 Kernel / EverOS 的记忆权威。

## Pattern index

| ID | 问题 | 根因 | 已验证处理 | Run records |
|---|---|---|---|---|
| P-001 | 复刻类任务范围漂移（「吸收」代替「复刻」） | 未先对齐范围就动手 | gap 表交用户勾选 → 分里程碑真 App 验收 | 2026-09-02_automation-port |
| P-002 | 后台自发 turn 干扰用户对话 | 共用 conversationId 触发 supersede/进历史 | 独立 conversationId + private scope + 自带 emit sink 收结果 | 2026-09-02_automation-port |
| P-003 | 子代理在调研阶段无产出即中止（一天 4 例） | 大量 WebFetch/WebSearch 与 npm view 拉文档，长时间无文件产出 | 给本地文档路径、禁网、前 5 步内写脚本开跑、每请求限时；同任务重派后 25 分钟交付 | 2026-09-04 语音实验（待写 raw 记录） |
| P-004 | 供应商 402 被当成「没额度 / 不支持」 | 打的是开放平台 `/v1` 路径，用户套餐在 `/step_plan/v1` | 先确认套餐路径前缀再判额度；把路径写进 .dev.vars 的 BASE 变量 | 2026-09-04 语音实验 |
| P-005 | 实时模型「不调工具」判断过早 | 中文指令 / 抽象工具名下 0 调用，教科书工具英文指令下能调 | 用 `get_weather` 类教科书工具先做能力探针，再测产品工具；两者结论分开写 | 2026-09-04 exp4/exp5 |
| P-006 | 装机后直接让用户跑长清单，三版都在测死路 | Swift 复制了 runtime 的模型清单，配置改了一边，`startTurn` 2 ms 内抛 `unsupportedModel`，只写 unified log，quality.jsonl 无失败事件；症状被兜底文案（把听写稿念回去）掩盖 | 装机后先让用户说一句，主代理读 `quality.jsonl` 见 `turn.start`+`model.first_byte` 才放行下一步；失败路径必须记质量事件；同一份配置只允许一处真相 | 2026-09-04 M0 v3–v5 |
| P-007 | 删掉一份副本就宣布「单一真相」 | 同一清单其实有三份（Swift 目录、protocol zod 枚举、model-config.json），删了一份后第二份在 runtime 入口 20 ms 拒掉 `MiniMax-M2.5`，症状从「Swift 抛错」变成「runtime 回 invalid_command」，口播文案一样 | 声称「单一真相」前 grep 整个仓库找同名字面量（`grep -rn "MiniMax-M3"`），每一处副本要么删、要么改成引用；错误载荷 `code/message` 必须一路带进质量事件，否则每换一层失败都要重新离线复现 | 2026-09-04 M0 v6 |
| P-008 | 装机脚本报 Done 就当新版在跑 | `ps -ax \| grep 奕枢` 在代理 shell 里被沙箱 + C locale 转义，找不到正式包，旧进程装完继续跑，接下来的真机测试全测的旧二进制 | 装机后核 `pgrep -f MacOS/<app>` 的 pid 与装前不同、runtime 子进程也换了；进程发现用 `pgrep -f` 锚定完整路径，不用 `ps \| grep` | 2026-09-04 M0 v7 |
| P-009 | `URLSession.invalidateAndCancel()` 放在 `cancel()` 里，测试宿主「随机」崩、真机松手后再按会杀进程 | 已过取消检查的 Swift Task 随后调 `session.bytes/data(for:)`，URLSession 抛不可捕获的 ObjC `NSGenericException` | `cancel()` 只取消任务（`getAllTasks { cancel }` + `Task.cancel`）；`invalidateAndCancel()` 只放 `deinit`（Task 持有 self 时 deinit 必在最后一次建任务之后） | 2026-09-04 M0 v9 |

## Skill impact

| 日期 | 目标 Skill | 原子修改 | 固定验证集前 → 后 | 决定 | 原因 |
|---|---|---|---|---|---|

## Rejected proposals

记录被拒绝的 diff 摘要、退化指标和适用环境，避免重复试错。

## 晋升门槛

- 至少 4 份相关运行记录，并同时包含成功与失败。
- 写清问题、根因、动作协议、适用与不适用条件。
- 一次只 create 或 patch 一个 Skill。
- 在目标模型、macOS/App 构建和工具环境运行固定验证集、`pnpm product:check`、`pnpm product:verify`；可见行为检查真实 App。
- 未提高主指标或造成产品门槛退化时回滚 Skill；Wiki 与拒绝记录保留。
