# Grok Teable 5m poller — field map + ops

Type: runbook
Status: current
Verified: 21629d6 2026-08-10
Review: poller 表结构、视图、字段或调度变化时

Canonical ops for scheduler `019fe219296b` (durable, every 5m).  
Repo: `/Users/mahaoxuan/Documents/我的agent`

| Item | Value |
|------|--------|
| Base | `bseXE1G4dAOJNZ36Bjq` |
| Table | `tblHpb7Pwu1b58GeSpV`（奕枢开发总表，**唯一**工作表，17 字段） |
| View 全部工作 | `viwnyJMkWXPFsazo9GU` |
| View **Grok 可领取** | `viwwnhvHW24XentzI7A` |
| View Codex 待验收 | `viwBYdS5gZaTWRDOXhY` |
| Lock | `.work/teable-grok-poller.lock` |

Never print Teable tokens/secrets. Never log raw credentials or private chat text.

---

## Hard ops

1. **Never stop/delete/disable this Loop** unless human says 关掉 Loop / 取消定时.
2. **Codex rework = Grok work.** 返工合同在 **下一步**（常有编号清单）；也读 **最新结果 / 当前差距 / 阻塞与决策**.
3. Deliver only **执行状态=待验收**. Never self-mark **完成**. Never self-mark **当前状态=已验证**.
4. Keep **负责人=Grok** from claim through 待验收.
5. **Only 记录类型=执行任务** is claimable. 产品能力 / 项目治理 = context only, never claim.

---

## Two axes (do not mix)

官方字段描述（Teable 实读）：

| Axis | Field | Meaning |
|------|-------|---------|
| **队列**（轮到谁、做什么） | **负责人** + **执行状态** | 谁在做、卡在哪一步 |
| **成熟度**（产品能不能用） | **当前状态** | 待审计/部分可用/可用待验证/已验证/阻塞/完全不可用 |

- 口语「待领取」= 视图 **Grok 可领取** 里的行，**不是** `负责人=待领取`（那个值几乎不用在执行任务上；派发后负责人直接是 Grok）。
- 口语「返工」= Codex 验收失败后把同一行 **执行状态** 改回 **可领取**（负责人仍 Grok），并在 **下一步** 写固定返工清单；也可能在 **进行中** 时由 Codex 改写 **下一步**。
- 交付时 **默认不改 当前状态**。

---

## Full field map（17 列 — 每轮都要懂）

| # | Field | ID | Type | Grok 每轮 | Grok 可写 | Role |
|---|-------|-----|------|-----------|-----------|------|
| 1 | **功能与任务** | `fldWyhSuLUS0feWuaKs` | text primary | **扫** | 否 | 行标题 |
| 2 | **用户最终能做什么** | `fldm73x1w3Eo6qLOY9C` | longText | claim 时深读 | 否 | 用户可见结果；目标不可谈判 |
| 3 | **当前状态** | `fldci61ffGDHnfjNiXL` | select | 扫（上下文） | **默认不动** | 成熟度，不是队列 |
| 4 | **优先级** | `fld1xD3rRch1ho483Vb` | select | **扫** | 否 | 领取排序 P0>P1>P2>P3 |
| 5 | **负责人** | `fldM0YUtby6FXYio3YD` | select | **扫** | claim 起保持 Grok | 待领取 / Codex / **Grok** / 老板 |
| 6 | **执行状态** | `fldEbcxzivrbuCyeWKb` | select | **扫** | claim + deliver | 队列状态（见下表） |
| 7 | **实现参考** | `fldOhfN41lFcyIJj228` | longText | claim 深读 | 极少 | 允许路径、禁止项、边界 |
| 8 | **当前差距** | `fldZdAyBDAjGuduBfiF` | longText | claim 深读 | 可选 | 还差什么 / 曾差什么 |
| 9 | **下一步** | `fldTHfFGxxE10bKinHb` | longText | **活跃行必读** | 可选中途 | **Codex 返工清单主合同** |
| 10 | **验收方法** | `fldWJ4yv9XVKy5OV35x` | longText | claim 深读 | 否 | 可证伪验收；交付对准它 |
| 11 | **最新结果** | `fldIy5xuAwU2pzL6Szr` | longText | 活跃行读 | **交付必写** | 诚实完成/缺口/ID |
| 12 | **证据** | `fld2GLmkEyKz6cHCM34` | longText | 活跃行读 | **交付必写** | `.work/` 路径 |
| 13 | **阻塞与决策** | `fldPTZ27Z1RVz3pKIrM` | longText | 活跃行读 | 若阻塞则写 | 人类决策；勿忽略 |
| 14 | **最后更新** | `fldowUmZMWhsbzeRPTf` | lastModifiedTime | 扫 | 自动 | 排序 / 新鲜度 |
| 15 | **记录类型** | `fldRjLsOhnTBITm3upO` | select | **扫** | 否 | **执行任务** 才可领；产品能力/项目治理否 |
| 16 | **上级任务** | `fldMUfHH2FRIq7C4XdS` | link manyOne | 扫 | 否 | 父能力；一条子任务一个上级 |
| 17 | **子任务** | `fldzrb3kb5L62WgGdgu` | link oneMany | 父行看 | 否 | 子执行任务；父可仍 进行中 |

### 负责人 values

| Value | Meaning |
|-------|---------|
| 待领取 | 未指派（执行任务派发后通常直接 Grok） |
| Codex | 规划 / 派发 / 验收 / 治理 |
| **Grok** | 实现；可领取视图要求此项 |
| 老板 | 必须人决定或操作 |

### 执行状态 values（队列）

| Value | Who sets | Grok action |
|-------|----------|-------------|
| 待梳理 | Codex | ignore |
| **可领取** | Codex 派发 **或** 验收退回 | **CLAIM**（若 执行任务∧负责人Grok） |
| **已领取** | Grok | CONTINUE |
| **进行中** | Grok（或 Codex 改下一步） | **CONTINUE**；下一步有返工则做 |
| **待验收** | Grok 交付 | idle（等 Codex）；勿领新项 |
| **完成** | **Codex only** | closed |
| 阻塞 | either | 读阻塞与决策 |

### 当前状态 values（成熟度 — 默认不改）

待审计 · 部分可用 · 可用待验证 · **已验证** · 阻塞 · 完全不可用

---

## Views（过滤器实读，勿发明）

**Grok 可领取** `viwwnhvHW24XentzI7A`:

```text
记录类型 = 执行任务
AND 负责人 = Grok
AND 执行状态 = 可领取
```

Sort: 优先级 asc, 最后更新 asc.

**Codex 待验收** `viwBYdS5gZaTWRDOXhY`:

```text
记录类型 = 执行任务
AND 负责人 = Grok
AND 执行状态 = 待验收
```

Grok 不扫此视图干活；交付后归 Codex。

---

## 每轮必做：整表通读（不只扫视图）

```bash
# 1) 全表 inventory — 每轮
teable record get --base-id bseXE1G4dAOJNZ36Bjq --table-id tblHpb7Pwu1b58GeSpV \
  --take 200 --projection all

# 2) 可领取视图（确认为空或有新返工）
teable record get --base-id bseXE1G4dAOJNZ36Bjq --table-id tblHpb7Pwu1b58GeSpV \
  --view-id viwwnhvHW24XentzI7A --take 20 --projection all

# 3) 动手前深读一行
teable record get --base-id bseXE1G4dAOJNZ36Bjq --table-id tblHpb7Pwu1b58GeSpV \
  --record-id <recXXX> --projection all
```

### 扫行最少解析列

`id, 功能与任务, 记录类型, 优先级, 负责人, 执行状态, 当前状态, 下一步, 最新结果, 阻塞与决策, 上级任务, 子任务`

### claim / 返工前深读

`用户最终能做什么, 实现参考, 当前差距, 下一步, 验收方法, 最新结果, 证据, 阻塞与决策, 上级任务`

### 信号

| 信号 | 条件 | 动作 |
|------|------|------|
| **待领取 / 可领** | 执行任务 ∧ 负责人=Grok ∧ 执行状态=**可领取** | claim → 已领取/进行中 → 实现 |
| **返工（视图）** | 同上，且 **下一步** 含 Codex 退回清单 | 同一 claim 路径；以 下一步+验收方法 为准 |
| **返工（在途）** | 执行任务 ∧ Grok ∧ **进行中/已领取**，下一步含返工/不得/必须补 | **CONTINUE** 实现，勿 idle |
| **待验收** | 执行任务 ∧ Grok ∧ 待验收 | 不领新项；等 Codex |
| **父能力在途** | 产品能力 ∧ 进行中 | 不 claim；可更新子任务结果时顺带写父行最新结果（可选） |

---

## Decision order（每 fire）

```text
1. Lock .work/teable-grok-poller.lock（活锁 skip；陈锁清；exit 必 unlock）
2. Full get --projection all → 建板：
   Grok 执行任务 by 执行状态 | Codex/治理/产品能力只作上下文
3. Decision:
   a. 已有 Grok 执行任务 已领取/进行中
        → 只 CONTINUE 这一条（一次一项）
        → 下一步有返工 → 按 验收方法 做完
        → 做完 → 待验收 + 最新结果 + 证据（不改 当前状态、不写 完成）
   b. 否则有 Grok 执行任务 待验收
        → Idle skip（等 Codex）
        → 若同一 id 又变回 可领取 → 走 (c)
   c. 否则可领取视图非空
        → P0 优先，同优先级更旧 最后更新 优先
        → 写 已领取/进行中，负责人=Grok
        → 深读全文；实现 下一步 + 验收方法
   d. 否则 idle skip
4. 短报：板上计数 + action + rec id。禁止废话。
5. 禁止无人类授权 scheduler_delete。
```

---

## Write-back

| Moment | 执行状态 | 负责人 | 最新结果 | 证据 | 当前状态 |
|--------|----------|--------|----------|------|----------|
| Claim | 已领取 / 进行中 | Grok | 可短写 | — | 不变 |
| Rework mid | 进行中 | Grok | 对照 Codex 条目 | 路径 | 不变 |
| Deliver | **待验收** | Grok | **必写** | **必写** | **不变** |
| Codex pass | 完成 | (Codex) | Codex | Codex | 常改 已验证 |
| Codex fail | **可领取** | Grok | 返工进 **下一步** | Codex | 通常不变 |

```bash
teable record update --base-id bseXE1G4dAOJNZ36Bjq --table-id tblHpb7Pwu1b58GeSpV \
  --records '[{"id":"recXXX","fields":{"执行状态":"待验收","负责人":"Grok","最新结果":"...","证据":"..."}}]'
```

---

## Live board（2026-08-09 全表实读，total=17）

**计数：** 完成 13 · 进行中 3 · 待梳理 1 · 可领取 0 · 待验收 0

| 执行状态 | 记录类型 | 负责人 | id | 标题 |
|----------|----------|--------|-----|------|
| 进行中 | 执行任务 | Grok | `recv8pGplP5xKN0m8B5` | 用语音完成一个安全电脑点击…（**当前 Grok 主线**） |
| 进行中 | 产品能力 | Grok | `recMxw0wLsRmEBEqDSC` | 验证语音到实际结果…（父；等子任务过） |
| 进行中 | 项目治理 | Codex | `reciqBIvnP2eBCADsvh` | 固化开发基线（**不 claim**） |
| 待梳理 | 项目治理 | Codex | `reczyq99skygiFX4MDR` | 书方法提取（**不 claim**） |

**Grok 执行任务 完成 8：** history×2 · memory remember/forget · voice online · speech speed · orphan proxy · voice answer e2e  
**可领取视图：** 空（因 `recv8p…` 已在 进行中）

树（父 → 子）：

- `recMxw0wLsRmEBEqDSC` 语音完整路径 → 子：在线 · 语速 · 孤儿 · 回答闭环(**完成**) · **点击 e2e 进行中**
- `recwrJkClvXqa8wBtMX` 记忆 · `recyWeJjGSF1vEOClB7` 历史 → 子任务均已完成

---

## Product boundaries

- Formal app: `apps/clicky` → `/Applications/奕枢.app`
- kernel + runtime product layer；Pi = harness only
- No Kairos；无第二产品身份
- Boss conversation `D7D12DFF-2A97-49C2-BFDF-D07D5B19FEE0` 必须保留

## Lessons

- 未授权停 Loop = 硬失败。
- 返工合同在 **下一步**；整表字段通读避免「视图空就 idle」而漏掉 进行中 返工。
- 可领取 = **执行任务 ∧ Grok ∧ 可领取**，不是「任意 Grok 行」。
- 负责人「待领取」≠ 可领取视图；派发后看 **执行状态=可领取 + 负责人=Grok**。
