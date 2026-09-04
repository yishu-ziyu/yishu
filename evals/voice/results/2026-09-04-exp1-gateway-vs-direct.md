# Exp1: gateway vs direct chat latency

Date: 2026-09-04
Runner: `node evals/voice/exp1-gateway/run.mjs` (Node v22.23.1)

## Method

OpenAI-compatible `POST /chat/completions` with `stream: true`, `max_tokens: 60`.
System: 「你是奕枢，一个说话简短的朋友。」 User: 「用一句话说今天适合做什么。」
Short = 20 sequential runs, 500 ms apart. Long = same user prompt, system padded to ~4000 Chinese characters, 5 runs.
Timers start at request send: t_connect = response headers, t_first_sse = first SSE line, t_first_token = first non-empty content delta, t_done = stream end.
Retries: at most twice per run. Unreachable or unauthorized routes are one result row, then skipped.

## Environment

- CHAT_BASE host=api.minimaxi.com port=443 path=/v1
- CHAT_MODEL=MiniMax-M3
- STEPFUN_CHAT_BASE host=api.stepfun.com port=443
- STEPFUN_CHAT_MODEL=step-3.7-flash
- Key lengths: MINIMAX_API_KEY=125, MINIMAX_TTS_MODEL=13, MINIMAX_VOICE_ID=22, MINIMAX_TTS_URL=34, STEPFUN_API_KEY=64, STEPFUN_ASR_MODEL=17, STEPFUN_CHAT_BASE=26, STEPFUN_CHAT_MODEL=14, CHAT_API_KEY=125, CHAT_BASE=27, CHAT_MODEL=10, YISHU_VOICE_PROXY_TOKEN=0
- Gateway GET /v1/models status=401 ids=(none) note=unreachable: 401
- MiniMax direct accepted model: MiniMax-M3
- App proxy 8787: needs runtime token; skipped
- Listening (`lsof -nP -iTCP:8317 -iTCP:8787 -sTCP:LISTEN`):

```
COMMAND     PID      USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
cli-proxy   714 mahaoxuan   10u  IPv4 0xf8579fb2098039e5      0t0  TCP 127.0.0.1:8317 (LISTEN)
node      20422 mahaoxuan   12u  IPv4  0x16c92141b8d8fb6      0t0  TCP 127.0.0.1:8787 (LISTEN)
```

## p50 / p95

| route | model | prompt | n ok | first-token p50 | first-token p95 | done p50 | done p95 | note |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| direct-minimax | MiniMax-M3 | short | 20/20 | 1179.4 | 2602.6 | 2116.1 | 3388.5 |  |
| direct-minimax | MiniMax-M3 | long | 5/5 | 1558.4 | 2424 | 3566.7 | 5967 |  |
| gateway-8317 | MiniMax-M3 | short | 0/1 | — | — | — | — | unreachable: 401; {"error":"Invalid API key"} |
| gateway-8317 | grok-4.6 | short | 0/1 | — | — | — | — | unreachable: 401; {"error":"Invalid API key"} |
| gateway-8317 | grok-4.5 | short | 0/1 | — | — | — | — | unreachable: 401; {"error":"Invalid API key"} |
| gateway-8317 | grok-4.3 | short | 0/1 | — | — | — | — | unreachable: 401; {"error":"Invalid API key"} |
| app-proxy-8787 | MiniMax-M3 | short | 0/1 | — | — | — | — | needs runtime token; skipped |
| stepfun | step-3.7-flash | short | 0/1 | — | — | — | — | unreachable: 402; {"error":{"message":"You exceeded your current quota, please check your plan and billing details","type":"quota_exceeded"}} |

## Caveats

- First-token is spoken-content delta only, not reasoning.
- `stream_options.include_usage` is requested; output token counts are missing when the vendor omits a usage chunk.
- CHAT_BASE in `.dev.vars` is the product chat pointer; 8317 is still probed as the cli-proxy exit even when CHAT_BASE is not that host.
- 8787 requires `YISHU_VOICE_PROXY_TOKEN` from the running app process, not from `.dev.vars`. This harness does not read another process's memory.
- Sample size is small (20 / 5). p95 is noisy.
- Sequential runs on a live laptop: local CPU, network, and gateway load are not isolated.

## gateway-8317 (retry)

Config: `/Users/mahaoxuan/.cli-proxy-api/config.yaml`. Client auth field: `api-keys` (1 key, len 48). Upstream auth-dir prefixes: antigravity, codex, kimi, xai, xai. Localhost still requires a key. Bearer and x-api-key both 200; CHAT_API_KEY 401.

Gateway remaining kimi/gpt-5.6-terra/grok-4.3 oneshots skipped after process death; MiniMax suites completed here.

| route | model | prompt | n ok | first-token p50 | first-token p95 | done p50 | done p95 | note |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| gateway-8317 | grok-4.6 | short | 20/20 | 11386 | 17387.5 | 12074.5 | 17816.1 |  |
| gateway-8317 | grok-4.6 | long | 5/5 | 8770.7 | 19513.7 | 8818.5 | 20074 |  |
| gateway-8317 | gpt-5.4-mini | short | 20/20 | 3637.3 | 25421.9 | 4404.4 | 25967.9 |  |
| gateway-8317 | gpt-5.4-mini | long | 5/5 | 3863.5 | 4732.2 | 4449.6 | 5478.1 |  |
| gateway-8317 | grok-3-mini | short | 20/20 | 4746.2 | 25724.4 | 4842.4 | 25854.7 |  |
| gateway-8317 | grok-3-mini | long | 5/5 | 6865 | 11142.7 | 6916.7 | 11383.3 |  |
| gateway-8317 | grok-3-mini-fast | short | 20/20 | 4905.3 | 7344.4 | 5020.4 | 7492.1 |  |
| gateway-8317 | grok-3-mini-fast | long | 5/5 | 26314.9 | 30329.5 | 26526.5 | 30499.5 |  |
| gateway-8317 | grok-composer-2.5-fast | short | 20/20 | 8217.5 | 27309.8 | 8358.8 | 27686.5 |  |
| gateway-8317 | grok-composer-2.5-fast | long | 5/5 | 11825.7 | 42546.6 | 12125.8 | 42768.1 |  |
| gateway-8317 | gpt-5.3-codex-spark | short | 20/20 | 18152.3 | 64117.7 | 18189.7 | 64173.9 |  |
| gateway-8317 | gpt-5.3-codex-spark | long | 5/5 | 18480.7 | 31093.6 | 18481.9 | 31094.9 |  |
| gateway-8317 | grok-4.20-0309-reasoning (oneshot-probe) | short | 1/1 | 3064.5 | 3064.5 | 3295.8 | 3295.8 |  |
| gateway-8317 | gpt-5.4 (oneshot-probe) | short | 1/1 | 113018 | 113018 | 113041.4 | 113041.4 |  |
| gateway-8317 | codex-auto-review (oneshot-probe) | short | 1/1 | 17554.8 | 17554.8 | 20615.3 | 20615.3 |  |
| gateway-8317 | claude-opus-4-6-thinking (oneshot-probe) | short | 1/1 | 5207.6 | 5207.6 | 5682.4 | 5682.4 |  |
| gateway-8317 | gemini-3.6-flash-high (oneshot-probe) | short | 0/1 | — | — | — | — | unreachable: 400; {
  "error": {
    "code": 400,
    "message": "User location is not supported for the API use.",
    "status": "FAILED_PRECONDITION"
  }
} |
| gateway-8317 | gemini-pro-agent (oneshot-probe) | short | 0/1 | — | — | — | — | unreachable: 400; {
  "error": {
    "code": 400,
    "message": "User location is not supported for the API use.",
    "status": "FAILED_PRECONDITION"
  }
} |
| gateway-8317 | grok-4.5 (oneshot-probe) | short | 1/1 | 4852.4 | 4852.4 | 5204 | 5204 |  |
| gateway-8317 | grok-4.20-multi-agent-0309 (oneshot-probe) | short | 1/1 | 4914.6 | 4914.6 | 5302 | 5302 |  |
| gateway-8317 | claude-sonnet-4-6 (oneshot-probe) | short | 1/1 | 9517.7 | 9517.7 | 9970.7 | 9970.7 |  |
| gateway-8317 | gemini-3.1-pro-low (oneshot-probe) | short | 0/1 | — | — | — | — | unreachable: 400; {
  "error": {
    "code": 400,
    "message": "User location is not supported for the API use.",
    "status": "FAILED_PRECONDITION"
  }
} |
| gateway-8317 | gemini-3.7-flash-high (oneshot-probe) | short | 0/1 | — | — | — | — | unreachable: 400; {
  "error": {
    "code": 400,
    "message": "User location is not supported for the API use.",
    "status": "FAILED_PRECONDITION"
  }
} |
| gateway-8317 | gpt-5.6-luna (oneshot-probe) | short | 1/1 | 47860 | 47860 | 47882.3 | 47882.3 |  |
| gateway-8317 | gpt-5.5 (oneshot-probe) | short | 0/1 | — | — | — | — | unreachable: TimeoutError |
| gateway-8317 | gpt-5.6-sol (oneshot-probe) | short | 0/1 | — | — | — | — | unreachable: TimeoutError |
| gateway-8317 | gemini-3-flash (oneshot-probe) | short | 0/1 | — | — | — | — | unreachable: 400; {
  "error": {
    "code": 400,
    "message": "User location is not supported for the API use.",
    "status": "FAILED_PRECONDITION"
  }
} |
| gateway-8317 | gemini-3.1-flash-lite (oneshot-probe) | short | 0/1 | — | — | — | — | unreachable: 400; {
  "error": {
    "code": 400,
    "message": "User location is not supported for the API use.",
    "status": "FAILED_PRECONDITION"
  }
} |

## minimax fast tier

GET https://api.minimaxi.com/v1/models status=200 chat ids: MiniMax-M3, MiniMax-M2.7, MiniMax-M2.7-highspeed, MiniMax-M2.5, MiniMax-M2.5-highspeed, MiniMax-M2.1, MiniMax-M2.1-highspeed, MiniMax-M2.
Docs: M3 thinking on by default; `thinking: { type: "disabled" }` skips reasoning. Also probed `reasoning_effort: "low"` and `max_tokens: 30`.

| route | model | prompt | n ok | first-token p50 | first-token p95 | done p50 | done p95 | note |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| direct-minimax | MiniMax-M3 | short | 20/20 | 1728.6 | 7589 | 3175.8 | 14058.2 |  |
| direct-minimax | MiniMax-M2.7 | short | 20/20 | 621.6 | 1296.6 | 2612.1 | 3171.7 |  |
| direct-minimax | MiniMax-M2.7-highspeed | short | 20/20 | 723.9 | 1372.6 | 2136.4 | 2845.4 |  |
| direct-minimax | MiniMax-M2.5 | short | 20/20 | 520.3 | 1492.7 | 1771.2 | 2750.1 |  |
| direct-minimax | MiniMax-M2.5-highspeed | short | 20/20 | 680.7 | 1348.4 | 1967.7 | 2922.1 |  |
| direct-minimax | MiniMax-M2.1 | short | 20/20 | 529.2 | 1009.5 | 1727 | 2233.9 |  |
| direct-minimax | MiniMax-M2.1-highspeed | short | 20/20 | 933.6 | 2035.6 | 2226.2 | 3139.8 |  |
| direct-minimax | MiniMax-M2 | short | 20/20 | 657.8 | 1534.2 | 1937.1 | 2756.3 |  |
| direct-minimax | MiniMax-M3 (thinking-disabled) | short | 20/20 | 2019.7 | 14289.2 | 2314.9 | 14666.2 |  |
| direct-minimax | MiniMax-M3 (reasoning_effort-low) | short | 20/20 | 1541.4 | 12569.5 | 2653.4 | 12888.3 |  |
| direct-minimax | MiniMax-M3 (max_tokens-30) | short | 20/20 | 2320.3 | 11459.4 | 2714.6 | 15200.6 |  |
| direct-minimax | MiniMax-M3 (thinking-disabled+max_tokens-30) | short | 20/20 | 1865.4 | 18044.2 | 2724.7 | 18620.7 |  |

## Recommendation (after retry)

For 实时对话, default to MiniMax-M2.5 direct (`api.minimaxi.com`): short first-token p50 520 ms / p95 1493 ms. MiniMax-M2.1 is the other ≤600 ms option (p50 529 ms). M3 stays over budget (p50 1179–1729 ms across two sessions). `thinking: {type:"disabled"}`, `reasoning_effort: "low"`, and `max_tokens: 30` did not cut M3 first-token (p50 1541–2320 ms; p95 up to 18 s). `*-highspeed` was not faster than the matching non-highspeed id on first-token. Gateway auth works once you load `~/.cli-proxy-api/config.yaml` `api-keys` (Bearer or x-api-key; localhost still requires a key). Fastest full gateway suite is gpt-5.4-mini at 3637 ms p50 — useful for a 网关/直连 toggle (Grok/GPT/Claude), not as the voice default.
