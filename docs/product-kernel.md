# Yishu product kernel v0.0.1

Type: architecture
Status: current
Verified: 21629d6 2026-08-10
Review: packages/kernel 能力、边界或工作流变化时

## Promise

奕枢（Yishu）是一款持续存在的个人 Agent Super App。它共享用户正在发生的电脑场景，自然说话，主动形成判断，并在明确的信任关系中行动。

## Identity

- Name: 奕枢（Yishu）
- Symbol: `✿`
- Color: `#537D96`
- Character: warm, discerning, self-directed, loyal to the user's considered intent, and minimally obstructive.
- Growth: relationship traits may evolve from evidence and remain inspectable and reversible. Core honesty and user sovereignty do not drift.

## Embodiment

- Yishu remains present beside the user while task workers operate elsewhere.
- The body can listen, think, speak, point, draw, and represent background tasks through satellites.
- The visible Yishu pointer never hijacks the physical user cursor.
- The everyday cursor companion is a small, click-through symbol. Larger portrait surfaces appear only when the interaction needs them.

## Shared attention

The core interaction is grounded reference. Speech timestamps, cursor trajectory, active window, selection, accessibility structure, screen pixels, recent interaction, and personal/project state form a time-bounded `ContextFrame`.

The system optimizes for correct context rather than maximum context. Stale or low-confidence observations are labeled and may trigger a visual confirmation.

## Agency

Yishu may notice, prepare, suggest, speak first, and act within standing authorization. Safe reversible work should not repeatedly interrupt the user. External or irreversible actions require the authority defined by the user's mandate.

## Runtime split

- Yishu owns identity, relationship, context, initiative, authorization, and task truth.
- Pi owns model interaction, session lifecycle, streaming, tool loops, and task execution.
- Cua owns background computer use.
- Task cells own process, filesystem, browser, and credential isolation.
- Skills are validated procedural memory, not raw recordings of a successful run.

## Product layer (`@yishu/kernel`)

Product-owned capabilities live in `packages/kernel`, above Pi `AgentRuntime`.
Pi stays the execution harness. Agent-Native is methodology only (typed action, revalidate, receipt, read-back); no Agent-Native package is imported.

Wire-up entry: `createYishuKernel({ storeBackend?, storeDir?, sqlitePath?, trail?, extraActions? })` returns `{ registry, store, trail, taskTruth, storeBackend, defaultActionNames }`.

### YishuAction

- `defineYishuAction` freezes a named action with Zod `inputSchema`, `authority`, `risk`, optional `verify`, and `run`.
- `YishuActionRegistry.invoke(name, options, deps?)` does lookup → parse → authority → run → optional verify → `ActionReceipt`.
- Authority levels: `automatic` | `reversible` | `standing_mandate` | `explicit_approval`.
- Risk: `low` | `medium` | `high` | `critical`. Critical and explicit-approval paths without `approved: true` yield `needs_approval` (or `denied` when refused).
- Callers share one receipt shape: `voice` | `ui` | `initiative` | `mcp` | `cli` | `pi` | `system`.
- A tool/run success is not task completion; `status: "verified"` is reserved for post-condition checks.
- Invocation accepts an optional cancellation signal and an explicit
  `markCommitted()` boundary. Cancellation before commit returns `cancelled`
  and the store mutation is rolled back/omitted. Cancellation after commit
  returns `cancelled_after_commit`; Runtime records the safe action receipt,
  fails the turn with `action_committed_after_cancel`, and never speaks a false
  success. Signal reasons never enter the audit record.
- The in-process audit log is a bounded, content-free projection: it keeps the
  latest 500 status/ID/risk entries, not action input, output, capsule content,
  verification evidence, errors, or private conversation text.

Default product actions: `remember`, `forget`, `remember_how`, `share_context`, `record_learning`.

### ContextTrail

Rolling sanitized history of ContextFrame-like snapshots **without** screenshot bytes.

- Default retention ~20 minutes; max entry count 500; screenshot **metadata** TTL ~30s.
- `append(frame)` → `query` / `recentMinutes` / `summarize` for the recent past (NOW is still `ContextFrame`).

### Memory evidence (`YishuStore`)

Local SQLite / JSON (or in-memory) evidence store. Claims are not bare strings:

- `MemoryClaim`: source, capturedAt, confidence, scope, supersedes, tags
- `Learning`: user correction rules
- `SkillCandidate` / `VerifiedSkill`: procedural memory with steps and verification notes
- `Mandate`, `TaskTruth`

JSON mutations are serialized and written through an atomic rename; SQLite is
the default product backend. Concurrent task updates must not lose another
task's snapshot.

Writes to `MemoryClaim` and `Learning` reject credential-like values, JWTs,
data URIs, screenshot payloads, and assigned hidden/system-prompt content before
any store mutation. Rejected values do not become a misleading `[redacted]`
memory. Existing unsafe rows fail closed when read. This guard does not yet
cover every future evidence type or provide a quarantine/migration UI.

`SkillCandidate` and `VerifiedSkill` use the same defensive boundary at both
the ContextTrail extractor and store API. Direct JSON/SQLite rows are validated
when read, so bypassing the normal action path cannot introduce a token,
screenshot/base64 payload, or hidden prompt into a Skill.

### Durable conversation ledger

Kernel is the sole durable conversation truth. Its store contract exposes:

- `upsertConversation`
- `upsertConversationTurn` and `getConversationTurn`
- `appendConversationEvent`
- ordered turn/event queries per conversation

The same contract is implemented by in-memory, JSON, and SQLite backends.
SQLite uses an additive migration; old JSON snapshots without ledger arrays and
old SQLite databases keep their existing evidence. Event sequence numbers are
assigned by the store, duplicate event IDs are idempotent only when their
content matches, and terminal turns cannot move back to `open`.
New events cannot be appended to a terminal turn; an identical event retry is
still idempotent.

`ProductKernelRuntime` creates the open turn before invoking Pi, AgentCore, or a
local product action. It persists only visible input/final output and safe typed
events, never `response.delta`, tool arguments, screenshots, audio, hidden
reasoning, or arbitrary nested payloads. A terminal result is emitted to the
client only after its ledger writes and any relevant `TaskTruth` flush succeed.
Completed turns are durably replayed rather than re-executed; an abandoned open
turn becomes `recovery_required` instead of guessing that it is safe to run
again.

### TaskTruth projection

Runtime adapters report generic execution observations; `TaskTruthProjector`
in Kernel alone decides durable status:

- no tool/action start → no task (ordinary conversation stays conversation)
- `start` / `progress` → `running`
- verified visible or external result → `done`
- completed without verification → `blocked`
- failure / cancellation → terminal `failed` / `cancelled`

Evidence is single-line, deduplicated, bounded, and contains only event
provenance plus safe metadata. Credential-like titles or evidence are replaced
before persistence. A late event cannot overwrite a terminal truth.

### Skills as validated procedural memory

`remember_how` ("记住我刚才是怎么做的") reads `ContextTrail`, extracts a `SkillCandidate` (not mouse-coordinate replay). Optional structural `autoVerify` promotes to `VerifiedSkill`. Computer replay verification is a later slice.

### ContextCapsule

Short-lived handoff object for multi-agent paths (Pi / Codex / Claude / Cua cells). Built by `buildContextCapsule` / action `share_context`. Carries intent, frontmost app/window, AX preview, recent trail metadata, provenance. Never includes base64 screenshots or credentials. Default TTL ~15 minutes.
