import Foundation
import Testing
@testable import Clicky

struct YishuComputerUseReadBackTests {
    @Test func waitReturnsWithoutScreenCaptureWhenThereIsNoLabeledEffect() async {
        let started = Date()
        // Window-signature evidence is allowed. The receipt path must not wait
        // on ScreenCaptureKit, which previously blocked MainActor for 15s+.
        _ = await YishuComputerUseReadBack.wait(
            processIdentifier: nil,
            focusedElementBefore: nil,
            windowSignatureBefore: "stable-window",
            candidate: nil,
            candidateBefore: nil
        )
        #expect(Date().timeIntervalSince(started) < 1.5)
    }

    @Test func pollLabeledEffectDoesNotWaitWhenTheIdentifierIsMissing() async {
        let started = Date()
        let labeled = await YishuComputerUseReadBack.pollLabeledEffect(processIdentifier: nil)
        #expect(labeled.terminalEffect == nil)
        #expect(labeled.values[YishuComputerUseReadBack.effectIdentifier] == nil)
        #expect(Date().timeIntervalSince(started) < 0.5)
    }
}
