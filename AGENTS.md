# Yishu Project Instructions

以不损失决策相关信息为边界，删除所有不改变用户判断、行动、风险或验证结果的文字。方法论全文 `docs/METHODOLOGY.md`。

## 每次会话默认怎么做

1. 先读 `docs/NOTES.md` 头部「当前状态」，再读命中的任务节。不把聊天记忆当恢复依据。
2. 动手前先有验收卡 `docs/evals/YYYYMMDD-<slug>.md`（按 `docs/evals/TEMPLATE.md`）。没有 evaluator 的句子不算标准。机器项跑到全绿再交付；人评项单列等用户裁。commit message 引用卡。写卡前读 `docs/PRODUCT.md`；改代码前读 `docs/ARCHITECTURE.md`；里程碑与各节点硬条在 `docs/ROADMAP.md`。架构、协议、安全门、卡的改动归主代理；来干活的 Agent 只在卡内做，缺判断就写进 NOTES「待主代理」并停下。
3. 现象即信号：用户说「太慢」「不好用」，不直接改。先追问成数值、行为、截图、复现路径，翻成检查脚本再改。
4. 上下文：探索派子代理，只带结论、改动清单、未决问题、证据位置回主上下文；每个子任务刚做完就写 NOTES，不等压缩。
5. 分工：主代理做判断、写卡、派工、核对、关键改动（协议 / 验证契约 / 安全门）、串行真机操作（安装、点屏幕）。子代理 Grok 4.6（探索 high，实现 xhigh），重任务并行多 builder，按文件归属切分；不与用户对话，不改卡 / AGENTS.md / 协议文件；不大量抓网页（给本地文档，先写脚本再跑）。两次屏幕点击不能并行。
6. 方向转了写 `docs/devlog/YYYY-MM-DD.md`：改了什么、为什么、结果、被推翻的路。不是 commit 复述。
10. 提交节奏：每个里程碑机器项全绿且用户裁完人评后提交一次，message 引用验收卡路径。提交、推送这类机械操作派 shell 子代理执行，主代理只核对 `git status` 与 message；不提交 `.dev.vars`、`.work/`、截图、音频。
7. 经验层 `agent-learning/`：raw 轨迹可扔；wiki.md 只增不删；日常会话不读 wiki。Skill 只许提案（≥4 份运行记录、一次一个、固定验证集 + `product:check` + `product:verify` + 真机），用户裁决后才进 `.agents/skills/`。
8. 用词具体：说部件名和它做的事（Blobatar 表情状态、光球指向动画、runtime 推理层），不用「脸」「嘴」「大脑」一类代称。
9. 状态与记录不含凭据、截图、私人对话、用户记忆正文。密钥只在 `apps/clicky/worker/.dev.vars`（gitignored）与钥匙串。

## 能合并的真实命令

```bash
pnpm product:check                 # 日常内环
pnpm product:verify                # 发版前
pnpm --filter @yishu/runtime test && pnpm --filter @yishu/kernel test
pnpm product:build:clicky          # 只编译；安装与启动 ./apps/clicky/scripts/run-local.sh 由主代理串行执行
node evals/voice/check-latency.mjs --last 30   # M0 期间的真机延迟闸门
```

已知预存红线：`evals/capability/device/quality-observation-collector.mjs` 880/856（`product:check` 因此退出 1）。`docs/capabilities/` 已冻结。`/code-review` 或明确说 review 才跑 Matt 双轴（`docs/runbooks/code-review.md`）。
