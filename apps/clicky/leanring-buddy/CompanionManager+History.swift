//
//  CompanionManager+History.swift
//  leanring-buddy
//
//  Durable conversation history operations for the on-demand history window.
//  Kept out of CompanionManager.swift to hold that file under its size
//  ratchet; the window (YishuConversationHistoryWindow.swift) is the only
//  consumer besides the panel's history entry button.
//

import Foundation

@MainActor
extension CompanionManager {

    /// Reload durable personal history (active + archived). No fake rows on
    /// empty or failure. The history window is scope-independent: it always
    /// lists the personal ledger regardless of the current panel scope.
    /// - Parameter clearNotice: When true (default), drop any prior notice so
    ///   a manual refresh does not leave stale success text. New-conversation
    ///   sets its notice first and passes false so "已开始新对话。" stays visible.
    func refreshPersonalHistory(clearNotice: Bool = true) {
        guard yishuAgentRuntimeClient.isRunning else {
            historyNotice = "运行时尚未就绪，稍后再看历史。"
            return
        }
        personalHistoryLoading = true
        if clearNotice {
            historyNotice = nil
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.personalHistoryLoading = false }
            do {
                let items = try await self.yishuAgentRuntimeClient.listHistory(
                    scope: .personal,
                    limit: 50,
                    includeArchived: true
                )
                self.personalHistoryItems = items
                self.personalHistoryEmpty = items.isEmpty
            } catch {
                self.personalHistoryItems = []
                self.personalHistoryEmpty = false
                self.historyNotice = error.localizedDescription
            }
        }
    }

    /// User actively selected an old personal conversation to continue.
    /// Archived rows are transparently restored first so the runtime open
    /// (which rejects archived) can succeed. `completion` reports success so
    /// the history window can close only on a real switch.
    func continuePersonalHistory(
        _ item: YishuHistoryListItem,
        completion: (@MainActor (Bool) -> Void)? = nil
    ) {
        guard canChangeConversation else {
            historyNotice = "请等当前回答结束后再切换对话。"
            completion?(false)
            return
        }
        guard yishuAgentRuntimeClient.isRunning else {
            historyNotice = "运行时尚未就绪。"
            completion?(false)
            return
        }
        historyNotice = nil
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                if item.status == "archived" {
                    let restored = try await self.yishuAgentRuntimeClient.restoreHistory(
                        conversationId: item.id,
                        scope: .personal
                    )
                    guard restored.status == "active" else {
                        self.historyNotice = "恢复失败，这段对话仍保持归档。"
                        completion?(false)
                        return
                    }
                }
                let opened = try await self.yishuAgentRuntimeClient.openHistory(
                    conversationId: item.id,
                    scope: .personal
                )
                guard self.canChangeConversation else {
                    self.historyNotice = "请等当前回答结束后再切换对话。"
                    completion?(false)
                    return
                }
                guard self.yishuAgentRuntimeClient.selectConversation(
                    id: opened.conversationId,
                    scope: .personal
                ) else {
                    self.historyNotice = "当前会话仍在执行，暂时不能切换。"
                    completion?(false)
                    return
                }
                // Continuing another conversation must not inherit the prior
                // turn's memory source line (Codex PROOF-1b residual).
                self.clearMemorySourceNotice()
                self.resetDelegatedTaskProjectionForConversationChange()
                self.sessionScope = .personal
                self.historyNotice = "已继续「\(item.title)」。"
                self.refreshPersonalHistory(clearNotice: false)
                completion?(true)
            } catch {
                self.historyNotice = error.localizedDescription
                completion?(false)
            }
        }
    }

    /// Ask the user to confirm restoring one archived history row.
    func requestRestorePersonalHistory(_ item: YishuHistoryListItem) {
        guard !historyRestoreInFlight else { return }
        guard item.status == "archived" else { return }
        historyRestoreCandidate = item
    }

    /// Cancel pending restore confirmation without touching storage or list.
    func cancelRestorePersonalHistory() {
        historyRestoreCandidate = nil
    }

    /// Confirm restore. Only moves the row after storage confirms active.
    func confirmRestorePersonalHistory() {
        guard let item = historyRestoreCandidate else { return }
        guard yishuAgentRuntimeClient.isRunning else {
            historyNotice = "运行时尚未就绪，恢复未执行。"
            historyRestoreCandidate = nil
            return
        }
        guard !historyRestoreInFlight else { return }
        historyRestoreInFlight = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                self.historyRestoreInFlight = false
                self.historyRestoreCandidate = nil
            }
            do {
                let restored = try await self.yishuAgentRuntimeClient.restoreHistory(
                    conversationId: item.id,
                    scope: .personal
                )
                guard restored.status == "active" else {
                    self.historyNotice = "恢复失败，这段对话仍保持归档。"
                    return
                }
                self.personalHistoryItems = self.personalHistoryItems.map { row in
                    row.id == item.id
                        ? YishuHistoryListItem(
                            id: row.id,
                            createdAt: row.createdAt,
                            updatedAt: Date(),
                            status: "active",
                            title: row.title,
                            summary: row.summary
                        )
                        : row
                }
                self.historyNotice = "已恢复「\(item.title)」。"
            } catch {
                self.historyNotice = error.localizedDescription
            }
        }
    }

    /// Create a clean personal conversation with no prior local context.
    /// Scope-independent: the history window can start a new personal
    /// conversation regardless of the current panel scope.
    func beginNewPersonalConversation() {
        guard canChangeConversation else {
            historyNotice = "请等当前回答结束后再新建对话。"
            return
        }
        guard yishuAgentRuntimeClient.beginNewConversation(scope: .personal) else {
            historyNotice = "当前会话仍在执行，暂时不能新建。"
            return
        }
        clearMemorySourceNotice()
        resetDelegatedTaskProjectionForConversationChange()
        sessionScope = .personal
        historyNotice = "已开始新对话。"
        // Keep the success notice; a plain refresh would wipe it immediately.
        refreshPersonalHistory(clearNotice: false)
        refreshPersonalMemories(clearNotice: false)
    }

    /// Ask the user to confirm soft-delete (archive) of one personal history row.
    func requestDeletePersonalHistory(_ item: YishuHistoryListItem) {
        guard canChangeConversation else {
            historyNotice = "请等当前回答结束后再删除对话。"
            return
        }
        guard !historyDeleteInFlight else { return }
        historyDeleteCandidate = item
        historyNotice = nil
    }

    /// Cancel pending delete confirmation without touching storage or list.
    func cancelDeletePersonalHistory() {
        historyDeleteCandidate = nil
    }

    /// Confirm soft-delete. Only moves the row after storage succeeds.
    /// If the deleted row is the current conversation, rotates to a new clean ID.
    func confirmDeletePersonalHistory() {
        guard let item = historyDeleteCandidate else { return }
        guard canChangeConversation else {
            historyNotice = "请等当前回答结束后再删除对话。"
            historyDeleteCandidate = nil
            return
        }
        guard yishuAgentRuntimeClient.isRunning else {
            historyNotice = "运行时尚未就绪，删除未执行。"
            historyDeleteCandidate = nil
            return
        }
        guard !historyDeleteInFlight else { return }
        historyDeleteInFlight = true
        let deletingCurrent = yishuAgentRuntimeClient.currentConversationId == item.id
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                self.historyDeleteInFlight = false
                self.historyDeleteCandidate = nil
            }
            do {
                let deleted = try await self.yishuAgentRuntimeClient.deleteHistory(
                    conversationId: item.id,
                    scope: .personal
                )
                guard deleted.status == "archived" else {
                    self.historyNotice = "删除失败，原对话仍保留。"
                    return
                }
                // Only move the row into the archived section after the store
                // confirmed the archive; the row stays visible so the user can
                // restore it later.
                self.personalHistoryItems = self.personalHistoryItems.map { row in
                    row.id == item.id
                        ? YishuHistoryListItem(
                            id: row.id,
                            createdAt: row.createdAt,
                            updatedAt: Date(),
                            status: "archived",
                            title: row.title,
                            summary: row.summary
                        )
                        : row
                }
                if deletingCurrent {
                    guard self.yishuAgentRuntimeClient.beginNewConversation(scope: .personal) else {
                        self.historyNotice = "已删除，但当前会话仍在执行，稍后请手动新建。"
                        return
                    }
                    self.clearMemorySourceNotice()
                    self.resetDelegatedTaskProjectionForConversationChange()
                    self.sessionScope = .personal
                    self.historyNotice = "已删除「\(item.title)」，已开始新对话。"
                } else {
                    self.historyNotice = "已删除「\(item.title)」。"
                }
            } catch {
                // Keep the original row on any failure.
                self.historyNotice = error.localizedDescription.isEmpty
                    ? "删除失败，原对话仍保留。"
                    : error.localizedDescription
            }
        }
    }
}
