import Foundation
import Testing
@testable import Clicky

struct YishuAsrInterimPolicyTests {
    @Test func growingWindowUsesFastThenSlowThenStopsAtTenSeconds() {
        #expect(YishuAsrInterimPolicy.nextInterval(elapsed: 0) == 0.8)
        #expect(YishuAsrInterimPolicy.nextInterval(elapsed: 4.9) == 0.8)
        #expect(YishuAsrInterimPolicy.nextInterval(elapsed: 5) == 1.5)
        #expect(YishuAsrInterimPolicy.nextInterval(elapsed: 9.9) == 1.5)
        #expect(YishuAsrInterimPolicy.nextInterval(elapsed: 10) == nil)
        #expect(YishuAsrInterimPolicy.nextInterval(elapsed: 12) == nil)
    }

    @Test func keyUpRacePrefersFinalWithin150msOtherwiseKeepsFirstNonEmpty() {
        #expect(
            YishuAsrKeyUpRace.winner(
                first: YishuAsrKeyUpRaceResult(source: .interim, text: "中间稿"),
                second: YishuAsrKeyUpRaceResult(source: .final, text: "终稿"),
                secondDelaySeconds: 0.15
            ) == "终稿"
        )
        #expect(
            YishuAsrKeyUpRace.winner(
                first: YishuAsrKeyUpRaceResult(source: .interim, text: "中间稿"),
                second: YishuAsrKeyUpRaceResult(source: .final, text: "终稿"),
                secondDelaySeconds: 0.151
            ) == "中间稿"
        )
        #expect(
            YishuAsrKeyUpRace.winner(
                first: YishuAsrKeyUpRaceResult(source: .final, text: "终稿"),
                second: YishuAsrKeyUpRaceResult(source: .interim, text: "中间稿"),
                secondDelaySeconds: 0.01
            ) == "终稿"
        )
        #expect(
            YishuAsrKeyUpRace.winner(
                first: YishuAsrKeyUpRaceResult(source: .interim, text: "  "),
                second: YishuAsrKeyUpRaceResult(source: .final, text: "终稿"),
                secondDelaySeconds: 1
            ) == "终稿"
        )
    }

    @Test func finalRequestDispatchesWithin50msOfKeyUp() async throws {
        let session = StepPlanAudioTranscriptionSession(
            proxyURL: URL(string: "http://127.0.0.1:9/audio/asr/sse")!,
            keyterms: [],
            onTranscriptUpdate: { _ in },
            onFinalTranscriptReady: { _ in },
            onError: { _ in }
        )
        session.appendPCM16(Data(repeating: 0, count: 32_000))
        session.requestFinalTranscript()
        var delay: Int?
        for _ in 0..<50 {
            delay = session.finalDispatchDelayMsForTests()
            if delay != nil { break }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        session.cancel()
        let dispatched = try #require(delay)
        #expect(dispatched < 50)
    }

    @Test func loopbackSessionHelperDisablesSystemProxy() {
        let session = YishuLoopbackSession.make()
        let dictionary = session.configuration.connectionProxyDictionary
        #expect(dictionary?.isEmpty == true)
        session.invalidateAndCancel()
    }

    @Test func loopbackSessionsBypassSystemProxy() {
        let session = StepPlanAudioTranscriptionSession(
            proxyURL: URL(string: "http://127.0.0.1:9/audio/asr/sse")!,
            keyterms: [],
            onTranscriptUpdate: { _ in },
            onFinalTranscriptReady: { _ in },
            onError: { _ in }
        )
        #expect(session.disablesSystemProxyForTests())
        session.cancel()
    }
}
