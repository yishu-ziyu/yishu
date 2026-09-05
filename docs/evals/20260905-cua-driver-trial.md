# Cua Driver 执行底座试用：验收卡

- 日期：2026-09-05
- 状态：active
- 上下文：`docs/NOTES.md` 「Cua Driver 执行底座 Trial」；`docs/devlog/2026-09-05.md`

## 一句话任务

在不削弱现有文件拖放和产品状态机的前提下，验证 Cua Driver 能否成为奕枢的 macOS 通用执行底座。

## Change（用户能观察到什么）

奕枢能连续完成「切到 Chrome → 找到上传框 → 把 `奕枢测试文件.txt` 拖入 → 页面出现同名附件后才结束」；同时能执行打开 App、聚焦窗口、点击、输入、滚动和拖拽，没有验证时不说完成。

## Not this（不算数的替代）

- 只跑 `list_windows` 或单次 click，没有连续跨 App 任务。
- 让 runtime 直接绕过 `ComputerUsePort` / Swift 执行接缝碰 Mac。
- 为了接 Cua 删掉现有 `NSDraggingSession` 文件拖放或任务回执。
- 把「已交付输入」当成「页面已出现结果」。
- 只报工具速度，不计算重试、观察和验证。

## Goal / Hard bar / Improve

- Goal：Cua 经现有协议与 Swift actuator 接缝完成 M1 通用动作，真机固定剧本成功率 ≥90%，假完成 0。
- Hard bar：文件拖放回归、目标错绑、任何假完成、或 Cua 无法由 `奕枢.app` 持有权限/生命周期，即 Trial 失败并回到现有 actuator。
- Improve：warm 窗口级观察 p95 ≤500 ms；松手→第一个动作开始 p50 ≤2.5 s；重试轮数越低越好。

## 验收标准

| # | 标准 | evaluator | 证据 |
|---|---|---|---|
| 1 | 锁定 Cua Driver 版本/提交；不读用户全局漂移版本 | 机器：新增的 driver 健康检查输出版本、协议版本与 capability set | 报告 JSON |
| 2 | 候选只在 `ComputerUsePort` ↔ Swift actuator 一侧接入，runtime / kernel 仍是任务与验证真相 | 机器：`pnpm dep:check && pnpm arch:check`；协议双端测试 | 命令输出 |
| 3 | 打开 App、聚焦窗口、点击、输入、滚动、坐标拖拽各 3/3，动作后有 fresh observation | 机器：`node evals/hands/compare-driver.mjs --driver cua --runs 3` | 报告 JSON + 动作回执 |
| 4 | 真机跨 App 文件上传 3/3，页面出现同名附件后才 verified，不自动提交 | 机器：`node evals/hands/check-file-drop.mjs`；人评：通过 `/Applications/奕枢.app` 语音完成 3 轮 | 日志 + 页面结果 |
| 5 | 关键速度报告分开 inventory、window observe no-image、observe with-image、act、fresh verify，记 p50/p95 和重试 | 机器：`node evals/hands/compare-driver.mjs --driver cua --runs 30 --json` | 报告 JSON |
| 6 | 旧的文件拖放、协议、runtime、kernel 和 Swift 聚焦测试全绿；旧 actuator 可回退 | 机器：`pnpm --filter @yishu/runtime test && pnpm --filter @yishu/kernel test`；Swift 文件拖放/协议测试；`git diff --check` | 命令输出 |
| 7 | 用现有 M1 30 步剧本验收：成功 ≥90%，假完成 0 | 机器：M1 日志统计；人评：`docs/evals/M1-hands.md` 附录逐条勾选 | 日志 + 勾选表 |

## 非目标

- 本 Trial 不替换模型/工具循环，不重开 Pi Agent Core 选型。
- 不把 Nuphus 二进制接入 macOS 执行层；它的动作词汇和浏览器实现仍可作参考。
- 不在 Trial 内打磨光球动画或口播情感。

## 基线与结果

- 当前分支：`feat/m1-file-upload-drag`，HEAD `60ab9d0`；保留用户/Cursor 的 35 项未提交变更。
- 现有模型可见电脑工具只有 `left_click` / `set_text` / `drop_download_file`；文件拖放机器项已绿，真机语音 3/3 未通过。
- 本机 Cua Driver 0.7.1：`list_windows` 12/12，p50 20.3 ms / p95 30.2 ms；ZCode 窗口 AX 观察不带图 10/10，p50 67.3 ms / p95 71.3 ms；带图 7/7，p50 338.5 ms / p95 399.9 ms。这只是工具基线，不是 Trial 通过。
- 本机 `pi-computer-use` 0.5.1：`listRoots` 12/12 通信成功但 0/12 返回可用目标，p50 454.5 ms；当前不进主 Trial。
- 从锁定源码构建 Nuphus 0.2.2：`desktop_windows_list` 在本机返回 `Platform not supported`；不进 macOS 执行核心。
- Peekaboo 3.1.2：当前 bridge 窗口观察 0/12，均返回 `INTERNAL_SWIFT_ERROR`；作为 Cua Trial 失败后的次选，先解决版本/桥连接。
- 结果：待实施与真机验收。

## 人评清单（交付时填）

- [ ] #4 说一句话后奕枢会自己切到 Chrome，拖入指定文件，附件出现后才说结果。
- [ ] #7 通用操控不比现有文件拖放更慢、更呆或更不稳。
