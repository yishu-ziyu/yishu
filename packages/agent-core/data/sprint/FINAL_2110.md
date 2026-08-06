# Sprint final 2026-08-06T13:10:32Z

## Tests
# tests 153
# suites 24
# pass 153
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1082.576917

## Eval
  [PASS] search tools=[web_search] 检索结果摘要：
<untrusted source="web_search">
NOTE: The following 
  [PASS] write-file tools=[write_file] 文件已写入。证据：<untrusted source="write_file">
NOTE: The following
  [PASS] knowledge tools=[knowledge_search] 根据知识库：
「ReAct Pattern」：ReAct interleaves reasoning traces wi
  [PASS] knowledge-write tools=[knowledge_search,write_file] 文件已写入。证据：<untrusted source="knowledge_search">
NOTE: The fol

pass rate: 100.0% (7/7)
Wilson CI: 100.0% [64.6%, 100.0%] (Wilson 95% CI, n=7)

## Status

> @yishu/agent-core@0.0.1 cli /Users/mahaoxuan/Documents/我的agent/packages/agent-core
> tsx src/cli.ts -- status


奕枢 · status (offline)

package: @yishu/agent-core
version: 0.0.1

paths:
  workspace:      /Users/mahaoxuan/Documents/我的agent/packages/agent-core/workspace
  skills:         /Users/mahaoxuan/Documents/我的agent/packages/agent-core/skills
  memory:         /Users/mahaoxuan/Documents/我的agent/packages/agent-core/data/memory.json
  knowledge:      /Users/mahaoxuan/Documents/我的agent/packages/agent-core/data/knowledge
  mcp:            /Users/mahaoxuan/Documents/我的agent/packages/agent-core/data/mcp
  skill-drafts:   /Users/mahaoxuan/Documents/我的agent/packages/agent-core/data/skill-drafts
  trajectories:   /Users/mahaoxuan/Documents/我的agent/packages/agent-core/data/trajectories

counts:
  trajectories:   196
  memory cards:   28
  knowledge docs: 3
  mcp tools:      2
  skills folders: 4

## Modules
      40
cli.ts
context
eval
events
evolution
harness.ts
index.ts
knowledge
llm-openai.ts
llm.ts
loop
memory
multi
security
tools
trajectory
types.ts
benchmark.ts
diagnose.ts
gate.ts
learning-signal.ts
loop.ts
propose.ts
scoreboard.ts
skill-draft.ts
snapshot.ts
types.ts
builtin.ts
discovery.ts
dynamic.ts
mcp-adapter.ts
registry.ts
orchestrator.ts
peer-review.ts
staged-roles.ts
harness.ts
judge.ts
significance.ts
stats.ts
store.ts
remaining=229s
