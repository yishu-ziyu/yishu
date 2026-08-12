# V0 验收：产品内核（@yishu/kernel）

Type: acceptance
Status: historical
As-of: 2026-08-09

## 切片名称

`v0-product-kernel`

## 范围

`packages/kernel` 实现奕枢产品层：`YishuAction` 注册表、`ContextTrail`、`ContextCapsule`、本地证据库（JSON / **SQLite**）、以及默认产品动作（`remember` / `forget` / `remember_how` / `share_context` / `record_learning` / `run_skill`）。

本切片已接线：

- Runtime `ProductKernelRuntime`：每条 `turn.start` 写入 trail；产品话术 short-circuit Pi
- Runtime execution → Kernel `TaskTruth`：首个工具/电脑动作才建任务，verified / unverified / failed / cancelled 分别投影为可信状态
- 协议 `trail.observe`：Clicky 约每 15s 元数据采样（无截图）
- Clicky 启动时默认 `YISHU_PRODUCT_KERNEL=1`、`YISHU_STORE_BACKEND=sqlite`

不替换 Pi，不导入 Agent-Native 运行时。Agent-Native 只作为 Action 设计方法参考。

对照实现：

- [packages/kernel/README.md](../../packages/kernel/README.md)
- [Product kernel](../product-kernel.md)
- [Architecture](../architecture.md)

## 用户可观察路径（包级）

用户不打开 macOS App。在仓库根目录用 `@yishu/kernel` 单测与类型检查验证产品层行为。

1. 安装依赖：`pnpm install`
2. 内核单测：`pnpm --filter @yishu/kernel test`
3. 内核类型检查：`pnpm --filter @yishu/kernel check`
4. 全仓测试（含 kernel）：`pnpm test`

## When X → Y（通过条件）

### 1. voice 调用 remember → 证据化 MemoryClaim

| When | Then |
|------|------|
| `createYishuKernel()` 后 `registry.invoke("remember", { caller: "voice", input: { claim, scope, confidence } })` | `ActionReceipt.status` 为 `verified`（或至少 `ok` 且 verify 通过） |
| 同上 | `receipt.output` 是 `MemoryClaim`，含 `claim`、`source`、`capturedAt`、`scope`、`confidence`、`lastConfirmedAt`、`id` |
| store 侧 `searchMemory` | 能按 claim / scope 找回同一条 |

### 2. remember_how + trail → SkillCandidate；trail-replay 通过才 VerifiedSkill

| When | Then |
|------|------|
| 先向 `trail` 写入若干帧（app / window / AX 元数据，无截图字节） | `trail.size()` > 0 |
| 语音「记住我刚才是怎么做的」经 `routeProductUtterance` / Runtime | 不进 Pi 全量对话；发 `product.action.completed` + 口播 receipt |
| `autoVerify: true` + **trail-replay** 置信度 ≥ 阈值 | `output.skill.status === "verified"`，附 `verifyReport` |
| trail-replay 不足 | 仍保留 `SkillCandidate`，不假冒已验证 Skill；用户仍听到「已记下候选」 |
| trail 窗口内无条目 | invoke 失败（`status: "failed"`），不得伪造成功 |

### 3. share_context → 无 base64 的 capsule JSON

| When | Then |
|------|------|
| `invoke("share_context", { caller: "cli" \| "pi" \| …, input: { userIntent?, projectHint?, recentMinutes? }, contextFrame? })` | `output.capsule` 为 `ContextCapsule`（`schemaVersion: 1`，含 `capsuleId`、`createdAt`、`expiresAt`、`recentTrail`、`provenance.source === "yishu"`） |
| 序列化 `output.json` 或 `serializeContextCapsule` | JSON **不含** `base64Data` / 凭据字段；`parseContextCapsule` 对带禁字段的 JSON 拒绝 |
| 源 frame 带截图 | trail / capsule 只保留 `hasScreenshot` 等元数据，不拷贝像素 |

### 4. high-risk / explicit_approval 未批准 → needs_approval

| When | Then |
|------|------|
| 已注册 `authority: "explicit_approval"` 的动作，且 invoke 时 `approved` 非 `true` | `receipt.status === "needs_approval"`，**不**执行 `run` |
| `risk: "critical"` 且未 `approved: true` | 同样 `needs_approval`（即使 authority 是 `automatic`） |
| 同上动作带 `approved: true` | 允许进入 `run`，receipt 为 `ok` / `verified` |
| `approved: false` | `status === "denied"` |

### 5. ContextTrail 按最近 N 分钟查询

| When | Then |
|------|------|
| `trail.append(frame)` 后 `trail.recentMinutes(N)` 或 `trail.query({ sinceMs: N * 60_000 })` | 只返回保留窗口内、时间落在 N 分钟内的 sanitized 条目 |
| 默认保留 | 约 20 分钟 retention；截图元数据 TTL 约 30s（超时后 `hasScreenshot` 可变为 false） |
| 条目内容 | 无 screenshot 字节；可含 app / window / AX 预览 / cursor 区域 / warnings |

### 6. Runtime execution → durable TaskTruth

| When | Then |
|------|------|
| 普通对话只有 `response.completed`，没有工具/电脑动作 | 不创建 `TaskTruth` |
| Pi / AgentCore 发出首个 `tool.started` 或 `computer.action.requested` | 以 `requestId` 懒创建 `running` 任务 |
| 执行后 `response.completed.verified === true` | Kernel 记为 `done` |
| 执行完成但没有可见/外部结果验证 | Kernel 记为 `blocked`，不得假装完成 |
| 执行失败或用户取消 | 记为 `failed` / `cancelled`；迟到事件不得覆盖终态 |
| 初始化期间先取消，随后 runtime 迟到发工具/完成事件 | 不制造任务；Pi 不再进入 session/prompt |
| 多个不同任务并发写 JSON store | 内存、磁盘、重开后三者均不丢任务；SQLite 同样可重开恢复 |
| 标题或 evidence 含 credential-like 内容 | 落盘前替换为固定隐藏值；不保存 response、tool args、截图或原始输出 |

## 默认产品动作清单

经 `createYishuKernel()` 注册：

| name | 作用 | authority / risk（定义时） |
|------|------|---------------------------|
| `remember` | 写入 MemoryClaim | reversible / low |
| `forget` | 软删除 MemoryClaim | reversible / medium |
| `remember_how` | 从 trail 提取 SkillCandidate，可选 promote | reversible / low |
| `share_context` | 构建 ContextCapsule 交接包 | automatic / low |
| `record_learning` | 写入 Learning（用户纠偏规则） | reversible / low |

Caller 可为：`voice` | `ui` | `initiative` | `mcp` | `cli` | `pi` | `system`。同一 `ActionReceipt` 形状，不因入口分叉。

## 工程通过条件

- `pnpm --filter @yishu/kernel test` 退出码 0
- `pnpm --filter @yishu/kernel check` 退出码 0
- `pnpm test` 不因 kernel 失败
- 不记录原始凭据、不把截图二进制写入 audit / capsule / trail
- 不依赖 Kairos bridge；不 import Agent-Native 包；不改 `packages/runtime` 的 Pi 协议

## 命令清单（验收员逐条跑）

在仓库根目录：

```bash
pnpm install
pnpm --filter @yishu/kernel test
pnpm --filter @yishu/kernel check
pnpm test
```

## 尚未验收（本切片外）

- Clicky 语音把「记住我刚才是怎么做的」接到 `remember_how`
- 把 capsule 真正交给 Pi / Codex / Claude / Cua 会话
- Skill 的电脑重放验证（当前 `autoVerify` 仅为结构性 promote）
- Clicky 中可见的任务列表、暂停/重试 UI，以及跨 request 的 parent/retry 关联
- 主动 initiative 触发与 standing mandate UI

## 2026-08-12 Current delta

这是对历史切片的增量记录，不改写 2026-08-09 的验收事实。当前代码已增加：

- 不可变 `TaskExecutionContract`：目标、成功模式、授权、风险与每 request 一次产品 attempt；真人重试必须发起新 request。
- 通用终态判定：只读任务交付非空结果即为 `completed`；外部改变只有进程内可信 actuator receipt 或 fresh read-back 可成为 `verified`，普通 wire 字段不足以信任。
- Result Inbox 在 SQLite 与 JSON store 中持久化；终态 TaskTruth 与 result 原子写入，Main turn 用 claim 读取，自身终态落盘后才 ack，失败或取消则 release。
- Runtime 重启时，孤立 running 子任务 fail closed 为 failed 并生成 durable result，不自动重试；已完成 Main turn 的 claim 会 ack，非终态 claim 会 release。
- 每个 delegated child 在终态、取消、异常或 dispose 后释放其 Pi session；Desktop action 共享一个进程内、无队列的 token/epoch lease。
- Clicky 有 `task.list` snapshot、`task.cancel.accepted` 确认、真实 typed event 驱动的 `SystemSequence`，以及诚实中断文案。没有 checkpoint 时只允许“从头重试”或“开始新方向”。

仍未验收的是真实用户面：安装后的 Clicky 中 PTT → 思考光点 → TTS、任务卡交互与 `SystemSequence` 布局、真实 App/sidecar 重启后的一次交付、以及签名 / TCC / 登录项 / UserDefaults 连续性。分布式 / 多进程 exactly-once、真正 checkpoint resume、raw-store facade、project UI / conflict / export、skill replay / initiative 也仍在当前切片外。

## 完成定义

上表 When→Y 均可在单测中复现；三条命令通过；文档路径真实：本文件、`docs/product-kernel.md`、`docs/architecture.md`、`README.md` Current boundary、`packages/kernel/README.md`。
