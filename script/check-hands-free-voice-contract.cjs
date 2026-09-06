#!/usr/bin/env node
/**
 * Issue #35 duplex voice contract.
 *
 * Counts deterministic production-seam failures for continuous listening.
 * Zero is the permanent ceiling for the scenario matrix. Do not satisfy
 * the metric with a standalone state machine that is not wired to
 * YishuVoiceSessionController / BuddyDictationManager.
 *
 * Usage: node script/check-hands-free-voice-contract.cjs
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SWIFT = path.join(ROOT, "apps/clicky/leanring-buddy");
const TESTS = path.join(ROOT, "apps/clicky/leanring-buddyTests");

function read(rel) {
  const full = path.join(ROOT, rel);
  try {
    return fs.readFileSync(full, "utf8");
  } catch (err) {
    console.error(`hands-free voice contract FAILED: cannot read ${rel}: ${err.message}`);
    process.exit(2);
  }
}

function collectSwift(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`hands-free voice contract FAILED: cannot read ${dir}: ${err.message}`);
    process.exit(2);
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["Tests", "build", "DerivedSources"].includes(entry.name)) continue;
      collectSwift(full, out);
    } else if (entry.name.endsWith(".swift")) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

const session = read("apps/clicky/leanring-buddy/YishuVoiceSessionController.swift");
const policy = read("apps/clicky/leanring-buddy/YishuHandsFreeListeningPolicy.swift");
const duplex = read("apps/clicky/leanring-buddy/CompanionManager+DuplexVoice.swift");
const companion = read("apps/clicky/leanring-buddy/CompanionManager.swift");
const dictation = read("apps/clicky/leanring-buddy/BuddyDictationManager.swift");
const tests = read(
  "apps/clicky/leanring-buddyTests/YishuHandsFreeVoiceContractTests.swift",
);
const sessionCode = stripComments(session);
const policyCode = stripComments(policy);
const duplexCode = stripComments(duplex);
const companionCode = stripComments(companion);
const dictationCode = stripComments(dictation);
const testsCode = stripComments(tests);

const scenarioFailures = [];

function failScenario(id, reason) {
  scenarioFailures.push(`${id}: ${reason}`);
}

if (!sessionCode.includes("setContinuousListeningEnabled")
    || !sessionCode.includes("func beginContinuousUtterance")
    || !testsCode.includes("threeTurnHandsFreeConversationNeedsNoShortcut")) {
  failScenario("A", "no continuous three-turn VoiceSession path");
}

if (!sessionCode.includes("continuousPhase = .armed")
    || !testsCode.includes("tenUtterancesNeedZeroRearm")) {
  failScenario("B", "no ten-utterance re-arm path");
}

if (!sessionCode.includes(".speechOnset")
    || !duplexCode.includes("handleDuplexSpeechOnset")
    || !duplexCode.includes("elevenLabsTTSClient.stopPlayback()")
    || /await[\s\S]{0,80}stopPlayback/.test(duplexCode)) {
  failScenario("C", "speech onset does not stop TTS synchronously");
}

const onsetCancelsRuntime =
  /cancelActiveRuntimeTurn|foregroundRuntimeExecution\.cancel|\.settle\s*\(|supersede/.test(
    duplexCode,
  );
if (
  onsetCancelsRuntime
  || !policyCode.includes("shouldCancelRuntimeOnSpeechOnset")
  || !policyCode.includes("return false")
  || !testsCode.includes("speechOnsetDoesNotCancelForegroundRuntime")
) {
  failScenario("D", "speech onset cancels or can cancel Runtime");
}

if (
  !policyCode.includes("echoResidualCeiling")
  || !dictationCode.includes("setVoiceProcessingEnabled")
  || !testsCode.includes("assistantPlaybackWithoutUserSpeechCreatesZeroTurns")
) {
  failScenario("E", "no self-echo gate for open-mic playback");
}

if (
  !sessionCode.includes("emptyOrNearSilence")
  || !testsCode.includes("silenceCreatesZeroTurns")
) {
  failScenario("F", "silence is not a non-turn");
}

if (
  !sessionCode.includes("disarmContinuousListening")
  || !sessionCode.includes("sessionGeneration &+= 1")
  || !testsCode.includes("disableDropsLateFinal")
) {
  failScenario("G", "disable does not drop late finals");
}

const pttRegressions =
  !sessionCode.includes("startPushToTalkFromKeyboardShortcut")
  || !sessionCode.includes("handleShortcutTransition")
  || !testsCode.includes("pttFallbackUnchangedWhenContinuousOff")
    ? 1
    : 0;

const duplicateAutoSubmissions =
  !sessionCode.includes("didEmitTerminalForGeneration")
  || !testsCode.includes("providerFinalAndLocalEndDoNotDoubleSubmit")
    ? 1
    : 0;

const silenceFalseTurns = scenarioFailures.some((row) => row.startsWith("F:"))
  ? 1
  : 0;

const assistantSelfTriggeredUserTurns = scenarioFailures.some((row) =>
  row.startsWith("E:"),
)
  ? 1
  : 0;

const speechOnsetRuntimeCancellations = scenarioFailures.some((row) =>
  row.startsWith("D:"),
)
  ? 1
  : 0;

const manualRearm =
  scenarioFailures.some((row) => row.startsWith("A:") || row.startsWith("B:"))
    ? 10
    : 0;

const swiftFiles = collectSwift(SWIFT);
let microphoneOwners = 0;
const microphoneOwnerFiles = [];
for (const file of swiftFiles) {
  const source = stripComments(fs.readFileSync(file, "utf8"));
  if (
    /AVAudioEngine\s*\(/.test(source)
    && /installTap\s*\(/.test(source)
    && /inputNode/.test(source)
  ) {
    microphoneOwners += 1;
    microphoneOwnerFiles.push(path.relative(ROOT, file));
  }
}

let realtimeBypasses = 0;
const realtimeNeedles = [
  /stepaudio-2\.5-realtime/,
  /\/step_plan\/v1\/realtime/,
  /response\.create/,
  /input_audio_buffer\.speech_started/,
];
for (const file of swiftFiles) {
  const rel = path.relative(ROOT, file);
  if (rel.includes("YishuHandsFreeListeningPolicy.swift")) continue;
  const source = stripComments(fs.readFileSync(file, "utf8"));
  const usesRealtime = realtimeNeedles.filter((re) => re.test(source));
  if (usesRealtime.length >= 2) {
    realtimeBypasses += 1;
  }
}

if (
  /stepaudio-2\.5-realtime/.test(companionCode)
  || /\/realtime\?model=/.test(companionCode)
) {
  realtimeBypasses += 1;
}

const handsFreeVoiceContractFailures = scenarioFailures.length;
const parallelMicrophoneCaptureOwners = microphoneOwners;

const target = {
  hands_free_voice_contract_failures: 0,
  manual_rearm_actions_per_10_utterances: 0,
  speech_onset_runtime_cancellations: 0,
  assistant_self_triggered_user_turns: 0,
  duplicate_auto_submissions: 0,
  silence_false_turns: 0,
  ptt_regressions: 0,
  realtime_semantic_authority_bypasses: 0,
  parallel_microphone_capture_owners: 1,
};

const measured = {
  hands_free_voice_contract_failures: handsFreeVoiceContractFailures,
  manual_rearm_actions_per_10_utterances: manualRearm,
  speech_onset_runtime_cancellations: speechOnsetRuntimeCancellations,
  assistant_self_triggered_user_turns: assistantSelfTriggeredUserTurns,
  duplicate_auto_submissions: duplicateAutoSubmissions,
  silence_false_turns: silenceFalseTurns,
  ptt_regressions: pttRegressions,
  realtime_semantic_authority_bypasses: realtimeBypasses,
  parallel_microphone_capture_owners: parallelMicrophoneCaptureOwners,
};

for (const [name, value] of Object.entries(measured)) {
  console.log(`${name}: ${value}`);
}

if (scenarioFailures.length) {
  for (const row of scenarioFailures) {
    console.error(`  scenario ${row}`);
  }
}
if (microphoneOwnerFiles.length) {
  console.error(
    `  microphone capture owners: ${microphoneOwnerFiles.join(", ")}`,
  );
}

let failed = false;
for (const [name, expected] of Object.entries(target)) {
  if (measured[name] !== expected) {
    console.error(
      `hands-free voice contract FAILED: ${name} ${measured[name]} (target ${expected})`,
    );
    failed = true;
  }
}

if (failed) process.exit(1);
console.error("hands-free voice contract passed");
