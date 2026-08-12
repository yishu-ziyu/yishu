import Foundation
import Testing
@testable import Clicky

struct ContextReminderPresenceTests {
    @Test @MainActor func liveReminderProjectsEveryRuntimeAuthoredPhaseWithoutResearchCopy() throws {
        let fixture = ReminderFixture()

        let waiting = try #require(YishuDelegatedTaskPresenceEvent.decode(
            fixture.live(status: "running", watchState: "waiting_for_departure")
        ))
        #expect(waiting.taskKind == .contextReminder)
        #expect(waiting.watchState == .waitingForDeparture)
        #expect(waiting.workerLabel == "应用返回提醒")
        #expect(waiting.statusLabel == "等待你离开当前应用")
        #expect(waiting.returnAnnouncementText == nil)

        let created = try #require(YishuDelegatedTaskPresenceEvent.decode(
            fixture.live(status: "pending", watchState: "waiting_for_departure")
        ))
        #expect(created.statusLabel == "提醒已创建")

        let armed = try #require(YishuDelegatedTaskPresenceEvent.decode(
            fixture.live(status: "running", watchState: "armed", secondsLater: 1)
        ))
        #expect(armed.watchState == .armed)
        #expect(armed.statusLabel == "等待你回到当前应用")
        let interrupted = armed.interruptedByRuntimeStop()
        #expect(interrupted.taskKind == .contextReminder)
        #expect(interrupted.watchState == .armed)
        #expect(interrupted.statusLabel == "恢复后继续等待")
        #expect(interrupted.interruptionMessage == "提醒仍已保存；奕枢恢复后会继续等待。")
        #expect(interrupted.returnAnnouncementText == nil)

        let fired = try #require(YishuDelegatedTaskPresenceEvent.decode(
            fixture.live(
                status: "done",
                watchState: "fired",
                resultKind: "completed",
                summary: "提醒：提交报销",
                secondsLater: 2
            )
        ))
        #expect(fired.watchState == .fired)
        #expect(fired.statusLabel == "提醒已送达")
        #expect(fired.returnAnnouncementText == "提醒你：提交报销。")

        let cancelled = try #require(YishuDelegatedTaskPresenceEvent.decode(
            fixture.live(
                status: "cancelled",
                watchState: "cancelled",
                resultKind: "cancelled",
                summary: "提醒已取消。",
                secondsLater: 2
            )
        ))
        #expect(cancelled.statusLabel == "提醒已取消")
        #expect(cancelled.interruptionMessage == "这个提醒已取消，不会再触发。")
        #expect(cancelled.returnAnnouncementText == "提醒已取消。")
    }

    @Test @MainActor func reminderSnapshotRehydratesArmedStateAndLegacyDefaultsAreExplicit() throws {
        let fixture = ReminderFixture()
        let requestID = UUID()
        let traceID = UUID()
        let eventID = UUID()
        let snapshotRaw: [String: Any] = [
            "schemaVersion": 1,
            "type": "task.listed",
            "eventId": eventID.uuidString,
            "requestId": requestID.uuidString,
            "traceId": traceID.uuidString,
            "conversationId": fixture.conversationID.uuidString,
            "payload": [
                "tasks": [fixture.payload(
                    status: "running",
                    watchState: "armed",
                    secondsLater: 1
                )],
            ],
        ]

        let snapshot = try #require(YishuAgentRuntimeClient.decodeDelegatedTaskSnapshot(
            snapshotRaw,
            expectedRequestId: requestID,
            expectedTraceId: traceID,
            expectedConversationId: fixture.conversationID
        ))
        let reminder = try #require(snapshot.first)
        #expect(reminder.taskKind == .contextReminder)
        #expect(reminder.watchState == .armed)
        #expect(reminder.statusLabel == "等待你回到当前应用")

        // Explicit compatibility rules: old generic rows are delegated; the
        // first context-reminder producer omitted watchState and was waiting.
        var legacyDelegated = fixture.live(status: "running", watchState: nil)
        var delegatedPayload = legacyDelegated["payload"] as! [String: Any]
        delegatedPayload.removeValue(forKey: "taskKind")
        legacyDelegated["payload"] = delegatedPayload
        let delegated = try #require(YishuDelegatedTaskPresenceEvent.decode(legacyDelegated))
        #expect(delegated.taskKind == .delegated)
        #expect(delegated.watchState == nil)
        #expect(delegated.workerLabel == "后台任务")

        let legacyReminder = try #require(YishuDelegatedTaskPresenceEvent.decode(
            fixture.live(status: "running", watchState: nil)
        ))
        #expect(legacyReminder.taskKind == .contextReminder)
        #expect(legacyReminder.watchState == .waitingForDeparture)
        #expect(legacyReminder.statusLabel == "等待你离开当前应用")
    }

    @Test @MainActor func reminderDiscriminatorAndWatchStateFailClosed() {
        let fixture = ReminderFixture()
        var unknownKind = fixture.live(status: "running", watchState: "armed")
        var unknownKindPayload = unknownKind["payload"] as! [String: Any]
        unknownKindPayload["taskKind"] = "research_reminder"
        unknownKind["payload"] = unknownKindPayload
        #expect(YishuDelegatedTaskPresenceEvent.decode(unknownKind) == nil)

        var unknownState = fixture.live(status: "running", watchState: "armed")
        var unknownStatePayload = unknownState["payload"] as! [String: Any]
        unknownStatePayload["watchState"] = "maybe"
        unknownState["payload"] = unknownStatePayload
        #expect(YishuDelegatedTaskPresenceEvent.decode(unknownState) == nil)

        var confusedDelegated = fixture.live(status: "running", watchState: "armed")
        var confusedPayload = confusedDelegated["payload"] as! [String: Any]
        confusedPayload["taskKind"] = "delegated"
        confusedDelegated["payload"] = confusedPayload
        #expect(YishuDelegatedTaskPresenceEvent.decode(confusedDelegated) == nil)

        #expect(YishuDelegatedTaskPresenceEvent.decode(
            fixture.live(status: "running", watchState: "fired")
        ) == nil)
    }
}

private struct ReminderFixture {
    let taskID = UUID()
    let parentID = UUID()
    let conversationID = UUID()
    let createdAt = Date(timeIntervalSince1970: 1_700_000_000)

    func live(
        status: String,
        watchState: String?,
        resultKind: String? = nil,
        summary: String? = nil,
        secondsLater: TimeInterval = 0
    ) -> [String: Any] {
        [
            "schemaVersion": 1,
            "type": "task.presence.updated",
            "eventId": UUID().uuidString,
            "requestId": parentID.uuidString,
            "traceId": UUID().uuidString,
            "conversationId": conversationID.uuidString,
            "payload": payload(
                status: status,
                watchState: watchState,
                resultKind: resultKind,
                summary: summary,
                secondsLater: secondsLater
            ),
        ]
    }

    func payload(
        status: String,
        watchState: String?,
        resultKind: String? = nil,
        summary: String? = nil,
        secondsLater: TimeInterval = 0
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "taskId": taskID.uuidString,
            "parentId": parentID.uuidString,
            "mainConversationId": conversationID.uuidString,
            "taskKind": "context_reminder",
            "title": "提醒：提交报销",
            "status": status,
            "createdAt": Self.timestamp(createdAt),
            "updatedAt": Self.timestamp(createdAt.addingTimeInterval(secondsLater)),
        ]
        if let watchState { payload["watchState"] = watchState }
        if let resultKind { payload["resultKind"] = resultKind }
        if let summary { payload["summary"] = summary }
        return payload
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
