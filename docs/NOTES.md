# NOTES（工作记忆）

压缩后先读这里。头部永远是「当前状态」，每个子任务刚做完就写，不等会话结束。不得写入凭据、截图、私人对话、用户记忆正文。

## 当前状态（2026-09-04 23:00）

- 用户拍：实时档用 **MiniMax-M3 + `thinking.disabled`**。Grok Voice 不接。卡 `docs/evals/20260904-m3-no-think.md`。
- 代码：M3 的 chat completions（对话 / 记忆抽取 / 口播摘录）带 `thinking:{type:disabled}`。本机实时档若仍是 M2.5，启动时迁一次到 M3。要装新包才进真机。
- M3 vs Grok 表：`evals/voice/results/2026-09-04-m3-vs-grok.md`（关思考 609 ms vs Grok 988 ms）。
- 阶跃 realtime 工具纪律不可解。B 轨维持关闭。Grok Voice 不接。

- 新增治理文件（16:40）：`docs/ROADMAP.md`（M0–M5 目标、依赖、硬条、给来干活 Agent 的手册）、`docs/ARCHITECTURE.md`（三层与方向、接缝表、不可越的线、并行切分、门禁、已知坑）、`docs/evals/M1-hands.md`、`M2-conversation-window.md`、`M3-brain.md`、`M4-memory-polish.md`、`M5-helpers.md`（draft，开工时改日期转 active）。领导权：架构与核心判断归主代理，用户定价值。

- 活动任务：**M0 像人**，卡 `docs/evals/20260904-m0-voice.md`（active）。三个 builder 并行，按文件归属切分：A runtime（说话规则 / 先应答提醒 / 空文本不判失败 / 首字兜底 / 模型出口与探活 / 台词清零）、B Swift 语音链路（Step Plan 听写 + 中间稿 / turn.start 不等截图 / presence cue / MiniMax 2.8-hd 流式 TTS + 预取 / 埋点 / Swift 台词清零）、C 评测脚本 + 光球画法（**已交 15:44**）。
- M0-A 已交（15:56）：runtime 446 测试、kernel 218 测试通过。协议新增 `turn.started.receivedAt|baseUrl|chatExit`、`response.delta.firstByte` + `phase:"model.first_byte"`、`response.completed.phase:"model.done"`、`models.probe`→`models.probed`；`chatExit: direct|gateway`；`YISHU_MODEL_FIRST_BYTE_MS` 默认 8000，`YISHU_FAULT=model_stall` 注入；点击结果改为给模型的状态文本，未验证却声称成功的口播被压成空。Swift 侧台词（点好了 / 这一轮没做成 / 等太久了）归 M0-B。
- M0-B 已交（16:01）：Step Plan 增长窗听写（0.8 s / 1.5 s，10 s 停，终稿与中间稿竞速）；`turn.start` 用 key-down 持有帧立即发；presence cue；MiniMax 2.8-hd 流式 TTS 首包播放 + 下一句预取，口播上限 6 句；埋点带 `turnId` + `sinceKeyUpMs`；去掉「好的，我去查查看」，模型轮次不再套「点好了」。回滚开关：`YISHU_ASR_BUFFER=1`、`YISHU_TTS_STREAM=0`、`VoiceTranscriptionProvider=stepfun-legacy`。`CompanionManager.swift` 4429/4607。
- checker（16:07）：runtime 446 / kernel 218 / worker 10 / evals 13 全过，`product:build:clicky` 过，git 卫生过，`product:check` 只撞已知红线；**Swift 测试编译失败**（`StepPlanTranscriptionProvider.swift:236` 元组标签类型不一致，测试宿主未启动）。已派 M0-B 修（改成具名 struct）并重跑 xcodebuild test。#8 台词残留 6 处均为白名单（失败兜底句、本地直点快路径），卡已注明。
- 真机第一次安装（16:15，build 59f7e9f + 未提交 M0 改动）：安装后需退旧实例（run-local.sh 未识别正式包在跑）；起新版时弹钥匙串授权（重签名后 ACL 不匹配，用户手动允许）。用户两轮实测：「在吗」松手→听写 4.2 s、→首字 21.6 s、声音 0.14 s 即停；「星期几」3.1 s / 9.1 s / 1.5 s 有声。根因：① Info.plist `VoiceTranscriptionProvider=stepfun` 仍映射旧缓冲听写，新 Step Plan 提供者未被选中，无中间稿；② runtime 每轮等 EverOS（启动后才起，健康循环 20 s）再发模型请求；③ 短句流式 TTS 首包后 140 ms 停。已派 M0-A 修 ②（召回 300 ms 预算、并行预处理、`recall.done`/`model.request_sent` 埋点、实时档只带光标屏截图）、M0-B 修 ①③。
- M0-B 修复已交（16:32）：`stepfun`/空/未知 → Step Plan 听写（`stepfun-legacy` 回滚）；启动记 `asr.provider`；流式 TTS 首块欠载不再当结束，全部缓冲播完才停；松手终稿独立 URLSession、关 pipelining，不排在中间稿后。259 Swift 测试过。`product:build:clicky` 在打包 kernel/runtime 时报 provenance 变化（M0-A 同时在改 runtime 所致），A 交付后重跑。
- 第二次真机（16:37 装，`asr.provider=stepplan`）：「在吗」听写 2.7 s / 首字 +9.0 s；「星期几」听写 3.4 s / 首字 +8.0 s 撞 8 s 超时 → 「这一轮没做成」。runtime 侧三个时间戳未进 quality.jsonl（Swift 白名单未放行），9 s 归属不明。决定：不看屏幕的话不发截图给模型（按话判，不按路由模式）。已派 M0-A（runtime-timing.jsonl 自记时间、按话决定截图、离线复现 M3 带图 vs 纯文本首字）、M0-B（听写路径埋点找 2–3 s、终稿 50 ms 内发出、兜底句不被「这一轮没做成」覆盖、放行 runtime 事件）。
- M0-A 定位结果（17:01）：**8–9 s 是 M3 在啃截图**。离线复现同一提示：带一张 575 KB JPEG 首个口播 token p50 7.8 s（7.1–14.6）；纯文本 2.6 s（SSE 首字节 1.47 s，之后约 1.1 s 是 M3 的推理段）；runtime 自身开销 139 ms。已改：不看屏幕的话不发截图和编号控件；`runtime-timing.jsonl` 默认开（字段 turnId/name/ms，recall.done+source，prompt.built+imageCount/imageBytes/promptChars，model.request_sent/first_byte/done，slow_await）。459 测试过。
- 由此推出两个待办：① 实时对话档必须切到 M2.5（M3 纯文本首个口播 token 仍 2.6 s，超 1.0 s 目标）——app 现在是「固定模型 M3」模式，装机后改路由配置；② 屏幕协作档 M3 + 575 KB 图 7.8 s，1.8 s 目标达不到，需做图片尺寸 / 质量扫描（1280→960、0.8→0.6）与视觉模型候选，进 M0 卡待办。
- M0-B 定位结果（17:04）：听写多出的 2–3 s 是本机代理每次请求对 StepFun 新开 TLS（connect ≈1.5 s），且经 `/transcribe` 旧路由；已改为直连 `/audio/asr/sse`、预热连接、边收边转、首个 `transcript.text.done` 即返回；1–2 s 的按住其实有中间稿但落在松手后被丢弃，已改为松手后也更新；兜底句不再被「这一轮没做成」覆盖（runtime 把 `first_byte_timeout` 改写成 `runtime_operation_failed` 是原因之一）。新事件 `asr.request_sent`（interim/final, audioMs）、`asr.first_sse`；放行 runtime 四个事件。261 Swift + 11 worker 测试过。
- 第三次安装（17:07，pid 96285）：路由改为 auto——实时对话 MiniMax-M2.5，屏幕协作 / 深任务 MiniMax-M3（`defaults` `clicky.modelRouting.*`）；`model-config.json` 加 `MiniMax-M2.5`，provider 名改「MiniMax 直连」（grok-4.x 三个假条目待 `models.probe` 清理）。
- 第三次真机（17:08）：模型段已好——听写终稿→首声 1.3–1.4 s（含 TTS）。听写终稿仍 2.3–3.2 s：终稿请求松手 14–25 ms 内发出，请求本身慢；0.2 s 误触也要 1.4 s 首包（离线同接口 0.38 s 全回）→ 每请求约 1 s 多固定开销 + 4 个中间稿在飞。用户把听写稿气泡误读为模型复述 → 听写稿要有区别样式。回归：`turn.start`/`model.first_byte` 未进日志；`runtime-timing.jsonl` 未生成。已派 M0-B（proxy [asr] 计时落文件、连接复用/独立池/松手取消中间稿、URLSession 系统代理排除、听写稿样式、恢复事件）与 M0-A（timing 文件为何没写）。
- M0-A（17:18）：timing 写入器 `begin()` 不落行且写错误被吞；已改为收到轮次即写 `turn_received`，失败 stderr 记一次；`recall.done` 带 `source`/`durationMs`（EverOS 挂起时 ≤300 ms 转 visible_only）。461 测试过。
- M0-B（17:32）：听写每请求 1.4 s 固定开销 = **macOS 系统 SOCKS 代理（7897）截走 URLSession→127.0.0.1**；另 Node fetch 从不复用 TLS（keep-alive Agent 未挂上，`text.done` 后还 destroy 套接字）、松手时中间稿与终稿争抢。修：Swift 回环 `connectionProxyDictionary = [:]`，proxy 共享 https.Agent（interim/final 分池）、首字节后不拆连接、松手取消全部中间稿、`proxy-asr.jsonl` 落盘；听写稿气泡 `mic.fill` + 次级灰、不朗读；恢复 `turn.start`/`model.first_byte`/`model.completed`/`context.resolved`。实测终稿：1 s 音频 913 ms，3.5 s 1412 ms（前 2.3–3.2 s）。264 Swift + 11 worker。
- 追加：让所有回环 URLSession（TTS、supervisor、hotwords…）统一走 `YishuLoopbackSession` 排除系统代理（已派）。
- 债：系统代理截回环这一坑要进 ARCHITECTURE「已知的坑」。
- 追加已交（17:36）：`YishuLoopbackSession.make()` 覆盖 TTS 两条、supervisor health、StepFun、Step Plan interim/final。265 Swift。
- 第四次安装（17:39，pid 75601）已起，runtime + 8787 在。
- 第四次真机（17:48）：松手→听写终稿 3.2 s（启动后首句，新连接上游首字节 3185 ms）/ 1.1 s / 0.9 s（复用连接）；终稿→首声 1.0–1.25 s；松手→首声 2.0–2.2 s（首句 4.5 s）。剩：首句冷连接、中间稿松手后仍未真正中止（与终稿抢上游）、runtime 无 HOME 环境变量致 `runtime-timing.jsonl` 未生成、`turn.start`/`model.first_byte` 仍未进日志。已派 M0-B（终稿独占保活连接、中间稿最多 1 个在飞且真正 abort、事件白名单 + 单测）、M0-A（timing 目录用与 `last-turn-error.json` 相同的解析）。
- 第五次安装（18:05，pid 18088）：钥匙串弹窗 3.5 min 后 runtime/proxy 才起。用户实测「在吗在吗」「我今天很累」→ 气泡显示自己的话，TTS 念回自己的话。
- **根因定位（18:30，主代理读日志）**：unified log `route=voice turn=dec243a4e71f … phase=runtime_failed delta_ms=1.9 reason=runtime_error`。`YishuAgentRuntimeClient.startTurn` 在发送前用 Swift 硬编码目录 `YishuConversationModelCatalog.localModels` 校验路由里的每个模型；第三次安装把实时档改成 `MiniMax-M2.5`（runtime `model-config.json` 有，Swift 目录没有）→ 每轮 2 ms 内抛 `unsupportedModel`，**从 v3（17:07）起没有一轮到达 runtime**。v3–v5 三次真机全在测死路；M0-A 两轮修 timing 写入器是在追鬼（文件没生成是因为 turn 从没来）。第二个 bug 放大症状：`presentRuntimeFailure` 用 `overlay.currentStreamingText` 当兜底文案，而 M0-B 把听写稿写进同一字段 → 把用户自己的话当回答显示并朗读。
- 修复（主代理，18:35）：`supportsModel` 对本地 provider 不再做门（模型清单归 runtime，二次真相删除）；`currentStreamingText` 只在 `textKind == .reply` 时返回；catch 里新增 `.unsupportedModel → unsupported_model` 并记 `turn.failed`（`errorCode`）质量事件；目录加 M2.5 供设置面显示。两条单测：`runtimeClientDoesNotGateLocalProviderModels`、`runtimeFailureFallbackNeverReplaysTranscript`。163 过；`selectConversationRequiresIdleTurnsAndPersistsId` / `waitReturnsWithoutScreenCapture…` 各闪失一次（共享 UserDefaults.standard 并行冲突，预存，列债）。第六次安装 18:35，又弹钥匙串。
- 教训（进 wiki）：装机后先让用户说一句，主代理读 `quality.jsonl` 看到 `turn.start`+`model.first_byte` 再让用户继续；`route=voice … runtime_failed` 在 unified log 里从 v3 起一直在，没人读。失败路径不记质量事件 = 评测脚本看不见失败。
- 第六次真机（18:47，pid 58100）：三轮「在吗」都 `turn.start`（松手 +281～452 ms，听写终稿 255～430 ms，中间稿正常）→ **20 ms 后 `turn.failed errorCode=turn_failed`**，气泡「这一轮没做成」。Swift 门已过，这次是 runtime 拒的。
- **第三份真相（18:55，主代理离线复现）**：`protocol.ts` 里 `LOCAL_GROK_MODEL_IDS` zod 枚举（M3 + grok-4.x）校验 `modelRouting` 每个模型 → 装机 runtime 收到 M2.5 直接回 `runtime.error code=invalid_command message="payload.modelRouting: Invalid input"`，没到 `begin()`（所以 `runtime-timing.jsonl` 仍不生成）。复现脚本 `/tmp/yishu-turn-repro.mjs`（起装机 `stdio-server.js`，发一条 fixed_model turn.start）：M2.5 → invalid_command；M3 对照 → `turn.started`。模型清单一共三处：Swift 目录（已删门）、protocol 枚举（本次删）、`model-config.json`（唯一保留）。
- 修复（19:00）：`localModelIdSchema = string 1–80 ^[A-Za-z0-9._:-]+$`（wire 只管形状，清单归 model-config；provider/baseUrl 仍锁死，安全边界没变）；protocol 测试改为「配置里有、picker 没列的 id 必须过；空 / 81 字 / 空格 / URL / `..` 必须拒」，47 过。本地 dist + 真 key 复现「在吗」→ `turn.started model=MiniMax-M2.5` → `response.completed "在的，有什么事？"`（receivedAt→done 2.2 s，其中 recall 327 ms）。`turnFailed` 改带 `code/message`（runtime 的 turn.failed 载荷），`turn.failed` 质量事件现在记真实 code（`invalid_command` / `pi_turn_failed` / `stream_ended_without_terminal_event` / `empty_final_text`）而不是笼统 `turn_failed`；口播仍固定「这一轮没做成」。
- **装机脚本盲区（19:05）**：`run-local.sh` 的 `list_formal_clicky_pids` 用 `ps -ax | grep 奕枢`；在代理 shell 里 `ps -ax` 被沙箱只列自身进程树、且 C locale 下 `ps` 把 UTF-8 名转义成 `M-eM-%M^U…` → 永远找不到正式包 → 装完旧进程继续跑（v7 装完 pid 仍是 58100，runtime 仍是旧 dist）。改用 `pgrep -f "^${FORMAL_APP_EXE}( |$)"`（锚定正式路径，dev 构建不匹配），`self-test` 全过。以后主代理装机后必核 `pgrep -f MacOS/奕枢` 的 pid 变了。
- 第七次安装（19:07，pid 6512，runtime 6702，装机 dist 含修复：`turn-repro` 对装机 dist M2.5 → `turn.started`）。
- 观察：每轮 `recallMs` 301～327 ms，正好撞 300 ms 预算 → 说明 EverOS 召回每轮都在烧满预算再退回 visible_only，是 0.3 s 的串行税，进 M0 待办（预算降到 100 ms 或改并行）。
- **第七次真机（19:37，pid 6512）：全链路第一次通**。三轮：松手→听写终稿 405 / 465 / 510 ms；→`turn.start` 434 / 495 / 533；`turn.start`→`model.first_byte` **2339 / 3506 / 2893 ms**（M2.5 直连，纯文本 79 字提示）；松手→首声 3.3 / 4.4 / 4.2 s。现在的大头是模型段 2.3–3.5 s，远超 exp1 量到的 M2.5 首 token 0.5 s——怀疑 M2.5 先吐 reasoning 内容被过滤、`model.first_byte` 记的是首个可见字；待 M0-A 用真提示量 SSE 首字节 vs 首个可见字节。
- 用户报告（19:38）：两句约 30 字的回答，**每句最后几个字断音**。定位：`YishuChunkedMPEGPlayer` 把「最后一块缓冲的完成回调」当播完 → `play()` 返回 → 播放器释放 → `AudioQueueStop(immediate)` 把还在输出管线里的尾音切掉。AudioQueue 的缓冲回调是「队列读完这块」，不是「扬声器放完」。探针 `/tmp/aq-probe`（同一套 AudioFileStream→AudioQueue 喂 4 KB 块）：2.82 s 的 MP3，最后一个缓冲回调在 **1.61 s**，`IsRunning→0` 在 **3.10 s**——旧逻辑每句切掉约 1.2 s。第五次真机「首声后 140 ms 就停」是同一根因，当时按欠载修（等 parseFinished），治了多块情况没治尾音。
- 修复（19:50，v8 已装 pid 90353，装机脚本这次自己退了旧实例）：解析完成后 `AudioQueueStop(queue, false)`（异步，放完所有已入队缓冲才停），监听 `kAudioQueueProperty_IsRunning` 转 0 才算 drained；停前已 idle 则读属性直接判完；gate 三条单测（缓冲完成不算完、stop 请求前的 running 跳变不算、空流直接完），27 Swift 过。评测口径：`tts.first_audio`→`tts.stopped` 应≈音频时长，不再出现 92 ms 这种比音频短的间隔（v7 第一轮就是）。
- **第八次真机（20:00）**：交互顺畅，尾字齐了，但「天气凉快下来了。」和「你呢」之间有一段死气。定位（主代理离线量，`/tmp/tts-seam/measure.mjs`，生产同参数 speech-2.8-hd + 产品音色）：每句 MP3 尾部带 **600–1460 ms 静音**（同一句两次请求 600 / 1460，不稳定），头部 160–350 ms；三句分开合成，两处接缝光 TTS 自带的静音就 1358 / 1810 ms；整段一次合成尾静音只 407 ms、句内停顿自然。原生音色（female-shaonv / Warm_Girl）尾静音 260–280 ms，speech-2.8-turbo 同音色 364 ms → 长尾主要来自克隆音色。v7 之前的「尾字断」其实是 AudioQueue 切掉 1.2–2 s，正好吃掉大部分静音再咬掉几个字；#20 修好后静音全露出来了。定长裁剪不安全（方差大），必须按 PCM 能量裁 → 卡 #22：解码到 PCM、按 −40 dBFS 裁头尾、同一个 `AVAudioPlayerNode` 连续排程、`dataPlayedBack` 才算完（这也是 AudioQueue 没有的原语）。删 `YishuChunkedMPEGPlayer`。已派 builder（Swift，M0-B 文件）。
- 同一轮模型段：`runtime-timing.jsonl` `model.request_sent 370 → model.first_byte 4149 → model.done 4335`：3117 字纯文本提示，生成只 186 ms，**3.78 s 全在首个可见字之前**；`model.first_byte` 记的是首个可见 delta（`loop-adapter.ts emitVisibleDelta`），不是 SSE 首字节 → 怀疑 M2.5 先吐推理内容。卡 #23：补 `model.sse_first_byte` / `model.first_visible` / `reasoningChars`，离线 10 次，推理段 >1 s 就关推理或换模型。已派 builder（runtime，M0-A 文件）。
- **#22 已交（Swift builder，20:39）+ 主代理补刀（20:50）**：新 `YishuSpeechClipPlayer.swift`（AVAudioEngine + 单个 AVAudioPlayerNode；AudioFileStream→AVAudioConverter 解码到 Float32 PCM；−40 dBFS 裁头≤80 ms / 尾≤200 ms；流式时押后 2.0 s PCM 以便裁尾；`.dataPlayedBack` 才算放完；stop 用 generation 忽略迟到回调）；`ElevenLabsTTSClient` 397→约 260 行，两条播放路径合一；删 `YishuChunkedMPEGPlayer`（432 行）及其测试。主代理补 `onClipDone` 钩子 → `tts.clip_done {durationMs(裁后), playedMs}`，白名单放行。离线探针（/tmp/speech-probe，三句 s1–s3）：裁尾 950 / 1260 / 1020 ms（= 实测尾静音 −200），句间 gap **8–14 ms**，`playedMs/durationMs` 1.008–1.030。
- **顺手抓到一个会崩 app 的 bug（20:47）**：`StepPlanAudioTranscriptionSession.cancel()` 同步 `invalidateAndCancel()` 两个 URLSession，而刚由 `requestFinalTranscript()` 派出的 Task 随后调 `session.bytes(for:)` → `NSGenericException: Task created in a session that has been invalidated`，ObjC 异常不可捕获，进程直接死。测试宿主就是这样崩的（`finalRequestDispatchesWithin50msOfKeyUp` 松手后立刻 cancel 正好复现），并行跑时被误读为「预存 flaky」。真机对应场景：松手后瞬间再按 / Esc / 4 s 兜底触发 cancel。修：`cancel()` 只取消任务，`invalidateAndCancel()` 移到 `deinit`（Task 持有 self，deinit 必在最后一次建任务之后）。串行 Swift 测试 242 + 33 全过，TEST SUCCEEDED（此前「190 过 + TEST FAILED」是宿主中途崩掉重启的计数）。
- v9 第一次安装失败（20:45）：`rmSync('dist')` ENOTEMPTY，runtime builder 当时在用 dist。第二次安装成功（21:11，pid **60883**，runtime 63406，proxy 63416；退了 90353 再退 59345）。二进制含 `YishuSpeechClipPlayer` / `tts.clip_done` / `tts.clip_gap`；装机 dist 含 `sse_first_byte`。钥匙串可能再弹一次。
- **#23 指令实验（runtime builder，20:58）不达标，persona 已还原**。共享 persona 加「思考限一两句」：reasoningChars p50 196→182（**−7%**，门槛 ≥40%）；「在吗」几乎不变（123→118，visible−sse 981→978）；「天气」变差（316→407）。更强末行指令两次 10 轮全失败，当时 `api.minimaxi.com` SSL_ERROR_SYSCALL，不是指令效果。M2.x 不能关思考、没有非推理对话模型可换 → 实时档暂留 M2.5，卡 #23 的「≤1.0 s」本轮达不到（离线 turn_received→可见字 p50 2.25 s）。465 runtime 测试过。
- **promptChars 79→2655 不是泄漏**：history 按 conversationId 隔离；涨的是 personal-scope recent trail（2 分钟、最多 8 条），换 conversationId 仍共享。1→2 的 +623 = 第一条 trail JSON；之后每条观察约 +279；第 9–10 轮顶到 8 条上限。已加分段计量 + 单测。不修。
- 评测脚本（主代理，20:30）：`check-latency.mjs` 新增默认门 #20 `tts.clip_done played≥95%`（每句 `playedMs ≥ 0.95 × durationMs`）与 #22 `tts.clip_gap p95 ≤120`；fixture 重生成（392 行），13 测试过；对 v8 真机日志两项均 FAIL「no event」，等 v9。**待办**：Swift builder 交付后追加 `tts.clip_done {durationMs, playedMs}` 事件（首轮任务书只写了 `tts.clip_gap`）。
- exp4b（Gemini Live 复开 C 轨）**搁置**（20:22）：用户暂时拿不到 Gemini API key。C 轨维持实验 4 的结论（关闭），拿到 key 再派；不阻塞 M0。
- 提交：`b5e858a` 已推 `origin/main`（2026-09-04 21:50）。卡 `docs/evals/20260904-m0-voice.md`。不含 `.dev.vars` / `.work/` / 音频。
- **非思考模型（对照桌面 `AI组件工作流库/docs/llm-service-asset-catalog.md` 2026-09-04 `/models`）**：MiniMax 目录 8 个 ID **全是思考模型**，M2.x 官方不能关；M3 `thinking.disabled` 实测更慢。本机真正标了 non-reasoning 的是 8317 的 `grok-4.20-0309-non-reasoning`；相邻的 `kimi-k2`（对照 `kimi-k2-thinking`）、`step-3.5-flash`、`grok-3-mini` 是「轻量/低延迟」档，未用真提示量过。业界做法是**说话路径换非思考模型**，不是调 prompt 让思考模型少想（我们 −7% 已否）。下一步若换口：先用真 3k 提示对 `grok-4.20-0309-non-reasoning` / `step-3.5-flash` / `kimi-k2` 各 10 轮，sse→可见字，再定实时档。
- **全双工怎么接**：不替换 runtime。Swift 开一条 StepFun/Gemini realtime WebSocket 当嘴和耳朵（PCM 进、`audio.delta` 出，绕过 MiniMax TTS）；需要屏幕/记忆/动手时 `function_call` → 现有 `turn.start` → 把可见回答塞回 `function_call_output`。卡在中文指令不调产品工具（exp5：英文+教科书工具会调，`ask_yishu` 仍 0/6）。Gemini Live 同形状，没 key。A 轨继续扛 M0。
- 债：重签名后钥匙串 ACL 每次弹窗（需固定签名身份或把 ACL 加入本地证书）；`xcodebuild test` 不能与 run-local 共用 derived data（run-local 重签名后 `奕枢.debug.dylib` 签名不匹配，测试宿主 dyld 启动即崩），测试用默认 DerivedData。 → 主代理真机安装 + 30 轮实测（串行） → `node evals/voice/check-latency.mjs --last 30` 填卡「基线」与结果 → 第二批：光球画法接进 CompanionManager、免按键连续聆听（#16）、停顿哼声（#17）。
- 待用户：盲听 `.work/voice-experiments/tts/blind-short/` 16 个文件填 `listening-sheet.md`。
- 提交节奏已定（用户 15:54）：每里程碑机器绿 + 人评过后提交一次，message 引用卡；提交由 shell 子代理执行，主代理只核对。首次提交在 M0 真机实测通过后，届时把今天的方法论文件、实验脚本与结果一并提交（不含 `.dev.vars`、`.work/`）。
- 阻塞：无。
- 工作区有非本任务的未提交改动（remember.ts、utterance-router.ts、CompanionManager.swift 等，59f7e9f 之后），不要 revert。
- 已知预存红线：`evals/capability/device/quality-observation-collector.mjs` 880/856（`product:check` 因此退出 1，不是新问题）。

## 任务：三仓库融合（意图与里程碑，2026-09-04）

Goal：把奕枢补成「Clicky 的菜单栏语音外壳 + nuphus 的通用电脑操控（鼠标/键盘/窗口/OCR/浏览器）+ grok-bot 的推理路由、MCP、例程与对话界面」，全部 Mac 原生外观。
Hard bar：每个里程碑先出验收卡，机器项全绿、人评项用户裁决，真 App 跑通才算完。
边界：Clicky / Kernel / Runtime。

### 已确认的决定（用户逐条拍板）

1. 产品一句话：奕枢是 Mac 原生语音伴侣：按住 Control+Option 说话，它看得见屏幕、能真的动手操作电脑和浏览器、能按例程自己干活，用你本机已登录的模型订阅，每步动作留可验证证据。
2. 架构：碰 Mac 的用 Swift（UI、鼠标键盘、窗口、截图、OCR、TCC）；推理、工具调用、记忆、例程留在 TypeScript runtime；grok-bot 控制平面代码搬进 `packages/runtime`。交互层全部 Swift 原生重做。「纯 Swift 砍 Node」未选。
3. 通用操控放开为一等能力：`ComputerAction` 扩成 nuphus 词汇（坐标点击/双击/右键、拖拽、滚动、按键组合、开 App、窗口挪动缩放、剪贴板、OCR）。AX 编号目标首选，坐标是退路。OCR 用 Apple Vision。
4. 验证分层：AX 回读优先 → 无 AX 才截图前后比对 → 轮次级结果核对。
5. 安全门「预告即执行」：Blobatar 飞到目标说一句就做；不可逆类（Cmd+Q/W、删除、发送、支付、密码框）等用户说「去」。
6. 浏览器：默认隔离浏览器（Stagehand 扩到 nuphus 23 工具面）；用户明说「用我的浏览器」才走桌面操控真实 Chrome。
7. MCP：先服务端（CLI provider 要用奕枢的操控能力），再客户端。
8. Provider：Claude Code 走本机 `claude` CLI headless（`-p --output-format stream-json --mcp-config <奕枢 MCP> --permission-prompt-tool`），不读 token；Claude Code 用自己的工具，许可请求转奕枢的门。Codex 走现有 OAuth。Cursor 不接。CLI provider 只挂「深任务」档。
9. 受众：半年内只有用户自己，验收线 accepted。
10. 旧能力清单 `docs/capabilities/` 冻结；能力事实以验收卡为准。
11. 协作机制：见 `docs/METHODOLOGY.md`；五件套 AGENTS.md / docs/evals / docs/NOTES.md / docs/devlog / 现象即信号。
12. 分工：用户定价值；主代理写卡、派工、核对、亲手写协议 / 验证契约 / 安全门、串行真机操作；子代理 Grok 4.6（探索 high、实现 xhigh），重任务并行多 builder；子代理不与用户对话、不改卡 / AGENTS.md / 协议文件。
13. 交互层 T1+T2+T3 全做：对话窗（打字 + 麦克风、流式、思考 / 工具行可展开、先应答再干活、失焦系统通知）；表情回应、选择卡片、图片、线程、搜索；一个主奕枢 + 可委派 / 生成 / 删除的具名帮手 + 群组。
14. 里程碑：M0 像人 → M1 通用操控 → M2 对话窗 → M3 MCP 服务端 + Claude Code + 深任务路由 → M4 记忆重构 + MCP 客户端 + 质感 → M5 帮手。内核页 A–J 十处相冲全修：C/H/I→M0，A/F→M1，E/J→M2，B→M3，G→M4，D→M5。
15. 价值函数：越像《Her》越好，全部翻成可观测数字（见 M0 卡）。
16. 说话规则：先出声再干活，干完可不总结，固定台词清零由模型说，朋友不是客服，长度跟用户，一个人干几件事的口吻。参考 grok-bot `system-prompt.ts:80-152` 与两个 ack 中间件。
17. 光球到达动作全要：描边、下划线、高亮框、连线、编号、敲两下、箭头、看过即隐。
18. 聊天模型出口：实时对话档直连；网关（CLIProxyAPI 8317，鉴权 `~/.cli-proxy-api/config.yaml` `api-keys[0]`，上游 xai/codex/antigravity/kimi，经 socks5 7897）首字 3.6–113 s，只作深任务可选出口。
19. 模型定案：MiniMax 直连，不再比供应商。实时对话档 MiniMax-M3 + `thinking.disabled`（2026-09-04 22:52 用户拍；在吗可见字 p50 609 ms）。屏幕协作 / 深任务档仍 MiniMax-M3，同一把请求也关思考。网关不作语音默认。
20. 记忆：用足 EverOS（情节、cases/skills、反思）。`记忆.md` 必须回到唯一真相——假设：让它成为 EverOS 管理的 profile 文件，M4 验证。召回在按下 PTT 时预取。MotherDuck 三层（上下文层 / 语义层 / 本体）作坐标：奕枢实体（App / 窗口 / 文件 / 例程 / 任务）进本体，确定性问题走本地 SQL。
21. 语音架构：只做 A 轨（流式听写 → 文本模型流式 → 流式 TTS）。B 轨（StepFun realtime 负责语音输入输出，`ask_yishu` 转交 runtime）四轮实测否决：中文指令 0/12、英文指令 0/6、具体工具名 0/6、文字对照 0/1；`get_weather` 教科书工具能调、产品语义工具不调；会编造记忆。重开条件：新的会调工具的实时模型；`evals/voice/exp4-duplex/run.mjs --concrete-tools` 一条命令复测。
22. 听写定案：终稿 Step Plan `stepaudio-2.5-asr` 整段（松手后 0.4–0.7 s）；按住期间每 0.8 s 发累计音频出中间稿（前 10 s，5 s 后 1.5 s 间隔），平方计费用户已接受。Apple（CER 0.09–0.55）、增量拼接、窗口拼接、realtime 转写否决。
23. TTS：MiniMax speech-2.8-hd 流式 676 ms 与 StepFun stepaudio-2.5-tts WebSocket 664 ms 首声打平；引擎由用户盲听定；产品保持 TTS 长连接（省约 470 ms）。MiniMax 情绪：参数 happy/sad/calm/fluent + 标签 `(laughs)` `(sighs)` `(breath)`；StepFun 每句 `instruction` 自然语言语气指令实测生效。
24. 全双工体感由 A 轨实现：免按键连续聆听开关（默认关，M0 #16）、插话沿用、停顿哼声本地短音（M0 #17）。
25. StepFun 套餐是 Step Plan：所有接口走 `https://api.stepfun.com/step_plan/v1/...`；Step Plan 下听写只有 HTTP+SSE，无 WebSocket 流式听写。key 在 `apps/clicky/worker/.dev.vars` 的 `STEPFUN_STEP_PLAN_API_KEY`（与旧 `STEPFUN_API_KEY` 不同把），用户已在聊天里贴过，建议轮换。

### 推翻的旧条目

| 旧条目 | 出处 | 现状 |
|---|---|---|
| 不同任务的 Blobatar 表情是任务标记，不是第二个角色 | 旧 AGENTS.md Lessons | 作废：帮手是独立具名角色 |
| 只做可验证语义动作，不猜像素 | `computer-control-tool.ts`、旧能力清单 | 分层验证，坐标是退路 |
| 能力矩阵是唯一能力事实源 | `docs/capabilities/CAPABILITY_MATRIX.md` | 冻结，验收卡取代 |
| 「StepFun realtime 完全不支持工具」（当天早先的判断） | 本文件 | 更正：教科书工具会调，产品语义工具不调 |
| 「M3 关思考不降首字」；实时档必须 M2.5 | 本文件 19；exp1 短提示 | 真 persona：M3 默认 `<think>` 后 3502 ms；关思考 609 ms。用户改实时档为 M3 关思考 |

### 证据位置

- 内核现状白话页：`docs/intent/kernel-walkthrough.md`。
- 实验结果：`evals/voice/results/2026-09-04-exp1-gateway-vs-direct.md`（模型出口）、`exp2-stt.md`（听写）、`exp3-tts.md`（TTS）、`exp4-duplex.md`（全双工）、`evals/voice/exp5-stepfun-tools/results.md`（工具调用能力）。音频与盲听文件在 `.work/voice-experiments/`（gitignored）。
- 三源完成度：Clicky 外壳完成；grok-bot 例程完成、路由半成、MCP / 交互层缺；nuphus 操控约 20%（6 个语义动作）。

### 未决

- Claude Code CLI 版本：`--permission-prompts` / MCP 等待需 v2.1.221+ / v2.1.259+，M3 前查本机版本。
- EverOS profile 文件能否直接作为 `~/Documents/Yishu/记忆.md`（M4 验证）。

## 任务：Automation 移植（complete，2026-09-02）

历史记录在 `runtime/tasks/20260902-automation-port.md`，运行记录 `agent-learning/raw/2026-09-02_automation-port.md`。后续：模型驱动例程管理工具、本地事件触发器（未排期）。
