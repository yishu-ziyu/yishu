import XCTest
@testable import Clicky

final class QualityEventRecorderTests: XCTestCase {
    func testRejectsTranscriptAttributesByIgnoringTheWrite() {
        QualityEventRecorder.clear()
        QualityEventRecorder.record(
            name: "asr.completed",
            sessionId: "s",
            attributes: ["transcript": "secret"]
        )
        QualityEventRecorder.record(
            name: "ptt.key_down",
            sessionId: "s",
            attributes: ["actionKind": "ptt"]
        )
        XCTAssertFalse(YishuOnboardingStore.isActivated)
    }

    func testOnboardingActivationRequiresVerifiedAction() {
        YishuOnboardingStore.record(.introSeen)
        XCTAssertFalse(YishuOnboardingStore.isActivated)
        YishuOnboardingStore.record(.verifiedActionCompleted, scenarioId: "desktop.ax_press_verified", receiptId: UUID().uuidString)
        XCTAssertTrue(YishuOnboardingStore.isActivated)
    }
}
