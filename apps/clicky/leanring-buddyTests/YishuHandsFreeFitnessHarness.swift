import Foundation
import Testing
@testable import Clicky

struct YishuHandsFreeFitnessReport: Equatable, Sendable {
    var threeTurnFinals: [String]
    var threeTurnPressed: Int
    var threeTurnKeyboardStarts: Int
    var threeTurnArmed: Bool
    var tenUtteranceFinalCount: Int
    var tenUtteranceKeyboardStarts: Int
    var tenUtteranceStopCount: Int
    var tenUtteranceArmed: Bool
    var speechOnsetBeforeFinal: Bool
    var speechOnsetHasFinal: Bool
    var runtimeCancelsOnOnset: Int
    var echoTurns: Int
    var echoBegins: Int
    var silenceTurns: Int
    var silenceBegins: Int
    var lateFinalAfterDisable: Bool
    var duplicateFinalCount: Int
    var pttKinds: [String]

    var jsonObject: [String: Any] {
        [
            "A": [
                "finals": threeTurnFinals,
                "pressed": threeTurnPressed,
                "keyboardStarts": threeTurnKeyboardStarts,
                "armed": threeTurnArmed,
            ],
            "B": [
                "finalCount": tenUtteranceFinalCount,
                "keyboardStarts": tenUtteranceKeyboardStarts,
                "stopCount": tenUtteranceStopCount,
                "armed": tenUtteranceArmed,
            ],
            "C": [
                "speechOnset": speechOnsetBeforeFinal,
                "hasFinal": speechOnsetHasFinal,
            ],
            "D": ["runtimeCancels": runtimeCancelsOnOnset],
            "E": ["turns": echoTurns, "begins": echoBegins],
            "F": ["turns": silenceTurns, "begins": silenceBegins],
            "G": ["lateFinal": lateFinalAfterDisable],
            "duplicateFinals": duplicateFinalCount,
            "H": ["kinds": pttKinds],
        ]
    }

    func write(to path: String) throws {
        let data = try JSONSerialization.data(withJSONObject: jsonObject, options: [.prettyPrinted])
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }
}

@MainActor
enum YishuHandsFreeFitnessHarness {
    static func run() async -> YishuHandsFreeFitnessReport {
        let three = await threeTurnTrace()
        let ten = await tenUtteranceTrace()
        let onset = await speechOnsetTrace()
        let echo = await echoTrace()
        let silence = await silenceTrace()
        let disable = await disableTrace()
        let duplicates = await duplicateTrace()
        let ptt = await pttTrace()
        return YishuHandsFreeFitnessReport(
            threeTurnFinals: three.finals,
            threeTurnPressed: three.pressed,
            threeTurnKeyboardStarts: three.keyboardStarts,
            threeTurnArmed: three.armed,
            tenUtteranceFinalCount: ten.finalCount,
            tenUtteranceKeyboardStarts: ten.keyboardStarts,
            tenUtteranceStopCount: ten.stopCount,
            tenUtteranceArmed: ten.armed,
            speechOnsetBeforeFinal: onset.speechOnset,
            speechOnsetHasFinal: onset.hasFinal,
            runtimeCancelsOnOnset: YishuDuplexAudioFloor.shouldCancelRuntimeOnSpeechOnset() ? 1 : 0,
            echoTurns: echo.turns,
            echoBegins: echo.begins,
            silenceTurns: silence.turns,
            silenceBegins: silence.begins,
            lateFinalAfterDisable: disable,
            duplicateFinalCount: duplicates,
            pttKinds: ptt
        )
    }

    private static func threeTurnTrace() async -> (
        finals: [String],
        pressed: Int,
        keyboardStarts: Int,
        armed: Bool
    ) {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness)
        for text in ["第一句", "第二句", "第三句"] {
            await speak(text, harness: harness)
        }
        return (
            finalizedTexts(harness),
            harness.events.utteranceKinds.filter { $0 == .pressed }.count,
            harness.keyboard.startCallCount,
            harness.controller.continuousListeningState.isArmed
        )
    }

    private static func tenUtteranceTrace() async -> (
        finalCount: Int,
        keyboardStarts: Int,
        stopCount: Int,
        armed: Bool
    ) {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness)
        for index in 1...10 {
            await speak("句\(index)", harness: harness)
        }
        let finals = harness.events.utteranceKinds.filter {
            if case .finalized = $0 { return true }
            return false
        }
        return (
            finals.count,
            harness.keyboard.startCallCount,
            harness.continuous.stopCount,
            harness.controller.continuousListeningState.isArmed
        )
    }

    private static func speechOnsetTrace() async -> (speechOnset: Bool, hasFinal: Bool) {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness)
        harness.controller.setAssistantPlaybackActive(true)
        harness.clock.now = 10
        harness.continuous.emitPower(0.4)
        await waitUntilBeginCount(harness.continuous, 1)
        let hasFinal = harness.events.utteranceKinds.contains {
            if case .finalized = $0 { return true }
            return false
        }
        return (harness.events.utteranceKinds.contains(.speechOnset), hasFinal)
    }

    private static func echoTrace() async -> (turns: Int, begins: Int) {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness)
        harness.controller.setAssistantPlaybackActive(true)
        for offset in 0..<12 {
            harness.clock.now = offset * 80
            harness.continuous.emitPower(0.14)
        }
        return (harness.events.utteranceKinds.count, harness.continuous.beginCount)
    }

    private static func silenceTrace() async -> (turns: Int, begins: Int) {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness)
        for offset in 0..<20 {
            harness.clock.now = offset * 100
            harness.continuous.emitPower(0.03)
        }
        return (harness.events.utteranceKinds.count, harness.continuous.beginCount)
    }

    private static func disableTrace() async -> Bool {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness)
        harness.clock.now += 20
        harness.continuous.emitPower(0.4)
        await waitUntilBeginCount(harness.continuous, 1)
        harness.continuous.emitPartial("会被关掉")
        harness.controller.setContinuousListeningEnabled(false)
        harness.continuous.emitFinal("迟到终稿")
        return harness.events.utteranceKinds.contains {
            if case .finalized = $0 { return true }
            return false
        }
    }

    private static func duplicateTrace() async -> Int {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness)
        harness.clock.now += 20
        harness.continuous.emitPower(0.4)
        await waitUntilBeginCount(harness.continuous, 1)
        harness.continuous.emitPartial("同一句")
        harness.clock.now += YishuHandsFreeListeningPolicy.endOfSpeechSilenceMs + 50
        harness.continuous.emitPower(0.02)
        harness.continuous.emitFinal("同一句")
        harness.continuous.emitFinal("同一句又来")
        return harness.events.utteranceKinds.filter {
            if case .finalized = $0 { return true }
            return false
        }.count
    }

    private static func pttTrace() async -> [String] {
        let harness = makeHarness()
        harness.controller.handleShortcutTransition(.pressed)
        for _ in 0..<50 {
            if harness.keyboard.startCallCount >= 1, harness.keyboard.submitDraftText != nil {
                break
            }
            await Task.yield()
        }
        harness.keyboard.emitPartial("按住")
        harness.controller.handleShortcutTransition(.released)
        harness.keyboard.emitFinal("按住说话")
        return harness.events.utteranceKinds.map { kind in
            switch kind {
            case .pressed: return "pressed"
            case .speechOnset: return "speechOnset"
            case let .partial(text): return "partial:\(text)"
            case .released: return "released"
            case let .finalized(text): return "finalized:\(text)"
            case .captureFailed: return "captureFailed"
            case .cancelled: return "cancelled"
            case .continuousListeningArmed: return "armed"
            case .continuousListeningFailed: return "failed"
            }
        }
    }

    private static func makeHarness() -> (
        controller: YishuVoiceSessionController,
        keyboard: FakeKeyboardDictation,
        continuous: FakeContinuousDictation,
        clock: FakeMonotonicClock,
        events: EventSink
    ) {
        let keyboard = FakeKeyboardDictation()
        let continuous = FakeContinuousDictation()
        let clock = FakeMonotonicClock()
        let events = EventSink()
        let controller = YishuVoiceSessionController(
            dictation: keyboard,
            monitor: FakePushToTalkMonitor(),
            onEvent: { events.append($0) },
            continuousDictation: continuous,
            clock: clock
        )
        return (controller, keyboard, continuous, clock, events)
    }

    private static func waitUntilArmed(
        _ harness: (
            controller: YishuVoiceSessionController,
            keyboard: FakeKeyboardDictation,
            continuous: FakeContinuousDictation,
            clock: FakeMonotonicClock,
            events: EventSink
        )
    ) async {
        for _ in 0..<80 where !harness.continuous.isContinuousCaptureActive {
            await Task.yield()
        }
        for _ in 0..<80 where !harness.controller.continuousListeningState.isArmed {
            await Task.yield()
        }
    }

    private static func waitUntilBeginCount(_ dictation: FakeContinuousDictation, _ count: Int) async {
        for _ in 0..<50 where dictation.beginCount < count {
            await Task.yield()
        }
    }

    private static func speak(
        _ text: String,
        harness: (
            controller: YishuVoiceSessionController,
            keyboard: FakeKeyboardDictation,
            continuous: FakeContinuousDictation,
            clock: FakeMonotonicClock,
            events: EventSink
        )
    ) async {
        let before = harness.continuous.beginCount
        harness.clock.now += 20
        harness.continuous.emitPower(0.4)
        await waitUntilBeginCount(harness.continuous, before + 1)
        harness.continuous.emitPartial(text)
        harness.clock.now += YishuHandsFreeListeningPolicy.endOfSpeechSilenceMs + 50
        harness.continuous.emitPower(0.02)
        harness.continuous.emitFinal(text)
        await Task.yield()
    }

    private static func finalizedTexts(
        _ harness: (
            controller: YishuVoiceSessionController,
            keyboard: FakeKeyboardDictation,
            continuous: FakeContinuousDictation,
            clock: FakeMonotonicClock,
            events: EventSink
        )
    ) -> [String] {
        harness.events.utteranceKinds.compactMap { kind in
            if case let .finalized(text) = kind { return text }
            return nil
        }
    }
}

@MainActor
struct YishuHandsFreeFitnessTests {
    @Test func executableFitnessHarnessProducesRequiredZeros() async throws {
        let report = await YishuHandsFreeFitnessHarness.run()
        let path = ProcessInfo.processInfo.environment["YISHU_HANDSFREE_FITNESS_JSON"]
            ?? "/tmp/yishu-hands-free-fitness.json"
        try report.write(to: path)
        #expect(report.threeTurnFinals == ["第一句", "第二句", "第三句"])
        #expect(report.threeTurnPressed == 0)
        #expect(report.tenUtteranceFinalCount == 10)
        #expect(report.tenUtteranceKeyboardStarts == 0)
        #expect(report.speechOnsetBeforeFinal)
        #expect(!report.speechOnsetHasFinal)
        #expect(report.runtimeCancelsOnOnset == 0)
        #expect(report.echoTurns == 0)
        #expect(report.silenceTurns == 0)
        #expect(!report.lateFinalAfterDisable)
        #expect(report.duplicateFinalCount == 1)
        #expect(report.pttKinds == ["pressed", "partial:按住", "released", "finalized:按住说话"])
    }
}
