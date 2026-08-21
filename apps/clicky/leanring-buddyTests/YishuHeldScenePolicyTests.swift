import XCTest
@testable import Clicky

final class YishuHeldScenePolicyTests: XCTestCase {
    func testReusesWhenAppAndDisplayStayPut() {
        let decision = YishuHeldScenePolicy.decide(
            requiresActiveWindowOnly: false,
            heldTraceID: "t1",
            turnTraceID: "t1",
            heldFrontmost: 42,
            currentFrontmost: 42,
            heldDisplay: "0,0,1440,900",
            currentDisplay: "0,0,1440,900",
            heldWindowNumber: 11,
            currentWindowNumber: 11,
            capturedAt: 1_000,
            now: 1_000 + 2_000_000_000
        )
        XCTAssertEqual(decision, .reuse)
    }

    func testReusesWhenWindowNumbersAreBothMissing() {
        let decision = YishuHeldScenePolicy.decide(
            requiresActiveWindowOnly: false,
            heldTraceID: "t1",
            turnTraceID: "t1",
            heldFrontmost: 42,
            currentFrontmost: 42,
            heldDisplay: "0,0,1440,900",
            currentDisplay: "0,0,1440,900",
            heldWindowNumber: nil,
            currentWindowNumber: nil,
            capturedAt: 1_000,
            now: 2_000
        )
        XCTAssertEqual(decision, .reuse)
    }

    func testRecapturesWhenActiveWindowChangesInSameApp() {
        let decision = YishuHeldScenePolicy.decide(
            requiresActiveWindowOnly: false,
            heldTraceID: "t1",
            turnTraceID: "t1",
            heldFrontmost: 42,
            currentFrontmost: 42,
            heldDisplay: "0,0,1440,900",
            currentDisplay: "0,0,1440,900",
            heldWindowNumber: 11,
            currentWindowNumber: 22,
            capturedAt: 1_000,
            now: 2_000
        )
        XCTAssertEqual(decision, .recaptureSceneChanged)
    }

    func testRecapturesWhenWindowIdentityAppearsOrDisappears() {
        let appeared = YishuHeldScenePolicy.decide(
            requiresActiveWindowOnly: false,
            heldTraceID: "t1",
            turnTraceID: "t1",
            heldFrontmost: 42,
            currentFrontmost: 42,
            heldDisplay: "0,0,1440,900",
            currentDisplay: "0,0,1440,900",
            heldWindowNumber: nil,
            currentWindowNumber: 22,
            capturedAt: 1_000,
            now: 2_000
        )
        let disappeared = YishuHeldScenePolicy.decide(
            requiresActiveWindowOnly: false,
            heldTraceID: "t1",
            turnTraceID: "t1",
            heldFrontmost: 42,
            currentFrontmost: 42,
            heldDisplay: "0,0,1440,900",
            currentDisplay: "0,0,1440,900",
            heldWindowNumber: 11,
            currentWindowNumber: nil,
            capturedAt: 1_000,
            now: 2_000
        )
        XCTAssertEqual(appeared, .recaptureSceneChanged)
        XCTAssertEqual(disappeared, .recaptureSceneChanged)
    }

    func testSameLiveSceneRequiresStableWindow() {
        let safariA = YishuHeldSceneIdentity(
            frontmostProcessIdentifier: 42,
            activeWindowNumber: 11,
            displayFingerprint: "0,0,1440,900"
        )
        let safariB = YishuHeldSceneIdentity(
            frontmostProcessIdentifier: 42,
            activeWindowNumber: 22,
            displayFingerprint: "0,0,1440,900"
        )
        let finder = YishuHeldSceneIdentity(
            frontmostProcessIdentifier: 99,
            activeWindowNumber: 11,
            displayFingerprint: "0,0,1440,900"
        )
        XCTAssertTrue(YishuHeldScenePolicy.isSameLiveScene(safariA, safariA))
        XCTAssertFalse(YishuHeldScenePolicy.isSameLiveScene(safariA, safariB))
        XCTAssertFalse(YishuHeldScenePolicy.isSameLiveScene(safariA, finder))
    }

    func testRecapturesWhenFrontmostAppChanges() {
        let decision = YishuHeldScenePolicy.decide(
            requiresActiveWindowOnly: false,
            heldTraceID: "t1",
            turnTraceID: "t1",
            heldFrontmost: 42,
            currentFrontmost: 99,
            heldDisplay: "0,0,1440,900",
            currentDisplay: "0,0,1440,900",
            heldWindowNumber: 11,
            currentWindowNumber: 11,
            capturedAt: 1_000,
            now: 2_000
        )
        XCTAssertEqual(decision, .recaptureSceneChanged)
    }

    func testRecapturesWhenDisplayArrangementChanges() {
        let decision = YishuHeldScenePolicy.decide(
            requiresActiveWindowOnly: false,
            heldTraceID: "t1",
            turnTraceID: "t1",
            heldFrontmost: 42,
            currentFrontmost: 42,
            heldDisplay: "0,0,1440,900",
            currentDisplay: "1440,0,1920,1080",
            heldWindowNumber: 11,
            currentWindowNumber: 11,
            capturedAt: 1_000,
            now: 2_000
        )
        XCTAssertEqual(decision, .recaptureSceneChanged)
    }

    func testRecapturesNarrowPageNoteWindow() {
        let decision = YishuHeldScenePolicy.decide(
            requiresActiveWindowOnly: true,
            heldTraceID: "t1",
            turnTraceID: "t1",
            heldFrontmost: 42,
            currentFrontmost: 42,
            heldDisplay: "0,0,1440,900",
            currentDisplay: "0,0,1440,900",
            heldWindowNumber: 11,
            currentWindowNumber: 11,
            capturedAt: 1_000,
            now: 2_000
        )
        XCTAssertEqual(decision, .recaptureActiveWindow)
    }

    func testRecapturesAfterEvidenceLifetime() {
        let capturedAt: UInt64 = 1_000
        let decision = YishuHeldScenePolicy.decide(
            requiresActiveWindowOnly: false,
            heldTraceID: "t1",
            turnTraceID: "t1",
            heldFrontmost: 42,
            currentFrontmost: 42,
            heldDisplay: "0,0,1440,900",
            currentDisplay: "0,0,1440,900",
            heldWindowNumber: 11,
            currentWindowNumber: 11,
            capturedAt: capturedAt,
            now: capturedAt + YishuHeldScenePolicy.maxAgeNanoseconds + 1
        )
        XCTAssertEqual(decision, .recaptureStale)
    }

    func testRecapturesWhenPressCaptureNeverLanded() {
        let decision = YishuHeldScenePolicy.decide(
            requiresActiveWindowOnly: false,
            heldTraceID: "t1",
            turnTraceID: "t1",
            heldFrontmost: 42,
            currentFrontmost: 42,
            heldDisplay: "0,0,1440,900",
            currentDisplay: "0,0,1440,900",
            heldWindowNumber: 11,
            currentWindowNumber: 11,
            capturedAt: nil,
            now: 2_000
        )
        XCTAssertEqual(decision, .recaptureMissingBasis)
    }
}
