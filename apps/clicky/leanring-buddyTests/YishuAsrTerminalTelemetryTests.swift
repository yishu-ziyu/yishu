import Foundation
import Testing
@testable import Clicky

@MainActor
struct YishuAsrTerminalTelemetryTests {
    @Test func continuousReleaseDoesNotEmitPTTKeys() throws {
        let store = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("yishu-asr-terminal-telemetry.jsonl")
        try? FileManager.default.removeItem(at: store)
        QualityEventRecorder.testStoreURL = store
        QualityEventRecorder.clear()
        ClickyAnalytics.bindVoiceTurn("abc123def456")
        YishuAsrReleaseTelemetry.recordCaptureRelease(
            continuousArmed: true,
            traceID: "abc123def456"
        )
        ClickyAnalytics.trackAsrTerminal(kind: .success)
        let events = try readEvents(at: store)
        let names = events.compactMap { $0["name"] as? String }
        #expect(names.contains("duplex.end_of_speech"))
        #expect(names.contains("asr.terminal"))
        #expect(!names.contains("ptt.key_down"))
        #expect(!names.contains("ptt.key_up"))
        for event in events {
            let attributes = event["attributes"] as? [String: Any]
            #expect(attributes?["turnId"] as? String == "abc123def456")
        }
        QualityEventRecorder.testStoreURL = nil
    }

    @Test func actualPTTReleaseStillEmitsKeyUp() throws {
        let store = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("yishu-asr-ptt-telemetry.jsonl")
        try? FileManager.default.removeItem(at: store)
        QualityEventRecorder.testStoreURL = store
        QualityEventRecorder.clear()
        ClickyAnalytics.trackPushToTalkStarted(turnId: "pttturn12ab")
        YishuAsrReleaseTelemetry.recordCaptureRelease(
            continuousArmed: false,
            traceID: "pttturn12ab"
        )
        let names = try readEvents(at: store).compactMap { $0["name"] as? String }
        #expect(names == ["ptt.key_down", "ptt.key_up"])
        QualityEventRecorder.testStoreURL = nil
    }

    @Test func voiceSessionCorrelatesOnsetEosAndTerminal() async {
        let continuous = FakeContinuousDictation()
        let clock = FakeMonotonicClock()
        var events: [YishuVoiceSessionEvent] = []
        let controller = YishuVoiceSessionController(
            dictation: FakeKeyboardDictation(),
            monitor: FakePushToTalkMonitor(),
            onEvent: { events.append($0) },
            continuousDictation: continuous,
            clock: clock
        )
        controller.setContinuousListeningEnabled(true)
        for _ in 0..<80 where !controller.continuousListeningState.isArmed {
            await Task.yield()
        }
        let before = continuous.beginCount
        clock.now += 20
        continuous.emitPower(0.4)
        for _ in 0..<80 where continuous.beginCount < before + 1 {
            await Task.yield()
        }
        continuous.emitPartial("同一句")
        clock.now += YishuHandsFreeListeningPolicy.endOfSpeechSilenceMs + 50
        continuous.emitPower(0.02)
        continuous.emitFinal("同一句")
        for _ in 0..<40 {
            if events.contains(where: { if case .finalized = $0 { return true }; return false }) {
                break
            }
            await Task.yield()
        }
        let onset = events.compactMap { event -> String? in
            if case let .speechOnset(id) = event { return id }
            return nil
        }
        let released = events.compactMap { event -> String? in
            if case let .released(origin) = event { return origin.traceID }
            return nil
        }
        let finalized = events.compactMap { event -> String? in
            if case let .finalized(origin, _) = event { return origin.traceID }
            return nil
        }
        #expect(onset.count == 1)
        #expect(released == onset)
        #expect(finalized == onset)
    }

    @Test func sseErrorDoesNotBecomeProductFinal() async {
        let continuous = FakeContinuousDictation()
        let clock = FakeMonotonicClock()
        var events: [YishuVoiceSessionEvent] = []
        let controller = YishuVoiceSessionController(
            dictation: FakeKeyboardDictation(),
            monitor: FakePushToTalkMonitor(),
            onEvent: { events.append($0) },
            continuousDictation: continuous,
            clock: clock
        )
        controller.setContinuousListeningEnabled(true)
        for _ in 0..<80 where !controller.continuousListeningState.isArmed {
            await Task.yield()
        }
        clock.now = 20
        continuous.emitPower(0.4)
        for _ in 0..<50 where continuous.beginCount < 1 {
            await Task.yield()
        }
        continuous.emitFinal("", kind: .sseError)
        await Task.yield()
        #expect(events.contains { event in
            if case let .captureFailed(_, reason) = event {
                return reason == .asrTerminal(.sseError)
            }
            return false
        })
        #expect(!events.contains { event in
            if case .finalized = event { return true }
            return false
        })
    }
}

private func readEvents(at url: URL) throws -> [[String: Any]] {
    let data = try Data(contentsOf: url)
    guard let text = String(data: data, encoding: .utf8) else { return [] }
    return text.split(whereSeparator: \.isNewline).compactMap { line in
        try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
    }
}
