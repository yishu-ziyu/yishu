import Combine
import Foundation
import Testing
@testable import Clicky

@MainActor
final class FakeKeyboardDictation: YishuKeyboardDictationControlling {
    var isDictationInProgress = false
    var startCallCount = 0
    var stopCallCount = 0
    var cancelCallCount = 0
    var waitForStart = false

    private var startGate: CheckedContinuation<Void, Never>?
    private(set) var updateDraftText: ((String) -> Void)?
    private(set) var submitDraftText: ((String) -> Void)?

    func startPushToTalkFromKeyboardShortcut(
        currentDraftText: String,
        updateDraftText: @escaping (String) -> Void,
        submitDraftText: @escaping (String) -> Void
    ) async {
        startCallCount += 1
        isDictationInProgress = true
        self.updateDraftText = nil
        self.submitDraftText = nil
        if waitForStart {
            await withCheckedContinuation { continuation in
                startGate = continuation
            }
        }
        guard !Task.isCancelled else {
            isDictationInProgress = false
            return
        }
        self.updateDraftText = updateDraftText
        self.submitDraftText = submitDraftText
    }

    func stopPushToTalkFromKeyboardShortcut() {
        stopCallCount += 1
    }

    func cancelCurrentDictation(preserveDraftText: Bool) {
        cancelCallCount += 1
        isDictationInProgress = false
        settleStart()
    }

    func settleStart() {
        startGate?.resume()
        startGate = nil
    }

    func emitPartial(_ text: String) {
        updateDraftText?(text)
    }

    func emitFinal(_ text: String) {
        isDictationInProgress = false
        submitDraftText?(text)
    }
}

final class FakePushToTalkMonitor: YishuPushToTalkShortcutMonitoring {
    let shortcutTransitionPublisher = PassthroughSubject<
        BuddyPushToTalkShortcut.ShortcutTransition,
        Never
    >()
    var startCount = 0
    var stopCount = 0

    func start() {
        startCount += 1
    }

    func stop() {
        stopCount += 1
    }
}

@MainActor
struct YishuVoiceSessionControllerTests {
    @Test func pressedPartialsReleasedFinalEmitsOneSubmission() async {
        let (controller, dictation, events) = makeController()

        controller.handleShortcutTransition(.pressed)
        await waitUntilReady(dictation, startCount: 1)
        dictation.emitPartial("你")
        dictation.emitPartial("你好")
        controller.handleShortcutTransition(.released)
        dictation.emitFinal("  你好世界  ")
        dictation.emitFinal("第二次终稿")

        #expect(events.kinds == [
            .pressed,
            .partial("你"),
            .partial("你好"),
            .released,
            .finalized("你好世界"),
        ])
        #expect(dictation.stopCallCount == 1)
        #expect(!controller.isKeyHeld)
    }

    @Test func quickReleaseBeforeStartSettlesDoesNotStickHeld() async {
        let (controller, dictation, events) = makeController()
        dictation.waitForStart = true

        controller.handleShortcutTransition(.pressed)
        await waitUntilStarted(dictation)
        #expect(dictation.startCallCount == 1)
        #expect(controller.isKeyHeld)

        controller.handleShortcutTransition(.released)
        #expect(!controller.isKeyHeld)
        #expect(dictation.stopCallCount == 1)

        dictation.settleStart()
        await Task.yield()
        dictation.emitFinal("迟到的终稿")

        #expect(events.kinds == [.pressed, .released])
        #expect(!dictation.isDictationInProgress)
        #expect(!controller.isKeyHeld)
    }

    @Test func staleAndSupersededCallbacksAreIgnored() async {
        let (controller, dictation, events) = makeController()

        controller.handleShortcutTransition(.pressed)
        await waitUntilReady(dictation, startCount: 1)
        let firstSubmit = dictation.submitDraftText
        dictation.emitPartial("第一轮")
        controller.handleShortcutTransition(.released)
        dictation.emitFinal("第一轮终稿")

        controller.handleShortcutTransition(.pressed)
        await waitUntilReady(dictation, startCount: 2)
        dictation.emitPartial("第二轮")
        firstSubmit?("过期终稿")
        controller.handleShortcutTransition(.released)
        dictation.emitFinal("第二轮终稿")

        #expect(events.kinds == [
            .pressed,
            .partial("第一轮"),
            .released,
            .finalized("第一轮终稿"),
            .pressed,
            .partial("第二轮"),
            .released,
            .finalized("第二轮终稿"),
        ])
    }

    @Test func cancellationPreventsLaterFinalSubmission() async {
        let (controller, dictation, events) = makeController()

        controller.handleShortcutTransition(.pressed)
        await waitUntilReady(dictation, startCount: 1)
        dictation.emitPartial("会被取消")
        controller.cancelCapture()
        dictation.emitFinal("取消后的终稿")

        #expect(events.kinds == [
            .pressed,
            .partial("会被取消"),
            .cancelled,
        ])
        #expect(dictation.cancelCallCount == 1)
        #expect(!controller.isKeyHeld)
    }

    @Test func emptyFinalIsUnsuccessfulCaptureNotFinalTranscript() async {
        let (controller, dictation, events) = makeController()

        controller.handleShortcutTransition(.pressed)
        await waitUntilReady(dictation, startCount: 1)
        controller.handleShortcutTransition(.released)
        dictation.emitFinal("   ")

        #expect(events.kinds == [
            .pressed,
            .released,
            .captureFailed,
        ])
        #expect(!events.kinds.contains { kind in
            if case .finalized = kind { return true }
            return false
        })
    }

    @Test func monitorPublisherDrivesTheSamePressedPath() async {
        let dictation = FakeKeyboardDictation()
        let monitor = FakePushToTalkMonitor()
        let events = EventSink()
        let controller = YishuVoiceSessionController(
            dictation: dictation,
            monitor: monitor,
            onEvent: { events.append($0) }
        )
        controller.start()
        monitor.shortcutTransitionPublisher.send(.pressed)
        await waitUntilReady(dictation, startCount: 1)
        controller.setShortcutMonitorEnabled(true)
        controller.stop()

        #expect(events.kinds.first == .pressed)
        #expect(monitor.startCount == 1)
        #expect(monitor.stopCount == 1)
        #expect(events.kinds.contains(.cancelled))
    }

    private func makeController() -> (
        YishuVoiceSessionController,
        FakeKeyboardDictation,
        EventSink
    ) {
        let dictation = FakeKeyboardDictation()
        let events = EventSink()
        let controller = YishuVoiceSessionController(
            dictation: dictation,
            monitor: FakePushToTalkMonitor(),
            onEvent: { events.append($0) }
        )
        return (controller, dictation, events)
    }

    private func waitUntilStarted(_ dictation: FakeKeyboardDictation) async {
        for _ in 0..<50 where dictation.startCallCount == 0 {
            await Task.yield()
        }
    }

    private func waitUntilReady(
        _ dictation: FakeKeyboardDictation,
        startCount: Int
    ) async {
        for _ in 0..<50 {
            if dictation.startCallCount >= startCount,
               dictation.submitDraftText != nil {
                return
            }
            await Task.yield()
        }
    }
}

@MainActor
final class EventSink {
    private(set) var events: [YishuVoiceSessionEvent] = []

    func append(_ event: YishuVoiceSessionEvent) {
        events.append(event)
    }

    var kinds: [Kind] {
        events.map(Kind.init)
    }

    enum Kind: Equatable {
        case pressed
        case partial(String)
        case released
        case finalized(String)
        case captureFailed
        case cancelled

        init(_ event: YishuVoiceSessionEvent) {
            switch event {
            case .pressed:
                self = .pressed
            case let .partial(_, text):
                self = .partial(text)
            case .released:
                self = .released
            case let .finalized(_, transcript):
                self = .finalized(transcript)
            case .captureFailed:
                self = .captureFailed
            case .cancelled:
                self = .cancelled
            }
        }
    }
}

