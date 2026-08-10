# Screenpipe 对 Yishu 的适配判断

> 核对日期：2026-08-07
> 上游快照：`screenpipe/screenpipe@9c5181998e1d68fb02f54814933b2297e1135f61`

## 结论

Screenpipe 能补 Yishu 的是“过去发生了什么”，不是“现在屏幕上是什么”。它的事件触发截图、Accessibility 树优先/OCR 回退、音频转写、本地 SQLite/FTS 检索，对长时间桌面历史和流程证据有价值。

当前不把 Screenpipe 引入正式产品代码。如果要验证，只做一个隔离、只读、可删除的 sidecar PoC。Screenpipe 不得拥有 Yishu 身份、关系记忆、`ContextTrail`、`MemoryClaim`、Skill 状态或 `TaskTruth`，也不进入点击/执行路径。

## 能力映射

| Screenpipe 能力 | 对 Yishu 的价值 | 边界 |
| --- | --- | --- |
| 事件触发的截图 + AX 树 | 补足当前约 15 秒一次的 metadata trail 盲区 | 只吸收设计思路；不复制当前受限代码 |
| AX 优先、OCR 回退 | 为历史观察提供更完整的文本和来源 | 历史 element/坐标禁止直接执行；动作前必须重采当前 `ContextFrame` |
| SQLite/FTS 和时间过滤检索 | 可作为长时间的外部 evidence archive | 结果必须转成 Yishu-owned typed evidence，携带 source/capturedAt/confidence/expiry |
| 系统音频、转写、说话人 | 可用于会议回溯 | 不替代 Clicky 语音入口/TTS；需单独授权和产品决定 |
| `/elements` / MCP / Pipes / Memories | 可作研究参考 | 不接入。它们会复制 Kernel/Pi/记忆/动作边界，并扩大权限面 |

## 硬门槛

1. **许可证**：当前 main 使用 Screenpipe Commercial License。任何组织最多可免费评估 7 天；商业使用、嵌入、面向客户分发或集成需另行付费许可。官方二进制还受 ToS/订阅约束。旧 MIT 快照仍保持 MIT，但不包含后续的快速演进，也意味着我们自己承担长期 fork 成本。
2. **权限与身份**：Screen Recording、Microphone、System Audio、Accessibility、Input Monitoring 等 TCC 按 bundle/signature 分开。sidecar 不能继承 Clicky 的 bundle identity 或权限。
3. **隐私默认值**：当前桌面端默认开启视觉、会议音频、点击记录和 analytics；键盘/剪贴板 raw rows 默认关闭，但屏幕上的文本仍可被 AX/OCR 收录。轻量 PII 处理不等于原始文本和图像的完整脱敏。
4. **资源未知**：上游同时声称 5–10% CPU、约 600 MB 或 0.5–3 GB RAM、约 5–20 GB/月，不是一致 SLA。必须在 Yishu 目标机器上实测。
5. **接口与供应链**：项目高频发版，包含 Rust/Tauri、本地模型、FFmpeg/Bun 等多种产物。不使用 `latest`，不在未完成 tag/SBOM/hash/第三方许可审计前打包进 Clicky。

## 采用路径

### P0：先做 Yishu-owned 改进

把 Screenpipe 最值得的方法重写到我们的 collector：使用 app switch、window focus、click/typing pause 触发 metadata-only trail sample，保留约 15 秒 idle backstop。不引入 Screenpipe 代码或依赖。

### P1：可选的 7 天 sidecar PoC

只有在用户明确同意安装和权限后才启动：

- 固定 exact tag/SHA，使用独立 data dir、端口和进程；不混入 Clicky 安装包。
- 第一阶段只授 Screen Recording；关闭音频、键盘、剪贴板、云 AI/转写/同步、LAN、analytics，并拒绝浏览器 cookie/Automation/Calendar/Input Monitoring。
- API auth 保持开启；除 `/health` 等窄豁免外，localhost 也必须使用 Bearer，凭据不得写入日志或证据对象。
- 只允许经过 allowlist 的 `GET /search`、`GET /elements?on_screen=true`、`GET /frames/:id/elements`、`GET /frames/:id/context` 和 `/health`；禁止 `/raw_sql`、`/memories`、Pipes、MCP action/export 和所有写入端点。`/elements` 的响应内引用只在当次响应中有效，不得作为长期 action target。
- 默认只读取 text metadata，不把 screenshot/audio bytes 放入 `ContextCapsule`。
- 所有返回项映射为外部证据，`source=screenpipe:<sha>`，保留捕获时间和过期规则。

### PoC 验收/停止条件

- 最近 5 分钟的本地文本查询 p95 低于 1 秒，且来源、时间、应用/窗口完整。
- 被排除应用在搜索与本地数据目录中都是 0 记录。
- 任何历史元素用于动作时，Clicky 必须重采当前 `ContextFrame` 并通过可见 read-back；不允许直接播放历史坐标。
- 暂定资源停止线：平均 CPU 超过 5%、RSS 超过 800 MB，或存储增长超过 500 MB/天即停止常驻方案评估。
- 出现未批准外联、云回退、敏感窗口泄漏、跨目录写入、权限扩大、超配额或 API contract 漂移时立即停止。
- 退出后无残留子进程/监听端口；隔离数据目录可整体移入废纸篓，TCC 只按 Screenpipe 自身 bundle 撤销。

## 官方证据

- [当前 README 与能力/资源声称](https://github.com/screenpipe/screenpipe/blob/9c5181998e1d68fb02f54814933b2297e1135f61/README.md)
- [当前商业许可证](https://github.com/screenpipe/screenpipe/blob/9c5181998e1d68fb02f54814933b2297e1135f61/LICENSE.md)
- [2026-06-10 许可证变更](https://github.com/screenpipe/screenpipe/commit/81e412ff5315dd7f6e270bed1911fadb2de5dc44)
- [事件驱动捕获设计](https://github.com/screenpipe/screenpipe/blob/9c5181998e1d68fb02f54814933b2297e1135f61/docs/EVENT_DRIVEN_CAPTURE_SPEC.md)
- [隐私数据流](https://github.com/screenpipe/screenpipe/blob/9c5181998e1d68fb02f54814933b2297e1135f61/docs/mintlify/docs-mintlify-mig-tmp/privacy-data-flow.mdx)
- [macOS 权限与 bundle/TCC 边界](https://github.com/screenpipe/screenpipe/blob/9c5181998e1d68fb02f54814933b2297e1135f61/docs/mintlify/docs-mintlify-mig-tmp/permissions.mdx)
- [当前录制/隐私/API 默认值](https://github.com/screenpipe/screenpipe/blob/9c5181998e1d68fb02f54814933b2297e1135f61/crates/screenpipe-config/src/recording.rs)
- [当前 API 路由与认证中间件](https://github.com/screenpipe/screenpipe/blob/9c5181998e1d68fb02f54814933b2297e1135f61/crates/screenpipe-engine/src/server.rs)
