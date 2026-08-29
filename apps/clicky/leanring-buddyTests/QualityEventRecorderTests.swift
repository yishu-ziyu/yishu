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

    func testMemoryQualityEventsContainOnlyOpaqueIdentityAndScopeHash() throws {
        let memoryID = UUID(uuidString: "6BA7B810-9DAD-11D1-80B4-00C04FD430C8")!
        let projectScope = "PROJECT:6BA7B811-9DAD-11D1-80B4-00C04FD430C8"
        YishuMemoryQualityEvents.recordRemembered(memoryID: memoryID, scope: "personal")
        YishuMemoryQualityEvents.recordUsed(memoryID: memoryID, scope: projectScope)
        YishuMemoryQualityEvents.recordForgotten(memoryID: memoryID, scope: "personal")
        YishuMemoryQualityEvents.recordForgotten(memoryID: memoryID, scope: "personal", status: "failed")
        YishuMemoryQualityEvents.recordForgotten(memoryID: memoryID, scope: "personal", status: "失败详情")
        // Project labels are user content, not a safe quality-event scope.
        YishuMemoryQualityEvents.recordUsed(memoryID: memoryID, scope: "project:秘密项目")

        XCTAssertEqual(
            YishuMemoryQualityEvents.scopeHash(" PERSONAL \n"),
            "4a0a339b0c6d0553897752a84115adc81c75812e1743eb2519258e5000f70deb"
        )
        XCTAssertEqual(
            YishuMemoryQualityEvents.scopeHash(projectScope),
            "a09241bf50effd414d486080ad08f20e5ecab3a8fb014b26e56842328fec0200"
        )
        XCTAssertEqual(
            YishuMemoryQualityEvents.scopeHash(" project:6ba7b811-9dad-11d1-80b4-00c04fd430c8 "),
            YishuMemoryQualityEvents.scopeHash(projectScope)
        )
        XCTAssertNil(YishuMemoryQualityEvents.scopeHash("project:秘密项目"))

        let storeURL = try XCTUnwrap(QualityEventRecorder.testStoreURL)
        let lines = String(
            decoding: try Data(contentsOf: storeURL),
            as: UTF8.self
        ).split(whereSeparator: \.isNewline)
        XCTAssertEqual(lines.count, 4)

        let expectedHash = "e5855ff48799c52c9ccf80b82bab9492c347a316876dbeaafef22b0bd4fac13d"
        let expectedNames = ["memory.remembered", "memory.used", "memory.forgotten", "memory.forgotten"]
        let expectedStatuses = ["ok", "ok", "ok", "failed"]
        let expectedScopeHashes = [
            "4a0a339b0c6d0553897752a84115adc81c75812e1743eb2519258e5000f70deb",
            "a09241bf50effd414d486080ad08f20e5ecab3a8fb014b26e56842328fec0200",
            "4a0a339b0c6d0553897752a84115adc81c75812e1743eb2519258e5000f70deb",
            "4a0a339b0c6d0553897752a84115adc81c75812e1743eb2519258e5000f70deb",
        ]
        for (((line, expectedName), expectedStatus), expectedScopeHash) in zip(
            zip(zip(lines, expectedNames), expectedStatuses), expectedScopeHashes
        ) {
            let event = try XCTUnwrap(
                JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
            )
            XCTAssertEqual(event["name"] as? String, expectedName)
            XCTAssertEqual(event["status"] as? String, expectedStatus)
            let attributes = try XCTUnwrap(event["attributes"] as? [String: Any])
            XCTAssertEqual(Set(attributes.keys), ["memoryIdHash", "scopeHash"])
            XCTAssertEqual(attributes["memoryIdHash"] as? String, expectedHash)
            XCTAssertEqual(attributes["scopeHash"] as? String, expectedScopeHash)
            XCTAssertEqual((attributes["scopeHash"] as? String)?.count, 64)
            XCTAssertTrue((attributes["scopeHash"] as? String)?.allSatisfy { $0.isHexDigit } == true)
            XCTAssertNil(attributes["scope"])
            XCTAssertFalse(String(data: Data(line.utf8), encoding: .utf8)?.contains(memoryID.uuidString) ?? true)
            XCTAssertFalse(String(data: Data(line.utf8), encoding: .utf8)?.contains(memoryID.uuidString.lowercased()) ?? true)
            XCTAssertFalse(String(data: Data(line.utf8), encoding: .utf8)?.contains("6BA7B811-9DAD-11D1-80B4-00C04FD430C8") ?? true)
            XCTAssertFalse(String(data: Data(line.utf8), encoding: .utf8)?.contains(projectScope.lowercased()) ?? true)
            XCTAssertFalse(String(data: Data(line.utf8), encoding: .utf8)?.contains("秘密项目") ?? true)
        }
    }

    func testOnboardingActivationRequiresVerifiedAction() {
        YishuOnboardingStore.record(.introSeen)
        XCTAssertFalse(YishuOnboardingStore.isActivated)
        YishuOnboardingStore.record(.verifiedActionCompleted, scenarioId: "desktop.ax_press_verified", receiptId: UUID().uuidString)
        XCTAssertTrue(YishuOnboardingStore.isActivated)
    }

    func testEveryQualityEventCarriesCurrentAppPID() throws {
        QualityEventRecorder.clear()
        QualityEventRecorder.record(name: "app.ready", sessionId: "app")

        let event = try XCTUnwrap(try readEvents().first)
        XCTAssertEqual(
            event["appPid"] as? Int,
            Int(ProcessInfo.processInfo.processIdentifier)
        )
    }

    func testRawScopeIsRejectedFromQualityEvents() throws {
        QualityEventRecorder.clear()
        QualityEventRecorder.record(
            name: "memory.used",
            sessionId: "memory",
            attributes: ["memoryIdHash": String(repeating: "a", count: 64), "scope": "personal"]
        )

        let storeURL = try XCTUnwrap(QualityEventRecorder.testStoreURL)
        let events = FileManager.default.fileExists(atPath: storeURL.path)
            ? try readEvents()
            : []
        XCTAssertTrue(events.isEmpty)
    }

    func testQualityLogUsesOwnerOnlyPermissionsForNewAndExistingFiles() throws {
        QualityEventRecorder.clear()
        QualityEventRecorder.record(name: "app.ready", sessionId: "app")
        XCTAssertEqual(try qualityLogMode(), 0o600)

        let storeURL = try XCTUnwrap(QualityEventRecorder.testStoreURL)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o644],
            ofItemAtPath: storeURL.path
        )
        XCTAssertEqual(try qualityLogMode(), 0o644)

        QualityEventRecorder.record(name: "app.launched", sessionId: "app")
        XCTAssertEqual(try qualityLogMode(), 0o600)
    }

    func testDeviceAttributeValidationRejectsUnsafeValues() throws {
        let invalidAttributes: [[String: Any]] = [
            ["memoryIdHash": String(repeating: "A", count: 64)],
            ["scopeHash": String(repeating: "a", count: 63)],
            ["receiptHash": String(repeating: "g", count: 64)],
            ["reason": "runtime_restart"],
            ["method": "user_supplied"],
            ["code": "user_supplied"],
            ["taskTerminal": "done"],
            ["sourceDimensionsAvailable": "true"],
            ["verified": 1],
            ["durationMs": -1],
            ["retryCount": "0"],
        ]

        for attributes in invalidAttributes {
            QualityEventRecorder.clear()
            QualityEventRecorder.record(
                name: "device.test",
                sessionId: "device",
                attributes: attributes
            )
            let storeURL = try XCTUnwrap(QualityEventRecorder.testStoreURL)
            XCTAssertFalse(
                FileManager.default.fileExists(atPath: storeURL.path),
                "unsafe attributes must reject the entire event: \(attributes.keys)"
            )
        }

        QualityEventRecorder.clear()
        QualityEventRecorder.record(
            name: "device.test",
            sessionId: "device",
            durationMs: -1
        )
        let storeURL = try XCTUnwrap(QualityEventRecorder.testStoreURL)
        XCTAssertFalse(FileManager.default.fileExists(atPath: storeURL.path))
    }

    func testPushToTalkReleaseRecordsHeldDuration() throws {
        QualityEventRecorder.clear()
        ClickyAnalytics.trackPushToTalkStarted()
        ClickyAnalytics.trackPushToTalkReleased()

        let events = try readEvents()
        XCTAssertEqual(events.map { $0["name"] as? String }, ["ptt.key_down", "ptt.key_up"])
        let duration = try XCTUnwrap(events[1]["durationMs"] as? Int)
        XCTAssertGreaterThanOrEqual(duration, 0)
    }

    func testContextResolutionStoresOnlyFixedReasonAndSourceAvailability() throws {
        QualityEventRecorder.clear()
        for reason in ClickyContextResolutionReason.allCases {
            ClickyAnalytics.trackContextResolution(
                reason: reason,
                sourceDimensionsAvailable: reason == .reuse
            )
        }

        let events = try readEvents()
        XCTAssertEqual(events.count, ClickyContextResolutionReason.allCases.count)
        for (event, reason) in zip(events, ClickyContextResolutionReason.allCases) {
            XCTAssertEqual(event["name"] as? String, "context.resolved")
            let attributes = try XCTUnwrap(event["attributes"] as? [String: Any])
            XCTAssertEqual(attributes["reason"] as? String, reason.rawValue)
            XCTAssertEqual(
                attributes["sourceDimensionsAvailable"] as? Bool,
                reason == .reuse
            )
            XCTAssertNil(attributes["sourceDimensions"])
        }
    }

    func testUnknownContextResolutionReasonIsDropped() throws {
        QualityEventRecorder.clear()
        ClickyAnalytics.trackContextResolution(
            reason: "runtime_restart",
            sourceDimensionsAvailable: true
        )

        let storeURL = try XCTUnwrap(QualityEventRecorder.testStoreURL)
        let events = FileManager.default.fileExists(atPath: storeURL.path)
            ? try readEvents()
            : []
        XCTAssertTrue(events.isEmpty)
    }

    func testComputerActionCompletionStoresTypedResultAndReceiptHash() throws {
        QualityEventRecorder.clear()
        let receipt = "receipt-with-private-context"
        let result = YishuComputerActionResult(
            succeeded: true,
            verified: true,
            message: "ignored",
            evidence: "ignored",
            status: .verified,
            method: .axPress,
            code: .verifiedAccessibility,
            receiptId: receipt
        )
        ClickyAnalytics.trackComputerActionCompleted(result: result)

        let event = try XCTUnwrap(try readEvents().first)
        XCTAssertEqual(event["name"] as? String, "computer.action.completed")
        XCTAssertEqual(event["status"] as? String, "verified")
        let attributes = try XCTUnwrap(event["attributes"] as? [String: Any])
        XCTAssertEqual(attributes["method"] as? String, "ax_press")
        XCTAssertEqual(attributes["code"] as? String, "verified_accessibility")
        XCTAssertEqual(attributes["verified"] as? Bool, true)
        XCTAssertEqual(attributes["retryCount"] as? Int, 0)
        let receiptHash = try XCTUnwrap(attributes["receiptHash"] as? String)
        XCTAssertNotEqual(receiptHash, receipt)
        XCTAssertEqual(receiptHash.count, 64)
        XCTAssertTrue(receiptHash.allSatisfy { $0.isHexDigit })
    }

    func testModelCompletionStoresVerifiedTerminalWithoutResponseText() throws {
        for (verified, terminal) in [(true, "verified"), (false, "unverified")] {
            QualityEventRecorder.clear()
            let privateResponse = "private-response-that-must-not-be-recorded"
            ClickyAnalytics.trackAIResponseReceived(
                response: privateResponse,
                verified: verified
            )

            let line = try XCTUnwrap(
                String(
                    decoding: try Data(contentsOf: try XCTUnwrap(QualityEventRecorder.testStoreURL)),
                    as: UTF8.self
                ).split(whereSeparator: \.isNewline).first
            )
            let event = try XCTUnwrap(
                JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
            )
            XCTAssertEqual(event["name"] as? String, "model.completed")
            let attributes = try XCTUnwrap(event["attributes"] as? [String: Any])
            XCTAssertEqual(attributes["verified"] as? Bool, verified)
            XCTAssertEqual(attributes["taskTerminal"] as? String, terminal)
            XCTAssertFalse(line.contains(privateResponse))
        }

        QualityEventRecorder.clear()
        ClickyAnalytics.trackResponseError(error: "private-error-detail")
        let failure = try XCTUnwrap(try readEvents().first)
        XCTAssertEqual(failure["status"] as? String, "failed")
    }

    func testVerifiedModelCompletionBindsOnlyItsVerifiedActionReceipt() throws {
        let verifiedResult = YishuComputerActionResult(
            succeeded: true,
            verified: true,
            message: "ignored",
            evidence: "ignored",
            status: .verified,
            method: .axPress,
            code: .verifiedAccessibility,
            receiptId: "verified-action-receipt"
        )
        let unverifiedResult = YishuComputerActionResult(
            succeeded: true,
            verified: false,
            message: "ignored",
            evidence: "ignored",
            status: .delivered,
            method: .axPress,
            code: .axPressUnverified,
            receiptId: "unverified-action-receipt"
        )

        for (terminalVerified, actionResult, expectsReceiptHash) in [
            (true, verifiedResult, true),
            (false, verifiedResult, false),
            (true, unverifiedResult, false),
        ] {
            QualityEventRecorder.clear()
            ClickyAnalytics.trackAIResponseReceived(
                response: "private-response",
                verified: terminalVerified,
                verifiedActionResult: actionResult
            )

            let event = try XCTUnwrap(try readEvents().first)
            let attributes = try XCTUnwrap(event["attributes"] as? [String: Any])
            if expectsReceiptHash {
                let receiptHash = try XCTUnwrap(attributes["receiptHash"] as? String)
                XCTAssertEqual(receiptHash.count, 64)
                XCTAssertNotEqual(receiptHash, actionResult.receiptId)
            } else {
                XCTAssertNil(attributes["receiptHash"])
            }
        }
    }

    private func readEvents() throws -> [[String: Any]] {
        let storeURL = try XCTUnwrap(QualityEventRecorder.testStoreURL)
        let lines = String(
            decoding: try Data(contentsOf: storeURL),
            as: UTF8.self
        ).split(whereSeparator: \.isNewline)
        return try lines.map {
            try XCTUnwrap(
                JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any]
            )
        }
    }

    private func qualityLogMode() throws -> Int {
        let storeURL = try XCTUnwrap(QualityEventRecorder.testStoreURL)
        let attributes = try FileManager.default.attributesOfItem(atPath: storeURL.path)
        return try XCTUnwrap((attributes[.posixPermissions] as? NSNumber)?.intValue)
    }
}
