# ADR 0010: 奕枢采用单一产品主干

Type: decision
Status: current
Verified: c268654 2026-08-13
Review: 该决策被重新讨论或推翻时（只能由新 ADR supersede）

## Status

Accepted 2026-08-11

## Context

奕枢已经拥有正式 Clicky、产品 Kernel、Pi Runtime、AgentCore 实验包、开发壳、
本地模型 continuity fallback、原生点击快路径和后台委派。能力都真实存在，但开发入口、
状态所有权和失败回退仍有分叉：Clicky 可以绕过 Runtime 直接调用 `/chat` 并维护独立
`conversationHistory`，named-click 可以在 Swift 内直接决定和完成，delegated result
当时暂存在 Runtime 内存，Runtime 直接访问 Kernel raw store，AgentCore 又在首页被描述为
另一套“认知内核”。继续横向增加能力会让每项功能形成自己的产品主链。

统一不等于把所有代码合并成一个模块。统一的是身份、入口、产品真相、能力协议和验收闭环。

> 2026-08-12 更新：本节记录的开发壳已由 ADR 0012 退役；本 ADR 的其余产品主干决策不变。

## Decision

奕枢采用一条单一产品主干：

```text
Clicky body
  voice | context sensors | presence | TTS | macOS actuator
                         |
              versioned product protocol
                         |
Yishu Kernel
  conversation | memory | policy | actions | skills | TaskTruth | result delivery
                         |
Runtime adapters
  Pi | computer-use port | provider/auth adapters | future execution cells
```

- `apps/clicky` 是唯一用户可见身体和正式安装源。它拥有传感器、语音、TTS、UI、权限、
  本机执行器和本地界面偏好，但不拥有第二份对话、记忆、任务或结果真相。
- `packages/kernel` 是唯一产品核心。所有会改变产品真相或产生用户可见任务结果的能力，
  必须通过 Kernel service 或 `YishuAction`，并留下类型化 receipt/evidence。
- `packages/runtime` 是协议网关和执行适配层。它可以管理执行会话和短生命周期 transport
  状态，但不得成为记忆、任务、关系或结果交付的最终事实源。
- Pi 是正式执行 harness。执行器可以替换，产品身份和状态所有权不可随执行器替换。
- `packages/agent-core` 与 mock runtime 是实验或验证设施，不是并行产品核心；原
  `apps/macos` 开发壳已由 ADR 0012 退役。实验能力只有迁入 Kernel/Runtime 的正式端口并
  进入唯一 Clicky App 后才算进入产品。
- 快路径可以预计算 observation 或优化 latency，但不能绕过 authority、TaskTruth、
  ActionReceipt 和可见 read-back。Swift 继续执行 macOS 动作，决策和结果归档回到主干。
- continuity fallback 必须位于 Runtime adapter 后面，继续经过同一 Kernel ledger。
  正式 Clicky 不再长期保留直接 provider 对话旁路。
- 新能力必须回答：归属哪一个 Kernel capability、使用哪个执行 Port、写入哪一种产品真相、
  如何验证，以及通过哪个真实用户闭环验收。答不出时不得接入正式产品。

## Migration order

1. **锁定边界**：统一文档、根命令、依赖守卫和验证入口，停止增加新旁路。
2. **消除主链旁路**：已删除 Clicky 对话 `/chat` fallback 与独立
   `conversationHistory`；Runtime 失败仅有界重启并诚实失败。Named-click 仍是 Swift
   内的延迟快路，但执行已共用类型化、重验证、可回读的 actuator；将决策收回
   Kernel Action 仍是后续边界收窄。
3. **集中产品真相**：Result Inbox 已作为 TaskTruth 关联的 Kernel 持久化记录落地；
   以 Kernel service facade 取代 Runtime 对 raw store 的直接调用仍是后续迁移。
4. **开放能力扩展**：语音、桌面、委派、主动性和未来能力只通过稳定 capability ports 扩展。

迁移采用纵向切片，不做大爆炸重写。每一步必须保持 Clicky bundle identity、TCC、登录项、
UserDefaults 兼容、现有语音/TTS 和用户数据。

## Acceptance behavior

统一主干的北极星闭环是：用户从 Clicky 说“研究当前页面，完成后告诉我”，继续工作；
Kernel 创建唯一 turn/task truth，后台执行只获得获准能力，Presence 投影任务状态；重启
Clicky 和 Runtime 后任务真相及已生成结果仍可恢复（中途 running 子任务 fail closed，不续跑），结果可重新打开且只交付一次；用户再说“记住
第二条”，下一轮回答能引用该记忆并显示来源。私密范围执行同一体验但不产生持久记录。

2026-08-12 的自动化实现已覆盖 Result Inbox 的 durable claim/ack/release、孤立子任务 fail-closed recovery、子 session 精确释放、Clicky task snapshot / cancel ack / SystemSequence，以及“从头重试”作为新 request。真实 Clicky 中的重启、交互和只交付一次仍需真人验收；这不得被包级测试或构建代替。

2026-08-12 的持续伴侣纵切又补齐了：冷 Pi session 从同 scope / conversation
的 Kernel 可见历史回填，五秒元数据 ContextTrail 与 Learning 进入后续 turn，后台
结果在静默窗口主动回访但不消费 Result Inbox，以及 verified click / Finder Back /
focused `set_text` 的类型化桌面闭环。安装 App 的真实 PTT、TTS、TCC 与主动回访仍是
人类验收门。

## Consequences

- 近期优先级从横向增加能力改为收敛主干。
- `CompanionManager` 的对话 fallback 与独立对话缓存已退役；direct-click 决策仍是迁移对象，不被视为长期产品边界。
- AgentCore 可以继续实验，但不得在正式产品说明中与 Kernel 并列为第二个核心。
- Runtime/Kernel 的公开面会收窄；Result Inbox 已归 Kernel store，raw-store facade 与其他执行器内部类型仍需退出产品调用面。
- 一项能力只有通过正式 Clicky、版本化协议和最终可见结果验收后，才算产品完成。
