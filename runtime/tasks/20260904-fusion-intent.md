# 三仓库融合：意图对齐与里程碑

> 2026-09-04 15:55 起内容已并入 `docs/NOTES.md`，本文件冻结不再更新。

- Task ID: 20260904-fusion-intent
- Status: migrated → docs/NOTES.md
- Git context: main（协议不要求独立分支）
- Goal: 把奕枢补成「Clicky 的菜单栏语音外壳 + nuphus 的通用电脑操控（鼠标/键盘/窗口/OCR/浏览器）+ grok-bot 的推理路由、MCP、例程与对话界面」，全部 Mac 原生外观。
- Hard bar: 每个里程碑先出验收卡（docs/evals/），机器项全绿、人评项由用户裁决，真 App 跑通才算完。
- Affected product boundary: Clicky / Kernel / Runtime
- Source commit / installed App build: 59f7e9f 起；工作区有未提交的记忆/路由改动（remember.ts、utterance-router.ts、CompanionManager.swift 等），非本任务产生。
- Updated at: 2026-09-04

## 已确认的决定（2026-09-04，用户逐条拍板）

1. 产品一句话：奕枢是 Mac 原生语音伴侣：按住 Control+Option 说话，它看得见屏幕、能真的动手操作电脑和浏览器、能按例程自己干活，用你本机已登录的模型订阅，每步动作留可验证证据。
2. 架构：碰 Mac 的用 Swift（UI、鼠标键盘、窗口、截图、OCR、TCC）；推理、工具调用、记忆、例程留在 TypeScript runtime；grok-bot 控制平面代码搬进 `packages/runtime`。交互层全部 Swift 原生重做。（用户关心的是界面层必须原生且有效；「纯 Swift 砍 Node」未选。）
3. 通用操控放开为一等能力：`ComputerAction` 扩成 nuphus 词汇（坐标点击/双击/右键、拖拽、滚动、按键组合、开 App、窗口挪动缩放、剪贴板、OCR）。AX 编号目标仍是首选定位，坐标是退路。OCR 用 Apple Vision，不移植 Paddle/YOLO。
4. 验证分层：AX 回读优先 → 无 AX 才截图前后比对 → 轮次级结果核对。不用纯截图自评。
5. 安全门「预告即执行」：Blobatar 飞到目标说一句就做；不可逆类（Cmd+Q/W、删除、发送、支付、密码框）等用户说「去」。
6. 浏览器：默认隔离浏览器（Stagehand 扩到 nuphus 23 工具面）；用户明说「用我的浏览器」才走桌面手操作真实 Chrome。
7. MCP：奕枢先做服务端（CLI provider 要用奕枢的手），再做客户端。
8. Provider：Claude Code 走本机 `claude` CLI headless（`-p --output-format stream-json --mcp-config <奕枢 MCP> --permission-prompt-tool`），不读 token、不调 Anthropic API；Claude Code 用自己的手，但许可请求转奕枢的门处理。Codex 走现有 OAuth 路。Cursor 不接。其他 CLI 见到再加，一个适配器一个 provider。CLI provider 只挂「深任务」档。
9. 受众：半年内只有用户自己日用，验收线到 accepted。
10. 旧能力清单（`docs/capabilities/`）冻结不管；新工作只用 docs/evals/ 验收卡。
11. 协作协议：保留 runtime/ + agent-learning/，补 docs/evals/、docs/devlog/，AGENTS.md 加「探索走子代理」「'太慢/不好用'先追问成可观测现象」两条。
12. 分工：用户定价值；主 Agent 写验收卡、派工、核对、亲手写协议/验证契约/安全门、串行真机操作；子 Agent 用 Grok 4.6（探索 high，重实现 xhigh），重任务并行多 builder；子 Agent 不与用户对话、不改验收卡/AGENTS.md/协议文件。
13. 交互层 T1+T2+T3 全做：对话窗（打字+麦克风、流式、思考/工具行可展开、先应答再干活、失焦系统通知）；表情回应、选择卡片、图片、线程、搜索；一个主奕枢 + 可委派/生成/删除的具名帮手 + 群组。
14. 里程碑顺序（2026-09-04 下午改）：M0 像人 → M1 手 → M2 对话窗 → M3 MCP 服务端 + Claude Code + 深任务路由 → M4 记忆重构 + MCP 客户端 + 质感 → M5 帮手。A–J 全修不列债：C/H/I→M0，A/F→M1，E/J→M2，B→M3，G→M4，D→M5。
15. 价值函数：越像贾维斯 / 《Her》越好。翻成可观测：说话中气泡出字；松手→首字 ≤1.0s；松手→首声 ≤1.5s；死寂 ≤0.3s 要有动静；打断→静音 ≤100ms；模型首字超时 8s 有兜底话。
16. 说话规则：先出声再干活，干完可不总结，固定台词清零由模型说，朋友不是客服，长度跟用户，一个人干几件事的口吻。参考 grok-bot `system-prompt.ts:80-152` 与两个 ack 中间件。
17. 光球到达动作全要：描边、下划线、高亮框、连线、编号、敲两下、箭头、看过即隐。需编号控件带位置、POINT 带矩形、覆盖层可画路径。
18. 聊天模型出口用户可选（8317 网关 / 直连），默认按实验结果。事实：`model-config.json` 现在直连 `api.minimaxi.com`，没走网关。
19. 语音供应商：STT/TTS/文本三家不同是现状。TTS 声调与全双工要先做对比实验再定（候选：MiniMax speech-2.8、ElevenLabs v3 Conversational、Boson Higgs TTS 3、阶跃 StepAudio 2.5 TTS；全双工：阶跃 Realtime API，支持 tools）。
20. 记忆：**用足 EverOS**（情节 = 跨会话/跨窗口/跨历史，cases/skills = 奕枢自己的做事经验，反思 = 会话间合并与作废）。`记忆.md` 必须回到唯一真相——假设：让它成为 EverOS 管理的 profile 文件（EverOS 支持直接改文件后自动重索引），需在 M4 验证。召回在按下 PTT 时预取。MotherDuck 三层（上下文层 / 语义层 / 本体）作为坐标：奕枢实体（App/窗口/文件/例程/任务）要进本体，确定性问题走本地 SQL。
21. 语音：M0 只做 A（流式听写 → 文本模型流式 → 流式 TTS）。B/C（阶跃 realtime 模型负责语音输入输出，`ask_yishu` 转交 runtime）实测否决：`tool_choice: required` 下仍 0/6 转交、只转写模式 9/9 抢答、打断检测 946 ms。证据 `evals/voice/results/2026-09-04-exp4-duplex.md`。TTS 候选收窄为 MiniMax speech-2.8 与阶跃 StepAudio 2.5（用户无 ElevenLabs/Boson key；提它们只为说明要句内情绪起伏）。
22. 分工：实验与实现交 Grok xhigh 子代理；主代理只做判断、验收卡、核对。
23. 听写定案：终稿用 Step Plan `stepaudio-2.5-asr` 整段（松手后 0.4–0.7 s）；按住期间每 0.8 s 发累计音频出中间稿（前 10 s，后半段 1.5 s 间隔），平方计费用户已接受。Apple、增量拼接、窗口拼接、realtime 转写全部否决。证据 `evals/voice/results/2026-09-04-exp2-stt.md`。
24. TTS：MiniMax speech-2.8-hd 流式与 StepFun stepaudio-2.5-tts WebSocket 流式首声打平（~670 ms），引擎由用户盲听 `.work/voice-experiments/tts/blind-short/` 决定；产品需保持 TTS 长连接。
25. 全双工体感走 A 轨（用户 2026-09-04 拍板）：免按键连续聆听做成开关放 M0（默认关）；插话沿用现有；停顿哼声用本地预渲染短音。另开临时子代理独立验证 StepFun realtime 工具调用能力（`evals/voice/exp5-stepfun-tools/`），若证明是我们接法问题则重开 B 轨评估。

## 本次推翻的旧条目

| 旧条目 | 出处 | 现状 |
|---|---|---|
| 不同任务的 Blobatar 表情是任务标记，不是第二个角色 | AGENTS.md Lessons | 作废：帮手是独立的具名角色，有自己的头像和侧栏行 |
| 只做可验证语义动作，不猜像素 | `computer-control-tool.ts` 注释、能力清单 | 改为分层验证，坐标是退路 |
| 能力矩阵是唯一能力事实源 | `docs/capabilities/CAPABILITY_MATRIX.md` | 冻结，验收卡取代 |

## Verified facts
- 现仓库对三源的完成度：Clicky 外壳完成；grok-bot 例程完成、路由半成（Codex/xAI）、MCP/交互层缺；nuphus 手约 20%（6 个语义动作）。
- 内核现状白话页：`docs/intent/kernel-walkthrough.md`（含 A–J 十处与新方向相冲的点）。
- 设备评测脚本存在但只 3 个场景，且被 `quality-observation-collector.mjs` 880/856 行红线卡住；已决定冻结旧表。

## Failed paths
- 无。

## Pending external state
- 用户看完 A–J：全修。待定：EverOS 去留、TTS 供应商、全双工是否上（等实验）。
- 语音实验需要的 key：MiniMax（有）、阶跃（有 STT key，realtime 是否同 key 待查）、ElevenLabs（未知）、Boson（未知）。
- Claude Code CLI 版本：`--permission-prompts`/MCP 等待需 v2.1.221+ / v2.1.259+，实施前查本机版本。

## Next action
- M0 卡已 active（15:20）。三个 builder 并行实施，按文件归属切分：M0-A runtime（persona / ack 中间件 / 空文本不判失败 / 首字兜底 / 模型出口与探活 / 台词清零）；M0-B Swift 语音链路（Step Plan ASR、按住中间稿、turn.start 不等截图、presence cue、MiniMax 2.8-hd 流式 TTS + 预取、埋点、Swift 台词清零）；M0-C 评测脚本 `check-latency.mjs` / `probe-models.mjs` + 光球画法（ring/underline/highlight/arrow/badge、AX frame 进 Context Frame）。
- M0-C 已交（15:44）：`evals/voice/check-latency.mjs`（13/13 自测）、`probe-models.mjs`、`OverlayMarks.swift`（ring/underline/highlight/arrow/badge，进框或 8 s 消失）、`NumberedAccessibilityTarget.frame` + `ContextFrame` 同步。待接线：CompanionManager 在光球落点后调 `showMark`/`clearMarks`，POINT 解析带矩形（归第二批，等 M0-B 释放 CompanionManager）。
- 三者回来 → 我核对报告与 `pnpm product:check` → 我亲手做真机安装与 30 轮实测（串行）→ 跑 `check-latency.mjs` 填基线与结果 → 未接线部分（#13 在 CompanionManager 的接线、#16 免按键、#17 哼声）派第二批。
- 还在跑：StepFun realtime 工具调用独立验证（fed675bc）。实验结果全部在 `evals/voice/results/`。

不得写入凭据、截图、私人对话、用户记忆正文或隐藏推理。
