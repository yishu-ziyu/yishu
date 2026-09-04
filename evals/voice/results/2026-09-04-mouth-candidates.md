## Grok Voice

Date: 2026-09-04
Runner: `node evals/voice/exp6-grok-voice/probe.mjs`
Transport: HTTP `curl -4` (honors HTTPS_PROXY); remote WS = HTTP CONNECT via 127.0.0.1:7897 then TLS; 8317 loopback direct

### Verdict

S2S works with subscription OAuth (session.created received)

### Auth

- source: gmail xAI json (type=xai, oauth)
- oauth access len: 810
- expired in past: false
- expired at: 2026-09-04T17:10:00.000Z
- refreshed: false (not_expired)
- token endpoint host: auth.x.ai
- jwt scope api:access: true; grok-cli:access: true
- env HTTPS_PROXY: 127.0.0.1:7897

### HTTP

| call | status | transport | note |
| --- | ---: | --- | --- |
| GET /v1/models (ids matching /voice\|realtime\|tts\|stt/i) | 200 | curl-4 | ids: (none);  |
| GET /v1/tts/voices | 200 | curl-4 | voice count=28;  |
| POST /v1/realtime/client_secrets | 200 | curl-4 | issued=true valueLen=107 expiresAtPresent=true |
| POST /v1/tts text=hiya voice_id=eve | 200 | curl-4 | audio bytes=14976 (saved under .work, not repo) |

### WebSocket

| target | upgraded | http | first event type | close | note |
| --- | --- | ---: | --- | --- | --- |
| wss://api.x.ai/v1/realtime?model=grok-voice-latest | true | 101 | session.created | —  |  |
| ws://127.0.0.1:8317/v1/realtime?model=grok-voice-latest | false | 400 | — | —  | Invalid Codex live call ID; 8317 api-keys count=1 lens=48 |

### 8317 listen

```
COMMAND   PID      USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
cli-proxy 714 mahaoxuan   10u  IPv4 0xf8579fb2098039e5      0t0  TCP 127.0.0.1:8317 (LISTEN)
```

### Reading

- Direct Node https to api.x.ai times out on this laptop; curl through the local HTTPS proxy succeeds. Same 7897 path as the product's URLSession pit.
- Subscription OAuth opened Grok Voice when the WS upgraded and first event was session.created. Catalog omit on GET /v1/models is not a deny.
- 8317 does not proxy Voice WS (expect a non-101). Product path would be Swift to api.x.ai with OAuth refresh, not 8317.
- Audio from TTS, if any, is only under `.work/voice-experiments/exp6/`.

## Chat mouth candidates

Date: 2026-09-04
Runner: `node evals/voice/exp6-mouth/run.mjs` (Node v22.23.1)

### Method

OpenAI-compatible streaming `POST /chat/completions`. Frozen system = `YISHU_SYSTEM_PROMPT` with dummy user name 「用户」, same every turn (no trail). promptChars=2027. 10 turns, 400 ms apart, alternating 「在吗」 / 「今天天气怎么样」. Timeout 30 s. Extra oneshot `max_tokens: 80`.
Timers from request send (t0): sse = first body bytes, reason = first non-empty `delta.reasoning_content` (or `reasoning` / `think`), visible = first non-empty `delta.content`, done = stream end. reasoningChars = reasoning length before first visible. visible−sse = visible − sse.

### Environment

- STEPFUN_API_KEY length=65
- STEPFUN_STEP_PLAN_API_KEY length=64
- Step Plan chat path: `/step_plan/v1/chat/completions` (host api.stepfun.com)
- Step key used: STEPFUN_API_KEY
- 8317 cli-proxy api-keys count=1 length=48
- 8317 GET /v1/models status=200 n_ids=43 contains `grok-4.20-0309-non-reasoning`=true

### M2.5 baseline (card)

| n | utt | sse | reason | visible | done | reasoningChars | visible−sse |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| p50 | (card) | 438 | — | 2248 | — | 196 | 1603 |

### `step-3.5-flash` via Step Plan

| n | utt | sse | reason | visible | done | reasoningChars | visible−sse |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 在吗 | 11711 | 11712 | 15110 | 15135 | 160 | 3399 |
| 2 | 今天天气怎么样 | 305 | 305 | 3700 | 3864 | 1541 | 3395 |
| 3 | 在吗 | 1510 | 1510 | 2153 | 2174 | 86 | 643 |
| 4 | 今天天气怎么样 | 310 | 310 | 732 | 965 | 43 | 422 |
| 5 | 在吗 | 282 | 282 | 3050 | 3081 | 505 | 2768 |
| 6 | 今天天气怎么样 | 13172 | 13172 | 21159 | 21181 | 1198 | 7987 |
| 7 | 在吗 | 338 | 338 | 2341 | 2375 | 351 | 2003 |
| 8 | 今天天气怎么样 | 381 | 382 | 6249 | 6346 | 995 | 5868 |
| 9 | 在吗 | 377 | 378 | 985 | 1005 | 90 | 608 |
| 10 | 今天天气怎么样 | 374 | 375 | 11995 | 12026 | 1969 | 11621 |

| n | utt | sse | reason | visible | done | reasoningChars | visible−sse |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| p50 | all | 376 | 377 | 3375 | 3473 | 428 | 3082 |
| p50 | 在吗 | 377 | 378 | 2341 | 2375 | 160 | 2003 |
| p50 | 今天天气怎么样 | 374 | 375 | 6249 | 6346 | 1198 | 5868 |

Oneshot `max_tokens: 80` (天气; not in p50):

| n | utt | sse | reason | visible | done | reasoningChars | visible−sse |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| oneshot | 今天天气怎么样 | 369 | 369 | — | 1287 | 142 | — |

### `grok-4.20-0309-non-reasoning` via 8317

| n | utt | sse | reason | visible | done | reasoningChars | visible−sse |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 在吗 | 978 | — | 978 | 981 | 0 | 0 |
| 2 | 今天天气怎么样 | 1620 | — | 1620 | 1878 | 0 | 0 |
| 3 | 在吗 | 1604 | — | 1604 | 1626 | 0 | 0 |
| 4 | 今天天气怎么样 | 1051 | — | 1051 | 1171 | 0 | 0 |
| 5 | 在吗 | 956 | — | 956 | 960 | 0 | 0 |
| 6 | 今天天气怎么样 | 990 | — | 990 | 1186 | 0 | 0 |
| 7 | 在吗 | 1100 | — | 1100 | 1146 | 0 | 0 |
| 8 | 今天天气怎么样 | 987 | — | 987 | 1278 | 0 | 0 |
| 9 | 在吗 | 1156 | — | 1156 | 1179 | 0 | 0 |
| 10 | 今天天气怎么样 | 2559 | — | 2560 | 2666 | 0 | 1 |

| n | utt | sse | reason | visible | done | reasoningChars | visible−sse |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| p50 | all | 1076 | — | 1076 | 1183 | 0 | 0 |
| p50 | 在吗 | 1100 | — | 1100 | 1146 | 0 | 0 |
| p50 | 今天天气怎么样 | 1051 | — | 1051 | 1278 | 0 | 0 |

Oneshot `max_tokens: 80` (天气; not in p50):

| n | utt | sse | reason | visible | done | reasoningChars | visible−sse |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| oneshot | 今天天气怎么样 | 1061 | — | 1061 | 1244 | 0 | 0 |

### vs M2.5

| model | sse p50 | visible p50 | reasoningChars p50 | visible−sse p50 | 在吗 visible−sse p50 |
| --- | ---: | ---: | ---: | ---: | ---: |
| M2.5 baseline | 438 | 2248 | 196 | 1603 | — |
| step-3.5-flash | 376 | 3375 | 428 | 3082 | 2003 |
| grok-4.20-0309-non-reasoning | 1076 | 1076 | 0 | 0 | 0 |

### Spot-check (40 chars, 3 visible replies)

- grok-4.20-0309-non-reasoning #1 「在吗」: 在。
- grok-4.20-0309-non-reasoning #2 「今天天气怎么样」: 今天北京多云，16℃，挺舒服的，不冷不热。
- step-3.5-flash #5 「在吗」: 在的，说吧。

### Verdict (do not switch product defaults)

Hard bar: 「在吗」 visible−sse p50 ≤ 500 ms.
- `step-3.5-flash`: 在吗 visible−sse p50 = 2003 ms (n_ok=5) → does not meet the bar.
- `grok-4.20-0309-non-reasoning`: 在吗 visible−sse p50 = 0 ms (n_ok=5) → MEETS the bar.

Either model meeting the bar is a candidate for the main agent to consider; this harness does not change defaults.

Notes for the main agent:

- `step-3.5-flash` still emits `reasoning_content` on every turn (not a non-think mouth). 在吗 reasoningChars p50 160 vs M2.5 196. Oneshot `max_tokens: 80` produced no visible token (reasoning filled the budget). Weather often puts `<tool_call>` in visible text.
- `grok-4.20-0309-non-reasoning` reasoningChars=0; visible−sse p50=0 because the first SSE chunk already contains `delta.content`. Hard bar is that gap, not t0→visible. 在吗 t0→visible p50 is 1100 ms (M2.5 visible 2248 / sse 438). Weather replies invent city/temp (no tools).
- Do not switch product defaults from this harness.
