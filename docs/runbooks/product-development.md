# 产品开发手册

Type: runbook
Status: current
Verified: 34c0eaa 2026-08-15
Review: 产品不变量、验证拓扑或子系统边界变化时

面向在本仓库做产品开发的工程师。回答"我要改 X 应该动哪里、跑什么、怎么算完成"。结构导览见 [Code Wiki](../wiki/README.md)，决策依据见 [ADR](../decisions/)；本手册不重复其内容，只给操作路径。

## 0. 三条铁律（违反即返工）

1. **一个身份**：用户只看到奕枢。不新建第二个产品身份 / App / Agent 循环。→ [ADR 0001](../decisions/0001-yishu-single-identity.md)、[0012](../decisions/0012-single-macos-app-source.md)、[0014](../decisions/0014-own-model-tool-loop.md)
2. **一条任务真相**：任务状态只来自 typed `AgentRuntime` 事件经 Kernel `TaskTruth` 投影；工具成功 ≠ 任务完成；外部效果必须 read-back 验证。
3. **证据即证据**：context 项带 source/capturedAt/confidence/expiry；截图字节与凭据永不落盘/入日志（ledger-safety fail-closed）。→ [ADR 0006](../decisions/0006-context-is-evidence.md)

禁区（边界守卫强制）：`apps/macos`、第二 executableTarget、`@yishu/agent-core` 进产品路径、Kairos 符号复活。

## 1. 环境与命令

环境：macOS 14+ / Xcode 16+ / Node ≥22.19 / pnpm 10。完整命令语义见 [wiki 09](../wiki/09-build-and-run.md) 与 [verification runbook](./verification.md)。

```bash
pnpm install
pnpm product:check        # 日常内环：边界守卫 + kernel/runtime check+test + swift test
pnpm product:verify       # 发版前：+ Clicky Xcode 测试 + 构建脚本 self-test
./apps/clicky/scripts/run-local.sh   # 构建安装启动真实产品
```

**验收纪律**：build 通过 ≠ 产品验收。用户可见变更必须启动真实 App 检查真实 floating presence；统一核心变更必须确认用户行为走 `Clicky → 协议 → Kernel → 执行 → verified receipt → presence` 全链。

## 2. 改动定位矩阵

| 你要改什么 | 动哪里 | 必跑 | 额外验收 |
|---|---|---|---|
| 人格 / system prompt | `packages/runtime/src/persona.ts` | `pnpm --filter @yishu/runtime test` | 真机听一轮回复语气 |
| prompt 装配（历史/记忆/trail 注入） | `packages/runtime/src/context-prompt.ts` + `product-kernel-runtime.ts` | runtime test | 真机冷启动会话连续性 |
| 模型循环（steer/abort/流式/工具执行） | `packages/runtime/src/model-loop/`（引擎）、`loop-adapter.ts`（接线） | runtime test（239 契约测试） | 真机打断/续话一轮 |
| 模型通道（新 provider / 端点） | `model-loop/provider-runtime.ts` + `oauth.ts` + worker 白名单（若走 8787） | runtime test | 真机登录 + 真实 turn |
| 新产品动作（记住/提醒类） | kernel `actions/` + `utterance-router.ts` + Clicky 话术镜像 | `pnpm --filter @yishu/kernel test` | 真机说一句话走通 + read-back |
| 存储 schema | kernel `store/sqlite-store.ts`（additive 迁移 + user_version） | kernel test（含 sqlite-store） | 旧库启动迁移不丢数据 |
| 桌面动作执行 | Clicky `YishuComputerUseActuator.swift` | Clicky Xcode 测试（product:verify） | 真机可见效果 + receipt verified |
| 语音链路（ASR/TTS/PTT） | Clicky `Buddy*` / `YishuSentenceSpeechPipeline` | Clicky 测试 | 真机 PTT 一轮 |
| worker 代理 | `apps/clicky/worker/local-server.mjs` | worker `pnpm test`（在 worker 目录） | 8787 /health + 对应路由 |
| 记忆层 | 见 §5 | kernel + runtime test | 见记忆验收清单 |

## 3. 子系统边界速查

- **model-loop（自有引擎，ADR 0014）**：会话引擎 + provider 注册表（OAuth-only）+ 双通道（openai-completions / codex-responses）。引擎不知道产品语义（记忆/动作/任务），产品上下文经 adapter 的 grounded prompt 进入。**不要**在引擎内 import `@yishu/kernel`。
- **loop-adapter**：generation 仲裁（`PiTurnGenerationState`）、会话缓存（key 含 profile/provider/model/scope/conversation）、工具 fence。引擎/线协议细节封在此文件内。
- **kernel（ADR 0011/0013）**：turn 之上的产品真相。新能力一律经 `defineYishuAction` + 一个 typed 执行端口进入。
- **Clicky（ADR 0012）**：唯一 App。Swift 侧话术路由是 kernel router 的镜像，改 kernel router 时同步检查 `YishuProductUtteranceRouter.swift`。
- **agent-core**：独立实验室，禁止接入产品路径（ADR 0011）。成熟算法按"独立算法"逐项迁入 kernel/runtime。

## 4. Playbook：新增一个产品动作

1. kernel `src/actions/<name>.ts`：`defineYishuAction`（inputSchema zod / authority / risk / markCommitted 边界 / 可选 verify）。
2. `actions/index.ts` 导出 + `kernel.ts` 注册固定顺序。
3. 若语音触发：`utterance-router.ts` 加高精度模式（宁缺勿滥，不命中落引擎）；`formatProductActionSpeech` 补播报文案。
4. 若需 macOS 执行：kernel `action/types.ts` 定义窄 Request/Executor 接口 → Clicky 实现 executor → 经 `computer.action.*` 通道回 receipt。
5. Clicky 侧镜像路由（若第 3 步有）+ 测试（kernel 契约 + Clicky 行为）。
6. 验收：真机一句话走通；不可逆动作确认 needs_approval/显式触发；取消路径报 `cancelled_after_commit` 而非静默。

## 5. 记忆层开发指引（ADR 0013）

存储骨干：episodes/facts/profile/skills = **Markdown 真相层**（`~/Library/Application Support/Yishu/Memory/<scope>/`）；账本/TaskTruth/队列/索引 = SQLite。写入流：显式"记住"热路径（已有）+ 普通对话 turn 终态自动提取（candidate → 敏感 fail-closed + scope 校验 → active）。整理：Reflection（簇合并 + supersedes，后台数据加工）。检索：token → +向量 → +rerank 渐进，经 worker 代理。

边界：private scope 提取前拒绝；秘密只在 worker/Pi 凭据存储；profile 可覆盖、episodes 恒 append。

注入拓扑（system vs prompt 装配 vs 末尾状态栏）与实施顺序见 [agent-book-product-alignment.md](../research/agent-book-product-alignment.md) 对齐清单——动手前先读，与本手册冲突时以对齐清单为准。

验收清单（不降标）：重启后正确 scope 回忆 + 显示来源；北京→上海版本链（新答用上海、历史可解释）；跨项目隔离；private 不读不写；删除源对话后派生记忆不可召回；secret 拒入。

## 6. 文档纪律

- 新知识入库先过**入库四问**（类型？唯一事实源？何时失效？失效如何被发现？）。
- 架构决策 → 新 ADR（顺号，只能被新 ADR supersede）；操作程序 → runbooks；实验记录 → research（historical，写入即冻结）。
- defer 决策即登记 [debt](../debt/technical-debt.md)，修复 PR 同时删条目。
- Wiki（`docs/wiki/`）随模块结构变化同步修订（各篇头部 Review 条件）。
- 敏感信息（凭据/截图载荷/私人对话）不入任何文档、日志、事件。

## 7. 提交前自查

```bash
pnpm product:check          # 必绿
git grep -n "pi-coding-agent" -- packages apps   # 应无结果
pnpm product:boundaries     # 边界守卫单跑
```

用户可见改动：真机走一轮完整语音 turn（PTT → 回复 → 打断 → 桌面动作 read-back）后再说完成。
