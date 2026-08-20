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
            capturedAt: 1_000,
            now: 1_000 + 2_000_000_000
        )
        XCTAssertEqual(decision, .reuse)
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
            capturedAt: nil,
            now: 2_000
        )
        XCTAssertEqual(decision, .recaptureMissingBasis)
    }
}
