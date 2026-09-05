import AppKit
import Foundation
import Testing
import YishuContext
@testable import Clicky

struct OverlayMarksTests {
    private let primaryHeight: CGFloat = 982
    private let screenFrame = CGRect(x: 0, y: 0, width: 1512, height: 982)

    @Test func quartzTopLeftRectMapsToAppKitThenOverlayLocal() {
        let quartz = CGRect(x: 100, y: 50, width: 200, height: 40)
        let appKit = OverlayCoordinateSpace.appKitRect(
            fromQuartzTopLeft: quartz,
            primaryDisplayHeight: primaryHeight
        )
        #expect(appKit.origin.x == 100)
        #expect(appKit.origin.y == 892)
        #expect(appKit.width == 200)
        #expect(appKit.height == 40)

        let overlay = OverlayCoordinateSpace.overlayRect(
            fromQuartzTopLeft: quartz,
            screenFrame: screenFrame,
            primaryDisplayHeight: primaryHeight
        )
        #expect(overlay.origin.x == 100)
        #expect(overlay.origin.y == 50)
        #expect(overlay.size == quartz.size)

        let point = OverlayCoordinateSpace.overlayPoint(
            fromAppKit: CGPoint(x: 100, y: 932),
            screenFrame: screenFrame
        )
        #expect(point.x == 100)
        #expect(point.y == 50)
    }

    @Test func quartzFrameCenterMapsToAppKitBottomLeft() {
        let quartz = CGRect(x: 100, y: 200, width: 240, height: 80)
        let center = OverlayCoordinateSpace.appKitCenter(
            ofQuartzFrame: quartz,
            primaryDisplayHeight: primaryHeight
        )
        #expect(center.x == 220)
        #expect(center.y == 742)
    }

    @Test func ringRectPadsTheTargetAndContainsIt() {
        let target = CGRect(x: 10, y: 20, width: 100, height: 30)
        let ring = OverlayCoordinateSpace.ringRect(around: target, padding: 4)
        #expect(ring == CGRect(x: 6, y: 16, width: 108, height: 38))
        #expect(ring.contains(target))
        #expect(ring.width == target.width + 8)
        #expect(ring.height == target.height + 8)
    }

    @Test func assignIdsCopiesAXFrameOntoNumberedTargets() {
        let candidates = [
            YishuNumberedAccessibility.Candidate(
                role: "AXButton",
                title: "Run",
                description: nil,
                enabled: true,
                x: 40,
                y: 80,
                width: 120,
                height: 28
            ),
        ]
        let targets = YishuNumberedAccessibility.assignIds(candidates)
        #expect(targets.count == 1)
        #expect(targets[0].frame != nil)
        #expect(targets[0].frame == CGRect(x: 40, y: 80, width: 120, height: 28))
    }

    @Test func numberedTargetFrameIsOptionalOnTheWire() throws {
        let legacy = NumberedAccessibilityTarget(
            id: "1",
            role: "AXButton",
            title: "Back",
            description: nil,
            enabled: true
        )
        let encoder = JSONEncoder()
        let legacyRaw = try #require(
            JSONSerialization.jsonObject(with: encoder.encode(legacy)) as? [String: Any]
        )
        #expect(!legacyRaw.keys.contains("frame"))

        let withFrame = NumberedAccessibilityTarget(
            id: "2",
            role: "AXButton",
            title: "Go",
            description: nil,
            enabled: true,
            frame: CGRect(x: 8, y: 16, width: 64, height: 24)
        )
        let data = try encoder.encode(withFrame)
        let decoded = try JSONDecoder().decode(NumberedAccessibilityTarget.self, from: data)
        #expect(decoded.frame == withFrame.frame)

        let withoutKey = Data(
            #"{"id":"3","role":"AXButton","title":"Skip","description":null,"enabled":true}"#.utf8
        )
        let roundTrip = try JSONDecoder().decode(NumberedAccessibilityTarget.self, from: withoutKey)
        #expect(roundTrip.frame == nil)
        #expect(roundTrip.id == "3")
    }
}
