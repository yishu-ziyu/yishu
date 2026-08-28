# Yishu Project Instructions

事实以正在跑的 `/Applications/奕枢.app` 和本仓库源码为准。不要写架构文档补叙事，也不要把 wiki / ADR 当产品结构。

## Product invariants

- 用户只看见奕枢。不要第二个身份、第二个 macOS App、第二套 Agent 循环。
- 唯一 App 源码是 `apps/clicky`。磁盘名 `/Applications/奕枢.app`，bundle id `com.yishu.yishu-buddy`，签名和 TCC 不要换。工程目录名 `leanring-buddy` 是历史包袱，不要为了好看改名。
- 入口是语音和光标旁的在场，不是面板里的说明书。
- 上下文是证据：来源、采集时间、把握、过期。截图和凭据不落盘、不进日志。
- 用户鼠标、奕枢指针、后台执行是三条通道，不要抢用户光标。
- 正式循环是 `packages/runtime/src/model-loop/`。`packages/agent-core` 只做实验室。禁止 Kairos 符号回潮。
- 工具成功不是任务完成。没验证可见结果不许说做完。
- 不要把隐藏推理说给用户。不要记录凭据、截图、私人对话。
- 模型会的事不要写死。时钟、截图、工具是证据；口播由模型说。不要为某一句问法硬编码回答。

## Boundaries

- Clicky：在场、语音、权限、TTS、设置、安装、可见验收。
- `YishuContext`：可移植证据协议。
- `packages/kernel`：对话、记忆、规则、动作、任务真相。
- `packages/runtime`：model-tool 循环和版本化协议。
- Always：改用户可见行为就启动真实 App 看浮层；单实例，不要再装一份 Debug Clicky。
- Ask first：换 bundle id、改登录项、删用户记忆文件、停 Teable Grok poller。
- Never：第二个 App；产品路径依赖 `@yishu/agent-core`；Kairos / `forceKairosRouting`；把 mock 验收写成真人能力。

## Commands

```bash
pnpm product:check
pnpm product:verify
./apps/clicky/scripts/run-local.sh
```

`/code-review` 或明确说 review 才跑 Matt 双轴，程序在 `docs/runbooks/code-review.md`。不要自动跑。

Teable Grok poller 字段和领取规则：`docs/runbooks/teable-grok-poller.md`。未经人说「关掉 Loop」不要停它。

## Lessons

- 模型列表写清本机 Grok / ChatGPT / xAI，以及登的是谁。不要「已登录」。
- 菜单栏第一屏：怎么说话。设置、模型目录、登录行不要摊在首页。
- 安装名是奕枢。Clicky 只是源码目录名。
- 后台任务芯片在角落，可拖，做完消失。不要挡在光标中间。
- 长期记忆走 EverOS；用户能看见的只有 `~/Documents/Yishu/记忆.md`。不要先问存在哪。
- 后台查到的结果也由模型说出来，不要为某一句硬编码。
- 不同任务的 Blobatar 脸是任务标记，不是第二个角色。
- 独立非桌面工作可以同一批并行；两次屏幕点击不能并行。
