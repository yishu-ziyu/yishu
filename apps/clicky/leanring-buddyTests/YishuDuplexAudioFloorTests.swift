import Foundation
import Testing
import YishuContext
@testable import Clicky

@MainActor
struct YishuDuplexAudioFloorTests {
    @Test func takeFloorStopsPresentationSynchronouslyBeforeAnyFinal() async throws {
        let probe = FloorProbe()
        let execution = try makeActiveExecution()
        YishuDuplexAudioFloor.takeFloorOnSpeechOnset(
            presentation: probe.presentation,
            foreground: probe.foreground(execution: execution.execution),
            transcriptFinalized: false,
            runtimeAcknowledged: false
        )
        #expect(probe.order == ["sentence", "playback"])
        #expect(probe.sentenceStops == 1)
        #expect(probe.playbackStops == 1)
        #expect(execution.execution.isActive)
        execution.execution.cancel(requestId: execution.session.requestId, reason: "test-cleanup")
    }

    @Test func takeFloorDoesNotWaitForRuntimeAcknowledgement() async throws {
        let probe = FloorProbe()
        let execution = try makeActiveExecution()
        YishuDuplexAudioFloor.takeFloorOnSpeechOnset(
            presentation: probe.presentation,
            foreground: probe.foreground(execution: execution.execution),
            transcriptFinalized: false,
            runtimeAcknowledged: false
        )
        #expect(probe.sentenceStops == 1)
        #expect(probe.playbackStops == 1)
        #expect(probe.cancels == 0)
        execution.execution.cancel(requestId: execution.session.requestId, reason: "test-cleanup")
    }

    @Test func takeFloorDoesNotCancelActiveForegroundRuntime() async throws {
        let probe = FloorProbe()
        let execution = try makeActiveExecution()
        YishuDuplexAudioFloor.takeFloorOnSpeechOnset(
            presentation: probe.presentation,
            foreground: probe.foreground(execution: execution.execution),
            transcriptFinalized: false,
            runtimeAcknowledged: false
        )
        #expect(probe.cancels == 0)
        #expect(execution.runtime.cancelCount == 0)
        #expect(execution.execution.isActive)
        execution.execution.cancel(requestId: execution.session.requestId, reason: "test-cleanup")
    }

    @Test func takeFloorDoesNotSettleOrSupersedeForegroundRuntime() async throws {
        let probe = FloorProbe()
        let execution = try makeActiveExecution()
        YishuDuplexAudioFloor.takeFloorOnSpeechOnset(
            presentation: probe.presentation,
            foreground: probe.foreground(execution: execution.execution),
            transcriptFinalized: false,
            runtimeAcknowledged: false
        )
        #expect(probe.settles == 0)
        #expect(probe.supersedes == 0)
        #expect(execution.runtime.startCount == 1)
        #expect(execution.execution.isActive)
        execution.execution.cancel(requestId: execution.session.requestId, reason: "test-cleanup")
    }

    private func makeActiveExecution() throws -> (
        runtime: FakeForegroundRuntime,
        execution: YishuForegroundRuntimeExecution,
        session: YishuForegroundRuntimeSession
    ) {
        let runtime = FakeForegroundRuntime()
        let execution = YishuForegroundRuntimeExecution(runtime: runtime)
        let session = try execution.start(
            utterance: "先做这件事",
            contextFrame: audioFloorDummyFrame(),
            modelProvider: "local",
            model: "test",
            modelRouting: .fixed(
                preference: YishuModelPreference(provider: "local", model: "test")
            )
        )
        return (runtime, execution, session)
    }
}

@MainActor
private final class FloorProbe {
    var sentenceStops = 0
    var playbackStops = 0
    var cancels = 0
    var settles = 0
    var supersedes = 0
    var order: [String] = []

    var presentation: YishuDuplexAudioFloor.PresentationEffects {
        .init(
            stopSentenceSpeech: { [unowned self] in
                sentenceStops += 1
                order.append("sentence")
            },
            stopPlayback: { [unowned self] in
                playbackStops += 1
                order.append("playback")
            }
        )
    }

    func foreground(
        execution: YishuForegroundRuntimeExecution
    ) -> YishuDuplexAudioFloor.ForegroundRuntimeBoundary {
        .init(
            isActive: { execution.isActive },
            cancel: { [unowned self] reason in
                cancels += 1
                execution.cancel(reason: reason)
            },
            settle: { [unowned self] in settles += 1 },
            supersede: { [unowned self] in supersedes += 1 }
        )
    }
}

private func audioFloorDummyFrame() -> YishuContextFrame {
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
