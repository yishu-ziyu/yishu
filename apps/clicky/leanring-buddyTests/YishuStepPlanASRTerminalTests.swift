import Foundation
import Testing
@testable import Clicky

struct YishuStepPlanASRTerminalTests {
    @Test func deltaThenDoneIsOneSuccessfulFinal() {
        var acc = YishuStepPlanSSEAccumulator()
        acc.consumeDataLine(#"data: {"type":"transcript.text.delta","delta":"你"}"#)
        acc.consumeDataLine(#"data: {"type":"transcript.text.done","text":"你好"}"#)
        let result = acc.result()
        guard case let .success(text) = result else {
            Issue.record("expected success")
            return
        }
        #expect(text == "你好")
        #expect(acc.counts.delta == 1)
        #expect(acc.counts.done == 1)
        #expect(acc.counts.error == 0)
    }

    @Test func providerErrorSSEIsExplicitFailureNotEmpty() {
        var acc = YishuStepPlanSSEAccumulator()
        acc.consumeDataLine(#"data: {"type":"error","code":"bad_request"}"#)
        let result = acc.result()
        guard case let .failure(error) = result else {
            Issue.record("expected failure")
            return
        }
        #expect(error.kind == .sseError)
        #expect(acc.counts.error == 1)
    }

    @Test func successfulEmptyDoneIsGenuineEmpty() {
        var acc = YishuStepPlanSSEAccumulator()
        acc.consumeDataLine(#"data: {"type":"transcript.text.done","text":""}"#)
        let result = acc.result()
        guard case let .success(text) = result else {
            Issue.record("expected empty success")
            return
        }
        #expect(text.isEmpty)
        #expect(!acc.sawError)
    }

    @Test func streamWithoutRecognizedTerminalIsMissingTerminal() {
        var acc = YishuStepPlanSSEAccumulator()
        acc.consumeDataLine("data: [DONE]")
        acc.consumeDataLine(#"data: {"type":"unknown"}"#)
        let result = acc.result()
        guard case let .failure(error) = result else {
            Issue.record("expected missing terminal")
            return
        }
        #expect(error.kind == .missingTerminal)
    }

    @Test func httpFailureAndTimeoutAreNotEmptySilence() {
        #expect(YishuAsrSessionError(kind: .httpFailure).kind != .empty)
        #expect(YishuAsrSessionError(kind: .timeout).kind != .empty)
        #expect(YishuAsrTerminalKind.httpFailure.isExplicitFailure)
        #expect(YishuAsrTerminalKind.timeout.isExplicitFailure)
        #expect(!YishuAsrTerminalKind.empty.isExplicitFailure)
    }

    @Test func httpNon2xxIsExplicitFailure() {
        #expect(YishuAsrSessionError(kind: .httpFailure).kind.isExplicitFailure)
        #expect(YishuAsrTerminalKind.httpFailure != .empty)
    }

    @Test func timeoutMapsToTimeoutKind() {
        #expect(YishuAsrSessionError(kind: .timeout).kind == .timeout)
        #expect(YishuAsrTerminalKind.timeout.isExplicitFailure)
        #expect(YishuAsrTerminalKind.timeout != .empty)
    }
}
