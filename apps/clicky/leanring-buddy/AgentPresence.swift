//
//  AgentPresence.swift
//  leanring-buddy
//
//  A visible projection of background TaskTruth. Runtime events own every
//  status; this file only owns presentation lifecycle such as open/seen.
//

import AppKit
import Combine
import Foundation
import SwiftUI

enum YishuDelegatedTaskStatus: String, Equatable {
    case pending
    case running
    case blocked
    case done
    case failed
    case cancelled
    /// Presentation-only state derived from a typed sidecar-stopped event.
    /// It is never accepted as TaskTruth on the wire.
    case interrupted
}

enum YishuDelegatedResultKind: String, Equatable {
    case succeeded
    case completed
    case unverified
    case failed
    case cancelled
}

/// Additive task discriminator from the runtime. Missing values are treated as
/// delegated work so Yishu remains compatible with older sidecars.
enum YishuBackgroundTaskKind: String, Equatable {
    case delegated
    case contextReminder = "context_reminder"
}

enum YishuContextReminderWatchState: String, Equatable {
    case waitingForDeparture = "waiting_for_departure"
    case armed
    case fired
    case cancelled
}

enum YishuSystemSequenceStepStatus: String, Equatable {
    case pending
    case running
    case passed
    case failed
}

/// One runtime-authored system observation. A sequence step is displayable only
/// when it carries the event id that produced it; Yishu never advances steps
/// with timers or by translating its own visual phases.
struct YishuSystemSequenceStep: Identifiable, Equatable {
    let id: String
    let label: String
    let detail: String?
    let status: YishuSystemSequenceStepStatus
    let occurredAt: Date
    let sourceEventId: UUID

    static func decode(_ raw: [String: Any]) -> Self? {
        guard let rawID = raw["id"] as? String,
              let rawLabel = raw["label"] as? String,
              let rawStatus = raw["status"] as? String,
              let status = normalizedStatus(rawStatus),
              let occurredAt = YishuDelegatedTaskPresenceEvent.parseISO8601(
                raw["occurredAt"] as? String
              ),
              let sourceEventId = (raw["sourceEventId"] as? String)
                .flatMap(UUID.init(uuidString:)) else {
            return nil
        }
        let id = rawID.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = rawLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...80).contains(id.count), (1...120).contains(label.count) else {
            return nil
        }
        let detail = YishuDelegatedTaskPresenceEvent.boundedOptionalString(
            raw["detail"],
            maximum: 240
        )
        guard raw["detail"] == nil || detail != nil else { return nil }
        return Self(
            id: id,
            label: label,
            detail: detail,
            status: status,
            occurredAt: occurredAt,
            sourceEventId: sourceEventId
        )
    }

    private static func normalizedStatus(_ wireStatus: String) -> YishuSystemSequenceStepStatus? {
        switch wireStatus {
        case "pending": return .pending
        case "running": return .running
        case "passed", "completed": return .passed
        case "failed", "cancelled": return .failed
        default: return nil
        }
    }
}

enum YishuTaskCancelRequestState: Equatable {
    case idle
    case requesting
    case accepted
    case failed(String)
}

struct YishuDelegatedTaskPresenceEvent: Identifiable, Equatable {
    let id: UUID
    let parentId: UUID
    let mainConversationId: UUID
    let title: String
    let status: YishuDelegatedTaskStatus
    let createdAt: Date
    let updatedAt: Date
    let provider: String?
    let model: String?
    let resultKind: YishuDelegatedResultKind?
    let summary: String?
    let sourceEventId: UUID
    let sequence: [YishuSystemSequenceStep]
    let taskKind: YishuBackgroundTaskKind
    let watchState: YishuContextReminderWatchState?

    init(
        id: UUID,
        parentId: UUID,
        mainConversationId: UUID,
        title: String,
        status: YishuDelegatedTaskStatus,
        createdAt: Date,
        updatedAt: Date,
        provider: String?,
        model: String?,
        resultKind: YishuDelegatedResultKind?,
        summary: String?,
        sourceEventId: UUID,
        sequence: [YishuSystemSequenceStep] = [],
        taskKind: YishuBackgroundTaskKind = .delegated,
        watchState: YishuContextReminderWatchState? = nil
    ) {
        self.id = id
        self.parentId = parentId
        self.mainConversationId = mainConversationId
        self.title = title
        self.status = status
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.provider = provider
        self.model = model
        self.resultKind = resultKind
        self.summary = summary
        self.sourceEventId = sourceEventId
        self.sequence = sequence
        self.taskKind = taskKind
        self.watchState = watchState
    }

    var workerLabel: String {
        switch taskKind {
        case .delegated: return "后台任务"
        case .contextReminder: return "应用返回提醒"
        }
    }

    var statusLabel: String {
        if taskKind == .contextReminder {
            switch status {
            case .pending: return "提醒已创建"
            case .running:
                return watchState == .armed
                    ? "等待你回到当前应用"
                    : "等待你离开当前应用"
            case .blocked: return "提醒需要确认"
            case .done: return "提醒已送达"
            case .failed: return "提醒未送达"
            case .cancelled: return "提醒已取消"
            case .interrupted: return "恢复后继续等待"
            }
        }
        switch status {
        case .pending: return "等待开始"
        case .running: return "正在研究"
        case .blocked: return "需要确认"
        case .done: return "结果已就绪"
        case .failed, .cancelled, .interrupted: return "任务已中断"
        }
    }

    var interruptionMessage: String? {
        if taskKind == .contextReminder {
            switch status {
            case .failed:
                return "这个提醒未能送达。"
            case .cancelled:
                return "这个提醒已取消，不会再触发。"
            case .interrupted:
                return "提醒仍已保存；奕枢恢复后会继续等待。"
            case .pending, .running, .blocked, .done:
                return nil
            }
        }
        switch status {
        case .failed, .cancelled, .interrupted:
            return "任务已中断。可以从头重试，或开始一个新方向。"
        default:
            return nil
        }
    }

    @MainActor
    static func decode(_ raw: [String: Any]) -> Self? {
        guard raw["type"] as? String == "task.presence.updated",
              YishuAgentRuntimeClient.isValidSchemaVersionValue(raw["schemaVersion"]),
              let sourceEventId = (raw["eventId"] as? String).flatMap(UUID.init(uuidString:)),
              (raw["requestId"] as? String).flatMap(UUID.init(uuidString:)) != nil,
              (raw["traceId"] as? String).flatMap(UUID.init(uuidString:)) != nil,
              let envelopeConversationId = (raw["conversationId"] as? String)
                .flatMap(UUID.init(uuidString:)),
              let payload = raw["payload"] as? [String: Any],
              let mainConversationId = (payload["mainConversationId"] as? String)
                .flatMap(UUID.init(uuidString:)),
              mainConversationId == envelopeConversationId else {
            return nil
        }

        return decodePayload(
            payload,
            expectedConversationId: mainConversationId,
            sourceEventId: sourceEventId,
            requiresTerminalResult: true
        )
    }

    static func decodeSnapshotItem(
        _ payload: [String: Any],
        expectedConversationId: UUID,
        sourceEventId: UUID
    ) -> Self? {
        decodePayload(
            payload,
            expectedConversationId: expectedConversationId,
            sourceEventId: sourceEventId,
            requiresTerminalResult: false
        )
    }

    private static func decodePayload(
        _ payload: [String: Any],
        expectedConversationId: UUID,
        sourceEventId: UUID,
        requiresTerminalResult: Bool
    ) -> Self? {
        guard let taskId = (payload["taskId"] as? String).flatMap(UUID.init(uuidString:)),
              let parentId = (payload["parentId"] as? String).flatMap(UUID.init(uuidString:)),
              let mainConversationId = (payload["mainConversationId"] as? String)
                .flatMap(UUID.init(uuidString:)),
              mainConversationId == expectedConversationId,
              let rawTitle = payload["title"] as? String,
              let statusRaw = payload["status"] as? String,
              let status = YishuDelegatedTaskStatus(rawValue: statusRaw),
              status != .interrupted,
              let createdAt = parseISO8601(payload["createdAt"] as? String),
              let updatedAt = parseISO8601(payload["updatedAt"] as? String),
              updatedAt >= createdAt else {
            return nil
        }

        let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...160).contains(title.count) else { return nil }

        let provider = boundedOptionalString(payload["provider"], maximum: 120)
        let model = boundedOptionalString(payload["model"], maximum: 120)
        guard (payload["provider"] == nil || provider != nil),
              (payload["model"] == nil || model != nil) else {
            return nil
        }

        let resultKind = (payload["resultKind"] as? String)
            .flatMap(YishuDelegatedResultKind.init(rawValue:))
        let summary = boundedOptionalString(payload["summary"], maximum: 500)
        let taskKind: YishuBackgroundTaskKind
        if let rawTaskKind = payload["taskKind"] {
            guard let wireTaskKind = rawTaskKind as? String,
                  let decodedTaskKind = YishuBackgroundTaskKind(rawValue: wireTaskKind) else {
                return nil
            }
            taskKind = decodedTaskKind
        } else {
            // The one compatibility fallback: V1 producers omitted taskKind
            // and only produced delegated work.
            taskKind = .delegated
        }
        let watchState: YishuContextReminderWatchState?
        if taskKind == .contextReminder {
            if let rawWatchState = payload["watchState"] {
                guard let wireWatchState = rawWatchState as? String,
                      let decodedWatchState = YishuContextReminderWatchState(
                        rawValue: wireWatchState
                      ),
                      contextReminderStateMatchesStatus(decodedWatchState, status: status) else {
                    return nil
                }
                watchState = decodedWatchState
            } else {
                // Compatibility with the first context-reminder producer,
                // which emitted taskKind but no explicit watch state.
                watchState = .waitingForDeparture
            }
        } else {
            guard payload["watchState"] == nil else { return nil }
            watchState = nil
        }
        let isActive = status == .pending || status == .running
        let hasCompleteResult = resultKind != nil && summary != nil
        guard (provider == nil) == (model == nil),
              (payload["resultKind"] == nil || resultKind != nil),
              (payload["summary"] == nil || summary != nil),
              !(isActive && hasCompleteResult),
              (!requiresTerminalResult || isActive || hasCompleteResult),
              (resultKind == nil) == (summary == nil),
              (!requiresTerminalResult && resultKind == nil
                || resultMatchesStatus(resultKind, status: status)) else {
            return nil
        }

        let sequence: [YishuSystemSequenceStep]
        if let rawSequence = payload["sequence"] {
            guard let rows = rawSequence as? [[String: Any]], rows.count <= 64 else {
                return nil
            }
            sequence = rows.compactMap(YishuSystemSequenceStep.decode)
            guard sequence.count == rows.count,
                  Set(sequence.map(\.id)).count == sequence.count else {
                return nil
            }
        } else {
            sequence = []
        }

        return Self(
            id: taskId,
            parentId: parentId,
            mainConversationId: mainConversationId,
            title: title,
            status: status,
            createdAt: createdAt,
            updatedAt: updatedAt,
            provider: provider,
            model: model,
            resultKind: resultKind,
            summary: summary,
            sourceEventId: sourceEventId,
            sequence: sequence,
            taskKind: taskKind,
            watchState: watchState
        )
    }

    static func boundedOptionalString(_ value: Any?, maximum: Int) -> String? {
        guard let value else { return nil }
        guard let string = value as? String else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...maximum).contains(trimmed.count) else { return nil }
        return trimmed
    }

    static func parseISO8601(_ value: String?) -> Date? {
        guard let value else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }

    private static func resultMatchesStatus(
        _ result: YishuDelegatedResultKind?,
        status: YishuDelegatedTaskStatus
    ) -> Bool {
        switch status {
        case .pending, .running, .interrupted: return result == nil
        case .done: return result == .succeeded || result == .completed
        case .blocked: return result == nil || result == .unverified
        case .failed: return result == .failed
        case .cancelled: return result == .cancelled
        }
    }

    func interruptedByRuntimeStop() -> Self {
        guard status == .pending || status == .running else { return self }
        return Self(
            id: id,
            parentId: parentId,
            mainConversationId: mainConversationId,
            title: title,
            status: .interrupted,
            createdAt: createdAt,
            updatedAt: updatedAt,
            provider: provider,
            model: model,
            resultKind: nil,
            summary: nil,
            sourceEventId: sourceEventId,
            sequence: sequence,
            taskKind: taskKind,
            watchState: watchState
        )
    }

    /// A terminal result can return to the user, but it never becomes a new
    /// conversation turn. Interrupted is local presentation state and is kept
    /// in ResultInbox without creating a proactive announcement.
    var returnAnnouncementText: String? {
        if taskKind == .contextReminder {
            switch status {
            case .done:
                let reminder = summary.flatMap(Self.reminderExcerpt(from:))
                    ?? Self.reminderExcerpt(from: title)
                    ?? "你刚才设下的事"
                return "提醒你：\(reminder)。"
            case .blocked:
                return "这个提醒还没送达，需要你确认。"
            case .failed:
                return "这个提醒未能送达。"
            case .cancelled:
                return "提醒已取消。"
            case .pending, .running, .interrupted:
                return nil
            }
        }
        if looksLikeRelativeTimeReminder {
            switch status {
            case .pending, .running, .interrupted:
                return nil
            case .done, .blocked, .failed, .cancelled:
                return "这个提醒没有设上。"
            }
        }
        if let spoken = summary.flatMap({ Self.userFacingResultExcerpt(from: $0, title: title) }) {
            return spoken.hasSuffix("。") ? spoken : "\(spoken)。"
        }
        switch resultKind {
        case .succeeded, .completed:
            return "查好了。"
        case .unverified:
            return "做完了，但我没法确认。"
        case .failed:
            return "没做成。"
        case .cancelled:
            return "已经停下。"
        case nil:
            switch status {
            case .done:
                return "查好了。"
            case .blocked:
                return "还没做完。"
            case .failed:
                return "没做成。"
            case .cancelled:
                return "已经停下。"
            case .pending, .running, .interrupted:
                return nil
            }
        }
    }

    var presenceCaption: String {
        Self.returnExcerpt(from: title, maximum: 28) ?? workerLabel
    }

    private var looksLikeRelativeTimeReminder: Bool {
        YishuProductUtteranceRouter.looksLikeRelativeTimeReminder(title)
    }

    private static func reminderExcerpt(from rawText: String) -> String? {
        guard var reminder = returnExcerpt(from: rawText, maximum: 140) else { return nil }
        for prefix in ["提醒：", "提醒:"] where reminder.hasPrefix(prefix) {
            reminder.removeFirst(prefix.count)
            break
        }
        reminder = reminder.trimmingCharacters(in: .whitespacesAndNewlines)
        return reminder.isEmpty ? nil : reminder
    }

    private static func contextReminderStateMatchesStatus(
        _ watchState: YishuContextReminderWatchState,
        status: YishuDelegatedTaskStatus
    ) -> Bool {
        switch watchState {
        case .waitingForDeparture:
            return status == .pending || status == .running
        case .armed:
            return status == .running
        case .fired:
            return status == .done
        case .cancelled:
            return status == .cancelled
        }
    }

    /// Findings go through the spoken mouth. Reminder copy does not.
    var shouldExcerptSpokenFinding: Bool {
        guard taskKind == .delegated else { return false }
        guard !looksLikeRelativeTimeReminder else { return false }
        guard returnAnnouncementText != nil else { return false }
        return status == .done || status == .blocked
    }

    var chipFindingLine: String? {
        guard taskKind == .delegated else { return nil }
        guard status == .done || status == .blocked else { return nil }
        guard let spoken = returnAnnouncementText else { return nil }
        return Self.returnExcerpt(from: spoken, maximum: 18)
    }

    var pocketFindingText: String? {
        guard taskKind == .delegated else { return nil }
        return summary.flatMap { Self.stripVisibleNoise(from: $0) }
    }

    private static func userFacingResultExcerpt(from rawText: String, title: String) -> String? {
        guard var text = stripVisibleNoise(from: rawText) else { return nil }
        text = stripLeadingQuotedRequest(from: text, title: title)
        if text.contains("后台任务")
            || text.contains("未独立核验")
            || text.contains("详情保留")
            || text.contains("运行时")
            || text.contains("执行结束") {
            return nil
        }
        text = firstSpokenStretch(text, maximum: 160)
        return text.isEmpty ? nil : text
    }

    /// ResultInbox keeps the full runtime summary. Proactive speech uses one
    /// bounded plain-text stretch so URLs and formatting are never read out.
    private static func returnExcerpt(from rawText: String, maximum: Int) -> String? {
        guard var text = stripVisibleNoise(from: rawText) else { return nil }
        text = text.replacingOccurrences(
            of: #"[。！？!?；;]+"#,
            with: "，",
            options: .regularExpression
        )
        text = text.trimmingCharacters(in: CharacterSet(charactersIn: " ，、:："))
        guard !text.isEmpty else { return nil }
        if text.count > maximum {
            text = String(text.prefix(maximum)).trimmingCharacters(in: .whitespacesAndNewlines)
            text += "…"
        }
        return text
    }

    private static func stripVisibleNoise(from rawText: String) -> String? {
        let lowercase = rawText.lowercased()
        guard !lowercase.contains("[result summary omitted"),
              !lowercase.contains("[delegated result unavailable") else { return nil }
        var text = rawText.replacingOccurrences(
            of: #"\[([^\]\n]+)\]\(\s*(?:https?://|www\.)[^)\n]+\)"#,
            with: "$1",
            options: .regularExpression
        )
        text = text.replacingOccurrences(
            of: #"(?i)(?:https?://|www\.)[^\s<>()（）\[\]{}，。！？；、“”‘’]+"#,
            with: "",
            options: .regularExpression
        )
        text = text.replacingOccurrences(
            of: #"(?i)(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|co|info)(?:/[^\s<>()（）\[\]{}，。！？；、“”‘’]*)?"#,
            with: "",
            options: .regularExpression
        )
        text = text.replacingOccurrences(
            of: #"(?i)(?:来源|来源链接|网址|链接|source)\s*[:：]"#,
            with: "",
            options: .regularExpression
        )
        text = text.replacingOccurrences(
            of: #"[`*_>#~]+"#,
            with: " ",
            options: .regularExpression
        )
        text = text
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        text = text.replacingOccurrences(of: #"\s{2,}"#, with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: #"[,，](?:\s*[,，])+"#, with: "，", options: .regularExpression)
        text = text.trimmingCharacters(in: CharacterSet(charactersIn: " ，、:：;；"))
        return text.isEmpty ? nil : text
    }

    private static func stripLeadingQuotedRequest(from text: String, title: String) -> String {
        let normalizedTitle = title
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedTitle.isEmpty else { return text }
        let pairs = [("「", "」"), ("『", "』"), ("“", "”"), ("\"", "\""), ("'", "'")]
        for (open, close) in pairs {
            guard text.hasPrefix(open) else { continue }
            let searchRange = text.index(after: text.startIndex)..<text.endIndex
            guard let closeRange = text.range(of: close, range: searchRange) else { continue }
            var quoted = String(text[text.index(after: text.startIndex)..<closeRange.lowerBound])
            quoted = quoted.replacingOccurrences(
                of: #"[\.…]+$"#,
                with: "",
                options: .regularExpression
            )
            quoted = quoted
                .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let q = quoted.lowercased()
            let t = normalizedTitle.lowercased()
            guard !q.isEmpty, t.hasPrefix(q) || q.hasPrefix(t) else { continue }
            var rest = String(text[closeRange.upperBound...])
            rest = rest.replacingOccurrences(
                of: #"^[。.!！，,\s]+"#,
                with: "",
                options: .regularExpression
            )
            return rest.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return text
    }

    private static func firstSpokenStretch(_ raw: String, maximum: Int) -> String {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return text }
        var ends = 0
        var cut = text.endIndex
        for index in text.indices {
            if "。！？!?".contains(text[index]) {
                ends += 1
                cut = text.index(after: index)
                if ends == 2 { break }
            }
        }
        if ends == 2 {
            text = String(text[..<cut]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if text.count > maximum {
            text = String(text.prefix(maximum)).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
        }
        return text
    }
}

/// Persists only the two facts needed to prevent restart floods. A task first
/// seen as terminal in a snapshot is recorded as baseline; a task previously
/// seen running may return when a later snapshot supplies its terminal state.
struct YishuDelegatedTaskReturnState {
    private static let knownTaskIDsKey = "yishu.delegated-return.known-task-ids.v1"
    private static let announcedTaskIDsKey = "yishu.delegated-return.announced-task-ids.v1"

    private let userDefaults: UserDefaults
    private(set) var knownTaskIDs: Set<UUID>
    private(set) var announcedTaskIDs: Set<UUID>

    init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
        knownTaskIDs = Self.loadIDs(forKey: Self.knownTaskIDsKey, from: userDefaults)
        announcedTaskIDs = Self.loadIDs(forKey: Self.announcedTaskIDsKey, from: userDefaults)
    }

    mutating func shouldEnqueueLive(_ task: YishuDelegatedTaskPresenceEvent) -> Bool {
        if task.status == .pending || task.status == .running {
            recordKnown(task.id)
            return false
        }
        guard task.returnAnnouncementText != nil else { return false }
        recordKnown(task.id)
        return !announcedTaskIDs.contains(task.id)
    }

    mutating func shouldEnqueueSnapshot(_ task: YishuDelegatedTaskPresenceEvent) -> Bool {
        if task.status == .pending || task.status == .running {
            recordKnown(task.id)
            return false
        }
        guard task.returnAnnouncementText != nil else { return false }
        guard knownTaskIDs.contains(task.id) else {
            // Existing terminal rows are history, not new interruptions.
            recordKnown(task.id)
            recordAnnounced(task.id)
            return false
        }
        return !announcedTaskIDs.contains(task.id)
    }

    mutating func markAnnounced(_ taskID: UUID) {
        recordKnown(taskID)
        recordAnnounced(taskID)
    }

    static func canPresent(
        foregroundBusy: Bool,
        secondsSinceLastUserInput: TimeInterval,
        quietInterval: TimeInterval = 3
    ) -> Bool {
        !foregroundBusy && secondsSinceLastUserInput >= quietInterval
    }

    private mutating func recordKnown(_ taskID: UUID) {
        guard knownTaskIDs.insert(taskID).inserted else { return }
        persist(knownTaskIDs, forKey: Self.knownTaskIDsKey)
    }

    private mutating func recordAnnounced(_ taskID: UUID) {
        guard announcedTaskIDs.insert(taskID).inserted else { return }
        persist(announcedTaskIDs, forKey: Self.announcedTaskIDsKey)
    }

    private static func loadIDs(forKey key: String, from userDefaults: UserDefaults) -> Set<UUID> {
        Set((userDefaults.stringArray(forKey: key) ?? []).compactMap(UUID.init(uuidString:)))
    }

    private func persist(_ ids: Set<UUID>, forKey key: String) {
        userDefaults.set(ids.map(\.uuidString).sorted(), forKey: key)
    }
}

@MainActor
final class AgentPresenceViewModel: ObservableObject {
    @Published private(set) var tasks: [YishuDelegatedTaskPresenceEvent] = []
    @Published private(set) var cancelRequestStates: [UUID: YishuTaskCancelRequestState] = [:]

    var hasTasks: Bool { !tasks.isEmpty }

    func apply(
        _ event: YishuDelegatedTaskPresenceEvent,
        expectedConversationId: UUID
    ) {
        guard event.mainConversationId == expectedConversationId else { return }
        if let index = tasks.firstIndex(where: { $0.id == event.id }) {
            guard event.updatedAt >= tasks[index].updatedAt else { return }
            tasks[index] = event
        } else {
            tasks.append(event)
        }
        if event.status != .pending && event.status != .running {
            cancelRequestStates.removeValue(forKey: event.id)
        }
        tasks.sort { $0.createdAt > $1.createdAt }
    }

    func replaceWithSnapshot(_ snapshot: [YishuDelegatedTaskPresenceEvent]) {
        tasks = snapshot.sorted { $0.createdAt > $1.createdAt }
        let visibleIDs = Set(tasks.map(\.id))
        cancelRequestStates = cancelRequestStates.filter { visibleIDs.contains($0.key) }
    }

    /// Merge a request-time snapshot without overwriting typed presence that
    /// arrived while task.list was in flight. The latest runtime timestamp wins;
    /// live-only rows stay because their omission can be a snapshot race.
    func mergeSnapshot(_ snapshot: [YishuDelegatedTaskPresenceEvent]) {
        var merged = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, $0) })
        for task in snapshot {
            if let current = merged[task.id],
               current.status != .interrupted,
               current.updatedAt >= task.updatedAt {
                continue
            }
            merged[task.id] = task
        }
        tasks = merged.values.sorted { $0.createdAt > $1.createdAt }
        let visibleIDs = Set(tasks.map(\.id))
        cancelRequestStates = cancelRequestStates.filter { visibleIDs.contains($0.key) }
    }

    func markRuntimeInterrupted() {
        tasks = tasks.map { $0.interruptedByRuntimeStop() }
        for task in tasks where task.status == .interrupted {
            cancelRequestStates.removeValue(forKey: task.id)
        }
    }

    func markCancelRequesting(_ taskId: UUID) {
        cancelRequestStates[taskId] = .requesting
    }

    func markCancelAccepted(_ taskId: UUID) {
        guard tasks.contains(where: {
            $0.id == taskId && ($0.status == .pending || $0.status == .running)
        }) else { return }
        cancelRequestStates[taskId] = .accepted
    }

    func markCancelFailed(_ taskId: UUID, message: String) {
        guard tasks.contains(where: {
            $0.id == taskId && ($0.status == .pending || $0.status == .running)
        }) else { return }
        cancelRequestStates[taskId] = .failed(message)
    }

    func cancelRequestState(for taskId: UUID) -> YishuTaskCancelRequestState {
        cancelRequestStates[taskId] ?? .idle
    }

    func acknowledge(_ taskId: UUID) {
        tasks.removeAll { $0.id == taskId }
        cancelRequestStates.removeValue(forKey: taskId)
    }

    func reset() {
        tasks.removeAll()
        cancelRequestStates.removeAll()
    }
}

enum AgentPresencePlacement {
    static let panelSize = CGSize(width: 260, height: 48)
    static let edgeInset: CGFloat = 14
    static let savedAnchorKey = "yishu.presence.anchor-center.v1"

    static func defaultAnchor(in visibleFrame: NSRect) -> NSPoint {
        NSPoint(
            x: visibleFrame.maxX - panelSize.width / 2 - edgeInset,
            y: visibleFrame.maxY - panelSize.height / 2 - edgeInset
        )
    }

    static func clamp(_ point: NSPoint, in visibleFrame: NSRect) -> NSPoint {
        let halfW = panelSize.width / 2
        let halfH = panelSize.height / 2
        let minX = visibleFrame.minX + halfW + edgeInset
        let maxX = visibleFrame.maxX - halfW - edgeInset
        let minY = visibleFrame.minY + halfH + edgeInset
        let maxY = visibleFrame.maxY - halfH - edgeInset
        return NSPoint(
            x: minX <= maxX ? min(max(point.x, minX), maxX) : visibleFrame.midX,
            y: minY <= maxY ? min(max(point.y, minY), maxY) : visibleFrame.midY
        )
    }

    static func resolvedAnchor(
        saved: NSPoint?,
        mouse: NSPoint,
        screens: [(frame: NSRect, visible: NSRect)]
    ) -> NSPoint {
        let mouseScreen = screens.first(where: { $0.frame.contains(mouse) }) ?? screens.first
        guard let mouseScreen else { return .zero }
        if let saved, let host = screens.first(where: { $0.visible.insetBy(dx: -8, dy: -8).contains(saved) }) {
            return clamp(saved, in: host.visible)
        }
        return defaultAnchor(in: mouseScreen.visible)
    }

    static func loadSavedAnchor(from defaults: UserDefaults = .standard) -> NSPoint? {
        guard let values = defaults.array(forKey: savedAnchorKey) as? [NSNumber], values.count == 2 else {
            return nil
        }
        return NSPoint(x: values[0].doubleValue, y: values[1].doubleValue)
    }

    static func saveAnchor(_ point: NSPoint, to defaults: UserDefaults = .standard) {
        defaults.set([point.x, point.y], forKey: savedAnchorKey)
    }

    static func labelOrigin(near center: NSPoint, size: CGSize, visibleFrame: NSRect) -> NSPoint {
        let x = min(
            max(center.x - size.width / 2, visibleFrame.minX + 8),
            visibleFrame.maxX - size.width - 8
        )
        let above = center.y + 22
        if above + size.height <= visibleFrame.maxY - 4 {
            return NSPoint(x: x, y: above)
        }
        return NSPoint(x: x, y: center.y - size.height - 22)
    }
}

enum AgentPresenceSettlePolicy {
    static let hideDelay: TimeInterval = 4

    static func visibleTasks(
        _ tasks: [YishuDelegatedTaskPresenceEvent],
        dismissedTerminalIDs: Set<UUID>
    ) -> [YishuDelegatedTaskPresenceEvent] {
        tasks.filter { task in
            if YishuProductUtteranceRouter.looksLikeRelativeTimeReminder(task.title) {
                return false
            }
            switch task.status {
            case .pending, .running:
                return true
            case .blocked, .done, .failed, .cancelled, .interrupted:
                return !dismissedTerminalIDs.contains(task.id)
            }
        }
    }

    static func shouldAutoHide(
        displayTasks: [YishuDelegatedTaskPresenceEvent],
        pocketOpen: Bool,
        hovering: Bool,
        dragging: Bool
    ) -> Bool {
        guard !pocketOpen, !hovering, !dragging else { return false }
        guard !displayTasks.isEmpty else { return false }
        return displayTasks.allSatisfy { $0.status != .pending && $0.status != .running }
    }
}

private final class AgentPresencePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class AgentPresenceWindowManager: NSObject {
    let viewModel = AgentPresenceViewModel()

    var onCancelTask: ((YishuDelegatedTaskPresenceEvent) -> Void)?
    var onPresentResult: ((YishuDelegatedTaskPresenceEvent) -> Void)?
    var onRetryFromBeginning: ((YishuDelegatedTaskPresenceEvent) -> Void)?
    var onStartNewDirection: ((YishuDelegatedTaskPresenceEvent) -> Void)?

    private var anchorPoint: NSPoint?
    private var anchorPanel: NSPanel?
    private var pocketPanel: NSPanel?
    private var labelPanel: NSPanel?
    private var tasksCancellable: AnyCancellable?
    private var outsideClickMonitor: Any?
    private var labelHideWorkItem: DispatchWorkItem?
    private var settleHideWorkItem: DispatchWorkItem?
    private var dismissedTerminalIDs: Set<UUID> = []
    private var dragOrigin: NSPoint?
    private var chipHovering = false
    private var hidesChipForForeground = false

    override init() {
        super.init()
        tasksCancellable = viewModel.$tasks
            .receive(on: RunLoop.main)
            .sink { [weak self] tasks in
                self?.synchronizeWindows(with: tasks)
            }
    }

    deinit {
        if let outsideClickMonitor { NSEvent.removeMonitor(outsideClickMonitor) }
    }

    func apply(
        _ event: YishuDelegatedTaskPresenceEvent,
        expectedConversationId: UUID
    ) {
        viewModel.apply(event, expectedConversationId: expectedConversationId)
    }

    func replaceWithSnapshot(_ tasks: [YishuDelegatedTaskPresenceEvent]) {
        viewModel.replaceWithSnapshot(tasks)
    }

    func mergeSnapshot(_ tasks: [YishuDelegatedTaskPresenceEvent]) {
        viewModel.mergeSnapshot(tasks)
    }

    func markRuntimeInterrupted() {
        viewModel.markRuntimeInterrupted()
    }

    func markCancelRequesting(_ taskId: UUID) {
        viewModel.markCancelRequesting(taskId)
    }

    func markCancelAccepted(_ taskId: UUID) {
        viewModel.markCancelAccepted(taskId)
    }

    func markCancelFailed(_ taskId: UUID, message: String) {
        viewModel.markCancelFailed(taskId, message: message)
    }

    func setForegroundOccupied(_ occupied: Bool) {
        guard hidesChipForForeground != occupied else { return }
        hidesChipForForeground = occupied
        if occupied {
            hideLabel()
            anchorPanel?.ignoresMouseEvents = true
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.14
                anchorPanel?.animator().alphaValue = 0
            }
            return
        }
        guard !viewModel.tasks.filter({
            !YishuProductUtteranceRouter.looksLikeRelativeTimeReminder($0.title)
        }).isEmpty else { return }
        anchorPanel?.ignoresMouseEvents = false
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.18
            anchorPanel?.animator().alphaValue = 1
        }
    }

    func acknowledge(_ taskId: UUID) {
        viewModel.acknowledge(taskId)
    }

    func stop() {
        settleHideWorkItem?.cancel()
        settleHideWorkItem = nil
        dismissedTerminalIDs.removeAll()
        dragOrigin = nil
        chipHovering = false
        viewModel.reset()
        hidePocket()
        hideLabel()
        anchorPanel?.orderOut(nil)
        anchorPanel = nil
        anchorPoint = nil
    }

    private func synchronizeWindows(with tasks: [YishuDelegatedTaskPresenceEvent]) {
        pruneDismissed(against: tasks)
        let visible = AgentPresenceSettlePolicy.visibleTasks(
            tasks,
            dismissedTerminalIDs: dismissedTerminalIDs
        )
        guard !visible.isEmpty else {
            hideAnchor()
            return
        }
        if anchorPoint == nil {
            anchorPoint = resolvedAnchorPoint()
        }
        showAnchor(tasks: visible)
        if pocketPanel?.isVisible == true { showPocket() }
        scheduleSettleHide(for: visible)
    }

    private func showAnchor(tasks: [YishuDelegatedTaskPresenceEvent]) {
        guard let anchorPoint else { return }
        let size = AgentPresencePlacement.panelSize
        let panel = anchorPanel ?? makePanel(size: size)
        if dragOrigin == nil {
            panel.contentView = hostingView(
                AgentPresenceAnchorButton(
                    label: Self.presenceChipLabel(for: tasks),
                    tasks: tasks,
                    action: { [weak self] in self?.togglePocket() },
                    onHover: { [weak self] hovering in
                        self?.handleChipHover(hovering, tasks: tasks)
                    },
                    onDrag: { [weak self] translation in
                        self?.handleChipDrag(translation)
                    },
                    onDragEnd: { [weak self] in
                        self?.handleChipDragEnd()
                    }
                ),
                size: size
            )
        }
        panel.setFrameOrigin(NSPoint(x: anchorPoint.x - size.width / 2, y: anchorPoint.y - size.height / 2))
        if anchorPanel == nil {
            anchorPanel = panel
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.18
                panel.animator().alphaValue = hidesChipForForeground ? 0 : 1
            }
        }
        panel.ignoresMouseEvents = hidesChipForForeground
        if hidesChipForForeground {
            panel.alphaValue = 0
        }
    }

    private func togglePocket() {
        if pocketPanel?.isVisible == true {
            hidePocket()
        } else {
            showPocket()
        }
        let visible = AgentPresenceSettlePolicy.visibleTasks(
            viewModel.tasks,
            dismissedTerminalIDs: dismissedTerminalIDs
        )
        scheduleSettleHide(for: visible)
    }

    private func showPocket() {
        guard let anchorPoint else { return }
        let tasks = viewModel.tasks
        let width: CGFloat = 344
        let height = min(CGFloat(72 + tasks.count * 228), 520)
        let size = CGSize(width: width, height: max(height, 138))
        let panel = pocketPanel ?? makePanel(size: size)
        panel.contentView = hostingView(
            AgentPresencePocketView(
                viewModel: viewModel,
                onClose: { [weak self] in self?.hidePocket() },
                onCancel: { [weak self] task in self?.onCancelTask?(task) },
                onResult: { [weak self] task in
                    guard let self else { return }
                    self.onPresentResult?(task)
                    self.viewModel.acknowledge(task.id)
                },
                onRetryFromBeginning: { [weak self] task in
                    self?.hidePocket()
                    self?.onRetryFromBeginning?(task)
                },
                onStartNewDirection: { [weak self] task in
                    self?.hidePocket()
                    self?.onStartNewDirection?(task)
                }
            ),
            size: size
        )
        panel.setContentSize(size)
        panel.setFrameOrigin(pocketOrigin(size: size, anchor: anchorPoint))
        let wasVisible = panel.isVisible
        pocketPanel = panel
        if !wasVisible {
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            panel.makeKey()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.16
                panel.animator().alphaValue = 1
            }
        }
        installOutsideClickMonitor()
    }

    private func hidePocket() {
        pocketPanel?.orderOut(nil)
        removeOutsideClickMonitor()
        let visible = AgentPresenceSettlePolicy.visibleTasks(
            viewModel.tasks,
            dismissedTerminalIDs: dismissedTerminalIDs
        )
        scheduleSettleHide(for: visible)
    }

    private func hideAnchor() {
        hidePocket()
        hideLabel()
        settleHideWorkItem?.cancel()
        settleHideWorkItem = nil
        guard anchorPoint != nil || anchorPanel != nil else { return }
        let anchorPanel = self.anchorPanel
        self.anchorPanel = nil
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.22
            anchorPanel?.animator().alphaValue = 0
        }, completionHandler: {
            anchorPanel?.orderOut(nil)
        })
        self.anchorPoint = nil
    }

    private func handleChipHover(
        _ hovering: Bool,
        tasks: [YishuDelegatedTaskPresenceEvent]
    ) {
        chipHovering = hovering
        scheduleSettleHide(for: tasks)
        guard let anchorPoint else { return }
        let caption = tasks.first { $0.status == .pending || $0.status == .running }?.presenceCaption
            ?? tasks.first { $0.status == .done || $0.status == .blocked }?.presenceCaption
            ?? tasks.first?.presenceCaption
        guard let caption else {
            hideLabel()
            return
        }
        if hovering {
            showLabel(text: caption, near: anchorPoint, autoHideAfter: nil)
        } else {
            showLabel(text: caption, near: anchorPoint, autoHideAfter: 0.18)
        }
    }

    private func showLabel(
        text: String,
        near center: NSPoint,
        autoHideAfter delay: TimeInterval?
    ) {
        labelHideWorkItem?.cancel()
        let size = CGSize(width: 260, height: 56)
        let panel = labelPanel ?? makePanel(size: size, ignoresMouseEvents: true)
        panel.contentView = hostingView(AgentPresenceLabel(text: text), size: size)
        let screen = NSScreen.screens.first(where: { $0.frame.contains(center) }) ?? NSScreen.main
        let frame = screen?.visibleFrame ?? .zero
        panel.setFrameOrigin(AgentPresencePlacement.labelOrigin(near: center, size: size, visibleFrame: frame))
        labelPanel = panel
        panel.alphaValue = 1
        panel.orderFrontRegardless()
        if let delay {
            let work = DispatchWorkItem { [weak self] in self?.hideLabel() }
            labelHideWorkItem = work
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
        }
    }

    private func hideLabel() {
        labelHideWorkItem?.cancel()
        labelHideWorkItem = nil
        labelPanel?.orderOut(nil)
    }

    private func resolvedAnchorPoint() -> NSPoint {
        let screens = NSScreen.screens.map { (frame: $0.frame, visible: $0.visibleFrame) }
        return AgentPresencePlacement.resolvedAnchor(
            saved: AgentPresencePlacement.loadSavedAnchor(),
            mouse: NSEvent.mouseLocation,
            screens: screens
        )
    }

    private func handleChipDrag(_ translation: CGSize) {
        if dragOrigin == nil {
            dragOrigin = anchorPoint ?? resolvedAnchorPoint()
            hideLabel()
            settleHideWorkItem?.cancel()
        }
        guard let dragOrigin else { return }
        let raw = NSPoint(
            x: dragOrigin.x + translation.width,
            y: dragOrigin.y - translation.height
        )
        let screen = NSScreen.screens.first(where: { $0.frame.contains(raw) })
            ?? NSScreen.screens.first(where: { $0.frame.contains(dragOrigin) })
            ?? NSScreen.main
        let frame = screen?.visibleFrame ?? .zero
        let next = AgentPresencePlacement.clamp(raw, in: frame)
        anchorPoint = next
        let size = AgentPresencePlacement.panelSize
        anchorPanel?.setFrameOrigin(NSPoint(x: next.x - size.width / 2, y: next.y - size.height / 2))
        if pocketPanel?.isVisible == true {
            pocketPanel?.setFrameOrigin(pocketOrigin(size: pocketPanel?.frame.size ?? .zero, anchor: next))
        }
    }

    private func handleChipDragEnd() {
        if let anchorPoint {
            AgentPresencePlacement.saveAnchor(anchorPoint)
        }
        dragOrigin = nil
        let visible = AgentPresenceSettlePolicy.visibleTasks(
            viewModel.tasks,
            dismissedTerminalIDs: dismissedTerminalIDs
        )
        scheduleSettleHide(for: visible)
    }

    private func scheduleSettleHide(for tasks: [YishuDelegatedTaskPresenceEvent]) {
        settleHideWorkItem?.cancel()
        settleHideWorkItem = nil
        let shouldHide = AgentPresenceSettlePolicy.shouldAutoHide(
            displayTasks: tasks,
            pocketOpen: pocketPanel?.isVisible == true,
            hovering: chipHovering,
            dragging: dragOrigin != nil
        )
        guard shouldHide else { return }
        let work = DispatchWorkItem { [weak self] in
            self?.settleTerminalChip()
        }
        settleHideWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + AgentPresenceSettlePolicy.hideDelay, execute: work)
    }

    private func settleTerminalChip() {
        let visible = AgentPresenceSettlePolicy.visibleTasks(
            viewModel.tasks,
            dismissedTerminalIDs: dismissedTerminalIDs
        )
        guard AgentPresenceSettlePolicy.shouldAutoHide(
            displayTasks: visible,
            pocketOpen: pocketPanel?.isVisible == true,
            hovering: chipHovering,
            dragging: dragOrigin != nil
        ) else { return }
        for task in visible {
            dismissedTerminalIDs.insert(task.id)
        }
        hidePocket()
        hideLabel()
        hideAnchor()
    }

    private func pruneDismissed(against tasks: [YishuDelegatedTaskPresenceEvent]) {
        let ids = Set(tasks.map(\.id))
        dismissedTerminalIDs = dismissedTerminalIDs.intersection(ids)
    }

    static func presenceChipLabel(for tasks: [YishuDelegatedTaskPresenceEvent]) -> String {
        let activeCount = tasks.filter { $0.status == .pending || $0.status == .running }.count
        if activeCount == 1 { return "还在做" }
        if activeCount > 1 { return "还在做几件事" }
        let failedCount = tasks.filter { $0.status == .failed || $0.status == .interrupted }.count
        if failedCount > 0 { return "没做成" }
        let readyTasks = tasks.filter { $0.status == .done || $0.status == .blocked }
        if readyTasks.count == 1 {
            return readyTasks[0].chipFindingLine ?? "做好了"
        }
        if readyTasks.count > 1 { return "有几件做好了" }
        return "已经停下"
    }

    private func pocketOrigin(size: CGSize, anchor: NSPoint) -> NSPoint {
        let screen = NSScreen.screens.first(where: { $0.frame.contains(anchor) }) ?? NSScreen.main
        let frame = screen?.visibleFrame ?? .zero
        let preferredX = anchor.x - size.width + 22
        let preferredY = anchor.y + 34
        return NSPoint(
            x: min(max(preferredX, frame.minX + 10), frame.maxX - size.width - 10),
            y: min(max(preferredY, frame.minY + 10), frame.maxY - size.height - 10)
        )
    }

    private func makePanel(size: CGSize, ignoresMouseEvents: Bool = false) -> NSPanel {
        let panel = AgentPresencePanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.screenSaver.rawValue + 1)
        panel.isFloatingPanel = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isExcludedFromWindowsMenu = true
        panel.ignoresMouseEvents = ignoresMouseEvents
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        return panel
    }

    private func hostingView<Content: View>(_ root: Content, size: CGSize) -> NSHostingView<Content> {
        let hosting = NSHostingView(rootView: root)
        hosting.frame = NSRect(origin: .zero, size: size)
        hosting.wantsLayer = true
        hosting.layer?.backgroundColor = .clear
        hosting.clipsToBounds = false
        hosting.layer?.masksToBounds = false
        return hosting
    }

    private func installOutsideClickMonitor() {
        removeOutsideClickMonitor()
        outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) {
            [weak self] _ in
            guard let self, let pocketPanel, pocketPanel.isVisible else { return }
            let point = NSEvent.mouseLocation
            if pocketPanel.frame.contains(point) || self.anchorPanel?.frame.contains(point) == true {
                return
            }
            self.hidePocket()
        }
    }

    private func removeOutsideClickMonitor() {
        if let outsideClickMonitor {
            NSEvent.removeMonitor(outsideClickMonitor)
            self.outsideClickMonitor = nil
        }
    }
}

private struct AgentPresenceAnchorButton: View {
    let label: String
    let tasks: [YishuDelegatedTaskPresenceEvent]
    let action: () -> Void
    let onHover: (Bool) -> Void
    let onDrag: (CGSize) -> Void
    let onDragEnd: () -> Void
    @State private var hovered = false
    @State private var dragging = false

    var body: some View {
        Button(action: {
            guard !dragging else { return }
            action()
        }) {
            HStack(spacing: 7) {
                HStack(spacing: -8) {
                    ForEach(Array(chipTasks.prefix(3))) { task in
                        YishuBlobatarView(
                            name: task.blobatarName,
                            expression: task.blobatarExpression,
                            size: 20,
                            animates: task.blobatarAnimates
                        )
                    }
                }
                Text(label)
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(DS.Colors.overlayResponseInk.opacity(0.86))
                    .lineLimit(1)
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 7)
            .background {
                ZStack {
                    Capsule().fill(.ultraThinMaterial)
                    Capsule().fill(
                        LinearGradient(
                            stops: [
                                .init(color: DS.Colors.overlayResponsePearl.opacity(0.94), location: 0),
                                .init(color: DS.Colors.overlayResponsePearl.opacity(0.82), location: 0.62),
                                .init(color: DS.Colors.overlaySpectralAmber.opacity(0.08), location: 1)
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    Capsule()
                        .strokeBorder(
                            LinearGradient(
                                stops: [
                                    .init(color: Color.white.opacity(0.96), location: 0),
                                    .init(color: DS.Colors.overlayCursorBlue.opacity(0.48), location: 0.48),
                                    .init(color: DS.Colors.overlaySpectralMagenta.opacity(0.32), location: 0.76),
                                    .init(color: DS.Colors.overlaySpectralAmber.opacity(0.36), location: 1)
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            ),
                            lineWidth: 0.85
                        )
                }
            }
            .shadow(color: DS.Colors.overlayCursorBlue.opacity(0.07), radius: 6, y: 3)
            .shadow(color: Color.black.opacity(0.11), radius: 8, y: 4)
        }
        .buttonStyle(.plain)
        .padding(4)
        .simultaneousGesture(
            DragGesture(minimumDistance: 5)
                .onChanged { value in
                    dragging = true
                    onDrag(value.translation)
                }
                .onEnded { _ in
                    onDragEnd()
                    DispatchQueue.main.async { dragging = false }
                }
        )
        .onHover { hovering in
            hovered = hovering
            onHover(hovering)
        }
        .scaleEffect(hovered && !dragging ? 1.02 : 1)
        .animation(.easeOut(duration: 0.14), value: hovered)
        .help("任务。可拖开。点开看详情。")
        .accessibilityLabel("任务，\(label)，可拖动")
    }

    private var chipTasks: [YishuDelegatedTaskPresenceEvent] {
        let live = tasks.filter { $0.status == .pending || $0.status == .running }
        let rest = tasks.filter { $0.status != .pending && $0.status != .running }
        return live + rest
    }
}

private struct AgentPresenceLabel: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .medium, design: .rounded))
            .foregroundStyle(DS.Colors.overlayResponseInk.opacity(0.82))
            .lineLimit(1)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.72), lineWidth: 0.7))
            .shadow(color: Color.black.opacity(0.10), radius: 6, y: 3)
    }
}

private struct AgentPresencePocketView: View {
    @ObservedObject var viewModel: AgentPresenceViewModel
    let onClose: () -> Void
    let onCancel: (YishuDelegatedTaskPresenceEvent) -> Void
    let onResult: (YishuDelegatedTaskPresenceEvent) -> Void
    let onRetryFromBeginning: (YishuDelegatedTaskPresenceEvent) -> Void
    let onStartNewDirection: (YishuDelegatedTaskPresenceEvent) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("任务与提醒")
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                Text("\(viewModel.tasks.count)")
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .foregroundStyle(DS.Colors.overlayCursorBlue)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(DS.Colors.overlayCursorBlue.opacity(0.10), in: Capsule())
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .frame(width: 26, height: 26)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(DS.Colors.overlayResponseInk.opacity(0.56))
            }
            .padding(.horizontal, 15)
            .padding(.vertical, 12)

            Divider().opacity(0.42)

            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(viewModel.tasks) { task in
                        TaskStatusCard(
                            task: task,
                            cancelState: viewModel.cancelRequestState(for: task.id),
                            onCancel: onCancel,
                            onResult: onResult,
                            onRetryFromBeginning: onRetryFromBeginning,
                            onStartNewDirection: onStartNewDirection
                        )
                    }
                }
                .padding(10)
            }
            .scrollIndicators(.hidden)
        }
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: 20, style: .continuous).fill(.ultraThinMaterial)
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(DS.Colors.overlayResponsePearl.opacity(0.90))
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(
                        LinearGradient(
                            colors: [Color.white, DS.Colors.overlayCursorBlue.opacity(0.32)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: 0.8
                    )
            }
            .shadow(color: Color.black.opacity(0.16), radius: 22, y: 9)
        }
        .padding(10)
    }
}

struct TaskStatusCard: View {
    let task: YishuDelegatedTaskPresenceEvent
    let cancelState: YishuTaskCancelRequestState
    let onCancel: (YishuDelegatedTaskPresenceEvent) -> Void
    let onResult: (YishuDelegatedTaskPresenceEvent) -> Void
    let onRetryFromBeginning: (YishuDelegatedTaskPresenceEvent) -> Void
    let onStartNewDirection: (YishuDelegatedTaskPresenceEvent) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top, spacing: 9) {
                YishuBlobatarView(
                    name: task.blobatarName,
                    expression: task.blobatarExpression,
                    size: 36,
                    animates: task.blobatarAnimates
                )
                .padding(.top, 1)
                VStack(alignment: .leading, spacing: 3) {
                    Text(task.title)
                        .font(.system(size: 12.5, weight: .semibold, design: .rounded))
                        .foregroundStyle(DS.Colors.overlayResponseInk)
                        .lineLimit(2)
                    Text(task.workerLabel)
                        .font(.system(size: 10.5, weight: .medium, design: .rounded))
                        .foregroundStyle(DS.Colors.overlayResponseInk.opacity(0.52))
                }
                Spacer(minLength: 4)
            }

            HStack(spacing: 7) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 6, height: 6)
                    .shadow(color: statusColor.opacity(0.48), radius: 4)
                Text(task.statusLabel)
                    .font(.system(size: 10.5, weight: .medium, design: .rounded))
                    .foregroundStyle(DS.Colors.overlayResponseInk.opacity(0.62))
                Spacer()
                if task.status == .pending || task.status == .running {
                    Button(action: { onCancel(task) }) {
                        Text(cancelActionLabel)
                            .font(.system(size: 10.5, weight: .semibold, design: .rounded))
                            .padding(.horizontal, 9)
                            .padding(.vertical, 5)
                            .background(Color.red.opacity(0.08), in: Capsule())
                            .overlay(Capsule().strokeBorder(Color.red.opacity(0.18), lineWidth: 0.7))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.red.opacity(0.78))
                    .disabled(cancelState == .requesting || cancelState == .accepted)
                } else if task.taskKind == .contextReminder,
                          task.status == .done || task.status == .blocked {
                    Button(action: { onResult(task) }) {
                        Text("查看提醒")
                            .font(.system(size: 10.5, weight: .semibold, design: .rounded))
                            .padding(.horizontal, 9)
                            .padding(.vertical, 5)
                            .background(DS.Colors.overlayCursorBlue.opacity(0.10), in: Capsule())
                            .overlay(
                                Capsule().strokeBorder(
                                    DS.Colors.overlayCursorBlue.opacity(0.24),
                                    lineWidth: 0.7
                                )
                            )
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(DS.Colors.overlayCursorBlue)
                }
            }

            if let finding = task.pocketFindingText {
                Text(finding)
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(DS.Colors.overlayResponseInk.opacity(0.78))
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let requestMessage = cancelRequestMessage {
                Text(requestMessage)
                    .font(.system(size: 10.5, weight: .medium, design: .rounded))
                    .foregroundStyle(cancelRequestColor)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("task-cancel-request-state")
            }

            if let message = task.interruptionMessage {
                Text(message)
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(DS.Colors.overlayResponseInk.opacity(0.72))
                    .fixedSize(horizontal: false, vertical: true)

                if task.taskKind == .delegated {
                    HStack(spacing: 8) {
                        actionButton("从头重试", tint: DS.Colors.overlayCursorBlue) {
                            onRetryFromBeginning(task)
                        }
                        actionButton("开始新方向", tint: DS.Colors.overlaySpectralViolet) {
                            onStartNewDirection(task)
                        }
                    }
                }
            }

            if !task.sequence.isEmpty {
                SystemSequence(steps: task.sequence)
            }
        }
        .padding(11)
        .background(Color.white.opacity(0.58), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .strokeBorder(DS.Colors.overlayCursorBlue.opacity(0.10), lineWidth: 0.6)
        )
    }

    private var cancelActionLabel: String {
        if task.taskKind == .contextReminder {
            switch cancelState {
            case .requesting: return "正在取消"
            case .accepted: return "已请求取消"
            case .idle, .failed: return "取消提醒"
            }
        }
        switch cancelState {
        case .requesting: return "正在停止"
        case .accepted: return "已请求停止"
        case .idle, .failed: return "停止"
        }
    }

    private var cancelRequestMessage: String? {
        if task.taskKind == .contextReminder {
            switch cancelState {
            case .idle: return nil
            case .requesting: return "正在确认取消提醒…"
            case .accepted: return "已经收到取消请求。"
            case .failed(let message): return "取消提醒失败：\(message)"
            }
        }
        switch cancelState {
        case .idle: return nil
        case .requesting: return "正在确认停止…"
        case .accepted: return "已经收到停止请求。"
        case .failed(let message): return "停止失败：\(message)"
        }
    }

    private var cancelRequestColor: Color {
        if case .failed = cancelState { return .red.opacity(0.82) }
        return DS.Colors.overlayResponseInk.opacity(0.58)
    }

    private var statusColor: Color {
        switch task.status {
        case .pending, .running, .done: return DS.Colors.overlayCursorBlue
        case .blocked: return DS.Colors.overlaySpectralAmber
        case .failed, .interrupted: return .red.opacity(0.78)
        case .cancelled: return .gray
        }
    }

    private func actionButton(
        _ label: String,
        tint: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 10.5, weight: .semibold, design: .rounded))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .background(tint.opacity(0.09), in: Capsule())
                .overlay(Capsule().strokeBorder(tint.opacity(0.22), lineWidth: 0.7))
        }
        .buttonStyle(.plain)
        .foregroundStyle(tint)
    }
}

struct SystemSequence: View {
    let steps: [YishuSystemSequenceStep]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("系统序列")
                .font(.system(size: 10, weight: .semibold, design: .rounded))
                .foregroundStyle(DS.Colors.overlayResponseInk.opacity(0.48))

            ForEach(steps) { step in
                HStack(alignment: .top, spacing: 7) {
                    Image(systemName: icon(for: step.status))
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(color(for: step.status))
                        .frame(width: 12, height: 12)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(step.label)
                            .font(.system(size: 10.5, weight: .medium, design: .rounded))
                            .foregroundStyle(DS.Colors.overlayResponseInk.opacity(0.74))
                        if let detail = step.detail {
                            Text(detail)
                                .font(.system(size: 9.5, design: .rounded))
                                .foregroundStyle(DS.Colors.overlayResponseInk.opacity(0.48))
                                .lineLimit(2)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .accessibilityIdentifier("system-sequence-\(step.sourceEventId.uuidString)")
            }
        }
        .padding(.top, 2)
    }

    private func icon(for status: YishuSystemSequenceStepStatus) -> String {
        switch status {
        case .pending: return "circle"
        case .running: return "arrow.triangle.2.circlepath"
        case .passed: return "checkmark.circle.fill"
        case .failed: return "xmark.circle.fill"
        }
    }

    private func color(for status: YishuSystemSequenceStepStatus) -> Color {
        switch status {
        case .pending: return .gray
        case .running: return DS.Colors.overlayCursorBlue
        case .passed: return .green.opacity(0.78)
        case .failed: return .red.opacity(0.78)
        }
    }
}
