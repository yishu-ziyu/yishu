import AppKit
import Foundation
import Testing
@testable import Clicky

struct AgentPresencePlacementTests {
    @Test func defaultAnchorSitsInTheTopRightNotTheCenter() {
        let frame = NSRect(x: 0, y: 0, width: 1440, height: 878)
        let mouse = NSPoint(x: frame.midX, y: frame.midY)
        let screens = [(frame: frame, visible: frame)]
        let anchor = AgentPresencePlacement.resolvedAnchor(
            saved: nil,
            mouse: mouse,
            screens: screens
        )
        let expected = AgentPresencePlacement.defaultAnchor(in: frame)

        #expect(anchor == expected)
        #expect(anchor.x > frame.midX + 200)
        #expect(anchor.y > frame.midY + 200)
        #expect(abs(anchor.x - mouse.x) > 300)
        #expect(abs(anchor.y - mouse.y) > 200)
    }

    @Test func savedAnchorWinsWhenItStillFitsAScreen() {
        let frame = NSRect(x: 0, y: 0, width: 1440, height: 878)
        let saved = NSPoint(x: 80, y: 820)
        let anchor = AgentPresencePlacement.resolvedAnchor(
            saved: saved,
            mouse: NSPoint(x: 720, y: 439),
            screens: [(frame: frame, visible: frame)]
        )
        let clamped = AgentPresencePlacement.clamp(saved, in: frame)
        #expect(anchor == clamped)
        #expect(anchor.x < frame.midX)
    }

    @Test func clampKeepsTheChipInsideTheVisibleFrame() {
        let frame = NSRect(x: 100, y: 50, width: 1200, height: 800)
        let outside = NSPoint(x: 10_000, y: -40)
        let clamped = AgentPresencePlacement.clamp(outside, in: frame)
        let halfW = AgentPresencePlacement.panelSize.width / 2
        let halfH = AgentPresencePlacement.panelSize.height / 2
        let inset = AgentPresencePlacement.edgeInset
        #expect(clamped.x <= frame.maxX - halfW - inset)
        #expect(clamped.x >= frame.minX + halfW + inset)
        #expect(clamped.y <= frame.maxY - halfH - inset)
        #expect(clamped.y >= frame.minY + halfH + inset)
    }

    @Test func labelDropsBelowWhenTheChipIsAgainstTheTopEdge() {
        let frame = NSRect(x: 0, y: 0, width: 1440, height: 878)
        let chip = AgentPresencePlacement.defaultAnchor(in: frame)
        let size = CGSize(width: 260, height: 56)
        let origin = AgentPresencePlacement.labelOrigin(near: chip, size: size, visibleFrame: frame)
        #expect(origin.y + size.height <= frame.maxY)
        #expect(origin.y < chip.y)
    }

    @Test func finishedTasksAutoHideIdleChipsAndLeaveRunningOnes() {
        let done = makeTask(status: .done)
        let running = makeTask(status: .running)
        #expect(
            AgentPresenceSettlePolicy.shouldAutoHide(
                displayTasks: [done],
                pocketOpen: false,
                hovering: false,
                dragging: false
            )
        )
        #expect(
            !AgentPresenceSettlePolicy.shouldAutoHide(
                displayTasks: [running],
                pocketOpen: false,
                hovering: false,
                dragging: false
            )
        )
        #expect(
            !AgentPresenceSettlePolicy.shouldAutoHide(
                displayTasks: [done],
                pocketOpen: true,
                hovering: false,
                dragging: false
            )
        )
        #expect(
            !AgentPresenceSettlePolicy.shouldAutoHide(
                displayTasks: [done],
                pocketOpen: false,
                hovering: true,
                dragging: false
            )
        )
    }

    @Test func dismissedTerminalsLeaveTheChipUntilALiveTaskReturns() {
        let done = makeTask(status: .done)
        let running = makeTask(status: .running)
        let reminder = makeTask(
            title: "20分钟后提醒我喝一口水",
            status: .done
        )
        let visible = AgentPresenceSettlePolicy.visibleTasks(
            [done, running, reminder],
            dismissedTerminalIDs: [done.id]
        )
        #expect(visible.map(\.id) == [running.id])
        #expect(
            AgentPresenceSettlePolicy.visibleTasks(
                [done],
                dismissedTerminalIDs: [done.id]
            ).isEmpty
        )
    }

    @Test func savedAnchorRoundTripsThroughDefaults() throws {
        let suiteName = "AgentPresencePlacementTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(AgentPresencePlacement.loadSavedAnchor(from: defaults) == nil)
        let point = NSPoint(x: 1188, y: 840)
        AgentPresencePlacement.saveAnchor(point, to: defaults)
        #expect(AgentPresencePlacement.loadSavedAnchor(from: defaults) == point)
    }

    private func makeTask(
        title: String = "查深圳明天天气",
        status: YishuDelegatedTaskStatus
    ) -> YishuDelegatedTaskPresenceEvent {
        YishuDelegatedTaskPresenceEvent(
            id: UUID(),
            parentId: UUID(),
            mainConversationId: UUID(),
            title: title,
            status: status,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            updatedAt: Date(timeIntervalSince1970: 1_700_000_010),
            provider: nil,
            model: nil,
            resultKind: status == .done ? .completed : nil,
            summary: status == .done ? "多云。" : nil,
            sourceEventId: UUID()
        )
    }
}
