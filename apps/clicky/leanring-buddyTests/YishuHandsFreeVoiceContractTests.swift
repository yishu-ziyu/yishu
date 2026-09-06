import Foundation
import Testing
import YishuContext
@testable import Clicky

@MainActor
final class FakeContinuousDictation: YishuContinuousDictationControlling {
    var isContinuousCaptureActive = false
    var beginCount = 0
    var requestFinalCount = 0
    var stopCount = 0
    private(set) var onPartial: ((String) -> Void)?
    private(set) var onFinal: ((String) -> Void)?
    private(set) var onPower: ((CGFloat) -> Void)?

    func startContinuousCapture(
        onPartial: @escaping (String) -> Void,
        onFinal: @escaping (String) -> Void,
        onPower: @escaping (CGFloat) -> Void
    ) async {
        isContinuousCaptureActive = true
        self.onPartial = onPartial
        self.onFinal = onFinal
        self.onPower = onPower
    }

    func beginContinuousUtterance() async {
        beginCount += 1
    }

    func requestContinuousUtteranceFinal() {
        requestFinalCount += 1
    }

    func stopContinuousCapture() {
        isContinuousCaptureActive = false
        stopCount += 1
    }

    func emitPower(_ power: CGFloat) {
        onPower?(power)
    }

    func emitPartial(_ text: String) {
        onPartial?(text)
    }

    func emitFinal(_ text: String) {
        onFinal?(text)
    }
}

final class FakeMonotonicClock: YishuMonotonicClock, @unchecked Sendable {
    var now = 0
    func milliseconds() -> Int { now }
}

@MainActor
struct YishuHandsFreeVoiceContractTests {
    @Test func policyIgnoresEchoAndSilenceAndTakesFloorOnUserOnset() {
        #expect(
            YishuHandsFreeListeningPolicy.decision(
                phase: .armed,
                power: 0.05,
                assistantPlaybackActive: false,
                millisecondsSinceLoud: 0,
                utteranceDurationMs: 0
            ) == .none
        )
        #expect(
            YishuHandsFreeListeningPolicy.decision(
                phase: .armed,
                power: 0.14,
                assistantPlaybackActive: true,
                millisecondsSinceLoud: 0,
                utteranceDurationMs: 0
            ) == .none
        )
        #expect(
            YishuHandsFreeListeningPolicy.decision(
                phase: .armed,
                power: 0.4,
                assistantPlaybackActive: true,
                millisecondsSinceLoud: 0,
                utteranceDurationMs: 0
            ) == .beginUtterance
        )
        #expect(
            YishuHandsFreeListeningPolicy.decision(
                phase: .inUtterance,
                power: 0.02,
                assistantPlaybackActive: false,
                millisecondsSinceLoud: 800,
                utteranceDurationMs: 400
            ) == .endUtterance
        )
        #expect(!YishuDuplexAudioFloor.shouldCancelRuntimeOnSpeechOnset())
        #expect(!YishuDuplexAudioFloor.shouldWaitForTranscriptBeforeStoppingTTS())
        #expect(!YishuDuplexAudioFloor.shouldWaitForRuntimeAcknowledgementBeforeStoppingTTS())
    }

    @Test func threeTurnHandsFreeConversationNeedsNoShortcut() async {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness.continuous)

        for text in ["第一句", "第二句", "第三句"] {
            await speakUtterance(text, harness: harness)
        }

        let finals = harness.events.kinds.compactMap { kind -> String? in
            if case let .finalized(text) = kind { return text }
            return nil
        }
        #expect(finals == ["第一句", "第二句", "第三句"])
        #expect(harness.events.kinds.filter { $0 == .speechOnset }.count == 3)
        #expect(!harness.events.kinds.contains(.pressed))
        #expect(harness.controller.isContinuousListeningEnabled)
        #expect(harness.controller.capturePhase == .armed)
        #expect(harness.keyboard.startCallCount == 0)
    }

    @Test func tenUtterancesNeedZeroRearm() async {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness.continuous)

        for index in 1...10 {
            await speakUtterance("句\(index)", harness: harness)
        }

        let finals = harness.events.kinds.filter { kind in
            if case .finalized = kind { return true }
            return false
        }
        #expect(finals.count == 10)
        #expect(harness.keyboard.startCallCount == 0)
        #expect(harness.continuous.stopCount == 0)
        #expect(harness.controller.capturePhase == .armed)
    }

    @Test func speechOnsetStopsPresentationWithoutWaitingForFinal() async {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness.continuous)
        harness.controller.setAssistantPlaybackActive(true)

        harness.clock.now = 10
        harness.continuous.emitPower(0.4)
        await waitUntilBeginCount(harness.continuous, 1)

        #expect(harness.events.kinds.first == .speechOnset)
        #expect(!harness.events.kinds.contains { kind in
            if case .finalized = kind { return true }
            return false
        })
        #expect(!YishuDuplexAudioFloor.shouldWaitForTranscriptBeforeStoppingTTS())
    }

    @Test func speechOnsetDoesNotCancelForegroundRuntime() async throws {
        let runtime = FakeForegroundRuntime()
        let execution = YishuForegroundRuntimeExecution(runtime: runtime)
        let session = try execution.start(
            utterance: "先做这件事",
            contextFrame: duplexDummyFrame(),
            modelProvider: "local",
            model: "test",
            modelRouting: .fixed(
                preference: YishuModelPreference(provider: "local", model: "test")
            )
        )
        #expect(execution.isActive)
        #expect(execution.owns(session.requestId))

        var ttsStopped = false
        if !YishuDuplexAudioFloor.shouldCancelRuntimeOnSpeechOnset() {
            ttsStopped = true
        } else {
            execution.cancel(requestId: session.requestId, reason: "onset")
        }

        #expect(ttsStopped)
        #expect(execution.isActive)
        #expect(runtime.cancelCount == 0)
        execution.cancel(requestId: session.requestId, reason: "test-cleanup")
    }

    @Test func assistantPlaybackWithoutUserSpeechCreatesZeroTurns() async {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness.continuous)
        harness.controller.setAssistantPlaybackActive(true)

        for offset in 0..<12 {
            harness.clock.now = offset * 80
            harness.continuous.emitPower(0.14)
        }

        #expect(harness.events.kinds.isEmpty)
        #expect(harness.continuous.beginCount == 0)
    }

    @Test func silenceCreatesZeroTurns() async {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness.continuous)

        for offset in 0..<20 {
            harness.clock.now = offset * 100
            harness.continuous.emitPower(0.03)
        }

        #expect(harness.events.kinds.isEmpty)
        #expect(harness.continuous.beginCount == 0)
    }

    @Test func disableDropsLateFinal() async {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness.continuous)
        await beginUtterance(harness: harness)
        harness.continuous.emitPartial("会被关掉")
        harness.controller.setContinuousListeningEnabled(false)
        harness.continuous.emitFinal("迟到终稿")

        #expect(!harness.events.kinds.contains { kind in
            if case .finalized = kind { return true }
            return false
        })
        #expect(harness.continuous.stopCount == 1)
        #expect(!harness.controller.isContinuousListeningEnabled)
    }

    @Test func providerFinalAndLocalEndDoNotDoubleSubmit() async {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness.continuous)
        await beginUtterance(harness: harness)
        harness.continuous.emitPartial("同一句")
        endUtterance(harness: harness)
        harness.continuous.emitFinal("同一句")
        harness.continuous.emitFinal("同一句又来")

        let finals = harness.events.kinds.filter { kind in
            if case .finalized = kind { return true }
            return false
        }
        #expect(finals.count == 1)
        #expect(harness.events.kinds.contains(.finalized("同一句")))
    }

    @Test func pttFallbackUnchangedWhenContinuousOff() async {
        let harness = makeHarness()
        #expect(!harness.controller.isContinuousListeningEnabled)

        harness.controller.handleShortcutTransition(.pressed)
        await waitUntilKeyboardReady(harness.keyboard)
        harness.keyboard.emitPartial("按住")
        harness.controller.handleShortcutTransition(.released)
        harness.keyboard.emitFinal("按住说话")

        #expect(harness.events.kinds == [
            .pressed,
            .partial("按住"),
            .released,
            .finalized("按住说话"),
        ])
        #expect(harness.keyboard.startCallCount == 1)
        #expect(harness.keyboard.stopCallCount == 1)
    }

    private func makeHarness() -> Harness {
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
        return Harness(
            controller: controller,
            keyboard: keyboard,
            continuous: continuous,
            clock: clock,
            events: events
        )
    }

    private func waitUntilArmed(_ dictation: FakeContinuousDictation) async {
        for _ in 0..<50 where !dictation.isContinuousCaptureActive {
            await Task.yield()
        }
    }

    private func waitUntilBeginCount(
        _ dictation: FakeContinuousDictation,
        _ count: Int
    ) async {
        for _ in 0..<50 where dictation.beginCount < count {
            await Task.yield()
        }
    }

    private func waitUntilKeyboardReady(_ dictation: FakeKeyboardDictation) async {
        for _ in 0..<50 {
            if dictation.startCallCount >= 1, dictation.submitDraftText != nil {
                return
            }
            await Task.yield()
        }
    }

    private func beginUtterance(harness: Harness) async {
        let before = harness.continuous.beginCount
        harness.clock.now += 20
        harness.continuous.emitPower(0.4)
        await waitUntilBeginCount(harness.continuous, before + 1)
    }

    private func endUtterance(harness: Harness) {
        harness.clock.now += YishuHandsFreeListeningPolicy.endOfSpeechSilenceMs + 50
        harness.continuous.emitPower(0.02)
    }

    private func speakUtterance(_ text: String, harness: Harness) async {
        await beginUtterance(harness: harness)
        harness.continuous.emitPartial(text)
        endUtterance(harness: harness)
        harness.continuous.emitFinal(text)
        await Task.yield()
    }

    private func duplexDummyFrame() -> YishuContextFrame {
        let now = Date()
        let point = YishuScreenPoint(x: 0, y: 0, coordinateSpace: .globalTopLeft)
        return YishuContextFrame(
            capturedAt: now,
            expiresAt: now.addingTimeInterval(15),
            cursor: YishuObservedValue(
                value: point,
                source: "test",
                capturedAt: now,
                confidence: 1
            ),
            pointerTrail: [],
            frontmostApplication: nil,
            activeWindow: nil,
            elementUnderCursor: nil,
            screenshots: [],
            numberedTargets: [],
            warnings: []
        )
    }

    @MainActor
    private struct Harness {
        let controller: YishuVoiceSessionController
        let keyboard: FakeKeyboardDictation
        let continuous: FakeContinuousDictation
        let clock: FakeMonotonicClock
        let events: EventSink
    }
}
