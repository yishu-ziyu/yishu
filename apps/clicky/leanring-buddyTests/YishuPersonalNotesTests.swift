import Foundation
import Testing
@testable import Clicky

struct YishuPersonalNotesTests {
    @Test func memoryAccessibilityIdentifiersUseStableOpaqueHashes() {
        let id = UUID(uuidString: "6BA7B810-9DAD-11D1-80B4-00C04FD430C8")!
        let hash = YishuMemoryQualityEvents.memoryIDHash(id)

        #expect(hash == "e5855ff48799c52c9ccf80b82bab9492c347a316876dbeaafef22b0bd4fac13d")
        #expect(
            YishuMemoryQualityEvents.cardAccessibilityIdentifier(for: id)
                == "yishu-memory-card-\(hash)"
        )
        #expect(
            YishuMemoryQualityEvents.forgetAccessibilityIdentifier(for: id)
                == "yishu-memory-forget-\(hash)"
        )
        #expect(!YishuMemoryQualityEvents.cardAccessibilityIdentifier(for: id).contains(id.uuidString))
        #expect(
            YishuMemoryQualityEvents.memoryIDHash(
                UUID(uuidString: "6BA7B811-9DAD-11D1-80B4-00C04FD430C8")!
            ) != hash
        )
    }

    @Test func emptyOrWhitespaceTextDoesNotCreate() {
        #expect(YishuPersonalNoteWritePolicy.shouldCreate("") == false)
        #expect(YishuPersonalNoteWritePolicy.shouldCreate("   \n\t") == false)
        #expect(YishuPersonalNoteWritePolicy.shouldCreate("周四把钥匙放在抽屉") == true)
        #expect(YishuPersonalNoteWritePolicy.normalizedText("  记下  ").isEmpty == false)
    }

    @Test func visibleCopyStaysHumanAndHonest() {
        let visible = [
            YishuPersonalNotesCopy.sectionTitle,
            YishuPersonalNotesCopy.emptyList,
            YishuPersonalNotesCopy.emptyDraft,
            YishuPersonalNotesCopy.saved,
            YishuPersonalNotesCopy.notSaved,
            YishuPersonalNotesCopy.unconfirmed,
            YishuPersonalNotesCopy.forgetPrompt,
            YishuPersonalNotesCopy.forgetDetail("周四钥匙"),
            YishuPersonalNotesCopy.forgot("周四钥匙"),
            YishuPersonalNotesCopy.alreadyGone,
            YishuPersonalNotesCopy.forgetFailed,
            YishuPersonalNoteWritePolicy.notice(confirmed: true, maybeWritten: false),
            YishuPersonalNoteWritePolicy.notice(confirmed: false, maybeWritten: true),
            YishuPersonalNoteWritePolicy.notice(confirmed: false, maybeWritten: false),
        ].joined(separator: "\n")

        for term in YishuPersonalNotesCopy.forbiddenInternalTerms {
            #expect(!visible.contains(term), "copy leaked \(term)")
        }
        #expect(YishuPersonalNoteWritePolicy.notice(confirmed: true, maybeWritten: false) == "记下了。")
        #expect(
            YishuPersonalNoteWritePolicy.notice(confirmed: false, maybeWritten: true)
                .contains("没能确认")
        )
        #expect(
            YishuPersonalNoteWritePolicy.notice(confirmed: false, maybeWritten: false)
                .contains("没有记下")
        )
    }

    @Test @MainActor func rememberSuccessOnlyAfterConfirmedEvent() async throws {
        let client = YishuAgentRuntimeClient()
        let parked = await client.parkMemoryRememberWaitForTests()
        let item = YishuMemoryListItem(
            id: UUID(),
            summary: "周四把钥匙放在抽屉",
            capturedAt: Date(),
            source: "conversation",
            scope: "personal"
        )
        client.completeParkedMemoryRememberForTests(
            requestId: parked.requestId,
            result: YishuMemoryRememberResult(item: item, confirmed: true)
        )
        let remembered = try await parked.wait.value
        #expect(remembered.confirmed)
        #expect(remembered.item.summary.contains("钥匙"))
    }

    @Test @MainActor func rememberFailureStaysFailedWithoutHang() async throws {
        let client = YishuAgentRuntimeClient()
        let parked = await client.parkMemoryRememberWaitForTests()
        client.failParkedHistoryRequestForTests(
            requestId: parked.requestId,
            error: YishuAgentRuntimeClientError.memoryFailed(YishuPersonalNotesCopy.unconfirmed)
        )
        var message = ""
        do {
            _ = try await parked.wait.value
        } catch let error as YishuAgentRuntimeClientError {
            message = error.localizedDescription
        }
        #expect(message.contains("没能确认"))
        #expect(!message.contains("记下了。"))
    }

    @Test @MainActor func processDeathEndsPendingRememberWithoutTimeout() async throws {
        let client = YishuAgentRuntimeClient()
        let parked = await client.parkMemoryRememberWaitForTests()
        #expect(client.pendingHistoryRequestCountForTests == 1)
        let started = ContinuousClock.now
        client.endAllPendingRuntimeRequests(
            throwing: YishuAgentRuntimeClientError.runtimeNotRunning
        )
        #expect(client.pendingHistoryRequestCountForTests == 0)
        var failed = false
        do { _ = try await parked.wait.value } catch { failed = true }
        #expect(failed)
        #expect(ContinuousClock.now - started < .seconds(2))
    }
}
