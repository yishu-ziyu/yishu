# 09 构建与运行

Type: wiki
Status: current
Verified: 34c0eaa 2026-08-15
Review: 脚本或验证流程变化时

## 环境要求

- macOS 14.0+（arm64）
- Xcode 16+
- Node.js ≥ 22.19
- pnpm 10（`corepack enable` 即可，版本由 `packageManager` 固定）

无 `.env`、无外部数据库；SQLite 是内置 `node:sqlite`。

## 命令速查

### 日常验证（根 package.json）

| 命令 | 作用 |
|------|------|
| `pnpm install` | 安装依赖 |
| `pnpm product:check` | **日常内环**：边界守卫 + kernel/runtime check+test + `swift test`（无凭据要求） |
| `pnpm product:verify` | 再加正式 Clicky Xcode 测试 + 构建脚本无副作用 self-test（不安装、不启动 App） |
| `pnpm product:boundaries` | 仅运行边界守卫 |
| `pnpm product:build:clicky` | 构建正式 Clicky（不安装、不启动） |
| `pnpm test` / `pnpm run check` | 完整 workspace（含 agent-core 实验室）测试/检查 |
| `pnpm kernel:test` | 仅 kernel 测试 |

### 安装并启动真实产品

```bash
./apps/clicky/scripts/run-local.sh          # build + install + open
# 或分步：build | install | open | pin | self-test
```

一次完成：xcodebuild Debug 构建（Manual signing：`Shangqiuko Local Code Signing`）→ `pnpm build` kernel/runtime 并打包进 bundle（`Resources/YishuRuntime/`，含 node 二进制，保留 V8/JIT entitlements 重签）→ bundle worker → 安装到 `/Applications/奕枢.app` → TCC 权限钉住 → 语音代理凭据播种（`~/Library/Application Support/Yishu/Worker/.dev.vars`）→ 孤儿 8787 回收 → 启动。

首次使用需授予四项 TCC 权限：辅助功能、屏幕录制、麦克风、语音识别（与 bundle identity + 签名身份绑定；授权漂移用 `pin-local-permissions.sh` 修复）。

### AgentCore 实验室（可选）

```bash
pnpm lab:agent:test                        # 实验室测试
pnpm agent -- run "计算 17*19+3"           # 离线单 Agent
pnpm agent -- evolve                       # 一轮自进化
pnpm agent -- eval / demo / status ...     # 其余见 07-agent-core.md
```

## 验证金字塔

```text
pnpm product:check（快、无凭据、日常）
  = check-product-boundaries.sh
  + pnpm --filter @yishu/kernel check && test
  + pnpm --filter @yishu/runtime check && test
  + swift test（根包 YishuContext 契约）

pnpm product:verify（CI 与发版前）
  = product:check 全部
  + xcodebuild test（Clicky Xcode 测试，CODE_SIGNING_ALLOWED=NO）
  + run-local.sh self-test（脚本自测：路径过滤、孤儿谓词、8787 busy 报告、pkill 禁令扫描）

CI（.github/workflows/ci.yml，macos-15）
  = pnpm product:verify
  + agent-core check && test（独立实验室验收）
```

**验收纪律**（[docs/runbooks/verification.md](../runbooks/verification.md)）：build 通过 ≠ 产品验收。用户可见变更必须启动真实 App、检查真实 floating presence；统一核心变更必须确认最终用户行为始终走 `Clicky → versioned protocol → Kernel truth/action → executor → verified receipt → visible presence`。

## 凭据管理

| 凭据 | 位置 | 生成/同步 |
|------|------|-----------|
| StepFun / MiniMax / chat key | `worker/.dev.vars`（0600） | `./apps/clicky/scripts/sync-dev-vars-from-ai-providers.sh` 从 `~/.config/ai-providers/env.local` 与 `~/.cli-proxy-api/client.env` 同步（绝不打印值） |
| 8787 bearer token | 进程内 32 字节（SecRandomCopyBytes） | App 启动时生成，不持久不 log |
| provider OAuth（Runtime） | runtime 凭据存储 | App 内 OAuth 流程；奕枢不复制不打印 |

模型路由默认：chat 走本机 8317 代理（`grok-4.6` 默认），ASR 走 StepFun，TTS 走 MiniMax——全部经 8787 worker 中转，key 不进 Swift 二进制。

## 常用调试入口

- runtime sidecar 日志：stderr 只 drain 不回显（防泄漏 provider 片段）；排查用 `YISHU_RUNTIME_MODE=mock` 跑确定性替身。
- 运行时行为开关：`YISHU_PRODUCT_KERNEL=0`（关闭产品投影，仅调试）、`YISHU_RUNTIME_MODE=mock`。
- store 切换：`YISHU_STORE_BACKEND=json|sqlite|memory`、`YISHU_SQLITE_PATH`、`YISHU_STORE_DIR`。
- 单测定位：kernel `packages/kernel/test/`、runtime `packages/runtime/test/`、agent-core `packages/agent-core/test/`、Swift 契约 `Tests/YishuContextTests/`、App 测试 `apps/clicky/leanring-buddyTests/`。

## 相关 runbook

- [docs/runbooks/local-development.md](../runbooks/local-development.md)——本地开发全流程
- [docs/runbooks/verification.md](../runbooks/verification.md)——验证纪律与命令语义
- [docs/runbooks/clicky-install.md](../runbooks/clicky-install.md)——安装、签名、TCC、登录项细节
