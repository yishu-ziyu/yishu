# agent-core smoke acceptance

Timestamp (UTC): **2026-08-06T13:04:00Z** → **2026-08-06T13:04:13Z**

Package: `@yishu/agent-core`  
Workspace: `/Users/mahaoxuan/Documents/我的agent`

## Summary

| Metric | Value |
|--------|-------|
| Commands run | 9 |
| Passed | **9** |
| Failed | **0** |
| Unit tests | **153 / 153** pass |
| Eval gold | **7 / 7** (100%) |
| Judge-eval gold + judge | **7 / 7** + **7 / 7** |

Overall: **PASS**

## Command results

| # | Command | Result | Notes |
|---|---------|--------|-------|
| 1 | `pnpm agent:test` | PASS | tests 153, suites 24, fail 0 |
| 2 | `pnpm agent:eval` | PASS | pass rate 100.0% (7/7); Wilson 100% [64.6%, 100.0%] |
| 3 | `pnpm agent -- judge-eval` | PASS | gold 7/7; judge 7/7 (heuristic); mean score 0.893 |
| 4 | `pnpm agent -- mcp-list` | PASS | 2 tools: `mcp_example_echo`, `mcp_example_time_now` |
| 5 | `pnpm agent -- run "关于 ReAct 模式"` | PASS | tools=`knowledge_search`, accepted=true |
| 6 | `pnpm agent -- peer "计算 17*19+3"` | PASS | round 1 ACCEPT, tools=`code_exec`, answer 326 |
| 7 | `pnpm agent -- staged "列目录 ."` | PASS | planner→worker→checker, stages=3 |
| 8 | `pnpm agent -- heartbeat-demo` | PASS | heartbeats=1, results=2 (2+3→5, 10+5→15) |
| 9 | `pnpm agent -- experience` | PASS | last 10 of 138 signals from `data/evolution/experience.jsonl` |

## Convenience scripts added (root `package.json`)

- `agent:judge` → `pnpm --filter @yishu/agent-core cli -- judge-eval`
- `agent:mcp` → `pnpm --filter @yishu/agent-core cli -- mcp-list`
- `agent:heartbeat` → `pnpm --filter @yishu/agent-core cli -- heartbeat-demo`
- `agent:experience` → `pnpm --filter @yishu/agent-core cli -- experience`
- `agent:evolve` (pre-existing)

## CLI additions

- `experience` / `replay`: print last N=10 learning signals (outcome, tools, lessons) from `data/evolution/experience.jsonl`; friendly message if missing.

## Dist build

```text
pnpm --filter @yishu/agent-core build  → OK (tsc)
```

Final: tests 153, path fix for replay/promote-skill, time ~21:10
