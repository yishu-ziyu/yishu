# Yishu Project Instructions

以不损失决策相关信息为边界，删除所有不改变用户判断、行动、风险或验证结果的文字。

## Commands

```bash
pnpm product:check
pnpm product:verify
./apps/clicky/scripts/run-local.sh
```

`/code-review` 或明确说 review 才跑 Matt 双轴，程序在 `docs/runbooks/code-review.md`。不要自动跑。

## Lessons

- 模型列表写清本机 Grok / ChatGPT / xAI，以及登的是谁。不要「已登录」。
- 菜单栏第一屏：怎么说话。设置、模型目录、登录行不要摊在首页。
- 安装名是奕枢。Clicky 只是源码目录名。
- 后台任务芯片在角落，可拖，做完消失。不要挡在光标中间。
- 长期记忆走 EverOS；用户能看见的只有 `~/Documents/Yishu/记忆.md`。不要先问存在哪。
- 后台查到的结果也由模型说出来，不要为某一句硬编码。
- 不同任务的 Blobatar 脸是任务标记，不是第二个角色。
- 独立非桌面工作可以同一批并行；两次屏幕点击不能并行。

## Codex 长任务上下文与 Skill 演进

本节只管理 Codex 开发过程，不属于奕枢产品记忆，也不得写入 EverOS 用户记忆。

这套协议本身不要求创建独立分支；沿用当前 checkout，只有用户明确要求时才切换或新建分支。

1. 每个新会话在规划前先读 `runtime/STATE.md`。若用户意图命中其中的活动任务，再读对应的 `runtime/tasks/<task-id>.md`；不要把聊天记忆当恢复依据。新长任务按 `runtime/tasks/TEMPLATE.md` 建独立状态文件并登记，不能覆盖其他会话的任务。
2. 每个里程碑结束、上下文压缩、交接或退出前，更新任务文件及索引中的状态、更新时间和下一步。只保存恢复所需的事实、改动、失败路径和证据位置。
3. 重要任务结束后，按 `agent-learning/raw/TEMPLATE.md` 新建去敏运行记录，并把索引状态改为 `complete`。单次任务可以给 `agent-learning/wiki.md` 增加证据，不得据此直接扩大本文件或创建 Skill。
4. Skill 变更必须作为单独任务：至少比较 4 份相关运行记录，兼看成功与失败；一次只改一个 Skill；运行固定验证集、`pnpm product:check`、`pnpm product:verify`，涉及可见行为时还要检查真实奕枢 App。只有主指标提高且产品门槛不退化才接受，否则回滚并记录拒绝原因。
5. 通过验证的 Skill 才进入 `.agents/skills/<skill-name>/SKILL.md`。更换模型、macOS/App 构建、工具或交互预算后重新验证。

状态与学习记录不得保存凭据、截图、私人对话、用户记忆正文或隐藏推理；只记录去敏事实和证据位置。
