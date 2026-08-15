import Foundation
import Testing
@testable import Clicky

struct DelegatedTaskReturnPolicyTests {
    @Test func liveTerminalReturnsOnceAndSurvivesRelaunch() throws {
        let (defaults, suiteName) = try isolatedDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let task = makeTask(status: .done, resultKind: .succeeded)

        var state = YishuDelegatedTaskReturnState(userDefaults: defaults)
        let firstLiveDecision = state.shouldEnqueueLive(task)
        #expect(firstLiveDecision)
        state.markAnnounced(task.id)
        let duplicateLiveDecision = state.shouldEnqueueLive(task)
        #expect(!duplicateLiveDecision)

        var relaunched = YishuDelegatedTaskReturnState(userDefaults: defaults)
        let relaunchedLiveDecision = relaunched.shouldEnqueueLive(task)
        #expect(!relaunchedLiveDecision)
    }

    @Test func snapshotBaselinesOldTerminalButReturnsKnownRunningTransition() throws {
        let (defaults, suiteName) = try isolatedDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let conversationID = UUID()
        let historical = makeTask(
            conversationID: conversationID,
            status: .done,
            resultKind: .completed
        )
        let running = makeTask(conversationID: conversationID, status: .running)

        var state = YishuDelegatedTaskReturnState(userDefaults: defaults)
        let historicalBaselineDecision = state.shouldEnqueueSnapshot(historical)
        let runningDecision = state.shouldEnqueueSnapshot(running)
        #expect(!historicalBaselineDecision)
        #expect(!runningDecision)

        // Known IDs are durable so a runtime restart can still report the
        // running -> terminal transition without replaying historical rows.
        var relaunched = YishuDelegatedTaskReturnState(userDefaults: defaults)
        let completed = makeTask(
            id: running.id,
            conversationID: conversationID,
            status: .done,
            resultKind: .completed
        )
        let completedTransitionDecision = relaunched.shouldEnqueueSnapshot(completed)
        let historicalReplayDecision = relaunched.shouldEnqueueSnapshot(historical)
        #expect(completedTransitionDecision)
        #expect(!historicalReplayDecision)
    }

    @Test func returnCopyDoesNotUpgradeUnverifiedOrInterruptedWork() throws {
        let verified = try #require(makeTask(
            status: .done,
            resultKind: .succeeded,
            summary: "确认了三项交付物，并通过了最终检查。详见 [内部记录](https://example.com/private)。"
        ).returnAnnouncementText)
        let completed = try #require(makeTask(
            status: .done,
            resultKind: .completed
        ).returnAnnouncementText)
        let failed = try #require(makeTask(
            status: .failed,
            resultKind: .failed
        ).returnAnnouncementText)
        let cancelled = try #require(makeTask(
            status: .cancelled,
            resultKind: .cancelled
        ).returnAnnouncementText)
        let running = makeTask(status: .running)

        #expect(verified.contains("做好了"))
        #expect(verified.contains("确认了三项交付物"))
        #expect(!verified.contains("https://"))
        #expect(!verified.contains("[内部记录]"))
        #expect(verified.count <= 220)
        #expect(completed.contains("整理好了"))
        #expect(!completed.contains("未独立核验"))
        #expect(!completed.contains("后台任务"))
        #expect(!completed.contains("确认"))
        #expect(failed.contains("没做成"))
        #expect(cancelled.contains("停下"))
        #expect(running.returnAnnouncementText == nil)
        #expect(running.interruptedByRuntimeStop().returnAnnouncementText == nil)
    }

    @Test @MainActor func reminderShapedDelegatedWorkDoesNotClaimASystemReminder() {
        let masquerade = makeTask(
            title: "20分钟后提醒用户喝一口水( 约07:34)",
            status: .done,
            resultKind: .unverified,
            summary: nil
        )
        #expect(masquerade.returnAnnouncementText == "这个提醒没有设上。")
        #expect(!(masquerade.returnAnnouncementText ?? "").contains("未独立核验"))
        #expect(!(masquerade.returnAnnouncementText ?? "").contains("后台任务"))
        #expect(YishuProductUtteranceRouter.looksLikeRelativeTimeReminder(masquerade.title))
        let runningReminder = makeTask(
            title: "20分钟后提醒用户喝一口水( 约07:34)",
            status: .running
        )
        #expect(runningReminder.returnAnnouncementText == nil)
        #expect(AgentPresenceWindowManager.presenceChipLabel(for: [runningReminder]) != "进行中")
    }

    @Test func presentationWaitsForForegroundAndThreeSecondsOfQuiet() {
        #expect(!YishuDelegatedTaskReturnState.canPresent(
            foregroundBusy: true,
            secondsSinceLastUserInput: 10
        ))
        #expect(!YishuDelegatedTaskReturnState.canPresent(
            foregroundBusy: false,
            secondsSinceLastUserInput: 2.999
        ))
        #expect(YishuDelegatedTaskReturnState.canPresent(
            foregroundBusy: false,
            secondsSinceLastUserInput: 3
        ))
    }

    private func isolatedDefaults() throws -> (UserDefaults, String) {
        let suiteName = "DelegatedTaskReturnPolicyTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        return (defaults, suiteName)
    }

    private func makeTask(
        id: UUID = UUID(),
        conversationID: UUID = UUID(),
        title: String = "整理研究结论",
        status: YishuDelegatedTaskStatus,
        resultKind: YishuDelegatedResultKind? = nil,
        summary: String? = nil
    ) -> YishuDelegatedTaskPresenceEvent {
        YishuDelegatedTaskPresenceEvent(
            id: id,
            parentId: UUID(),
            mainConversationId: conversationID,
            title: title,
            status: status,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            updatedAt: Date(timeIntervalSince1970: 1_700_000_010),
            provider: nil,
            model: nil,
            resultKind: resultKind,
            summary: summary ?? (resultKind == nil ? nil : "结果保留在后台任务中。"),
            sourceEventId: UUID()
        )
    }
}
