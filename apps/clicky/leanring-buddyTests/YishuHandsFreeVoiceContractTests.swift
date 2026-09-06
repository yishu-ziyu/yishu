import Foundation
import Testing
import YishuContext
@testable import Clicky

@MainActor
final class FakeContinuousDictation: YishuContinuousDictationControlling {
    var isContinuousCaptureActive = false
    var lastContinuousStartError: String?
    var startShouldSucceed = true
    var startShouldClaimSuccessWithoutActivating = false
    var beginCount = 0
    var requestFinalCount = 0
    var stopCount = 0
    private(set) var onPartial: ((String) -> Void)?
    private(set) var onFinal: ((String, YishuAsrTerminalKind) -> Void)?
    private(set) var onPower: ((CGFloat) -> Void)?

    func startContinuousCapture(
        onPartial: @escaping (String) -> Void,
        onFinal: @escaping (String, YishuAsrTerminalKind) -> Void,
        onPower: @escaping (CGFloat) -> Void
    ) async -> Bool {
        self.onPartial = onPartial
        self.onFinal = onFinal
        self.onPower = onPower
        if startShouldClaimSuccessWithoutActivating {
            isContinuousCaptureActive = false
            lastContinuousStartError = "capture did not become active"
            return true
        }
        if !startShouldSucceed {
            isContinuousCaptureActive = false
            lastContinuousStartError = lastContinuousStartError
                ?? "microphone permission is required for push to talk."
            return false
        }
        isContinuousCaptureActive = true
        return true
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

    func emitFinal(_ text: String, kind: YishuAsrTerminalKind = .success) {
        onFinal?(text, kind)
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
    }

    @Test func threeTurnHandsFreeConversationNeedsNoShortcut() async {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness)

        for text in ["第一句", "第二句", "第三句"] {
            await speakUtterance(text, harness: harness)
        }

        let finals = harness.events.utteranceKinds.compactMap { kind -> String? in
            if case let .finalized(text) = kind { return text }
            return nil
        }
        #expect(finals == ["第一句", "第二句", "第三句"])
        #expect(harness.events.utteranceKinds.filter { $0 == .speechOnset }.count == 3)
        #expect(!harness.events.utteranceKinds.contains(.pressed))
        #expect(harness.controller.isContinuousListeningEnabled)
        #expect(harness.controller.continuousListeningState.isArmed)
        #expect(harness.controller.capturePhase == .armed)
        #expect(harness.keyboard.startCallCount == 0)
    }

    @Test func tenUtterancesNeedZeroRearm() async {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness)

        for index in 1...10 {
            await speakUtterance("句\(index)", harness: harness)
        }

        let finals = harness.events.utteranceKinds.filter { kind in
            if case .finalized = kind { return true }
            return false
        }
        #expect(finals.count == 10)
        #expect(harness.keyboard.startCallCount == 0)
        #expect(harness.continuous.stopCount == 0)
        #expect(harness.controller.capturePhase == .armed)
        #expect(harness.controller.continuousListeningState.isArmed)
    }

    @Test func speechOnsetStopsPresentationWithoutWaitingForFinal() async {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness)
        harness.controller.setAssistantPlaybackActive(true)

        harness.clock.now = 10
        harness.continuous.emitPower(0.4)
        await waitUntilBeginCount(harness.continuous, 1)

        #expect(harness.events.utteranceKinds.first == .speechOnset)
        #expect(!harness.events.utteranceKinds.contains { kind in
            if case .finalized = kind { return true }
            return false
        })
        var sentenceStops = 0
        var playbackStops = 0
        YishuDuplexAudioFloor.takeFloorOnSpeechOnset(
            presentation: .init(
                stopSentenceSpeech: { sentenceStops += 1 },
                stopPlayback: { playbackStops += 1 }
            ),
            foreground: .init(
                isActive: { false },
                cancel: { _ in },
                settle: {},
                supersede: {}
            ),
            transcriptFinalized: false,
            runtimeAcknowledged: false
        )
        #expect(sentenceStops == 1)
        #expect(playbackStops == 1)
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
        var runtimeCancels = 0
        YishuDuplexAudioFloor.takeFloorOnSpeechOnset(
            presentation: .init(
                stopSentenceSpeech: {},
                stopPlayback: { ttsStopped = true }
            ),
            foreground: .init(
                isActive: { execution.isActive },
                cancel: { reason in
                    runtimeCancels += 1
                    execution.cancel(requestId: session.requestId, reason: reason)
                },
                settle: {},
                supersede: {}
            ),
            transcriptFinalized: false,
            runtimeAcknowledged: false
        )

        #expect(ttsStopped)
        #expect(runtimeCancels == 0)
        #expect(execution.isActive)
        #expect(runtime.cancelCount == 0)
        execution.cancel(requestId: session.requestId, reason: "test-cleanup")
    }

    @Test func assistantPlaybackWithoutUserSpeechCreatesZeroTurns() async {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness)
        harness.controller.setAssistantPlaybackActive(true)

        for offset in 0..<12 {
            harness.clock.now = offset * 80
            harness.continuous.emitPower(0.14)
        }

        #expect(harness.events.utteranceKinds.isEmpty)
        #expect(harness.continuous.beginCount == 0)
    }

    @Test func silenceCreatesZeroTurns() async {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness)

        for offset in 0..<20 {
            harness.clock.now = offset * 100
            harness.continuous.emitPower(0.03)
        }

        #expect(harness.events.utteranceKinds.isEmpty)
        #expect(harness.continuous.beginCount == 0)
    }

    @Test func userSpeechBeforeAudibleTTSUsesIdleThreshold() async {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness)
        harness.controller.setAssistantPlaybackActive(false)

        harness.clock.now = 10
        harness.continuous.emitPower(0.14)
        await waitUntilBeginCount(harness.continuous, 1)

        #expect(harness.events.utteranceKinds.contains(.speechOnset))
        #expect(harness.continuous.beginCount == 1)
    }

    @Test func permissionRejectedDoesNotPublishListening() async {
        let harness = makeHarness()
        harness.continuous.startShouldSucceed = false
        harness.continuous.lastContinuousStartError =
            "microphone permission is required for push to talk."
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilFailed(harness.controller)

        #expect(!harness.controller.continuousListeningState.isArmed)
        #expect(!harness.controller.isContinuousListeningEnabled)
        #expect(harness.controller.capturePhase == .idle)
        #expect(!YishuPanelFirstScreenCopy.isListeningNowCopyAllowed(
            continuousState: harness.controller.continuousListeningState
        ))
        if case let .failed(message) = harness.controller.continuousListeningState {
            #expect(message.contains("microphone"))
        } else {
            Issue.record("expected failed continuous listening state")
        }
        #expect(harness.events.kinds.contains(
            .continuousListeningFailed("microphone permission is required for push to talk.")
        ))
        #expect(harness.continuous.isContinuousCaptureActive == false)
    }

    @Test func captureInactiveAfterStartDoesNotPublishListening() async {
        let harness = makeHarness()
        harness.continuous.startShouldClaimSuccessWithoutActivating = true
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilFailed(harness.controller)

        #expect(!harness.controller.continuousListeningState.isArmed)
        #expect(!harness.controller.isContinuousListeningEnabled)
        #expect(harness.controller.capturePhase == .idle)
        #expect(!YishuPanelFirstScreenCopy.isListeningNowCopyAllowed(
            continuousState: harness.controller.continuousListeningState
        ))
        #expect(harness.continuous.isContinuousCaptureActive == false)
        #expect(harness.events.kinds.contains {
            if case .continuousListeningFailed = $0 { return true }
            return false
        })
    }

    @Test func disableDropsLateFinal() async {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness)
        await beginUtterance(harness: harness)
        harness.continuous.emitPartial("会被关掉")
        harness.controller.setContinuousListeningEnabled(false)
        harness.continuous.emitFinal("迟到终稿")

        #expect(!harness.events.utteranceKinds.contains { kind in
            if case .finalized = kind { return true }
            return false
        })
        #expect(harness.continuous.stopCount == 1)
        #expect(!harness.controller.isContinuousListeningEnabled)
        #expect(harness.controller.continuousListeningState == .off)
    }

    @Test func providerFinalAndLocalEndDoNotDoubleSubmit() async {
        let harness = makeHarness()
        harness.controller.setContinuousListeningEnabled(true)
        await waitUntilArmed(harness)
        await beginUtterance(harness: harness)
        harness.continuous.emitPartial("同一句")
        endUtterance(harness: harness)
        harness.continuous.emitFinal("同一句")
        harness.continuous.emitFinal("同一句又来")

        let finals = harness.events.utteranceKinds.filter { kind in
            if case .finalized = kind { return true }
            return false
        }
        #expect(finals.count == 1)
        #expect(harness.events.utteranceKinds.contains(.finalized("同一句")))
    }

    @Test func pttFallbackUnchangedWhenContinuousOff() async {
        let harness = makeHarness()
        #expect(!harness.controller.isContinuousListeningEnabled)

        harness.controller.handleShortcutTransition(.pressed)
        await waitUntilKeyboardReady(harness.keyboard)
        harness.keyboard.emitPartial("按住")
        harness.controller.handleShortcutTransition(.released)
        harness.keyboard.emitFinal("按住说话")

        #expect(harness.events.utteranceKinds == [
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

    private func waitUntilArmed(_ harness: Harness) async {
        for _ in 0..<80 where !harness.continuous.isContinuousCaptureActive {
            await Task.yield()
        }
        for _ in 0..<80 where !harness.controller.continuousListeningState.isArmed {
            await Task.yield()
        }
    }

    private func waitUntilFailed(_ controller: YishuVoiceSessionController) async {
        for _ in 0..<50 {
            if case .failed = controller.continuousListeningState {
                return
            }
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
