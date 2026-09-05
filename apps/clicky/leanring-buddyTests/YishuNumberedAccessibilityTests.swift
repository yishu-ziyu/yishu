import Foundation
import CoreGraphics
import Testing
import YishuContext
@testable import Clicky

@MainActor
struct YishuNumberedAccessibilityTests {
    @Test func assignIdsSortsTopToBottomThenLeftToRightAndCapsAt50() {
        var candidates = [
            YishuNumberedAccessibility.Candidate(
                role: "AXButton", title: "Right", description: nil, enabled: true, x: 80, y: 10
            ),
            YishuNumberedAccessibility.Candidate(
                role: "AXButton", title: "Left", description: nil, enabled: true, x: 10, y: 10
            ),
            YishuNumberedAccessibility.Candidate(
                role: "AXButton", title: "Lower", description: "Back", enabled: true, x: 10, y: 40
            ),
        ]
        candidates.append(contentsOf: (4...60).map { index in
            YishuNumberedAccessibility.Candidate(
                role: "AXButton",
                title: "Extra\(index)",
                description: nil,
                enabled: true,
                x: Double(index),
                y: 100
            )
        })
        let targets = YishuNumberedAccessibility.assignIds(candidates)
        #expect(targets.map(\.id) == (1...50).map(String.init))
        #expect(targets[0].title == "Left")
        #expect(targets[1].title == "Right")
        #expect(targets[2].description == "Back")
        #expect(targets.count == 50)
    }

    @Test func liveTargetsFallsBackWhenTheSceneIsEmpty() {
        let fallback = [
            NumberedAccessibilityTarget(
                id: "1", role: "AXButton", title: "Primary", description: nil, enabled: true
            ),
        ]
        let live = YishuNumberedAccessibility.liveTargets(fallback: fallback)
        #expect(!live.isEmpty)
    }

    @Test func fingerprintMismatchIsStale() {
        let expected = NumberedAccessibilityTarget(
            id: "1", role: "AXButton", title: "Back", description: "后退", enabled: true
        )
        let live = NumberedAccessibilityTarget(
            id: "1", role: "AXButton", title: "Forward", description: "前进", enabled: true
        )
        #expect(YishuNumberedAccessibility.isStale(expected: expected, live: live))
        #expect(!YishuNumberedAccessibility.isStale(expected: expected, live: expected))
    }

    @Test func fingerprintMatchesTheRuntimeFrameEncoding() {
        let target = NumberedAccessibilityTarget(
            id: "1",
            role: "AXGroup",
            title: "上传文件",
            description: "拖放到这里",
            enabled: true,
            frame: CGRect(x: 100, y: 200, width: 240, height: 80)
        )
        #expect(
            YishuNumberedAccessibility.fingerprint(target)
                == ["AXGroup", "上传文件", "拖放到这里", "200,400,480,160"].joined(separator: "\u{1e}")
        )
    }

    @Test func numberedClickFailsHonestlyWhenSceneHasNoTargets() async {
        let request = YishuComputerActionRequest(
            requestId: UUID(),
            traceId: UUID(),
            actionId: UUID(),
            action: "left_click",
            x: 0,
            y: 0,
            targetId: "1"
        )
        let result = await YishuComputerUseActuator.perform(
            request,
            screenCaptures: [],
            numberedTargets: []
        )
        #expect(result.succeeded == false)
        #expect(result.code == .axLookupFailed)
        #expect(result.message.contains("no numbered target"))
    }

    @Test func runtimeIngressDecodesTargetIdWithoutCoordinates() throws {
        let actionId = UUID()
        let decoded = try #require(YishuAgentRuntimeClient.decodeComputerActionRequest(
            payload: [
                "actionId": actionId.uuidString,
                "action": "left_click",
                "targetId": "4",
            ],
            requestId: UUID(),
            traceId: UUID(),
            schemaVersion: NSNumber(value: 1)
        ))
        #expect(decoded.targetId == "4")
        #expect(decoded.x == 0)
        #expect(decoded.y == 0)

        #expect(YishuAgentRuntimeClient.decodeComputerActionRequest(
            payload: [
                "actionId": UUID().uuidString,
                "action": "left_click",
                "targetId": "0",
            ],
            requestId: UUID(),
            traceId: UUID(),
            schemaVersion: NSNumber(value: 1)
        ) == nil)
    }
}
