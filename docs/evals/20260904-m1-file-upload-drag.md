# M1 文件上传拖放闭环：验收卡

- 日期：2026-09-04
- 状态：active
- 上下文：`docs/ROADMAP.md` M1；`docs/evals/M1-hands.md`；`docs/devlog/2026-09-04.md`
- 前置：M0 已获用户阶段验收；未达语音指标保留为质量债，不阻塞 M1

## 一句话任务

用户说出 Downloads 顶层目录中的文件名后，奕枢把对应的精确真实文件 URL 拖入当前可见浏览器的上传区；执行前确认一次，页面出现同名附件后才报告成功。2026-09-05 增补卡 `20260905-download-object-grounding.md` 允许本机同音/口述扩展名定位，再按真实 basename 绑定；原动作与附件验收标准不变。

## Change（用户能观察到什么）

用户说「把下载里的 `奕枢测试文件.txt` 拖到这个上传框」后，奕枢找到唯一文件，标出当前浏览器上传区并说清文件名与目标；用户说「去」后，文件以真实拖放进入上传区。页面出现同名附件时奕枢才确认完成；附件不会被自动提交。

## Not this（不算数的替代）

- 只移动鼠标，拖放剪贴板里没有真实文件 URL。
- 改走系统文件选择器、Stagehand `browser.upload` 或 agent 自有浏览器。
- 让模型传绝对路径、`..`、PID、bundle id、窗口 id 或像素坐标。
- `mouseUp` 成功就宣布上传完成，没有读回同名附件。
- 上传后自动点击「发送」「提交」或按回车。
- 测试绿，但 `/Applications/奕枢.app` 没在真实可见浏览器跑通。

## Goal / Hard bar / Improve

- Goal：精确文件名 → 一次确认 → 真实文件拖放 → AX 同名附件回读，完整闭环在本地上传页连续 3/3 通过。
- Hard bar：确认前 0 次拖放；缺失、重名、目录逃逸、目标过期或不可读时 0 次拖放；假完成 0；自动提交 0。
- Improve：用户说「去」→同名附件验证完成的 p50，基线未知，目标 ≤3 s。

## 验收标准

| # | 标准 | evaluator | 证据 |
|---|---|---|---|
| 1 | 新动作是产品语义动作 `drop_download_file`：模型只给精确 `fileName` 与当前帧 `targetId`；协议侧目标 app 身份由 runtime 注入，不接受路径、PID、bundle id、窗口 id、屏幕号或坐标 | 机器：runtime 协议与工具红测；`pnpm --filter @yishu/runtime test` | 测试输出 |
| 2 | `fileName` 只允许一个非空 basename，含扩展名，最长 255 字；拒绝 `/`、`\\`、`.`、`..`、NUL、绝对路径和控制字符 | 机器：runtime 参数表测 + Swift 解码表测 | 测试输出 |
| 3 | Swift 只在用户 Downloads 顶层目录精确匹配普通可读文件；标准化、解析符号链接后仍须位于 Downloads；缺失、重名、目录、符号链接逃逸或权限拒绝均失败且不发起拖放 | 机器：临时目录注入测试覆盖成功与全部失败分支 | 测试输出 |
| 4 | 向网页投放本地文件视为高风险外发：首轮只产生预告与一次性待确认状态；用户说「去」前 0 次 `computer.action.requested`；确认绑定 conversation、文件 basename、目标 app/window/AX 指纹，60 s 过期且不可重放 | 机器：runtime/kernel 测试覆盖缺确认、错会话、错文件、错目标、过期、重放；均 0 次执行 | 测试输出 |
| 5 | 目标只来自当前可见浏览器的 AX 上传区；确认轮 commit 前重新采集，关闭 `liveTargets` 旧列表 fallback。目标缺失、移动、禁用、换窗或换 app → `stale/blocked`，不使用 turn-start 像素 | 机器：Swift 新鲜度测试；测试夹具移动/删除目标后 0 次拖放 | 测试输出 |
| 6 | 拖放由已显示 Overlay `NSView` 发起 `NSDraggingSession`，dragging pasteboard 含唯一 `file://` URL；Finder 像素拖、空 HID 拖和文件选择器不算完成 | 机器：注入式 dragging session 测试核 file URL、source/destination 与单次 commit；本地上传页实际 `drop` 收到 1 个文件 | 测试输出 + 页面回执 |
| 7 | 执行前光球描边上传区；commit 前记录当前浏览器 AX 中精确 basename 的数量，拖放结束后只在该数量增加时判定附件新增。读回成功 → `verified`；鼠标已放开但数量未增加 → `delivered/unverified`，不得说完成 | 机器：Swift read-back 测试 + runtime 未验证口播门测试 | 测试输出 |
| 8 | 投放动作只附加文件，不自动点击、按回车或调用提交动作；同一确认 token 只能提交一次拖放 | 机器：本地上传页分别统计 `drop=1`、`submit=0`；重放后仍为 `drop=1` | 页面回执 |
| 9 | 本地测试页 + 非私人测试文件连续 3/3：精确文件进入、显示同名附件、没有提交；失败用例各 3/3 不发生拖放 | 机器：`node evals/hands/check-file-drop.mjs`；测试文件仅在运行期间临时进入 Downloads，退出即删除，不入 Git | JSON 报告 |
| 10 | 真机 `/Applications/奕枢.app`：当前可见浏览器打开本地上传页，按完整语音剧本跑通；说「去」→验证完成 p50 ≤3 s | 机器：质量事件统计；人评：用户确认拖放动作与确认节奏自然 | 日志 + 用户裁决 |
| 11 | runtime / kernel / Swift 聚焦测试、`product:build:clicky` 通过；`product:check` 除已知 880/856 红线外无新失败；改协议包含 schema + Swift 解码 + 双端测试 | 机器：项目门禁命令 | 输出 |

## 非目标

- 语义找文件（「昨天下载的最新版合同」）、子目录和多个文件；通用同音/口述扩展名匹配由 2026-09-05 增补卡单独验收。
- 只支持隐藏 `<input type=file>`、完全没有 AX 可读投放区的网页。
- 真实网站账号、真实私人文件和真实网络上传。
- 上传后的发送、提交、发布。
- agent 自有浏览器的 `browser.upload(workspaceFileId)`。
- M1 其余双击、右键、滚动、快捷键、窗口和剪贴板动作。

## 基线与结果

- 基线：`computerActionSchema` 与 `computer_control` 没有拖放动作；Swift 执行器只认 `left_click`、`set_text`、`finder_history_back`、`create_note`、`schedule_reminder`、`open_destination`。
- 基线：编号目标只收可按控件，网页 drop zone 常不进入列表；当前没有文件拖放测试页。
- 机器结果：runtime 文件拖放/协议聚焦 128/128、runtime 串行全量 490/490、kernel 全量 219/219、Swift 文件拖放/协议/描边/编号 AX 聚焦测试均通过；runtime/kernel typecheck、`git diff --check`、签名 `product:build:clicky` 通过。AX 目标 frame 已进入协议，runtime/Swift 半点精度位置指纹编码一致；目标移动或确认帧缺位置均失效且 0 次拖放。
- 产品门：`product:check` 的依赖边界与 Swift 尺寸门通过；仅预存 `evals/capability/device/quality-observation-collector.mjs 880/856` 红线失败，无本任务新增失败。
- 实物状态：本分支已重新安装启动 `/Applications/奕枢.app`（pid 56899）。ChromeMain 已打开过本地上传页；第一轮 180 秒人工窗口无人执行，报告 `drop=0 / submit=0 / invalid=0 / timeout_before_three_drops`，临时测试文件已删除。完整语音 3/3、页面回执、p50 与用户人评尚未执行，不算完成。

## 人评清单（交付时填）

- [ ] #10 文件名、目标和确认提示是否清楚。
- [ ] #10 光球到达上传区与拖放动作是否自然。
- [ ] #10 页面出现附件后再确认，且没有自动提交。
