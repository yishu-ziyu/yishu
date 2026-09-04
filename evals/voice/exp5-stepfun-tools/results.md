# exp5 — StepFun realtime function-call probe

- Model: `stepaudio-2.5-realtime` via Step Plan `wss://api.stepfun.com/step_plan/v1/realtime`
- Key: `STEPFUN_STEP_PLAN_API_KEY` length=64 (never printed)
- Any `function_call`: **yes**
- Logs: `.work/voice-experiments/exp5/`
- Script: `evals/voice/exp5-stepfun-tools/probe.mjs`

## Matrix

| config | n | accepted | function_call | note |
|---|---:|---|---|---|
| 1-text-audio-session-tools | 2 | yes | no | CN instructions; spoke 「我这就帮你查一下。」 |
| 2-text-only-modalities | 2 | yes | no | `modalities:["text"]` accepted (doc says fixed text+audio); same spoken stall |
| 3a-tools-in-response-create | 2 | yes | no | session tools absent; spoke fabricated 「北京现在是25度。」 |
| 3b-tools-in-both | 2 | yes | no | same stall as 1 |
| 4-english | 2 | yes | **yes** `get_weather` | EN instructions+tool desc; premature `function_call_output` → `ongoing response already exists` |
| 4-english-complete | 2 | yes | **yes** `{"city":"Beijing"}` | waited for `response.done` then output; spoke 「21°C … sunny」 |
| 5-force-instruction-cn | 2 | yes | no | force-call CN line; fabricated 「北京现在22度，天气晴朗。」 |
| 5b-force-instruction-en | 2 | yes | 1/2 | EN force line; one refusal, one `get_weather` |
| 6a tool_choice omitted | 2 | yes | no | CN + force; fabricated 22° |
| 6b tool_choice `"auto"` | 2 | yes | no | accepted; still no call |
| 6c tool_choice `"required"` | 2 | yes | no | accepted; still no call |
| 6d `{type:function,function:{name}}` | 2 | **no** `invalid event format` | — | |
| 6e `{type:function,name}` | 2 | **no** `invalid event format` | — | |
| 7-two-tools | 2 | yes | no | get_weather+ask_yishu, `required`; fabricated / stall |
| 8-audio-4-english | 2 | yes | no | **wrong clip** (duplex U2 屏幕报错); English session talked about the screen |
| 8-audio-english-weather | 2 | yes | no | VAD `speech_started`, never `speech_stopped` / no response |
| 8b-audio-cn-utterance | 2 | yes | no | same VAD hang |
| 8c/8d commit+VAD | 2+2 | yes | no | error `commit when server vad` |
| 8e-audio-en-novad | 2 | yes | **yes** | no VAD, `commit`+`response.create`; spoke tool result |
| 8f-audio-cn-novad | 2 | yes | **yes** | same English session, 「北京现在几度？」 audio; spoke 「北京现在21度，天气晴朗。」 |
| 9-step-1o-audio | 1 | no | — | WS upgrade failed: `non-101 status code` (not a parsed 402/404) |
| 9-step-audio-2 | 1 | no | — | same |

## Server event types observed

`session.created` `session.updated` `conversation.item.created` `conversation.item.input_audio_transcription.completed` `error` `input_audio_buffer.committed` `input_audio_buffer.speech_started` `input_audio_buffer.speech_stopped` `response.audio.delta` `response.audio.done` `response.audio_transcript.delta` `response.audio_transcript.done` `response.content_part.added` `response.content_part.done` `response.created` `response.done` `response.function_call_arguments.delta` `response.function_call_arguments.done` `response.output_item.added` `response.output_item.done`

Function-call shape matches OpenAI Realtime: `item.type=function_call`, `name=get_weather`, `call_id`, then `response.function_call_arguments.done` with JSON arguments.

## Minimal working config

English `session.update` + nested StepFun tools + text or committed audio:

```json
{
  "type": "session.update",
  "session": {
    "modalities": ["text", "audio"],
    "instructions": "You are a helpful AI chat assistant. Be brief. You speak English.",
    "voice": "linjiajiejie",
    "input_audio_format": "pcm16",
    "output_audio_format": "pcm16",
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city, including temperature and conditions.",
        "parameters": {
          "type": "object",
          "properties": { "city": { "type": "string", "description": "City name, e.g. Beijing" } },
          "required": ["city"]
        }
      }
    }]
  }
}
```

Then `conversation.item.create` `{type:"message", role:"user", content:[{type:"input_text", text:"What's the temperature in Beijing right now?"}]}` + `response.create`. Wait for `response.function_call_arguments.done` **and** that `response.done`. Then `conversation.item.create` `{type:"function_call_output", call_id, output:"北京 21 度，晴。"}` + `response.create`.

Audio: omit `turn_detection` (do not `commit` while `server_vad` is on), `input_audio_buffer.append` + `commit` + `response.create`. Same English session fires `get_weather` for both English TTS and 「北京现在几度？」.

Do not send `function_call_output` on the incomplete `output_item.added` — that races the in-flight response (`ongoing response already exists`).

## Verdict

(a) The model **can** emit function calls. Minimal config is English instructions + nested `get_weather` in `session.update` + text `response.create` (or audio with VAD off + commit). Server sends `response.function_call_arguments.done` (`get_weather`, `{"city":"Beijing"}`) and will speak the `function_call_output`. Chinese instructions never produced a call in this matrix — not even `tool_choice:"required"` or an explicit 「必须调用 get_weather」 line; the model invented a temperature. Object `tool_choice` is rejected; string `"auto"`/`"required"` are accepted but do not override the Chinese no-call behavior. Earlier duplex harness was wrong because it used **Chinese** instructions/audio and counted 0/12 as “tools unsupported”; tools are accepted and do fire. Audio does not uniquely suppress tools: with the English config, weather audio called the tool 4/4. `step-1o-audio` / `step-audio-2` on this Step Plan path failed WS upgrade (non-101), not measured.
