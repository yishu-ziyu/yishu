//
//  CompanionManager+Unread.swift
//  leanring-buddy
//
//  In-memory unread notices for the panel's history entry: terminal
//  delegated-task results and enqueued time reminders bump the count,
//  opening the history window clears it. A restart means "seen", so
//  nothing here is persisted. Kept out of CompanionManager.swift to hold
//  that file under its size ratchet.
//

import Foundation

@MainActor
extension CompanionManager {

    /// Count a terminal delegated-task result (done/failed/cancelled carrying
    /// a result kind) as unseen, once per task id.
    func noteUnseenTaskResult(_ event: YishuDelegatedTaskPresenceEvent) {
        guard event.resultKind != nil,
              event.status == .done || event.status == .failed || event.status == .cancelled
        else { return }
        let noticeID = "task:\(event.id.uuidString)"
        guard !unseenNoticeIDs.contains(noticeID) else { return }
        unseenNoticeIDs.insert(noticeID)
        unreadNoticeCount += 1
    }

    /// Count an enqueued time reminder as unseen, once per identifier.
    func noteUnseenReminder(identifier: String) {
        let noticeID = "reminder:\(identifier)"
        guard !unseenNoticeIDs.contains(noticeID) else { return }
        unseenNoticeIDs.insert(noticeID)
        unreadNoticeCount += 1
    }

    /// Opening the history window means every notice has been seen.
    func markNoticesSeen() {
        unseenNoticeIDs = []
        unreadNoticeCount = 0
    }
}
