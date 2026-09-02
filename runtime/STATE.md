# Yishu Codex Runtime State Index

> Codex 开发任务的跨会话索引，不是奕枢产品 Runtime 或用户记忆。新会话先读本页，再打开匹配的任务文件。

| Task ID | State file | Status | Git context | Updated at | Next action |
|---|---|---|---|---|---|

## 启动与写回

1. `active` / `blocked` 且与用户意图匹配：读取对应任务文件后继续。
2. 多个任务都可能匹配：先确认，不覆盖任何状态。
3. 新长任务：复制 `runtime/tasks/TEMPLATE.md` 为 `runtime/tasks/YYYYMMDD-short-slug.md`，再登记一行。
4. 里程碑、压缩、交接或退出前：先更新任务文件，再更新本表。
5. 完成后标为 `complete`，生成不可变去敏运行记录；旧任务文件保留。

不得写入凭据、截图、私人对话、用户记忆正文或隐藏推理。
