#!/usr/bin/env node
/**
 * Issue #35 duplex voice contract.
 *
 * Behavioral metrics are derived from an executed production VoiceSession
 * harness (YishuHandsFreeFitnessHarness) plus the production audio-floor
 * coordinator (YishuDuplexAudioFloor.takeFloorOnSpeechOnset with injectable
 * presentation/Runtime effects). speech_onset_runtime_cancellations is the
 * recorded cancel/settle/supersede count from that seam, not a constant.
 * Static analysis remains a secondary architecture guardrail for microphone
 * ownership, realtime semantic authority, and onset-handler ownership.
 *
 * Usage: node script/check-hands-free-voice-contract.cjs
 */

"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SWIFT = path.join(ROOT, "apps/clicky/leanring-buddy");
const GAMED_DIR = path.join(ROOT, "script/fixtures/hands-free-symbol-only");
const GAMED_BEHAVIOR = path.join(GAMED_DIR, "gamed-behavior.json");

function read(rel) {
  const full = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
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

function metricsFromBehavior(report) {
  const scenarioFailures = [];
  const a = report.A || {};
  const finals = Array.isArray(a.finals) ? a.finals : [];
  if (
    finals.length !== 3
    || finals[0] !== "第一句"
    || a.pressed !== 0
    || a.keyboardStarts !== 0
    || a.armed !== true
  ) {
    scenarioFailures.push("A: three-turn contract did not execute");
  }
  const b = report.B || {};
  if (
    b.finalCount !== 10
    || b.keyboardStarts !== 0
    || b.stopCount !== 0
    || b.armed !== true
  ) {
    scenarioFailures.push("B: ten-utterance re-arm contract did not execute");
  }
  const c = report.C || {};
  if (
    c.speechOnset !== true
    || c.hasFinal !== false
    || c.presentationStopped !== true
  ) {
    scenarioFailures.push(
      "C: speech onset did not synchronously stop presentation before a final",
    );
  }
  if (c.waitedForTranscript === true || c.waitedForRuntimeAck === true) {
    scenarioFailures.push(
      "C: presentation stop waited for transcript or Runtime acknowledgement",
    );
  }
  const d = report.D || {};
  const cancels = recordedCount(d, "runtimeCancels");
  const settles = recordedCount(d, "runtimeSettles");
  const supersedes = recordedCount(d, "runtimeSupersedes");
  const runtimeTerminations = (cancels ?? 1) + (settles ?? 1) + (supersedes ?? 1);
  if (runtimeTerminations !== 0 || d.runtimeActive !== true) {
    scenarioFailures.push(
      "D: speech onset cancelled, settled, or superseded Runtime",
    );
  }
  const e = report.E || {};
  if ((e.turns || 0) !== 0 || (e.begins || 0) !== 0) {
    scenarioFailures.push("E: assistant playback created a user turn");
  }
  const f = report.F || {};
  if ((f.turns || 0) !== 0 || (f.begins || 0) !== 0) {
    scenarioFailures.push("F: silence created a user turn");
  }
  const g = report.G || {};
  if (g.lateFinal !== false) {
    scenarioFailures.push("G: disable submitted a late final");
  }

  const duplicateFinals = Number(report.duplicateFinals);
  const duplicateAutoSubmissions = duplicateFinals === 1 ? 0 : 1;
  const h = report.H || {};
  const pttKinds = Array.isArray(h.kinds) ? h.kinds : [];
  const pttExpected = ["pressed", "partial:按住", "released", "finalized:按住说话"];
  const pttRegressions = pttKinds.length === pttExpected.length
    && pttExpected.every((item, index) => pttKinds[index] === item)
    ? 0
    : 1;

  return {
    scenarioFailures,
    measured: {
      hands_free_voice_contract_failures: scenarioFailures.length,
      manual_rearm_actions_per_10_utterances: scenarioFailures.some((row) =>
        row.startsWith("A:") || row.startsWith("B:"),
      )
        ? 10
        : 0,
      speech_onset_runtime_cancellations: runtimeTerminations === 0 ? 0 : 1,
      assistant_self_triggered_user_turns: scenarioFailures.some((row) =>
        row.startsWith("E:"),
      )
        ? 1
        : 0,
      duplicate_auto_submissions: duplicateAutoSubmissions,
      silence_false_turns: scenarioFailures.some((row) => row.startsWith("F:"))
        ? 1
        : 0,
      ptt_regressions: pttRegressions,
    },
  };
}

function recordedCount(obj, key) {
  if (obj == null || !Object.prototype.hasOwnProperty.call(obj, key)) return null;
  const n = Number(obj[key]);
  return Number.isFinite(n) ? n : null;
}

function passingBehavior(patchC = {}, patchD = {}) {
  return {
    A: {
      finals: ["第一句", "第二句", "第三句"],
      pressed: 0,
      keyboardStarts: 0,
      armed: true,
    },
    B: {
      finalCount: 10,
      keyboardStarts: 0,
      stopCount: 0,
      armed: true,
    },
    C: {
      speechOnset: true,
      hasFinal: false,
      presentationStopped: true,
      waitedForTranscript: false,
      waitedForRuntimeAck: false,
      ...patchC,
    },
    D: {
      runtimeCancels: 0,
      runtimeSettles: 0,
      runtimeSupersedes: 0,
      runtimeActive: true,
      ...patchD,
    },
    E: { turns: 0, begins: 0 },
    F: { turns: 0, begins: 0 },
    G: { lateFinal: false },
    duplicateFinals: 1,
    H: { kinds: ["pressed", "partial:按住", "released", "finalized:按住说话"] },
  };
}

function proveAudioFloorMutationsFail() {
  const mutations = [
    [
      "remove TTS/presentation stop from onset",
      passingBehavior({ presentationStopped: false }),
    ],
    [
      "add Runtime cancel on onset",
      passingBehavior({}, { runtimeCancels: 1, runtimeActive: false }),
    ],
    [
      "add settle-equivalent Runtime termination on onset",
      passingBehavior({}, { runtimeSettles: 1, runtimeActive: false }),
    ],
    [
      "add supersede-equivalent Runtime termination on onset",
      passingBehavior({}, { runtimeSupersedes: 1, runtimeActive: false }),
    ],
    [
      "delay presentation stop until transcript finalization",
      passingBehavior({
        presentationStopped: false,
        waitedForTranscript: true,
        hasFinal: false,
      }),
    ],
  ];
  for (const [name, report] of mutations) {
    const result = metricsFromBehavior(report);
    if (behavioralAllZero(result.measured) && result.scenarioFailures.length === 0) {
      console.error(
        `hands-free voice contract FAILED: mutation "${name}" still produced all-zero fitness`,
      );
      process.exit(1);
    }
  }
  const runtimeMutations = mutations.filter(([name]) =>
    /cancel on onset|settle-equivalent|supersede-equivalent/.test(name),
  );
  for (const [name, report] of runtimeMutations) {
    const result = metricsFromBehavior(report);
    if (result.measured.speech_onset_runtime_cancellations === 0) {
      console.error(
        `hands-free voice contract FAILED: mutation "${name}" left speech_onset_runtime_cancellations at 0`,
      );
      process.exit(1);
    }
  }
  console.error("hands-free anti-gaming: audio-floor mutations did not zero fitness");
}

function extractBalanced(source, startIdx) {
  const start = source.indexOf("{", startIdx);
  if (start < 0) return "";
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }
    if (ch === "\"" || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return "";
}

function extractFuncBody(source, name) {
  const re = new RegExp(`\\bfunc\\s+${name}\\s*\\(`);
  const match = re.exec(source);
  if (!match) return "";
  return extractBalanced(source, match.index);
}

function audioFloorOwnershipGuard() {
  const failures = [];
  const handlerSource = stripComments(
    read("apps/clicky/leanring-buddy/CompanionManager+DuplexVoice.swift"),
  );
  const floorSource = stripComments(
    read("apps/clicky/leanring-buddy/YishuDuplexAudioFloor.swift"),
  );
  const handler = extractFuncBody(handlerSource, "handleDuplexSpeechOnset");
  if (!handler) {
    failures.push("production speech-onset handler is missing");
    return failures;
  }
  if (!/YishuDuplexAudioFloor\s*\./.test(handler)) {
    failures.push(
      "production speech-onset handler does not route through the audio-floor coordinator",
    );
  }
  if (!/cancelActiveSentenceSpeechPipeline/.test(handler)
    || !/stopPlayback\s*\(/.test(handler)) {
    failures.push(
      "production speech-onset handler does not pass sentence-pipeline and TTS presentation stops",
    );
  }
  if (!/duplexForegroundRuntimeBoundary|ForegroundRuntimeBoundary/.test(handler)) {
    failures.push(
      "production speech-onset handler does not interact with the foreground Runtime owner boundary",
    );
  }
  const runtimeTerm = /\b(cancelActiveRuntimeTurn|foregroundRuntimeExecution\s*\.\s*(cancel|start)\s*\(|cancelTurn\s*\(|\.settle\s*\(|\.supersede\s*\()/;
  if (runtimeTerm.test(handler)) {
    failures.push(
      "production speech-onset handler terminates or supersedes foreground Runtime",
    );
  }
  if (/\bawait\b/.test(handler)) {
    failures.push("production speech-onset handler awaits before taking the audio floor");
  }

  const takeFloor = extractFuncBody(floorSource, "takeFloorOnSpeechOnset");
  if (!takeFloor) {
    failures.push("audio-floor coordinator takeFloorOnSpeechOnset is missing");
    return failures;
  }
  if (!/\.isActive\s*\(/.test(takeFloor)) {
    failures.push(
      "audio-floor coordinator does not observe the current foreground Runtime owner",
    );
  }
  const sentenceIdx = takeFloor.indexOf("stopSentenceSpeech()");
  const playbackIdx = takeFloor.indexOf("stopPlayback()");
  if (sentenceIdx < 0 || playbackIdx < 0) {
    failures.push("audio-floor coordinator does not invoke presentation stops");
  } else {
    const beforeStops = takeFloor.slice(
      0,
      Math.min(sentenceIdx, playbackIdx),
    );
    if (/\bawait\b/.test(beforeStops)) {
      failures.push("audio-floor coordinator waits before stopping presentation");
    }
    if (/if\s*!\s*transcriptFinalized|guard\s+transcriptFinalized/.test(beforeStops)
      || /if\s*!\s*runtimeAcknowledged|guard\s+runtimeAcknowledged/.test(beforeStops)) {
      failures.push(
        "audio-floor coordinator gates presentation stop on transcript or Runtime acknowledgement",
      );
    }
  }
  if (/\.cancel\s*\(|\.settle\s*\(|\.supersede\s*\(/.test(takeFloor)) {
    failures.push(
      "audio-floor coordinator terminates or supersedes foreground Runtime on onset",
    );
  }
  return failures;
}

function behavioralAllZero(measured) {
  return [
    "hands_free_voice_contract_failures",
    "manual_rearm_actions_per_10_utterances",
    "speech_onset_runtime_cancellations",
    "assistant_self_triggered_user_turns",
    "duplicate_auto_submissions",
    "silence_false_turns",
  ].every((key) => measured[key] === 0);
}

function symbolPresenceWouldPass(sourceText) {
  return (
    sourceText.includes("threeTurnHandsFreeConversationNeedsNoShortcut")
    && sourceText.includes("tenUtterancesNeedZeroRearm")
    && sourceText.includes("setContinuousListeningEnabled")
    && sourceText.includes("beginContinuousUtterance")
    && sourceText.includes("speechOnsetDoesNotCancelForegroundRuntime")
    && sourceText.includes("assistantPlaybackWithoutUserSpeechCreatesZeroTurns")
    && sourceText.includes("silenceCreatesZeroTurns")
    && sourceText.includes("disableDropsLateFinal")
    && sourceText.includes("providerFinalAndLocalEndDoNotDoubleSubmit")
    && sourceText.includes("pttFallbackUnchangedWhenContinuousOff")
  );
}

function proveAntiGaming() {
  const gamedSources = collectSwift(GAMED_DIR)
    .map((file) => stripComments(fs.readFileSync(file, "utf8")))
    .join("\n");
  if (!symbolPresenceWouldPass(gamedSources)) {
    console.error(
      "hands-free voice contract FAILED: anti-gaming fixture is missing expected symbols",
    );
    process.exit(2);
  }
  let gamedReport;
  try {
    gamedReport = JSON.parse(fs.readFileSync(GAMED_BEHAVIOR, "utf8"));
  } catch (err) {
    console.error(`hands-free voice contract FAILED: gamed fixture: ${err.message}`);
    process.exit(2);
  }
  const gamed = metricsFromBehavior(gamedReport);
  if (behavioralAllZero(gamed.measured)) {
    console.error(
      "hands-free voice contract FAILED: symbol-only sources produced all-zero fitness",
    );
    process.exit(1);
  }
  console.error("hands-free anti-gaming: symbol-only fixture did not zero fitness");
}

function architectureGuards() {
  const session = stripComments(read("apps/clicky/leanring-buddy/YishuVoiceSessionController.swift"));
  const dictation = stripComments(read("apps/clicky/leanring-buddy/BuddyDictationManager.swift"));
  const tts = stripComments(read("apps/clicky/leanring-buddy/ElevenLabsTTSClient.swift"));
  const panel = stripComments(read("apps/clicky/leanring-buddy/YishuPanelFirstScreen.swift"));
  const failures = [];

  if (!dictation.includes("YishuContinuousCapturePreRoll")
    || !dictation.includes("attachAndReplay")
    || !dictation.includes("continuousPreRoll.clear()")) {
    failures.push("continuous capture has no bounded PCM pre-roll");
  }
  const speakMatch = tts.match(/func speakText\([\s\S]*?\n    \}/);
  if (speakMatch && /onPlaybackActiveChange\?\(true\)/.test(speakMatch[0])) {
    failures.push("speakText marks playback active before audible audio");
  }
  if (panel.includes("也可以按住 Control+Option")) {
    failures.push("panel still claims PTT works while continuous listening is on");
  }
  if (!session.includes("YishuContinuousListeningState")
    || !session.includes("continuousListeningArmed")
    || !session.includes("continuousListeningFailed")) {
    failures.push("VoiceSession does not own starting/armed/failed listening state");
  }

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
  const companion = stripComments(read("apps/clicky/leanring-buddy/CompanionManager.swift"));
  for (const file of swiftFiles) {
    const rel = path.relative(ROOT, file);
    if (rel.includes("YishuHandsFreeListeningPolicy.swift")) continue;
    const source = stripComments(fs.readFileSync(file, "utf8"));
    const usesRealtime = realtimeNeedles.filter((re) => re.test(source));
    if (usesRealtime.length >= 2) realtimeBypasses += 1;
  }
  if (/stepaudio-2\.5-realtime/.test(companion) || /\/realtime\?model=/.test(companion)) {
    realtimeBypasses += 1;
  }

  failures.push(...audioFloorOwnershipGuard());
  return { failures, microphoneOwners, microphoneOwnerFiles, realtimeBypasses };
}

function runFitnessHarness() {
  const preset = process.env.YISHU_HANDSFREE_FITNESS_JSON;
  if (preset && fs.existsSync(preset) && process.env.YISHU_HANDSFREE_SKIP_XCODE === "1") {
    return JSON.parse(fs.readFileSync(preset, "utf8"));
  }
  const reportPath = preset || "/tmp/yishu-hands-free-fitness.json";
  try {
    if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
  } catch {
    // ignore
  }
  const derived = path.join(os.tmpdir(), "yishu-handsfree-derived2");
  const args = [
    "test",
    "-project",
    "apps/clicky/leanring-buddy.xcodeproj",
    "-scheme",
    "leanring-buddy",
    "-destination",
    "platform=macOS",
    "-derivedDataPath",
    derived,
    "CODE_SIGNING_ALLOWED=NO",
    "ENABLE_HARDENED_RUNTIME=NO",
    "ENABLE_DEBUG_DYLIB=NO",
    "-only-testing:leanring-buddyTests/YishuHandsFreeFitnessTests",
    "-only-testing:leanring-buddyTests/YishuHandsFreeVoiceContractTests",
    "-only-testing:leanring-buddyTests/YishuContinuousCapturePreRollTests",
    "-only-testing:leanring-buddyTests/YishuAudiblePlaybackHookTests",
    "-only-testing:leanring-buddyTests/YishuAudiblePlaybackPolicyTests",
    "-only-testing:leanring-buddyTests/YishuDuplexAudioFloorTests",
    "-only-testing:leanring-buddyTests/YishuPanelHierarchyTests",
  ];
  const result = spawnSync("xcodebuild", args, {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      YISHU_HANDSFREE_FITNESS_JSON: reportPath,
    },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const tail = String(result.stdout || result.stderr || "").slice(-4000);
    console.error("hands-free voice contract FAILED: fitness harness xcodebuild exited non-zero");
    if (tail) console.error(tail);
    process.exit(result.status == null ? 2 : result.status);
  }
  if (!fs.existsSync(reportPath)) {
    console.error(`hands-free voice contract FAILED: missing behavior report at ${reportPath}`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(reportPath, "utf8"));
}

proveAntiGaming();
proveAudioFloorMutationsFail();

const behavior = runFitnessHarness();
const fromBehavior = metricsFromBehavior(behavior);
const arch = architectureGuards();

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
  ...fromBehavior.measured,
  realtime_semantic_authority_bypasses: arch.realtimeBypasses,
  parallel_microphone_capture_owners: arch.microphoneOwners,
};

for (const [name, value] of Object.entries(measured)) {
  console.log(`${name}: ${value}`);
}

if (fromBehavior.scenarioFailures.length) {
  for (const row of fromBehavior.scenarioFailures) {
    console.error(`  scenario ${row}`);
  }
}
if (arch.failures.length) {
  for (const row of arch.failures) {
    console.error(`  architecture ${row}`);
  }
}
if (arch.microphoneOwnerFiles.length) {
  console.error(
    `  microphone capture owners: ${arch.microphoneOwnerFiles.join(", ")}`,
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
if (arch.failures.length) {
  console.error("hands-free voice contract FAILED: architecture guardrails");
  failed = true;
}
if (failed) process.exit(1);
console.error("hands-free voice contract passed");
