# Codex App Server 复用 Computer Use：验收卡

- 日期：2026-09-05
- 状态：passed（本机接入烟测；不代表 M1 通用操控验收）
- 上下文：用户授权测试现有 ChatGPT 登录态能否通过独立 App Server 使用桌面 Computer Use；M1 保持原状。

## 一句话任务

独立启动 Codex App Server，用已有订阅登录与 GPT-6 Astra 调用本机官方 Computer Use，执行并验证一个真实界面动作。

## Change（用户能观察到什么）

计算器通过 Computer Use 完成测试算式，工具回读与界面显示一致；明确调用方是否依赖桌面宿主。

## Not this（不算数的替代）

- 主会话替测试进程操作；仅模型文字声称完成；换成 API key；用脚本直接算出结果假冒界面操作。

## Goal / Hard bar / Improve

- Goal：确认从第三方进程接入 Codex Harness 与官方 Computer Use 的实际可用路径。
- Hard bar：不读取或复制认证 token，不购买 API；不修改 M1 代码、全局设置、签名或 TCC 数据库；只操作测试计算器。
- Improve：记录初始化、模型首响应、执行耗时与失败原因。

## 验收标准

| # | 标准 | evaluator | 证据 |
|---|---|---|---|
| 1 | 独立 App Server 完成 JSON-RPC 握手，account/read 为 ChatGPT | 机器：临时 stdio 客户端发 initialize、account/read，只保留认证类型 | 临时报告 |
| 2 | model/list 出现 GPT-6 Astra，真实 turn 使用该模型完成 | 机器：model/list、thread/start、turn/start 返回与完成事件 | 临时报告 |
| 3 | App Server 加载官方 cua_repl，非主会话转发 | 机器：mcpServerStatus/list 与真实 MCP 调用事件 | 临时报告 |
| 4 | 测试会话使用 Computer Use 在 Calculator 输入 37 × 19，回读 703 | 机器：MCP 调用结果；主代理串行独立观察最终界面 | 临时工具证据，截图不入仓 |
| 5 | 明确所用 CLI、插件版本及桌面宿主依赖，保留已有改动 | 机器：版本记录、测试子进程退出、git diff --check | 本卡结果与 NOTES |

## 非目标

- 本轮不接入奕枢正式 runtime，不切换默认模型，不提交或推送。

## 基线与结果

- 分支 feat/m1-file-upload-drag，有既有 M1 未提交改动。
- 本机 CLI 0.153.2；ChatGPT 登录；unified-computer-use 插件 26.901.41123。
- #1 通过：独立 `codex app-server` stdio 握手 0.09–0.13 s；`account/read.account.type = chatgpt`。只读认证类型，不读取/复制 token，没有使用 API key。
- #2 通过：`model/list` 返回 `gpt-6-astra`；两个真实 thread/turn 都以该模型 completed。
- #3 通过：`mcpServerStatus/list` 返回 `cua_repl: connected`，pluginId `unified-computer-use@openai-bundled`，工具 `js`、`js_reset`；实际执行事件也是该 server/tool。
- #4 通过：第一次模型通过 Calculator 按钮输入 37 × 19，AX 回读 703；主代理在测试退出后独立 AX 回读与截图确认。第二次清除旧结果后输入 23 × 17，AX 回读 391；主代理截图再次确认。
- 两个成功运行从 turn 开始到完成分别为 18.812 s、24.028 s；包含模型说明、工具调用与最终回复，不是语音首声指标。第一次六次点击加回读的单次工具调用 2.529 s；第二次该调用 4.842 s。样本仅两次，不推断成功率或延迟分位数。
- 第二次启动前剔除继承的 `CODEX_*`、`CMUX_CODEX_*`、`NODE_REPL_*`、`CUA_*`、`SKY_*`、`BROWSER_USE_*` 环境变量；仍通过用户目录中的既有 ChatGPT 登录和插件配置成功。未借用父会话 ID 或主会话工具代理。
- #5：npm CLI 0.153.2；桌面包内 CLI 为 0.153.3，本次实际调用前者。官方统一插件 26.901.41123，其 manifest 引用 `/Applications/ChatGPT.app/Contents/Resources/cua_node/` 与 `~/.codex/computer-use/Codex Computer Use.app`。本机已安装且获系统权限的服务是本次运行条件；未测试卸载桌面包、关闭全部宿主服务或干净机器安装。
- 测试客户端原型与原始事件仅在 `/tmp/yishu-codex-cua-trial/`：`probe.py`、`success-703.json`、`report.json`。原始图片/工具上下文不入仓；该目录可能被系统清理。

### 客户端必须接的协议

1. 启动 `codex app-server`，依次 `initialize` → `initialized` → `account/read` → `model/list` → `thread/start` → `turn/start`。
2. 持续读取 JSONL 并处理通知与服务器反向请求；不能只等待最终文本。读取器必须先消费自身缓冲区中的完整行，再等待新字节，否则会漏处理已到达的事件。
3. Computer Use 会通过 `mcpServer/elicitation/request` 询问 app 授权。本测试根据用户已授权的计算器试验，验证 `serverName=cua_repl` 且 `_meta.tool_params.app=com.apple.calculator` 后回复 `action=accept, content={}, _meta.persist=session`。没有持久化全局授权，也没有禁用授权机制。
4. 接收 `item/started`、`item/completed`、`item/agentMessage/delta`、`turn/completed`；以实际工具回读作为动作证据。

### 失败归因与范围

- 第一次临时客户端把读取缓冲区与 select 混用，工具事件后等待超时；修正为先解析缓冲行后，正常收到授权请求。
- 第二次客户端尚无 elicitation handler，返回错误，工具明确拒绝使用 Calculator；补上本试验授权范围内的会话级应答后，两次真实动作均通过。这是客户端接线缺失，不是 GPT-6 或官方操控服务不可用。
- 仅给测试子进程设置临时 config overrides，关闭无关显式 MCP、插件与 hooks/memory；未写全局配置。未改变任何生产动作范围、运行模型、签名或系统权限。
- 结论：本机可用 ChatGPT 订阅登录，通过第三方 App Server 客户端直接使用 GPT-6 与官方 Computer Use。后续可让奕枢作为该客户端；复杂跨应用任务、上传文件、语音打断和奕枢事件映射仍需分别验证。
- 官方协议参考：https://learn.chatgpt.com/docs/app-server

## 人评清单（交付时填）

- 无主观产品人评；本轮只验证接入能力。

## 用户追加：可视执行记录

- 用户指定 GPT-5.3-Codex-Spark 整理本次证据并制作简易 HTML，以便直接查看流程和结果。
- 验收：实际通过 `gpt-5.3-codex-spark` 产出页面；单页能显示结论、两次算式结果、真实工具事件与耗时、真实结果截图；过程回放可播放/暂停，注明依据事件日志；本机浏览器实际打开并操作验证。
- HTML 与截图放用户文档目录，不提交图片、不改 M1 产品界面。没有录屏的运行不伪造为 GIF 录像。
