import Foundation
import Testing
import UserNotifications
@testable import Clicky

@MainActor
struct YishuTimeReminderTests {
    @Test func strictReminderDecodeAndExactPendingReadback() async throws {
        let actionID = UUID()
        let reminderID = UUID()
        let payload: [String: Any] = [
            "actionId": actionID.uuidString,
            "action": "schedule_reminder",
            "x": 0,
            "y": 0,
            "reminderId": reminderID.uuidString,
            "delaySeconds": 1_200,
            "body": "  喝水  ",
            "intentId": UUID().uuidString,
            "attemptId": UUID().uuidString,
            "basisFrameId": UUID().uuidString,
            "effectClass": "schedule",
        ]
        let decoded = try #require(YishuAgentRuntimeClient.decodeComputerActionRequest(
            payload: payload,
            requestId: UUID(),
            traceId: UUID(),
            schemaVersion: NSNumber(value: 1)
        ))
        #expect(decoded.reminderId == reminderID.uuidString)
        #expect(decoded.reminderBody == "喝水")
        #expect(decoded.delaySeconds == 1_200)

        let center = FakeTimeReminderCenter(status: .authorized)
        let outcome = await YishuTimeReminderDelivery.schedule(
            reminderId: reminderID.uuidString,
            body: "喝水",
            delaySeconds: 1_200,
            authorizationFence: { true },
            center: center
        )
        #expect(outcome == .verified)
        #expect(center.addCount == 1)
    }

    @Test func undeterminedPermissionRequestsButDoesNotSchedule() async {
        let center = FakeTimeReminderCenter(status: .notDetermined)
        let outcome = await YishuTimeReminderDelivery.schedule(
            reminderId: UUID().uuidString,
            body: "喝水",
            delaySeconds: 60,
            authorizationFence: { true },
            center: center
        )
        #expect(outcome == .permissionPending)
        #expect(center.authorizationRequestCount == 1)
        #expect(center.addCount == 0)
    }

    @Test func foregroundReminderIsQueuedOnceAndConsumedBeforeSpeech() {
        var state = YishuTimeReminderReturnState()
        let firstQueued = state.enqueue(identifier: "one", body: "喝水")
        let duplicateQueued = state.enqueue(identifier: "one", body: "喝水")
        #expect(firstQueued)
        #expect(!duplicateQueued)
        #expect(state.pending.count == 1)
        #expect(state.takeNext() == .init(identifier: "one", body: "喝水"))
        #expect(state.pending.isEmpty)
        // Once the banner has delivered it, neither a duplicate callback nor
        // a historical notification click can put it back into speech.
        let replayQueued = state.enqueue(identifier: "one", body: "喝水")
        #expect(!replayQueued)
    }

    @Test func missingReadbackIsUnknownAfterOneSubmission() async {
        let center = FakeTimeReminderCenter(status: .authorized, omitReadbackAfterAdd: true)
        let outcome = await YishuTimeReminderDelivery.schedule(
            reminderId: UUID().uuidString,
            body: "喝水",
            delaySeconds: 60,
            authorizationFence: { true },
            center: center
        )
        #expect(outcome == .unknownAfterSubmission)
        #expect(center.addCount == 1)
    }

    @Test func reminderConfirmationNeverFallsBackToClickWording() {
        func confirmation(
            succeeded: Bool,
            status: YishuActionStatus,
            code: YishuActionCode
        ) -> String {
            CompanionManager.directActionConfirmation(
                for: YishuComputerActionResult(
                    succeeded: succeeded,
                    verified: status == .verified,
                    message: "",
                    evidence: nil,
                    status: status,
                    method: .nativeCommand,
                    code: code
                ),
                action: "schedule_reminder"
            )
        }
        #expect(confirmation(succeeded: true, status: .verified, code: .verifiedSystemNotification) == "提醒已经设好。")
        #expect(confirmation(succeeded: true, status: .unverified, code: .timeout) == "提醒可能已经设好，但我没能确认；我不会重复设置。")
        #expect(confirmation(succeeded: false, status: .blocked, code: .notificationPermissionPending) == "还没有设置，请允许后再说一次。")
        #expect(confirmation(succeeded: false, status: .blocked, code: .notificationPermissionDenied) == "系统提醒权限没有允许，所以这次没有设置。")
        #expect(confirmation(succeeded: false, status: .failed, code: .notificationScheduleFailed) == "这次没有设置提醒。")
    }
}

@MainActor
private final class FakeTimeReminderCenter: YishuTimeReminderCenter {
    let status: UNAuthorizationStatus
    let omitReadbackAfterAdd: Bool
    private(set) var authorizationRequestCount = 0
    private(set) var addCount = 0
    private var pending: [YishuPendingTimeReminder] = []

    init(status: UNAuthorizationStatus, omitReadbackAfterAdd: Bool = false) {
        self.status = status
        self.omitReadbackAfterAdd = omitReadbackAfterAdd
    }

    func authorizationStatus() async -> UNAuthorizationStatus { status }

    func requestAuthorization() {
        authorizationRequestCount += 1
    }

    func add(_ request: UNNotificationRequest) async throws {
        addCount += 1
        guard !omitReadbackAfterAdd else { return }
        let trigger = request.trigger as? UNTimeIntervalNotificationTrigger
        pending.append(YishuPendingTimeReminder(
            identifier: request.identifier,
            body: request.content.body,
            delaySeconds: trigger?.timeInterval,
            repeats: trigger?.repeats
        ))
    }

    func pendingRequests() async -> [YishuPendingTimeReminder] { pending }
}
