# Device trial verifier

`trial-verifier.mjs` is a pure, fail-closed verifier for one real-device
observation. A runner supplies raw, content-safe events; the verifier derives
`pass`, `fail`, or `invalid`. It never accepts a caller-supplied aggregate
result.

The observation is deliberately smaller than a transcript or screen dump:

- no transcript, screenshot, path, window title, memory text, prompt, URL,
  cookie, authorization, API key, token, password, email, username, label,
  credential, secret, or equivalent spelling with `_`, `-`, or spaces;
- no `passed`, `taskTerminal`, or `receipts` field;
- opaque state, memory, scope, and receipt identifiers are lowercase SHA-256
  hashes;
- every object is closed-schema. Unknown fields and unknown event kinds are
  invalid, rather than ignored.

## Contract shapes

The top-level object has `schemaVersion: 1`, a safe `trialId`, and an ordered
`events` array. `contract` selects one of these shapes:

- `t1.ptt`: exactly one `ptt_pressed` and `ptt_released`; `ptt_released` carries
  the monotonic `ptt.key_up` `durationMs`, which must be at least 5500 ms
  (the second-level `observedAt` values are not used for duration); one
  `context_recaptured` event must use `recaptureStale` or
  `recaptureSceneChanged` after release and carry
  `sourceDimensionsAvailable: true`; the only terminal must be verified; a
  human `latest_screen_answer` judgment must be correct; failure and
  false-completion events fail the trial.
- `t2.ax`: one `ax_action` event (the runner's safe projection of
  `computer.action.completed`) whose production
  fields are `method: "ax_press"`, `code: "verified_accessibility"`,
  `verified: true`, `retryCount: 0`, and `status: "verified"`; exactly one
  `action_receipt`; the verified terminal must repeat that receipt's same
  opaque hash, so a later unrelated model completion cannot close the action;
  opaque Finder `before` and `after` states from the same
  opaque `finderInstanceHash`, and an `after` relation of `direct_parent`;
  `opaqueStateHash` must change; a verified terminal is required, and retry,
  unknown-commit, failure, false-completion, failed, unverified, or unknown
  action outcomes fail the trial.
- `t3.memory`: one each of `remembered`, `used`, `forgotten`, and
  `notUsedAfterRestart`, with one `app_restart` between the latter two; a
  human `recall_before_forget` and `absence_after_restart` judgment must each
  be correct; every event must repeat the same memory and scope hashes, and
  any post-restart use or resurrection fails the trial.

Use:

```js
import { verifyDeviceTrial } from "./trial-verifier.mjs";

const result = verifyDeviceTrial(observation);
// { status: "pass" | "fail" | "invalid", reasons: string[] }
```

`device-observation.schema.json` is the interchange contract. The executable
validator mirrors its closed properties and adds the cross-event checks that
JSON Schema alone cannot express.

## Real-device runner

`yishu-device-runner.mjs` uses an `arm -> close -> replay` protocol. It binds a
trial to the installed formal App, the current committed runner, the quality-log
prefix, and a provenance file. State and observation files are created with
mode `0600` and are never overwritten.

```sh
node evals/capability/device/yishu-device-runner.mjs \
  --arm --scenario device.t1.ptt --trial 1 \
  --provenance /absolute/provenance.json --state /absolute/new-state.json

node evals/capability/device/yishu-device-runner.mjs \
  --close --state /absolute/state.json \
  --external-safe /absolute/human-and-finder-observation.json \
  --output /absolute/observations/device.t1.ptt-1.json

YISHU_E2E_DEVICE=1 \
YISHU_CAPABILITY_DEVICE_RUNNER="$PWD/evals/capability/device/yishu-device-runner.mjs" \
YISHU_CAPABILITY_DEVICE_PROVENANCE=/absolute/provenance.json \
YISHU_DEVICE_OBSERVATION_DIR=/absolute/observations \
node script/run-capability-eval.mjs --scenario device.t1.ptt --gate
```

The close step accepts only the contract-specific, content-free external facts:
the T1 human judgment, T2 opaque Finder before/after state, or the two T3 human
judgments. Replay writes only the raw observation to stdout; the gate always
derives the result again through `verifyDeviceTrial`.

This is a falsifiable product-evaluation boundary, not a cryptographic audit
log. It prevents the App or runner from supplying its own aggregate pass result
and detects malformed, mixed-process, stale, or contradictory evidence. It does
not defend against a malicious local administrator who can rewrite the App's
quality log or fabricate the human/Finder observation file. Real-device
acceptance therefore still requires a named human observer and preserved
private raw observations.
