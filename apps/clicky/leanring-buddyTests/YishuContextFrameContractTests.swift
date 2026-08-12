import Foundation
import XCTest
import YishuContext
@testable import Clicky

final class YishuContextFrameContractTests: XCTestCase {
    @MainActor
    func testPageNoteWindowCaptureIntentIsNarrow() {
        XCTAssertTrue(CompanionManager.requiresCurrentPageNoteWindow(
            "把当前页面需要我做的三件事整理成一条备忘录"
        ))
        XCTAssertTrue(CompanionManager.requiresCurrentPageNoteWindow(
            "把这个页面的3条行动项提炼成备忘"
        ))
        XCTAssertFalse(CompanionManager.requiresCurrentPageNoteWindow(
            "不要把当前页面的三件事整理成备忘录"
        ))
        XCTAssertFalse(CompanionManager.requiresCurrentPageNoteWindow(
            "能把当前页面三条行动项整理成备忘录吗？"
        ))
    }

    @MainActor
    func testActiveWindowScreenshotCarriesOnlyWindowIdentityMetadata() throws {
        let screenshot = YishuContextFrameCollector.activeWindowScreenshot(from: CompanionWindowCapture(
            imageData: Data("jpeg".utf8),
            windowNumber: 73,
            widthInPoints: 900,
            heightInPoints: 640,
            widthInPixels: 1280,
            heightInPixels: 911
        ))

        XCTAssertEqual(screenshot.label, "current frontmost window")
        XCTAssertEqual(screenshot.sourceWindowNumber, 73)
        XCTAssertNil(screenshot.displayOriginXPoints)
        XCTAssertNil(screenshot.displayOriginYPoints)

        let data = try JSONEncoder().encode(screenshot)
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(raw["sourceWindowNumber"] as? Int, 73)
        XCTAssertNil(raw["displayOriginXPoints"])
        XCTAssertNil(raw["displayOriginYPoints"])

        let display = YishuScreenshotContext(
            label: "display",
            base64Data: "anBlZw==",
            displayWidthPoints: 100,
            displayHeightPoints: 100,
            screenshotWidthPixels: 100,
            screenshotHeightPixels: 100
        )
        let displayData = try JSONEncoder().encode(display)
        let displayRaw = try XCTUnwrap(JSONSerialization.jsonObject(with: displayData) as? [String: Any])
        XCTAssertNil(displayRaw["sourceWindowNumber"])
    }

    func testClickyAdapterKeepsCanonicalJSONWireShape() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let point = YishuScreenPoint(x: 320, y: 240, coordinateSpace: .globalTopLeft)
        let frame = YishuContextFrame(
            capturedAt: now,
            expiresAt: now.addingTimeInterval(15),
            cursor: YishuObservedValue(
                value: point,
                source: "cg-event",
                capturedAt: now,
                confidence: 1
            ),
            pointerTrail: [
                YishuPointerSample(
                    capturedAt: now,
                    point: point,
                    kind: .move
                ),
            ],
            frontmostApplication: nil,
            activeWindow: nil,
            elementUnderCursor: nil,
            screenshots: [
                YishuScreenshotContext(
                    label: "cursor-display",
                    base64Data: "anBlZw==",
                    displayWidthPoints: 1512,
                    displayHeightPoints: 982,
                    screenshotWidthPixels: 1280,
                    screenshotHeightPixels: 831,
                    displayOriginXPoints: -1512,
                    displayOriginYPoints: 240
                ),
            ],
            warnings: []
        )

        try frame.validate(referenceDate: now)

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(frame)
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(
            Set(raw.keys),
            Set([
                "schemaVersion",
                "frameId",
                "capturedAt",
                "expiresAt",
                "cursor",
                "pointerTrail",
                "frontmostApplication",
                "activeWindow",
                "elementUnderCursor",
                "screenshots",
                "warnings",
            ])
        )
        XCTAssertTrue(raw["frontmostApplication"] is NSNull)
        XCTAssertTrue(raw["activeWindow"] is NSNull)
        XCTAssertTrue(raw["elementUnderCursor"] is NSNull)

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(YishuContextFrame.self, from: data)
        XCTAssertEqual(decoded.schemaVersion, yishuRuntimeProtocolVersion)
        XCTAssertEqual(decoded.cursor.value, point)
        XCTAssertEqual(decoded.screenshots.first?.mediaType, "image/jpeg")
        XCTAssertEqual(decoded.screenshots.first?.displayOriginXPoints, -1512)
        XCTAssertEqual(decoded.screenshots.first?.displayOriginYPoints, 240)
    }

    func testClickyAdapterUsesCanonicalValidationForOptionalObservations() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let point = YishuScreenPoint(x: 0, y: 0, coordinateSpace: .globalTopLeft)
        let frame = YishuContextFrame(
            capturedAt: now,
            expiresAt: now.addingTimeInterval(15),
            cursor: YishuObservedValue(
                value: point,
                source: "test",
                capturedAt: now,
                confidence: 1
            ),
            pointerTrail: [],
            frontmostApplication: YishuObservedValue(
                value: YishuApplicationContext(
                    name: "Notes",
                    bundleIdentifier: nil,
                    processIdentifier: 42
                ),
                source: "test",
                capturedAt: now,
                confidence: 1.1
            ),
            activeWindow: nil,
            elementUnderCursor: nil,
            screenshots: [],
            warnings: []
        )

        XCTAssertThrowsError(try frame.validate(referenceDate: now)) { error in
            XCTAssertEqual(
                error as? YishuContextFrameValidationError,
                .invalidConfidence(1.1)
            )
        }
    }
}
