# exp3 — companion TTS bake-off (MiniMax vs StepFun)

Pick a streaming default for 奕枢’s spoken replies. Only MiniMax and StepFun (keys on this machine).

```bash
node evals/voice/exp3-tts/run.mjs
node evals/voice/exp3-tts/run-ws.mjs   # Step Plan WebSocket + 16-file blind-short
```

Reads `apps/clicky/worker/.dev.vars` at runtime. Never prints key values.

## What it measures

- **t_first_audio_ms** — request start → first usable audio bytes
- **t_total_ms**, **audio_duration_ms** (`afinfo`, no playback), **realtime_factor**
- Sentence 1 「嗯，在。」: 10 runs; others: 5. p50 / p95.
- MiniMax `stream:true` (hex SSE) vs product `stream:false`
- StepFun HTTP `stream_format=sse` vs full body
- Emotion: MiniMax `voice_setting.emotion` and 2.8 tags `(laughs)` / `(sighs)` / `(breath)`; StepFun 2.5 `instruction` + `（…）`; `step-tts-mini` `voice_label.emotion`
- Tag syntax check: official parentheses vs the brief’s `[laughs]` brackets, using subtitle fields when the vendor returns them

## Outputs

- Audio: `.work/voice-experiments/tts/<engine>-<model>-sNN-<variant>.mp3`
- Blind listen (shuffled ids): `.work/voice-experiments/tts/blind/` + `blind-key.json`
- Report: `evals/voice/results/2026-09-04-exp3-tts.json` and `.md`

Blind: play files in `blind/` in any order, then open `blind-key.json`.
