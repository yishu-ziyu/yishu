import Foundation
import XCTest
import YishuContext
@testable import Clicky

final class YishuContextFrameContractTests: XCTestCase {
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
