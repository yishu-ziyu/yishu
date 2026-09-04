# exp4-duplex — StepFun full-duplex mouth/ears + ask_yishu brain

Throwaway lab harness. Does not touch product code.

## Command

From the repo root (Node 22, no extra npm deps):

```bash
node evals/voice/exp4-duplex/run.mjs
```

Secrets are read at runtime from `apps/clicky/worker/.dev.vars` (`STEPFUN_STEP_PLAN_API_KEY`, `STEPFUN_STEP_PLAN_BASE`, MiniMax TTS). Never printed.
Audio and per-run event logs go to `.work/voice-experiments/duplex/` (gitignored).
Results: `evals/voice/results/2026-09-04-exp4-duplex.json` and `.md` (Step Plan run appended).

## This run

- **Model actually used:** `stepaudio-2.5-realtime`
- **Sample rate:** 24000 Hz pcm16
- **Voice:** `linjiajiejie`
- **Tools:** `stepfun-nested`
- **Function calling:** true
- **Endpoint:** `wss://api.stepfun.com/step_plan/v1/realtime?model=stepaudio-2.5-realtime`

## S6–S8

Re-run only these: `node evals/voice/exp4-duplex/run.mjs --s6-s8`

## English instructions, VAD off

`node evals/voice/exp4-duplex/run.mjs --en-novad`

## Concrete tools

`node evals/voice/exp4-duplex/run.mjs --concrete-tools`
