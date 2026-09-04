# Exp2 — speech-to-text latency

From the repo root. Secrets are read at runtime from `apps/clicky/worker/.dev.vars`. Do not print them.

```bash
node evals/voice/exp2-stt/synth.mjs
node evals/voice/exp2-stt/run.mjs
```

`synth.mjs` writes 16 kHz mono WAVs and ground truth to `.work/voice-experiments/stt/`.
`run.mjs` runs methods A/B/C, 5 samples × 3 trials, and writes:

- `evals/voice/results/2026-09-04-exp2-stt.json`
- `evals/voice/results/2026-09-04-exp2-stt.md`

## Single-shot helpers

```bash
node evals/voice/exp2-stt/run-stepfun.mjs --method a --wav .work/voice-experiments/stt/s01.wav --text '帮我把这个窗口挪到左边。'
node evals/voice/exp2-stt/run-stepfun.mjs --method b --wav .work/voice-experiments/stt/s01.wav --text '帮我把这个窗口挪到左边。'

node evals/voice/exp2-stt/run-step-plan.mjs
```

Apple STT was rejected by the owner (人评). Leave `.app` artifacts. Step Plan methods D–G use `STEPFUN_STEP_PLAN_*` from worker `.dev.vars`.

That packs `.work/voice-experiments/stt/AppleSTTProbe.app`, launches it with `open -W` (Speech Recognition dialog — click Allow), then runs on-device and server-assisted modes.
