import Foundation
import XCTest
@testable import YishuContext

final class ContextFrameTests: XCTestCase {
    func testActiveWindowScreenshotRequiresPositiveWindowIdentity() throws {
        let now = Date()
        let point = ScreenPoint(x: 0, y: 0, coordinateSpace: .globalTopLeft)
        let frame = ContextFrame(
            capturedAt: now,
            expiresAt: now.addingTimeInterval(15),
            cursor: ObservedValue(value: point, source: "test", capturedAt: now, confidence: 1),
            pointerTrail: [],
            frontmostApplication: nil,
            activeWindow: nil,
            elementUnderCursor: nil,
            screenshots: [ScreenshotContext(
                label: "window",
                base64Data: "anBlZw==",
                displayWidthPoints: 100,
                displayHeightPoints: 100,
                screenshotWidthPixels: 100,
                screenshotHeightPixels: 100,
                sourceWindowNumber: 0
            )],
            warnings: []
        )
        XCTAssertThrowsError(try frame.validate(referenceDate: now)) { error in
            XCTAssertEqual(error as? ContextFrameValidationError, .invalidScreenshot)
        }
    }

    func testLegacyWindowWithoutNumberStillDecodes() throws {
        let data = Data(
            #"{"title":"Legacy","ownerName":"Safari","processIdentifier":42,"bounds":null}"#.utf8
        )
        let window = try JSONDecoder().decode(WindowContext.self, from: data)
        XCTAssertNil(window.windowNumber)

        let encoded = try JSONEncoder().encode(window)
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertNil(raw["windowNumber"])
    }

    func testLegacyScreenshotWithoutDisplayOriginStillDecodes() throws {
        let data = Data(
            #"""
            {
              "label": "legacy",
              "mediaType": "image/jpeg",
              "base64Data": "anBlZw==",
              "displayWidthPoints": 1512,
              "displayHeightPoints": 982,
              "screenshotWidthPixels": 1280,
              "screenshotHeightPixels": 831
            }
            """#.utf8
        )

        let screenshot = try JSONDecoder().decode(ScreenshotContext.self, from: data)
        XCTAssertNil(screenshot.displayOriginXPoints)
        XCTAssertNil(screenshot.displayOriginYPoints)
    }

    func testContextFrameRoundTripsThroughVersionedJSON() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let point = ScreenPoint(x: 320, y: 240, coordinateSpace: .globalTopLeft)
        let frame = ContextFrame(
            capturedAt: now,
            expiresAt: now.addingTimeInterval(15),
            cursor: ObservedValue(value: point, source: "cg-event", capturedAt: now, confidence: 1),
            pointerTrail: [PointerSample(capturedAt: now, point: point, kind: .move)],
            frontmostApplication: ObservedValue(
                value: ApplicationContext(name: "Notes", bundleIdentifier: "com.apple.Notes", processIdentifier: 42),
                source: "workspace",
                capturedAt: now,
                confidence: 1
            ),
            activeWindow: nil,
            elementUnderCursor: nil,
            screenshots: [
                ScreenshotContext(
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
        XCTAssertTrue(raw.keys.contains("activeWindow"))
        XCTAssertTrue(raw["activeWindow"] is NSNull)
        XCTAssertTrue(raw.keys.contains("elementUnderCursor"))
        XCTAssertTrue(raw["elementUnderCursor"] is NSNull)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(ContextFrame.self, from: data)

        XCTAssertEqual(decoded.schemaVersion, yishuProtocolVersion)
        XCTAssertEqual(decoded.cursor.value, point)
        XCTAssertEqual(decoded.screenshots.first?.mediaType, "image/jpeg")
        XCTAssertEqual(decoded.screenshots.first?.displayOriginXPoints, -1512)
        XCTAssertEqual(decoded.screenshots.first?.displayOriginYPoints, 240)
    }

    func testExpiredFrameIsRejected() {
        let now = Date()
        let point = ScreenPoint(x: 0, y: 0, coordinateSpace: .globalTopLeft)
        let frame = ContextFrame(
            capturedAt: now.addingTimeInterval(-20),
            expiresAt: now.addingTimeInterval(-5),
            cursor: ObservedValue(value: point, source: "test", capturedAt: now, confidence: 1),
            pointerTrail: [],
            frontmostApplication: nil,
            activeWindow: nil,
            elementUnderCursor: nil,
            screenshots: [],
            warnings: []
        )

        XCTAssertThrowsError(try frame.validate(referenceDate: now)) { error in
            XCTAssertEqual(error as? ContextFrameValidationError, .expired)
        }
    }

    func testValidationCoversEveryObservedConfidence() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let point = ScreenPoint(x: 0, y: 0, coordinateSpace: .globalTopLeft)
        let frame = ContextFrame(
            capturedAt: now,
            expiresAt: now.addingTimeInterval(15),
            cursor: ObservedValue(value: point, source: "test", capturedAt: now, confidence: 1),
            pointerTrail: [],
            frontmostApplication: ObservedValue(
                value: ApplicationContext(name: "Notes", bundleIdentifier: nil, processIdentifier: 42),
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
            XCTAssertEqual(error as? ContextFrameValidationError, .invalidConfidence(1.1))
        }
    }

    func testValidationRejectsNonPositiveScreenshotDimensions() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let point = ScreenPoint(x: 0, y: 0, coordinateSpace: .globalTopLeft)
        let frame = ContextFrame(
            capturedAt: now,
            expiresAt: now.addingTimeInterval(15),
            cursor: ObservedValue(value: point, source: "test", capturedAt: now, confidence: 1),
            pointerTrail: [],
            frontmostApplication: nil,
            activeWindow: nil,
            elementUnderCursor: nil,
            screenshots: [
                ScreenshotContext(
                    label: "invalid",
                    base64Data: "anBlZw==",
                    displayWidthPoints: 0,
                    displayHeightPoints: 982,
                    screenshotWidthPixels: 1280,
                    screenshotHeightPixels: 831
                ),
            ],
            warnings: []
        )

        XCTAssertThrowsError(try frame.validate(referenceDate: now)) { error in
            XCTAssertEqual(error as? ContextFrameValidationError, .invalidScreenshot)
        }
    }
}
