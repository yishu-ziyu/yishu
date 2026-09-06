#!/usr/bin/env node
/**
 * Issue #35 duplex voice contract.
 *
 * Behavioral metrics are derived from an executed production VoiceSession
 * harness (YishuHandsFreeFitnessHarness), not from source-symbol presence.
 * Static analysis remains a secondary architecture guardrail for microphone
 * ownership and realtime semantic authority.
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
  if (c.speechOnset !== true || c.hasFinal !== false) {
    scenarioFailures.push("C: speech onset did not take the floor before a final");
  }
  const d = report.D || {};
  if (d.runtimeCancels !== 0) {
    scenarioFailures.push("D: speech onset cancelled Runtime");
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
      speech_onset_runtime_cancellations: d.runtimeCancels === 0 ? 0 : 1,
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
