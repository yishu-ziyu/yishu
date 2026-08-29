import Foundation
import XCTest
@testable import Clicky

final class QualityEventRecorderTests: XCTestCase {
    private var previousQualityStoreURL: URL?
    private var qualityStoreDirectory: URL?
    private var previousOnboardingDefaults: UserDefaults?
    private var onboardingDefaults: UserDefaults?
    private var onboardingSuiteName: String?

    override func setUpWithError() throws {
        try super.setUpWithError()

        previousQualityStoreURL = QualityEventRecorder.testStoreURL
        let qualityDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("yishu-quality-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: qualityDirectory,
            withIntermediateDirectories: true
        )
        qualityStoreDirectory = qualityDirectory
        QualityEventRecorder.testStoreURL = qualityDirectory.appendingPathComponent("quality.jsonl")
        QualityEventRecorder.clear()

        previousOnboardingDefaults = YishuOnboardingStore.testDefaults
        let suiteName = "com.yishu.tests.onboarding.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        onboardingSuiteName = suiteName
        onboardingDefaults = defaults
        YishuOnboardingStore.testDefaults = defaults
    }

    override func tearDownWithError() throws {
        if let onboardingDefaults, let onboardingSuiteName {
            onboardingDefaults.removePersistentDomain(forName: onboardingSuiteName)
        }
        YishuOnboardingStore.testDefaults = previousOnboardingDefaults

        QualityEventRecorder.clear()
        QualityEventRecorder.testStoreURL = previousQualityStoreURL
        if let qualityStoreDirectory {
            try? FileManager.default.removeItem(at: qualityStoreDirectory)
        }
        try super.tearDownWithError()
    }

    func testRejectsTranscriptAttributesByIgnoringTheWrite() throws {
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

        let storeURL = try XCTUnwrap(QualityEventRecorder.testStoreURL)
        let lines = String(
            decoding: try Data(contentsOf: storeURL),
            as: UTF8.self
        ).split(whereSeparator: \.isNewline)
        XCTAssertEqual(lines.count, 1)
        let event = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(lines[0].utf8)) as? [String: Any]
        )
        XCTAssertEqual(event["name"] as? String, "ptt.key_down")
        let attributes = try XCTUnwrap(event["attributes"] as? [String: Any])
        XCTAssertEqual(attributes["actionKind"] as? String, "ptt")
        XCTAssertNil(attributes["transcript"])
    }

    func testOnboardingActivationRequiresVerifiedAction() {
        YishuOnboardingStore.record(.introSeen)
        XCTAssertFalse(YishuOnboardingStore.isActivated)
        YishuOnboardingStore.record(.verifiedActionCompleted, scenarioId: "desktop.ax_press_verified", receiptId: UUID().uuidString)
        XCTAssertTrue(YishuOnboardingStore.isActivated)
    }
}
