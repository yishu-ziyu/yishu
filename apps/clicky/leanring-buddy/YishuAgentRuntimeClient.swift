import Foundation
import YishuContext

enum YishuSessionScopeKind: String, Codable, CaseIterable {
    case personal
    case project
    case privateSession = "private"
}

struct YishuSessionScope: Codable, Equatable {
    let kind: YishuSessionScopeKind
    let projectId: UUID?
    let projectLabel: String?

    static let personal = YishuSessionScope(
        kind: .personal,
        projectId: nil,
        projectLabel: nil
    )

    static let privateSession = YishuSessionScope(
        kind: .privateSession,
        projectId: nil,
        projectLabel: nil
    )

    static func project(id: UUID, label: String) -> YishuSessionScope? {
        let normalized = label
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, normalized.count <= 80 else { return nil }
        return YishuSessionScope(
            kind: .project,
            projectId: id,
            projectLabel: normalized
        )
    }
}

enum YishuRuntimeLifecycleEvent {
    case ready(mode: String)
    case stopped(exitCode: Int32)
}

/// Controlled durable-memory use notice for one ordinary turn (not a full claim dump).
struct YishuMemoryUsedItem: Equatable, Identifiable {
    let id: UUID
    let summary: String
    let source: String
    let capturedAt: String
    let scope: String
}

enum YishuRuntimeTurnEvent {
    case started(route: YishuResolvedModelRoute?, generation: Int)
    case responseDelta(text: String, generation: Int)
    case toolStarted(name: String, generation: Int)
    case toolCompleted(name: String, isError: Bool, generation: Int)
    case computerActionRequested(YishuComputerActionRequest, generation: Int)
    case memoryUsed([YishuMemoryUsedItem], generation: Int)
    case completed(text: String, verified: Bool, generation: Int)
    case cancelled(generation: Int)

    var generation: Int {
        switch self {
        case let .started(_, generation),
             let .responseDelta(_, generation),
             let .toolStarted(_, generation),
             let .toolCompleted(_, _, generation),
             let .computerActionRequested(_, generation),
             let .memoryUsed(_, generation),
             let .completed(_, _, generation),
             let .cancelled(generation):
            return generation
        }
    }
}

enum YishuTurnInterruptDecision: Equatable {
    case accepted(interruptedGeneration: Int, nextGeneration: Int)
    case rejected(generation: Int, code: String)
}

/// Second, client-side fence around Runtime-owned assistant generations.
/// Runtime remains authoritative: Swift never invents `nextGeneration`; it
/// blocks the interrupted generation immediately and advances only from the
/// typed `turn.interrupt.accepted` receipt.
struct YishuTurnProjectionReducer: Equatable {
    let requestId: UUID
    private(set) var currentGeneration = 1
    private(set) var pendingInterruptedGeneration: Int?
    private(set) var acceptedNextGeneration: Int?
    private(set) var submittedSteerGeneration: Int?
    private(set) var hasAdvancedGeneration = false

    var interruptionPending: Bool {
        pendingInterruptedGeneration != nil
    }

    mutating func beginInterruption(requestId: UUID, expectedGeneration: Int) -> Bool {
        guard requestId == self.requestId,
              expectedGeneration == currentGeneration,
              pendingInterruptedGeneration == nil else { return false }
        pendingInterruptedGeneration = expectedGeneration
        acceptedNextGeneration = nil
        // A newer interruption attempt supersedes interpretation of any late
        // rejection from the prior generation's already-submitted steer.
        submittedSteerGeneration = nil
        return true
    }

    mutating func acceptInterruption(
        requestId: UUID,
        interruptedGeneration: Int,
        nextGeneration: Int
    ) -> Bool {
        guard requestId == self.requestId,
              pendingInterruptedGeneration == interruptedGeneration,
              nextGeneration > interruptedGeneration else { return false }
        currentGeneration = nextGeneration
        acceptedNextGeneration = nextGeneration
        submittedSteerGeneration = nil
        pendingInterruptedGeneration = nil
        hasAdvancedGeneration = true
        return true
    }

    func accepts(requestId: UUID, generation: Int?) -> Bool {
        guard requestId == self.requestId else { return false }
        if let generation {
            return !interruptionPending && generation == currentGeneration
        }
        // Protocol-v1 compatibility is safe only before an interruption. Once
        // a floor exists, a generation-less event cannot prove ownership.
        return !hasAdvancedGeneration && !interruptionPending && currentGeneration == 1
    }

    mutating func consumeSteer(requestId: UUID, nextGeneration: Int) -> Bool {
        guard requestId == self.requestId,
              acceptedNextGeneration == nextGeneration else { return false }
        acceptedNextGeneration = nil
        submittedSteerGeneration = nextGeneration
        return true
    }

    func hasSubmittedSteer(requestId: UUID, generation: Int) -> Bool {
        requestId == self.requestId && submittedSteerGeneration == generation
    }

    mutating func markGenerationLive(requestId: UUID, generation: Int) -> Bool {
        guard requestId == self.requestId,
              submittedSteerGeneration == generation else { return false }
        submittedSteerGeneration = nil
        return true
    }
}

struct YishuRuntimeTurn {
    let requestId: UUID
    /// Stable user-session scope shared by all turns from this Yishu client.
    let conversationId: UUID
    let events: AsyncThrowingStream<YishuRuntimeTurnEvent, Error>
}

struct YishuDelegatedTaskCancelAcceptance: Equatable {
    let requestId: UUID
    let taskId: UUID
    let mainConversationId: UUID
}

struct YishuAuthRequest {
    let requestId: UUID
    let events: AsyncThrowingStream<YishuAuthEvent, Error>
}

enum YishuAgentRuntimeClientError: LocalizedError {
    case runtimeEntryMissing
    case nodeExecutableMissing
    case launchFailed
    case credentialConfigurationUnavailable
    case runtimeNotRunning
    case unsupportedModel
    case turnFailed
    case turnTimedOut
    case turnInterruptUnavailable
    case turnInterruptTimedOut
    case turnSteerRejected(message: String, code: String)
    case authFailed
    case invalidAuthEvent
    case authRequestUnavailable
    case authTimedOut
    case historyFailed(String)
    case historyTimedOut
    case invalidHistoryEvent
    case memoryFailed(String)
    case memoryTimedOut
    case invalidMemoryEvent
    case speechExcerptFailed(String)
    case speechExcerptTimedOut
    case invalidSpeechExcerptEvent
    case taskListFailed(String)
    case taskListTimedOut
    case invalidTaskListEvent
    case taskCancelFailed(String)
    case taskCancelTimedOut
    case invalidTaskCancelEvent
    case workspaceFailed(String)
    case workspaceTimedOut
    case invalidWorkspaceEvent

    var errorDescription: String? {
        switch self {
        case .runtimeEntryMissing: return "找不到奕枢后台。"
        case .nodeExecutableMissing: return "找不到可用的 Node.js。"
        case .launchFailed: return "奕枢后台没起来。"
        case .credentialConfigurationUnavailable: return "本机模型凭据配置不可用。请完成迁移后重试。"
        case .runtimeNotRunning: return YishuPanelRuntimeCopy.headerStopped + "。"
        case .unsupportedModel: return "这个模型还接不上。"
        case .turnFailed: return "这一轮没做成。"
        case .turnTimedOut: return "等太久了，这一轮没回。"
        case .turnInterruptUnavailable: return "当前回答已经无法安全打断。"
        case .turnInterruptTimedOut: return "等待打断确认超时。"
        case .turnSteerRejected: return "这次续话需要用新鲜上下文重新开始。"
        case .authFailed: return "Provider 登录流程失败。"
        case .invalidAuthEvent: return "Provider 账号协议无效。"
        case .authRequestUnavailable: return "Provider 登录请求已结束。"
        case .authTimedOut: return "Provider 登录请求超时。"
        case let .historyFailed(message): return message
        case .historyTimedOut: return "读取历史超时。"
        case .invalidHistoryEvent: return "历史协议无效。"
        case let .memoryFailed(message): return message
        case .memoryTimedOut: return "等太久了，没能完成。"
        case .invalidMemoryEvent: return "记下这条时出了点问题。"
        case let .speechExcerptFailed(message): return message
        case .speechExcerptTimedOut: return "抽出口播超时。"
        case .invalidSpeechExcerptEvent: return "口播协议无效。"
        case let .taskListFailed(message): return message
        case .taskListTimedOut: return "读取后台任务超时。"
        case .invalidTaskListEvent: return "后台任务快照协议无效。"
        case let .taskCancelFailed(message): return message
        case .taskCancelTimedOut: return "停止后台任务超时。"
        case .invalidTaskCancelEvent: return "停止后台任务的运行时回执无效。"
        case let .workspaceFailed(message): return message
        case .workspaceTimedOut: return "文件夹工作区操作超时。"
        case .invalidWorkspaceEvent: return "文件夹工作区协议无效。"
        }
    }
}

/// Compact personal-history row for the "我的" list.
struct YishuHistoryListItem: Identifiable, Equatable {
    let id: UUID
    let createdAt: Date
    let updatedAt: Date
    let status: String
    let title: String
    let summary: String
}

/// Compact personal-memory row for the "我的" list (never project/private).
struct YishuMemoryListItem: Identifiable, Equatable {
    let id: UUID
    let summary: String
    let capturedAt: Date
    let source: String
    let scope: String

    var sourceLabel: String {
        switch source {
        case "conversation": return "对话"
        case "observation": return "观察"
        case "user_correction": return "你的纠正"
        case "skill_verify": return "技能验证"
        case "system": return "系统"
        default: return source.isEmpty ? "未知" : source
        }
    }
}

struct YishuMemoryForgetResult: Equatable {
    let memoryId: UUID
    let alreadyGone: Bool
}

struct YishuMemoryRememberResult: Equatable {
    let item: YishuMemoryListItem
    let confirmed: Bool
}

struct YishuHistoryVisibleTurn: Equatable {
    let userInput: String
    let assistantOutput: String
}

struct YishuHistoryOpenResult: Equatable {
    let conversationId: UUID
    let turns: [YishuHistoryVisibleTurn]
}

struct YishuHistoryDeleteResult: Equatable {
    let conversationId: UUID
    let status: String
    let alreadyArchived: Bool
}

struct YishuHistoryRestoreResult: Equatable {
    let conversationId: UUID
    let status: String
    let alreadyActive: Bool
}

@MainActor
final class YishuAgentRuntimeClient {
    /// The app creates one runtime client alongside CompanionManager.  The
    /// panel can borrow that client without launching a second Pi process.
    /// This registry carries no credentials and is intentionally not persisted.
    static private(set) var active: YishuAgentRuntimeClient?

    /// The conversation scope is owned by the Yishu session, not by the Pi
    /// sidecar. Persisting it here means a sidecar restart does not fork the
    /// user's conversation identity; callers can explicitly rotate it when a
    /// genuinely new conversation begins.
    private static let conversationIDDefaultsKey = "yishu.runtime.conversationId.v1"
    private static let sessionScopeKindDefaultsKey = "yishu.runtime.sessionScope.kind.v1"
    private static let projectIDDefaultsKey = "yishu.runtime.sessionScope.projectId.v1"
    private static let projectLabelDefaultsKey = "yishu.runtime.sessionScope.projectLabel.v1"
    private(set) var currentConversationId: UUID
    private(set) var currentSessionScope: YishuSessionScope
    private(set) var lastProjectScope: YishuSessionScope?

    var onLifecycleEvent: ((YishuRuntimeLifecycleEvent) -> Void)?
    var onDelegatedTaskPresenceEvent: ((YishuDelegatedTaskPresenceEvent) -> Void)?

    private var process: Process?
    private var inputHandle: FileHandle?
    private var outputHandle: FileHandle?
    private var errorHandle: FileHandle?
    private var outputBuffer = Data()
    private var turnContinuations: [UUID: AsyncThrowingStream<YishuRuntimeTurnEvent, Error>.Continuation] = [:]
    /// Every command belonging to one active turn reuses its start trace id.
    /// This prevents a cancel/late receipt from becoming a separate trace.
    private var activeTurnTraceIds: [UUID: UUID] = [:]
    private var turnProjectionReducers: [UUID: YishuTurnProjectionReducer] = [:]
    private var seenTurnEventIds: [UUID: Set<UUID>] = [:]
    private var turnWatchdogTasks: [UUID: Task<Void, Never>] = [:]
    /// Per-turn dead-air fence: any accepted runtime event proves progress and
    /// re-arms this. A silently broken provider stream (no terminal event, no
    /// error) must surface as a failed turn instead of a frozen overlay for
    /// the full 3-minute foreground timeout.
    private var turnStallWatchdogTasks: [UUID: Task<Void, Never>] = [:]
    /// Browser research (goto + observe + cite) and recapture after a click
    /// both overrun a 60s hang fence. Keep a bound; do not wait forever.
    private let foregroundTurnTimeoutNanoseconds: UInt64 = 180_000_000_000
    /// Generous enough to cover slow tool execution: the runtime emits
    /// tool/computer events while working, and each one re-arms the fence.
    private let turnStallTimeoutNanoseconds: UInt64 = 30_000_000_000

    private struct PendingTurnInterrupt {
        let traceId: UUID
        let expectedGeneration: Int
        let continuation: CheckedContinuation<YishuTurnInterruptDecision, Error>
        var timeoutTask: Task<Void, Never>?
    }

    private var turnInterruptContinuations: [UUID: PendingTurnInterrupt] = [:]
    private var submittedSteerMessages: [UUID: String] = [:]
    private enum AuthRequestKind {
        case status(expectedCount: Int, provider: YishuAuthProvider?)
        case login(provider: YishuAuthProvider)
        case logout(provider: YishuAuthProvider)

        var provider: YishuAuthProvider? {
            switch self {
            case let .status(_, provider):
                return provider
            case let .login(provider), let .logout(provider):
                return provider
            }
        }

        var timeoutNanoseconds: UInt64 {
            switch self {
            case .status:
                return 10_000_000_000
            case .login:
                // OAuth may require a browser/device-code round trip, but it
                // must never leave a continuation alive indefinitely.
                return 300_000_000_000
            case .logout:
                return 15_000_000_000
            }
        }

        var sendsCancelOnTermination: Bool {
            if case .login = self { return true }
            return false
        }
    }

    private struct PendingAuthRequest {
        let kind: AuthRequestKind
        let continuation: AsyncThrowingStream<YishuAuthEvent, Error>.Continuation
        var statusCount = 0
        var statusProviders: Set<YishuAuthProvider> = []
        var seenEventIDs: Set<UUID> = []
        var timeoutTask: Task<Void, Never>?
    }

    private var authContinuations: [UUID: PendingAuthRequest] = [:]
    /// Request IDs are tombstoned after finish/cancel so late runtime events
    /// can never re-enter a newly created UI request.
    private var authTombstones: Set<UUID> = []
    private var authCancelSent: Set<UUID> = []
    private var stopping = false

    enum PendingHistoryKind {
        case list
        case open
        case delete
        case restore
        case memoryList
        case memoryForget
        case memoryRemember
        case speechExcerpt
        case workspaceGrant
        case workspaceRevoke
        case workspaceList
        case workspaceApprove
    }

    struct PendingHistoryRequest {
        let kind: PendingHistoryKind
        let continuation: CheckedContinuation<Any, Error>
        var timeoutTask: Task<Void, Never>?
    }

    var historyContinuations: [UUID: PendingHistoryRequest] = [:]

    private struct PendingTaskListRequest {
        let traceId: UUID
        let mainConversationId: UUID
        let continuation: CheckedContinuation<[YishuDelegatedTaskPresenceEvent], Error>
        var timeoutTask: Task<Void, Never>?
    }

    private struct PendingTaskCancelRequest {
        let traceId: UUID
        let taskId: UUID
        let mainConversationId: UUID
        let continuation: CheckedContinuation<YishuDelegatedTaskCancelAcceptance, Error>
        var timeoutTask: Task<Void, Never>?
    }

    private var taskListContinuations: [UUID: PendingTaskListRequest] = [:]
    private var taskCancelContinuations: [UUID: PendingTaskCancelRequest] = [:]

    var isRunning: Bool { process?.isRunning == true }

    /// True while any turn is still streaming events.
    var hasActiveTurn: Bool { !turnContinuations.isEmpty }

    init() {
        if let projectIDString = UserDefaults.standard.string(forKey: Self.projectIDDefaultsKey),
           let projectID = UUID(uuidString: projectIDString),
           let projectLabel = UserDefaults.standard.string(forKey: Self.projectLabelDefaultsKey),
           let projectScope = YishuSessionScope.project(id: projectID, label: projectLabel) {
            lastProjectScope = projectScope
        } else {
            lastProjectScope = nil
        }
        // Speaking never starts from a leftover filing choice.
        currentSessionScope = .personal
        if let stored = UserDefaults.standard.string(forKey: Self.conversationIDDefaultsKey),
           let storedID = UUID(uuidString: stored) {
            currentConversationId = storedID
        } else {
            let newID = UUID()
            currentConversationId = newID
            UserDefaults.standard.set(newID.uuidString, forKey: Self.conversationIDDefaultsKey)
        }
        Self.active = self
    }

    /// Start an explicitly new user conversation at the selected scope.
    @discardableResult
    func beginNewConversation(scope: YishuSessionScope? = nil) -> Bool {
        // A turn owns the conversation scope in its start payload. Rotating
        // while one is active would split its late events across identities.
        guard turnContinuations.isEmpty else { return false }
        let nextScope = scope ?? currentSessionScope
        let newID = UUID()
        currentConversationId = newID
        currentSessionScope = nextScope
        if nextScope.kind != .privateSession {
            UserDefaults.standard.set(newID.uuidString, forKey: Self.conversationIDDefaultsKey)
            UserDefaults.standard.set(nextScope.kind.rawValue, forKey: Self.sessionScopeKindDefaultsKey)
            if nextScope.kind == .project {
                lastProjectScope = nextScope
                UserDefaults.standard.set(nextScope.projectId?.uuidString, forKey: Self.projectIDDefaultsKey)
                UserDefaults.standard.set(nextScope.projectLabel, forKey: Self.projectLabelDefaultsKey)
            }
        }
        return true
    }

    /// Continue a durable conversation the user explicitly selected.
    /// Does not auto-switch; caller must already have validated the row.
    @discardableResult
    func selectConversation(id: UUID, scope: YishuSessionScope) -> Bool {
        guard turnContinuations.isEmpty else { return false }
        guard scope.kind != .privateSession else { return false }
        currentConversationId = id
        currentSessionScope = scope
        UserDefaults.standard.set(id.uuidString, forKey: Self.conversationIDDefaultsKey)
        UserDefaults.standard.set(scope.kind.rawValue, forKey: Self.sessionScopeKindDefaultsKey)
        if scope.kind == .project {
            lastProjectScope = scope
            UserDefaults.standard.set(scope.projectId?.uuidString, forKey: Self.projectIDDefaultsKey)
            UserDefaults.standard.set(scope.projectLabel, forKey: Self.projectLabelDefaultsKey)
        }
        return true
    }

    /// List durable history rows for a scope (default: 我的 / personal).
    /// `includeArchived` also returns archived rows for the history window.
    func listHistory(
        scope: YishuSessionScope = .personal,
        limit: Int = 30,
        includeArchived: Bool = false
    ) async throws -> [YishuHistoryListItem] {
        let clamped = min(max(limit, 1), 50)
        let requestId = UUID()
        let result: Any = try await withCheckedThrowingContinuation { continuation in
            historyContinuations[requestId] = PendingHistoryRequest(
                kind: .list,
                continuation: continuation,
                timeoutTask: nil
            )
            let timeoutTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                await MainActor.run {
                    self?.failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.historyTimedOut)
                }
            }
            historyContinuations[requestId]?.timeoutTask = timeoutTask
            do {
                try send(YishuHistoryListCommand(
                    schemaVersion: yishuRuntimeProtocolVersion,
                    type: "history.list",
                    requestId: requestId,
                    traceId: UUID(),
                    sentAt: Date(),
                    payload: YishuHistoryListPayload(
                        sessionScope: scope,
                        limit: clamped,
                        includeArchived: includeArchived ? true : nil
                    )
                ))
            } catch {
                failHistoryRequest(requestId, error: error)
            }
        }
        guard let items = result as? [YishuHistoryListItem] else {
            throw YishuAgentRuntimeClientError.invalidHistoryEvent
        }
        return items
    }

    /// Open one durable conversation and return visible turns for context restore.
    func openHistory(
        conversationId: UUID,
        scope: YishuSessionScope = .personal
    ) async throws -> YishuHistoryOpenResult {
        let requestId = UUID()
        let result: Any = try await withCheckedThrowingContinuation { continuation in
            historyContinuations[requestId] = PendingHistoryRequest(
                kind: .open,
                continuation: continuation,
                timeoutTask: nil
            )
            let timeoutTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                await MainActor.run {
                    self?.failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.historyTimedOut)
                }
            }
            historyContinuations[requestId]?.timeoutTask = timeoutTask
            do {
                try send(YishuHistoryOpenCommand(
                    schemaVersion: yishuRuntimeProtocolVersion,
                    type: "history.open",
                    requestId: requestId,
                    traceId: UUID(),
                    sentAt: Date(),
                    payload: YishuHistoryOpenPayload(
                        conversationId: conversationId,
                        sessionScope: scope
                    )
                ))
            } catch {
                failHistoryRequest(requestId, error: error)
            }
        }
        guard let opened = result as? YishuHistoryOpenResult else {
            throw YishuAgentRuntimeClientError.invalidHistoryEvent
        }
        return opened
    }

    /// Un-archive one personal history conversation so it reappears in the
    /// active list. Only succeeds after the runtime confirms storage.
    func restoreHistory(
        conversationId: UUID,
        scope: YishuSessionScope = .personal
    ) async throws -> YishuHistoryRestoreResult {
        let requestId = UUID()
        let result: Any = try await withCheckedThrowingContinuation { continuation in
            historyContinuations[requestId] = PendingHistoryRequest(
                kind: .restore,
                continuation: continuation,
                timeoutTask: nil
            )
            let timeoutTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                await MainActor.run {
                    self?.failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.historyTimedOut)
                }
            }
            historyContinuations[requestId]?.timeoutTask = timeoutTask
            do {
                try send(YishuHistoryRestoreCommand(
                    schemaVersion: yishuRuntimeProtocolVersion,
                    type: "history.restore",
                    requestId: requestId,
                    traceId: UUID(),
                    sentAt: Date(),
                    payload: YishuHistoryRestorePayload(
                        conversationId: conversationId,
                        sessionScope: scope
                    )
                ))
            } catch {
                failHistoryRequest(requestId, error: error)
            }
        }
        guard let restored = result as? YishuHistoryRestoreResult else {
            throw YishuAgentRuntimeClientError.invalidHistoryEvent
        }
        return restored
    }

    /// Soft-delete one personal history conversation (archive). Only succeeds
    /// after the runtime confirms storage; UI must not drop the row early.
    func deleteHistory(
        conversationId: UUID,
        scope: YishuSessionScope = .personal
    ) async throws -> YishuHistoryDeleteResult {
        let requestId = UUID()
        let result: Any = try await withCheckedThrowingContinuation { continuation in
            historyContinuations[requestId] = PendingHistoryRequest(
                kind: .delete,
                continuation: continuation,
                timeoutTask: nil
            )
            let timeoutTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                await MainActor.run {
                    self?.failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.historyTimedOut)
                }
            }
            historyContinuations[requestId]?.timeoutTask = timeoutTask
            do {
                try send(YishuHistoryDeleteCommand(
                    schemaVersion: yishuRuntimeProtocolVersion,
                    type: "history.delete",
                    requestId: requestId,
                    traceId: UUID(),
                    sentAt: Date(),
                    payload: YishuHistoryDeletePayload(
                        conversationId: conversationId,
                        sessionScope: scope
                    )
                ))
            } catch {
                failHistoryRequest(requestId, error: error)
            }
        }
        guard let deleted = result as? YishuHistoryDeleteResult else {
            throw YishuAgentRuntimeClientError.invalidHistoryEvent
        }
        return deleted
    }

    /// List durable personal memories for the "我的" panel (max 50).
    func listMemories(
        scope: YishuSessionScope = .personal,
        limit: Int = 50
    ) async throws -> [YishuMemoryListItem] {
        let clamped = min(max(limit, 1), 50)
        let requestId = UUID()
        let result: Any = try await withCheckedThrowingContinuation { continuation in
            historyContinuations[requestId] = PendingHistoryRequest(
                kind: .memoryList,
                continuation: continuation,
                timeoutTask: nil
            )
            let timeoutTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                await MainActor.run {
                    self?.failHistoryRequest(
                        requestId,
                        error: YishuAgentRuntimeClientError.memoryTimedOut
                    )
                }
            }
            historyContinuations[requestId]?.timeoutTask = timeoutTask
            do {
                try send(YishuMemoryListCommand(
                    schemaVersion: yishuRuntimeProtocolVersion,
                    type: "memory.list",
                    requestId: requestId,
                    traceId: UUID(),
                    sentAt: Date(),
                    payload: YishuMemoryListPayload(
                        sessionScope: scope,
                        limit: clamped
                    )
                ))
            } catch {
                failHistoryRequest(requestId, error: error)
            }
        }
        guard let items = result as? [YishuMemoryListItem] else {
            throw YishuAgentRuntimeClientError.invalidMemoryEvent
        }
        return items
    }

    /// Forget one personal memory by exact id. Only succeeds after storage confirms.
    func forgetMemory(
        memoryId: UUID,
        scope: YishuSessionScope = .personal
    ) async throws -> YishuMemoryForgetResult {
        let requestId = UUID()
        let result: Any = try await withCheckedThrowingContinuation { continuation in
            historyContinuations[requestId] = PendingHistoryRequest(
                kind: .memoryForget,
                continuation: continuation,
                timeoutTask: nil
            )
            let timeoutTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                await MainActor.run {
                    self?.failHistoryRequest(
                        requestId,
                        error: YishuAgentRuntimeClientError.memoryTimedOut
                    )
                }
            }
            historyContinuations[requestId]?.timeoutTask = timeoutTask
            do {
                try send(YishuMemoryForgetCommand(
                    schemaVersion: yishuRuntimeProtocolVersion,
                    type: "memory.forget",
                    requestId: requestId,
                    traceId: UUID(),
                    sentAt: Date(),
                    payload: YishuMemoryForgetPayload(
                        memoryId: memoryId,
                        sessionScope: scope
                    )
                ))
            } catch {
                failHistoryRequest(requestId, error: error)
            }
        }
        guard let forgotten = result as? YishuMemoryForgetResult else {
            throw YishuAgentRuntimeClientError.invalidMemoryEvent
        }
        return forgotten
    }

    /// Write one personal note. Only returns after storage confirms the row.
    func rememberMemory(
        text: String,
        scope: YishuSessionScope = .personal
    ) async throws -> YishuMemoryRememberResult {
        let clipped = YishuPersonalNoteWritePolicy.normalizedText(text)
        guard YishuPersonalNoteWritePolicy.shouldCreate(clipped) else {
            throw YishuAgentRuntimeClientError.memoryFailed(YishuPersonalNotesCopy.emptyDraft)
        }
        let requestId = UUID()
        let result: Any = try await withCheckedThrowingContinuation { continuation in
            historyContinuations[requestId] = PendingHistoryRequest(
                kind: .memoryRemember,
                continuation: continuation,
                timeoutTask: nil
            )
            let timeoutTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                await MainActor.run {
                    self?.failHistoryRequest(
                        requestId,
                        error: YishuAgentRuntimeClientError.memoryTimedOut
                    )
                }
            }
            historyContinuations[requestId]?.timeoutTask = timeoutTask
            do {
                try send(YishuMemoryRememberCommand(
                    schemaVersion: yishuRuntimeProtocolVersion,
                    type: "memory.remember",
                    requestId: requestId,
                    traceId: UUID(),
                    sentAt: Date(),
                    payload: YishuMemoryRememberPayload(
                        text: clipped,
                        sessionScope: scope
                    )
                ))
            } catch {
                failHistoryRequest(requestId, error: error)
            }
        }
        guard let remembered = result as? YishuMemoryRememberResult else {
            throw YishuAgentRuntimeClientError.invalidMemoryEvent
        }
        return remembered
    }

    func awaitPanelResult(
        kind: PendingHistoryKind,
        timeout: YishuAgentRuntimeClientError,
        sendCommand: (UUID) throws -> Void
    ) async throws -> Any {
        let requestId = UUID()
        return try await withCheckedThrowingContinuation { continuation in
            historyContinuations[requestId] = PendingHistoryRequest(
                kind: kind,
                continuation: continuation,
                timeoutTask: nil
            )
            let timeoutTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                await MainActor.run {
                    self?.failHistoryRequest(requestId, error: timeout)
                }
            }
            historyContinuations[requestId]?.timeoutTask = timeoutTask
            do {
                try sendCommand(requestId)
            } catch {
                failHistoryRequest(requestId, error: error)
            }
        }
    }

    /// Ask Runtime for at most two spoken sentences from a scrubbed visible reply.
    func excerptSpeech(
        visibleText: String,
        provider: String,
        model: String
    ) async throws -> String {
        let trimmed = String(visibleText.trimmingCharacters(in: .whitespacesAndNewlines).prefix(8000))
        guard !trimmed.isEmpty else {
            throw YishuAgentRuntimeClientError.speechExcerptFailed("暂时无法抽出口播。")
        }
        guard let modelPreference = Self.modelPreference(provider: provider, model: model) else {
            throw YishuAgentRuntimeClientError.unsupportedModel
        }
        let requestId = UUID()
        let result: Any = try await withCheckedThrowingContinuation { continuation in
            historyContinuations[requestId] = PendingHistoryRequest(
                kind: .speechExcerpt,
                continuation: continuation,
                timeoutTask: nil
            )
            let timeoutTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                await MainActor.run {
                    self?.failHistoryRequest(
                        requestId,
                        error: YishuAgentRuntimeClientError.speechExcerptTimedOut
                    )
                }
            }
            historyContinuations[requestId]?.timeoutTask = timeoutTask
            do {
                try send(YishuSpeechExcerptCommand(
                    schemaVersion: yishuRuntimeProtocolVersion,
                    type: "speech.excerpt",
                    requestId: requestId,
                    traceId: UUID(),
                    sentAt: Date(),
                    payload: YishuSpeechExcerptPayload(
                        visibleText: trimmed,
                        modelPreference: modelPreference
                    )
                ))
            } catch {
                failHistoryRequest(requestId, error: error)
            }
        }
        guard let spoken = result as? String,
              !spoken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw YishuAgentRuntimeClientError.invalidSpeechExcerptEvent
        }
        return spoken
    }

    func start() throws {
        if process?.isRunning == true { return }
        if process != nil { resetProcessReferences() }

        let configuration = try resolveConfiguration()
        let runtimeProcess = Process()
        let inputPipe = Pipe()
        let outputPipe = Pipe()
        let errorPipe = Pipe()

        runtimeProcess.executableURL = configuration.nodeExecutable
        runtimeProcess.arguments = [configuration.runtimeEntry.path]
        runtimeProcess.currentDirectoryURL = configuration.workingDirectory
        let parentEnvironment = ProcessInfo.processInfo.environment
        var environment = YishuVoiceProxySupervisor.minimumChildEnvironment(
            from: parentEnvironment
        )
        do {
            try YishuRuntimeCredentialEnvironment.applyDefaultConfiguration(to: &environment)
        } catch {
            // Do not pass through malformed references, missing Keychain
            // values, or inline legacy secrets.  The error is intentionally
            // collapsed so neither the UI nor logs can reveal config details.
            throw YishuAgentRuntimeClientError.credentialConfigurationUnavailable
        }
        environment["YISHU_RUNTIME_MODE"] = "pi"
        environment["YISHU_PRODUCT_KERNEL"] = "1"
        environment["YISHU_STORE_BACKEND"] = "sqlite"
        if let support = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first {
            let storeDir = support
                .appendingPathComponent("Yishu", isDirectory: true)
                .appendingPathComponent("Store", isDirectory: true)
            try? FileManager.default.createDirectory(
                at: storeDir,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: storeDir.path
            )
            environment["YISHU_STORE_DIR"] = storeDir.path
        }
        for key in ["YISHU_USER_NAME", "YISHU_AUTH_WATCHDOG_MS"] {
            if let value = parentEnvironment[key], !value.isEmpty {
                environment[key] = value
            }
        }
        YishuVoiceProxySupervisor.authorizeChildEnvironment(&environment)
        environment["NO_COLOR"] = "1"
        runtimeProcess.environment = environment
        runtimeProcess.standardInput = inputPipe
        runtimeProcess.standardOutput = outputPipe
        runtimeProcess.standardError = errorPipe

        outputPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            Task { @MainActor in
                self?.ingest(data)
            }
        }

        // Runtime stderr can contain provider request fragments. Consume it but
        // never mirror it into Console or the user-visible overlay.
        errorPipe.fileHandleForReading.readabilityHandler = { handle in
            _ = handle.availableData
        }

        runtimeProcess.terminationHandler = { [weak self] terminatedProcess in
            Task { @MainActor in
                guard let self else { return }
                let wasStopping = self.stopping
                // Turns, auth, and history all wait on the sidecar.  A crash or
                // unexpected exit must end every pending UI wait immediately so
                // the panel does not sit on the history timeout for 10s.
                self.endAllPendingRuntimeRequests(
                    throwing: YishuAgentRuntimeClientError.runtimeNotRunning
                )
                self.resetProcessReferences()
                if !wasStopping {
                    self.onLifecycleEvent?(.stopped(exitCode: terminatedProcess.terminationStatus))
                }
            }
        }

        do {
            try runtimeProcess.run()
        } catch {
            outputPipe.fileHandleForReading.readabilityHandler = nil
            errorPipe.fileHandleForReading.readabilityHandler = nil
            throw YishuAgentRuntimeClientError.launchFailed
        }

        stopping = false
        process = runtimeProcess
        inputHandle = inputPipe.fileHandleForWriting
        outputHandle = outputPipe.fileHandleForReading
        errorHandle = errorPipe.fileHandleForReading
    }

    func startTurn(
        utterance: String,
        contextFrame: YishuContextFrame,
        modelProvider: String,
        model: String,
        modelRouting: YishuModelRouting,
        capabilityProfile: String = "conversation"
    ) throws -> YishuRuntimeTurn {
        guard let modelPreference = Self.modelPreference(
            provider: modelProvider,
            model: model
        ) else {
            throw YishuAgentRuntimeClientError.unsupportedModel
        }
        guard modelRouting.allPreferences.allSatisfy({ preference in
            Self.supportsModel(provider: preference.provider, model: preference.model)
        }) else {
            throw YishuAgentRuntimeClientError.unsupportedModel
        }

        let requestId = UUID()
        let traceId = UUID()
        var streamContinuation: AsyncThrowingStream<YishuRuntimeTurnEvent, Error>.Continuation?
        let stream = AsyncThrowingStream<YishuRuntimeTurnEvent, Error> { continuation in
            streamContinuation = continuation
        }
        guard let streamContinuation else {
            throw YishuAgentRuntimeClientError.runtimeNotRunning
        }
        turnContinuations[requestId] = streamContinuation
        activeTurnTraceIds[requestId] = traceId
        turnProjectionReducers[requestId] = YishuTurnProjectionReducer(requestId: requestId)
        seenTurnEventIds[requestId] = []

        let command = YishuTurnStartCommand(
            schemaVersion: yishuRuntimeProtocolVersion,
            type: "turn.start",
            requestId: requestId,
            traceId: traceId,
            sentAt: Date(),
            payload: YishuTurnStartPayload(
                utterance: utterance,
                contextFrame: contextFrame,
                capabilityProfile: capabilityProfile,
                conversationId: currentConversationId,
                sessionScope: currentSessionScope,
                modelPreference: modelPreference,
                modelRouting: modelRouting
            )
        )

        do {
            try send(command)
            armTurnWatchdog(requestId: requestId)
        } catch {
            turnContinuations.removeValue(forKey: requestId)
            activeTurnTraceIds.removeValue(forKey: requestId)
            turnProjectionReducers.removeValue(forKey: requestId)
            seenTurnEventIds.removeValue(forKey: requestId)
            streamContinuation.finish(throwing: error)
            throw error
        }
        return YishuRuntimeTurn(
            requestId: requestId,
            conversationId: currentConversationId,
            events: stream
        )
    }

    // MARK: - Provider OAuth RPC

    /// Request public auth status without exposing any credential material.
    /// A nil provider asks for both product-approved subscription providers.
    func startAuthStatus(provider: YishuAuthProvider? = nil) throws -> YishuAuthRequest {
        let request = makeAuthRequest(
            kind: .status(
                expectedCount: provider == nil ? YishuAuthProvider.allCases.count : 1,
                provider: provider
            )
        )
        let command = YishuAuthStatusCommand(
            schemaVersion: yishuRuntimeProtocolVersion,
            type: "auth.status",
            requestId: request.requestId,
            traceId: UUID(),
            sentAt: Date(),
            payload: YishuAuthStatusPayload(provider: provider?.rawValue)
        )
        do {
            try send(command)
        } catch {
            finishAuthRequest(request.requestId, throwing: error)
            throw error
        }
        return request
    }

    /// Start one OAuth flow.  Progress, URL, device-code, prompt and terminal
    /// events all stay on this request's auth continuation.
    func startAuthLogin(provider: YishuAuthProvider) throws -> YishuAuthRequest {
        let request = makeAuthRequest(kind: .login(provider: provider))
        let command = YishuAuthLoginStartCommand(
            schemaVersion: yishuRuntimeProtocolVersion,
            type: "auth.login.start",
            requestId: request.requestId,
            traceId: UUID(),
            sentAt: Date(),
            payload: YishuAuthLoginStartPayload(provider: provider.rawValue, authType: "oauth")
        )
        do {
            try send(command)
        } catch {
            finishAuthRequest(request.requestId, throwing: error)
            throw error
        }
        return request
    }

    /// Reply to a transient OAuth prompt.  The value is sent directly to the
    /// pending runtime request and is never copied to an event, log or store.
    func replyToAuthPrompt(
        requestId: UUID,
        provider: YishuAuthProvider,
        promptId: String,
        value: String
    ) throws {
        guard let pending = authContinuations[requestId],
              case let .login(expectedProvider) = pending.kind,
              expectedProvider == provider else {
            throw YishuAgentRuntimeClientError.authRequestUnavailable
        }
        try send(YishuAuthPromptReplyCommand(
            schemaVersion: yishuRuntimeProtocolVersion,
            type: "auth.prompt.reply",
            requestId: requestId,
            traceId: UUID(),
            sentAt: Date(),
            payload: YishuAuthPromptReplyPayload(
                provider: provider.rawValue,
                promptId: promptId,
                value: value
            )
        ))
    }

    /// Cancel only the OAuth request identified by `requestId`; active voice
    /// turns continue on their separate continuation map.
    func cancelAuthLogin(
        requestId: UUID,
        provider: YishuAuthProvider,
        reason: String = "user-cancelled"
    ) throws {
        guard let pending = authContinuations[requestId],
              case let .login(expectedProvider) = pending.kind,
              expectedProvider == provider else {
            throw YishuAgentRuntimeClientError.authRequestUnavailable
        }
        do {
            try sendAuthCancelOnce(requestId: requestId, provider: provider, reason: reason)
        } catch {
            finishAuthRequest(requestId, throwing: error)
            throw error
        }
    }

    func logoutProvider(provider: YishuAuthProvider) throws -> YishuAuthRequest {
        let request = makeAuthRequest(kind: .logout(provider: provider))
        let command = YishuAuthLogoutCommand(
            schemaVersion: yishuRuntimeProtocolVersion,
            type: "auth.logout",
            requestId: request.requestId,
            traceId: UUID(),
            sentAt: Date(),
            payload: YishuAuthLogoutPayload(provider: provider.rawValue)
        )
        do {
            try send(command)
        } catch {
            finishAuthRequest(request.requestId, throwing: error)
            throw error
        }
        return request
    }

    private func makeAuthRequest(kind: AuthRequestKind) -> YishuAuthRequest {
        let requestId = UUID()
        var continuation: AsyncThrowingStream<YishuAuthEvent, Error>.Continuation?
        let stream = AsyncThrowingStream<YishuAuthEvent, Error> { [weak self] newContinuation in
            continuation = newContinuation
            newContinuation.onTermination = { [weak self] _ in
                Task { @MainActor [weak self] in
                    self?.handleAuthStreamTermination(requestId: requestId)
                }
            }
        }
        guard let continuation else {
            // AsyncThrowingStream always supplies its continuation.  Keep the
            // fallback explicit so a future implementation cannot create a
            // request that has no completion path.
            return YishuAuthRequest(requestId: requestId, events: stream)
        }
        authContinuations[requestId] = PendingAuthRequest(
            kind: kind,
            continuation: continuation
        )
        let timeoutNanoseconds = kind.timeoutNanoseconds
        let timeoutTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(nanoseconds: timeoutNanoseconds)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            self?.timeoutAuthRequest(requestId: requestId)
        }
        authContinuations[requestId]?.timeoutTask = timeoutTask
        return YishuAuthRequest(requestId: requestId, events: stream)
    }

    func cancelTurn(requestId: UUID, reason: String = "user-interrupted") throws {
        let command = YishuTurnCancelCommand(
            schemaVersion: yishuRuntimeProtocolVersion,
            type: "turn.cancel",
            requestId: requestId,
            traceId: activeTurnTraceIds[requestId] ?? UUID(),
            sentAt: Date(),
            payload: YishuTurnCancelPayload(reason: reason)
        )
        do {
            try send(command)
        } catch {
            finishTurn(requestId, throwing: error)
            throw error
        }
    }

    /// Synchronous presentation fence used at PTT key-down. It runs before the
    /// async interrupt RPC so a late old-generation delta cannot flash or enter
    /// TTS while the acknowledgement is in flight.
    func suppressTurnForInterruption(
        requestId: UUID,
        expectedGeneration: Int
    ) -> Bool {
        guard var reducer = turnProjectionReducers[requestId] else { return false }
        let accepted = reducer.beginInterruption(
            requestId: requestId,
            expectedGeneration: expectedGeneration
        )
        if accepted {
            turnProjectionReducers[requestId] = reducer
            submittedSteerMessages.removeValue(forKey: requestId)
        }
        return accepted
    }

    func activeGeneration(requestId: UUID) -> Int? {
        turnProjectionReducers[requestId]?.currentGeneration
    }

    func hasActiveTurn(requestId: UUID) -> Bool {
        turnContinuations[requestId] != nil
    }

    /// Waits at most two seconds for the typed Runtime interrupt receipt.
    /// `suppressTurnForInterruption` must already have established the local
    /// presentation floor; failure leaves that old generation suppressed.
    func interruptTurn(
        requestId: UUID,
        expectedGeneration: Int
    ) async throws -> YishuTurnInterruptDecision {
        guard let traceId = activeTurnTraceIds[requestId],
              turnContinuations[requestId] != nil,
              turnProjectionReducers[requestId]?.pendingInterruptedGeneration == expectedGeneration,
              turnInterruptContinuations[requestId] == nil else {
            throw YishuAgentRuntimeClientError.turnInterruptUnavailable
        }

        return try await withCheckedThrowingContinuation { continuation in
            turnInterruptContinuations[requestId] = PendingTurnInterrupt(
                traceId: traceId,
                expectedGeneration: expectedGeneration,
                continuation: continuation,
                timeoutTask: nil
            )
            let timeoutTask = Task { @MainActor [weak self] in
                do {
                    try await Task.sleep(nanoseconds: 2_000_000_000)
                } catch {
                    return
                }
                self?.failTurnInterrupt(
                    requestId,
                    error: YishuAgentRuntimeClientError.turnInterruptTimedOut
                )
            }
            turnInterruptContinuations[requestId]?.timeoutTask = timeoutTask

            do {
                try send(YishuTurnInterruptCommand(
                    schemaVersion: yishuRuntimeProtocolVersion,
                    type: "turn.interrupt",
                    requestId: requestId,
                    traceId: traceId,
                    sentAt: Date(),
                    payload: YishuTurnInterruptPayload(
                        expectedGeneration: expectedGeneration,
                        reason: "user_barge_in"
                    )
                ))
            } catch {
                failTurnInterrupt(requestId, error: error)
            }
        }
    }

    func steerTurn(
        requestId: UUID,
        message: String,
        nextGeneration: Int
    ) throws {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let traceId = activeTurnTraceIds[requestId],
              turnContinuations[requestId] != nil,
              var reducer = turnProjectionReducers[requestId],
              reducer.consumeSteer(
                requestId: requestId,
                nextGeneration: nextGeneration
              ) else {
            throw YishuAgentRuntimeClientError.turnInterruptUnavailable
        }
        try send(YishuTurnSteerCommand(
            schemaVersion: yishuRuntimeProtocolVersion,
            type: "turn.steer",
            requestId: requestId,
            traceId: traceId,
            sentAt: Date(),
            payload: YishuTurnSteerPayload(
                message: trimmed,
                nextGeneration: nextGeneration,
                interactionClass: "conversation"
            )
        ))
        turnProjectionReducers[requestId] = reducer
        submittedSteerMessages[requestId] = trimmed
        // Each accepted generation owns a fresh bounded foreground window;
        // otherwise a barge-in near the original turn's deadline inherits only
        // the few seconds left on that old watchdog.
        armTurnWatchdog(requestId: requestId)
    }

    func listDelegatedTasks(
        mainConversationId: UUID? = nil
    ) async throws -> [YishuDelegatedTaskPresenceEvent] {
        let conversationId = mainConversationId ?? currentConversationId
        let requestId = UUID()
        let traceId = UUID()
        return try await withCheckedThrowingContinuation { continuation in
            taskListContinuations[requestId] = PendingTaskListRequest(
                traceId: traceId,
                mainConversationId: conversationId,
                continuation: continuation,
                timeoutTask: nil
            )
            let timeoutTask = Task { @MainActor [weak self] in
                do {
                    try await Task.sleep(nanoseconds: 10_000_000_000)
                } catch {
                    return
                }
                self?.failTaskListRequest(
                    requestId,
                    error: YishuAgentRuntimeClientError.taskListTimedOut
                )
            }
            taskListContinuations[requestId]?.timeoutTask = timeoutTask
            do {
                try send(YishuDelegatedTaskListCommand(
                    schemaVersion: yishuRuntimeProtocolVersion,
                    type: "task.list",
                    requestId: requestId,
                    traceId: traceId,
                    sentAt: Date(),
                    payload: YishuDelegatedTaskListPayload(
                        mainConversationId: conversationId
                    )
                ))
            } catch {
                failTaskListRequest(requestId, error: error)
            }
        }
    }

    func cancelDelegatedTask(
        taskId: UUID,
        mainConversationId: UUID,
        reason: String = "user_cancelled"
    ) async throws -> YishuDelegatedTaskCancelAcceptance {
        let requestId = UUID()
        let traceId = UUID()
        return try await withCheckedThrowingContinuation { continuation in
            taskCancelContinuations[requestId] = PendingTaskCancelRequest(
                traceId: traceId,
                taskId: taskId,
                mainConversationId: mainConversationId,
                continuation: continuation,
                timeoutTask: nil
            )
            let timeoutTask = Task { @MainActor [weak self] in
                do {
                    try await Task.sleep(nanoseconds: 10_000_000_000)
                } catch {
                    return
                }
                self?.failTaskCancelRequest(
                    requestId,
                    error: YishuAgentRuntimeClientError.taskCancelTimedOut
                )
            }
            taskCancelContinuations[requestId]?.timeoutTask = timeoutTask
            do {
                try send(YishuDelegatedTaskCancelCommand(
                    schemaVersion: yishuRuntimeProtocolVersion,
                    type: "task.cancel",
                    requestId: requestId,
                    traceId: traceId,
                    sentAt: Date(),
                    payload: YishuDelegatedTaskCancelPayload(
                        taskId: taskId,
                        mainConversationId: mainConversationId,
                        reason: reason
                    )
                ))
            } catch {
                failTaskCancelRequest(requestId, error: error)
            }
        }
    }

    /// Append a frame into the product ContextTrail without starting a Pi turn.
    /// Prefer metadata-only frames (empty screenshots) for background sampling.
    func observeTrail(contextFrame: YishuContextFrame) throws {
        let command = YishuTrailObserveCommand(
            schemaVersion: yishuRuntimeProtocolVersion,
            type: "trail.observe",
            requestId: UUID(),
            traceId: UUID(),
            sentAt: Date(),
            payload: YishuTrailObservePayload(
                contextFrame: contextFrame,
                sessionScope: currentSessionScope
            )
        )
        try send(command)
    }

    /// Keep the voice turn alive when a desktop request cannot be decoded.
    /// Node is blocked on this actionId until it gets a result or its 8s timeout.
    private func rejectUndecodableComputerAction(
        requestId: UUID,
        traceId: UUID,
        payload: [String: Any]
    ) {
        guard let actionId = (payload["actionId"] as? String).flatMap(UUID.init(uuidString:)) else {
            return
        }
        let attemptId = payload["attemptId"] as? String
        let request = YishuComputerActionRequest(
            requestId: requestId,
            traceId: traceId,
            actionId: actionId,
            action: (payload["action"] as? String) ?? "left_click",
            x: 0,
            y: 0,
            attemptId: attemptId
        )
        let result = YishuComputerActionResult(
            succeeded: false,
            verified: false,
            message: "Desktop action request was invalid.",
            evidence: nil,
            status: .failed,
            method: .unknown,
            code: .runtimeError,
            attemptId: attemptId ?? UUID().uuidString
        )
        try? completeComputerAction(request, result: result)
    }

    func completeComputerAction(
        _ request: YishuComputerActionRequest,
        result: YishuComputerActionResult,
        recapture: YishuContextFrame? = nil
    ) throws {
        QualityEventRecorder.record(
            name: "computer.result.sending",
            sessionId: "desktop",
            attributes: ["receiptStatus": result.status.rawValue]
        )
        try send(YishuComputerActionResultCommand(
            schemaVersion: yishuRuntimeProtocolVersion,
            type: "computer.action.result",
            requestId: request.requestId,
            traceId: request.traceId,
            sentAt: Date(),
            payload: YishuComputerActionResultPayload(
                actionId: request.actionId,
                succeeded: result.succeeded,
                verified: result.verified,
                message: result.message,
                evidence: result.evidence,
                status: result.status.rawValue,
                method: result.method.rawValue,
                code: result.code.rawValue,
                receiptId: result.receiptId,
                attemptId: result.attemptId,
                clockLabel: result.clockLabel.flatMap {
                    YishuTimeReminderDelivery.isMacClockLabel($0) ? $0 : nil
                },
                observationId: recapture?.frameId,
                numberedTargets: recapture?.numberedTargets,
                screenshots: recapture.map { Array($0.screenshots.prefix(1)) }
            )
        ))
        QualityEventRecorder.record(
            name: "computer.result.sent",
            sessionId: "desktop",
            attributes: ["receiptStatus": result.status.rawValue]
        )
    }

    func stop() {
        stopping = true
        endAllPendingRuntimeRequests(throwing: CancellationError())
        inputHandle?.closeFile()
        inputHandle = nil
        if let process, process.isRunning {
            process.terminate()
        } else {
            resetProcessReferences()
        }
    }

    /// Recovery-only termination keeps `stopping` false so the unexpected
    /// stopped lifecycle event drives CompanionManager's bounded restart.
    func terminateForRecovery() {
        stopping = false
        endAllPendingRuntimeRequests(
            throwing: YishuAgentRuntimeClientError.runtimeNotRunning
        )
        guard let process, process.isRunning else {
            resetProcessReferences()
            onLifecycleEvent?(.stopped(exitCode: -1))
            return
        }
        process.terminate()
    }

    /// Ends every in-flight turn / auth / history wait when the sidecar is gone.
    /// Used by `stop()` and by unexpected process termination.
    func endAllPendingRuntimeRequests(throwing error: Error) {
        finishAllTurns(throwing: error)
        finishAllAuthRequests(throwing: error)
        finishAllHistoryRequests(throwing: error)
        finishAllTaskListRequests(throwing: error)
        finishAllTaskCancelRequests(throwing: error)
    }

    /// Test hook: park one history.list wait without talking to Node.
    /// Suspends until the wait is registered, then returns a task that finishes
    /// when `endAllPendingRuntimeRequests` / success path resumes it.
    func parkHistoryListWaitForTests() async -> (requestId: UUID, wait: Task<Void, Error>) {
        await parkHistoryKindWaitForTests(kind: .list)
    }

    /// Test hook: park one memory.list wait (same continuation table as history).
    func parkMemoryListWaitForTests() async -> (requestId: UUID, wait: Task<Void, Error>) {
        await parkHistoryKindWaitForTests(kind: .memoryList)
    }

    /// Test hook: park one memory.forget wait.
    func parkMemoryForgetWaitForTests() async -> (requestId: UUID, wait: Task<Void, Error>) {
        await parkHistoryKindWaitForTests(kind: .memoryForget)
    }

    /// Test hook: park one memory.remember wait.
    func parkMemoryRememberWaitForTests() async -> (requestId: UUID, wait: Task<YishuMemoryRememberResult, Error>) {
        let requestId = UUID()
        let (readyStream, readyContinuation) = AsyncStream<Void>.makeStream()
        let wait = Task { @MainActor in
            let result: Any = try await withCheckedThrowingContinuation { continuation in
                historyContinuations[requestId] = PendingHistoryRequest(
                    kind: .memoryRemember,
                    continuation: continuation,
                    timeoutTask: nil
                )
                readyContinuation.yield(())
                readyContinuation.finish()
            }
            guard let remembered = result as? YishuMemoryRememberResult else {
                throw YishuAgentRuntimeClientError.invalidMemoryEvent
            }
            return remembered
        }
        for await _ in readyStream {
            break
        }
        return (requestId, wait)
    }

    func completeParkedMemoryRememberForTests(
        requestId: UUID,
        result: YishuMemoryRememberResult
    ) {
        finishHistoryRequest(requestId, value: result)
    }

    /// Test hook: park one speech.excerpt wait and surface the spoken text.
    func parkSpeechExcerptWaitForTests() async -> (requestId: UUID, wait: Task<String, Error>) {
        let requestId = UUID()
        let (readyStream, readyContinuation) = AsyncStream<Void>.makeStream()
        let wait = Task { @MainActor in
            let result: Any = try await withCheckedThrowingContinuation { continuation in
                historyContinuations[requestId] = PendingHistoryRequest(
                    kind: .speechExcerpt,
                    continuation: continuation,
                    timeoutTask: nil
                )
                readyContinuation.yield(())
                readyContinuation.finish()
            }
            guard let spoken = result as? String else {
                throw YishuAgentRuntimeClientError.invalidSpeechExcerptEvent
            }
            return spoken
        }
        for await _ in readyStream {
            break
        }
        return (requestId, wait)
    }

    func completeParkedSpeechExcerptForTests(requestId: UUID, spokenText: String) {
        finishHistoryRequest(requestId, value: spokenText)
    }

    private func parkHistoryKindWaitForTests(
        kind: PendingHistoryKind
    ) async -> (requestId: UUID, wait: Task<Void, Error>) {
        let requestId = UUID()
        let (readyStream, readyContinuation) = AsyncStream<Void>.makeStream()

        let wait = Task { @MainActor in
            let _: Any = try await withCheckedThrowingContinuation { continuation in
                historyContinuations[requestId] = PendingHistoryRequest(
                    kind: kind,
                    continuation: continuation,
                    timeoutTask: nil
                )
                readyContinuation.yield(())
                readyContinuation.finish()
            }
        }

        for await _ in readyStream {
            break
        }
        return (requestId, wait)
    }

    var pendingHistoryRequestCountForTests: Int {
        historyContinuations.count
    }

    func parkDelegatedTaskRPCWaitsForTests() async -> (
        list: Task<Void, Error>,
        cancel: Task<Void, Error>
    ) {
        let listRequestId = UUID()
        let cancelRequestId = UUID()
        let conversationId = UUID()
        let taskId = UUID()
        let (readyStream, readyContinuation) = AsyncStream<Void>.makeStream()
        let list = Task { @MainActor in
            let _: [YishuDelegatedTaskPresenceEvent] = try await withCheckedThrowingContinuation {
                continuation in
                taskListContinuations[listRequestId] = PendingTaskListRequest(
                    traceId: UUID(),
                    mainConversationId: conversationId,
                    continuation: continuation,
                    timeoutTask: nil
                )
                readyContinuation.yield(())
            }
        }
        let cancel = Task { @MainActor in
            let _: YishuDelegatedTaskCancelAcceptance = try await withCheckedThrowingContinuation {
                continuation in
                taskCancelContinuations[cancelRequestId] = PendingTaskCancelRequest(
                    traceId: UUID(),
                    taskId: taskId,
                    mainConversationId: conversationId,
                    continuation: continuation,
                    timeoutTask: nil
                )
                readyContinuation.yield(())
            }
        }
        var readyCount = 0
        for await _ in readyStream {
            readyCount += 1
            if readyCount == 2 { break }
        }
        readyContinuation.finish()
        return (list, cancel)
    }

    var pendingDelegatedTaskRPCCountForTests: Int {
        taskListContinuations.count + taskCancelContinuations.count
    }

    /// Test hook for spontaneous events that do not belong to a turn stream.
    func dispatchRuntimeEventForTests(_ raw: [String: Any]) {
        dispatch(raw)
    }

    /// Test hook for strict voice-envelope and generation projection without
    /// launching the Node sidecar.
    func parkTurnForTests(
        requestId: UUID = UUID(),
        traceId: UUID = UUID()
    ) -> (turn: YishuRuntimeTurn, traceId: UUID) {
        var streamContinuation: AsyncThrowingStream<YishuRuntimeTurnEvent, Error>.Continuation?
        let stream = AsyncThrowingStream<YishuRuntimeTurnEvent, Error> { continuation in
            streamContinuation = continuation
        }
        guard let streamContinuation else {
            preconditionFailure("AsyncThrowingStream did not provide a continuation")
        }
        turnContinuations[requestId] = streamContinuation
        activeTurnTraceIds[requestId] = traceId
        turnProjectionReducers[requestId] = YishuTurnProjectionReducer(requestId: requestId)
        seenTurnEventIds[requestId] = []
        return (
            YishuRuntimeTurn(
                requestId: requestId,
                conversationId: currentConversationId,
                events: stream
            ),
            traceId
        )
    }

    var pendingTurnCountForTests: Int { turnContinuations.count }

    func acceptTurnInterruptionForTests(
        requestId: UUID,
        interruptedGeneration: Int,
        nextGeneration: Int
    ) -> Bool {
        guard var reducer = turnProjectionReducers[requestId] else { return false }
        let accepted = reducer.acceptInterruption(
            requestId: requestId,
            interruptedGeneration: interruptedGeneration,
            nextGeneration: nextGeneration
        )
        if accepted { turnProjectionReducers[requestId] = reducer }
        return accepted
    }

    func markTurnSteeredForTests(
        requestId: UUID,
        message: String,
        nextGeneration: Int
    ) -> Bool {
        guard var reducer = turnProjectionReducers[requestId],
              reducer.consumeSteer(
                requestId: requestId,
                nextGeneration: nextGeneration
              ) else { return false }
        turnProjectionReducers[requestId] = reducer
        submittedSteerMessages[requestId] = message
        return true
    }

    func timeoutTurnForTests(requestId: UUID) {
        timeoutTurn(requestId)
    }

    /// Test hook: complete a parked memory.forget with a store-confirmed result.
    func finishParkedMemoryForgetForTests(
        requestId: UUID,
        memoryId: UUID,
        alreadyGone: Bool
    ) {
        finishHistoryRequest(
            requestId,
            value: YishuMemoryForgetResult(memoryId: memoryId, alreadyGone: alreadyGone)
        )
    }

    /// Test hook: fail a parked history/memory request with a stable product error.
    func failParkedHistoryRequestForTests(
        requestId: UUID,
        error: YishuAgentRuntimeClientError
    ) {
        failHistoryRequest(requestId, error: error)
    }

    static func decodeDelegatedTaskSnapshot(
        _ raw: [String: Any],
        expectedRequestId: UUID,
        expectedTraceId: UUID,
        expectedConversationId: UUID
    ) -> [YishuDelegatedTaskPresenceEvent]? {
        guard raw["type"] as? String == "task.listed",
              isValidSchemaVersionValue(raw["schemaVersion"]),
              let sourceEventId = (raw["eventId"] as? String).flatMap(UUID.init(uuidString:)),
              (raw["requestId"] as? String).flatMap(UUID.init(uuidString:)) == expectedRequestId,
              (raw["traceId"] as? String).flatMap(UUID.init(uuidString:)) == expectedTraceId,
              (raw["conversationId"] as? String).flatMap(UUID.init(uuidString:))
                == expectedConversationId,
              let payload = raw["payload"] as? [String: Any],
              let rows = payload["tasks"] as? [[String: Any]],
              rows.count <= 64 else {
            return nil
        }
        let tasks = rows.compactMap {
            YishuDelegatedTaskPresenceEvent.decodeSnapshotItem(
                $0,
                expectedConversationId: expectedConversationId,
                sourceEventId: sourceEventId
            )
        }
        guard tasks.count == rows.count,
              Set(tasks.map(\.id)).count == tasks.count else {
            return nil
        }
        return tasks
    }

    static func decodeDelegatedTaskCancelAcceptance(
        _ raw: [String: Any],
        expectedRequestId: UUID,
        expectedTraceId: UUID,
        expectedTaskId: UUID,
        expectedConversationId: UUID
    ) -> YishuDelegatedTaskCancelAcceptance? {
        guard raw["type"] as? String == "task.cancel.accepted",
              isValidSchemaVersionValue(raw["schemaVersion"]),
              (raw["eventId"] as? String).flatMap(UUID.init(uuidString:)) != nil,
              (raw["requestId"] as? String).flatMap(UUID.init(uuidString:)) == expectedRequestId,
              (raw["traceId"] as? String).flatMap(UUID.init(uuidString:)) == expectedTraceId,
              (raw["conversationId"] as? String).flatMap(UUID.init(uuidString:))
                == expectedConversationId,
              let payload = raw["payload"] as? [String: Any],
              (payload["taskId"] as? String).flatMap(UUID.init(uuidString:)) == expectedTaskId,
              (payload["mainConversationId"] as? String).flatMap(UUID.init(uuidString:))
                == expectedConversationId,
              payload["accepted"] == nil || payload["accepted"] as? Bool == true else {
            return nil
        }
        return YishuDelegatedTaskCancelAcceptance(
            requestId: expectedRequestId,
            taskId: expectedTaskId,
            mainConversationId: expectedConversationId
        )
    }

    private static func runtimeErrorMessage(from payload: [String: Any]) -> String? {
        YishuDelegatedTaskPresenceEvent.boundedOptionalString(payload["message"], maximum: 180)
    }

    func send<Command: Encodable>(_ command: Command) throws {
        guard let inputHandle, process?.isRunning == true else {
            throw YishuAgentRuntimeClientError.runtimeNotRunning
        }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        var data = try encoder.encode(command)
        data.append(0x0A)
        try inputHandle.write(contentsOf: data)
    }

    private func ingest(_ data: Data) {
        outputBuffer.append(data)
        while let newline = outputBuffer.firstIndex(of: 0x0A) {
            let line = outputBuffer[..<newline]
            outputBuffer.removeSubrange(...newline)
            guard !line.isEmpty,
                  let object = try? JSONSerialization.jsonObject(with: Data(line)),
                  let event = object as? [String: Any] else {
                continue
            }
            dispatch(event)
        }
    }

    private func dispatch(_ raw: [String: Any]) {
        guard let type = raw["type"] as? String else { return }
        let requestId = (raw["requestId"] as? String).flatMap(UUID.init(uuidString:))
        let traceId = (raw["traceId"] as? String).flatMap(UUID.init(uuidString:))
        let payload = raw["payload"] as? [String: Any] ?? [:]

        if type == "runtime.ready" {
            onLifecycleEvent?(.ready(mode: payload["mode"] as? String ?? "unknown"))
            Task { @MainActor in
                await WorkspaceGrantSync.pushActiveGrants(using: self)
            }
            return
        }

        if type == "task.presence.updated" {
            guard let event = YishuDelegatedTaskPresenceEvent.decode(raw) else { return }
            onDelegatedTaskPresenceEvent?(event)
            return
        }

        if type == "task.listed" {
            guard let requestId, let pending = taskListContinuations[requestId] else { return }
            guard let tasks = Self.decodeDelegatedTaskSnapshot(
                raw,
                expectedRequestId: requestId,
                expectedTraceId: pending.traceId,
                expectedConversationId: pending.mainConversationId
            ) else {
                failTaskListRequest(
                    requestId,
                    error: YishuAgentRuntimeClientError.invalidTaskListEvent
                )
                return
            }
            finishTaskListRequest(requestId, value: tasks)
            return
        }

        if type == "task.cancel.accepted" {
            guard let requestId, let pending = taskCancelContinuations[requestId] else { return }
            guard let acceptance = Self.decodeDelegatedTaskCancelAcceptance(
                raw,
                expectedRequestId: requestId,
                expectedTraceId: pending.traceId,
                expectedTaskId: pending.taskId,
                expectedConversationId: pending.mainConversationId
            ) else {
                failTaskCancelRequest(
                    requestId,
                    error: YishuAgentRuntimeClientError.invalidTaskCancelEvent
                )
                return
            }
            finishTaskCancelRequest(requestId, value: acceptance)
            return
        }

        if type == "runtime.error", let requestId {
            let message = Self.runtimeErrorMessage(from: payload)
            if let pending = taskListContinuations[requestId] {
                guard Self.isValidSchemaVersionValue(raw["schemaVersion"]),
                      traceId == pending.traceId else {
                    failTaskListRequest(
                        requestId,
                        error: YishuAgentRuntimeClientError.invalidTaskListEvent
                    )
                    return
                }
                failTaskListRequest(
                    requestId,
                    error: YishuAgentRuntimeClientError.taskListFailed(
                        message ?? "暂时无法读取后台任务。"
                    )
                )
                return
            }
            if let pending = taskCancelContinuations[requestId] {
                guard Self.isValidSchemaVersionValue(raw["schemaVersion"]),
                      traceId == pending.traceId else {
                    failTaskCancelRequest(
                        requestId,
                        error: YishuAgentRuntimeClientError.invalidTaskCancelEvent
                    )
                    return
                }
                failTaskCancelRequest(
                    requestId,
                    error: YishuAgentRuntimeClientError.taskCancelFailed(
                        message ?? "暂时无法停止后台任务。"
                    )
                )
                return
            }
        }

        if type == "turn.interrupt.accepted" || type == "turn.interrupt.rejected" {
            guard let requestId,
                  turnContinuations[requestId] != nil,
                  traceId == activeTurnTraceIds[requestId],
                  Self.isValidSchemaVersionValue(raw["schemaVersion"]),
                  let eventId = (raw["eventId"] as? String).flatMap(UUID.init(uuidString:)),
                  rememberTurnEvent(eventId, requestId: requestId) else {
                return
            }

            if type == "turn.interrupt.accepted" {
                guard let pending = turnInterruptContinuations[requestId] else { return }
                guard let interruptedGeneration = Self.turnGeneration(payload["interruptedGeneration"]),
                      let nextGeneration = Self.turnGeneration(payload["nextGeneration"]),
                      interruptedGeneration == pending.expectedGeneration,
                      var reducer = turnProjectionReducers[requestId],
                      reducer.acceptInterruption(
                        requestId: requestId,
                        interruptedGeneration: interruptedGeneration,
                        nextGeneration: nextGeneration
                      ) else {
                    failTurnInterrupt(
                        requestId,
                        error: YishuAgentRuntimeClientError.turnInterruptUnavailable
                    )
                    return
                }
                turnProjectionReducers[requestId] = reducer
                finishTurnInterrupt(
                    requestId,
                    decision: .accepted(
                        interruptedGeneration: interruptedGeneration,
                        nextGeneration: nextGeneration
                    )
                )
                return
            }

            guard let generation = Self.turnGeneration(payload["generation"]),
                  let code = Self.boundedProtocolString(payload["code"], maximum: 80) else {
                if turnInterruptContinuations[requestId] != nil {
                    failTurnInterrupt(
                        requestId,
                        error: YishuAgentRuntimeClientError.turnInterruptUnavailable
                    )
                }
                return
            }
            if turnInterruptContinuations[requestId] != nil {
                finishTurnInterrupt(
                    requestId,
                    decision: .rejected(generation: generation, code: code)
                )
                return
            }
            // Runtime can reject a submitted steer after the interrupt receipt
            // (for example if its effect classifier is stricter than Swift's).
            // Surface that typed failure immediately instead of silently
            // waiting for the Runtime's 35-second steer watchdog.
            if let reducer = turnProjectionReducers[requestId],
               !reducer.interruptionPending,
               turnInterruptContinuations[requestId] == nil,
               reducer.hasSubmittedSteer(
                requestId: requestId,
                generation: generation
            ) == true,
               let message = submittedSteerMessages[requestId] {
                // A steer rejection is not itself a terminal Runtime event.
                // Cancel with the still-owned start trace before `finishTurn`
                // removes that trace; a later random-trace cancel would be
                // rejected by the protocol and leave the old session alive.
                if let activeTraceId = activeTurnTraceIds[requestId] {
                    try? send(YishuTurnCancelCommand(
                        schemaVersion: yishuRuntimeProtocolVersion,
                        type: "turn.cancel",
                        requestId: requestId,
                        traceId: activeTraceId,
                        sentAt: Date(),
                        payload: YishuTurnCancelPayload(reason: "steer-rejected")
                    ))
                }
                finishTurn(
                    requestId,
                    throwing: YishuAgentRuntimeClientError.turnSteerRejected(
                        message: message,
                        code: code
                    )
                )
            }
            return
        }

        // Auth events use their own continuation map and strict envelope
        // validation. They must never be delivered to a voice turn just
        // because UUIDs share the same envelope.
        if type.hasPrefix("auth.") {
            guard let requestId,
                  authContinuations[requestId] != nil else {
                // Unknown/tombstoned auth requests are intentionally dropped.
                return
            }
            guard let envelope = YishuAuthEvent.decodeEnvelope(raw) else {
                finishAuthRequest(requestId, throwing: YishuAgentRuntimeClientError.invalidAuthEvent)
                return
            }
            guard envelope.requestID == requestId else {
                finishAuthRequest(requestId, throwing: YishuAgentRuntimeClientError.invalidAuthEvent)
                return
            }
            dispatchAuthEvent(envelope)
            return
        }
        if let requestId,
           authContinuations[requestId] != nil,
           type == "runtime.error" {
            finishAuthRequest(requestId, throwing: YishuAgentRuntimeClientError.authFailed)
            return
        }

        // history.* always, and only memory.list/forget/remember result events (not memory.used).
        let isMemoryPanelEvent =
            type == "memory.listed"
            || type == "memory.forgotten"
            || type == "memory.remembered"
            || type == "memory.failed"
        let isSpeechExcerptEvent = type == "speech.excerpted" || type == "speech.failed"
        if consumeWorkspacePanelEvent(type: type, requestId: requestId, payload: payload) {
            return
        }
        if type.hasPrefix("history.") || isMemoryPanelEvent || isSpeechExcerptEvent {
            guard let requestId, historyContinuations[requestId] != nil else { return }
            if isSpeechExcerptEvent {
                dispatchSpeechExcerptEvent(type: type, requestId: requestId, payload: payload)
            } else if isMemoryPanelEvent {
                dispatchMemoryEvent(type: type, requestId: requestId, payload: payload)
            } else {
                dispatchHistoryEvent(type: type, requestId: requestId, payload: payload)
            }
            return
        }
        if let requestId,
           historyContinuations[requestId] != nil,
           type == "runtime.error" {
            let message = (payload["message"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let pending = historyContinuations[requestId]
            let isMemory = pending?.kind == .memoryList
                || pending?.kind == .memoryForget
                || pending?.kind == .memoryRemember
            let isWorkspace = pending.map { isWorkspaceHistoryKind($0.kind) } ?? false
            if pending?.kind == .speechExcerpt {
                failHistoryRequest(
                    requestId,
                    error: YishuAgentRuntimeClientError.speechExcerptFailed(
                        (message?.isEmpty == false) ? message! : "暂时无法抽出口播。"
                    )
                )
            } else if isMemory {
                failHistoryRequest(
                    requestId,
                    error: YishuAgentRuntimeClientError.memoryFailed(
                        (message?.isEmpty == false) ? message! : YishuPersonalNotesCopy.notSaved
                    )
                )
            } else if isWorkspace {
                failHistoryRequest(requestId, error: workspaceRuntimeError(from: message))
            } else {
                failHistoryRequest(
                    requestId,
                    error: YishuAgentRuntimeClientError.historyFailed(
                        (message?.isEmpty == false) ? message! : "暂时无法读取历史。"
                    )
                )
            }
            return
        }

        guard let requestId,
              let continuation = turnContinuations[requestId],
              activeTurnTraceIds[requestId] == traceId,
              Self.isValidSchemaVersionValue(raw["schemaVersion"]),
              let eventId = (raw["eventId"] as? String).flatMap(UUID.init(uuidString:)),
              rememberTurnEvent(eventId, requestId: requestId),
              var reducer = turnProjectionReducers[requestId] else { return }

        let wireGeneration = Self.turnGeneration(payload["generation"])
        guard reducer.accepts(requestId: requestId, generation: wireGeneration) else {
            let isTerminal = type == "response.completed"
                || type == "turn.cancelled"
                || type == "turn.failed"
                || type == "runtime.error"
            if isTerminal,
               reducer.interruptionPending,
               (wireGeneration == nil
                || wireGeneration == reducer.pendingInterruptedGeneration) {
                // The old provider may finish concurrently with PTT/ASR. It
                // closes that stream but never projects old text or success;
                // transcript submission then takes exactly one fresh-start path.
                finishTurn(requestId, throwing: CancellationError())
            }
            return
        }
        let generation = wireGeneration ?? reducer.currentGeneration
        let provesSubmittedSteerIsLive = type == "turn.started"
            || type == "response.delta"
            || type == "response.completed"
            || type == "tool.started"
            || type == "tool.completed"
            || type == "computer.action.requested"
        if provesSubmittedSteerIsLive,
           reducer.markGenerationLive(requestId: requestId, generation: generation) {
            turnProjectionReducers[requestId] = reducer
            submittedSteerMessages.removeValue(forKey: requestId)
        }
        // Any accepted event — delta, tool, action request, memory — proves the
        // runtime is alive and buys another quiet window.
        armTurnStallWatchdog(requestId: requestId)

        switch type {
        case "turn.started":
            continuation.yield(.started(
                route: YishuResolvedModelRoute.decode(payload),
                generation: generation
            ))
        case "response.delta":
            if let text = payload["text"] as? String {
                continuation.yield(.responseDelta(text: text, generation: generation))
            }
        case "tool.started":
            continuation.yield(.toolStarted(
                name: payload["toolName"] as? String ?? "tool",
                generation: generation
            ))
        case "tool.completed":
            continuation.yield(.toolCompleted(
                name: payload["toolName"] as? String ?? "tool",
                isError: payload["isError"] as? Bool ?? false,
                generation: generation
            ))
        case "computer.action.requested":
            guard let traceId else { return }
            if let request = Self.decodeComputerActionRequest(
                payload: payload,
                requestId: requestId,
                traceId: traceId,
                schemaVersion: raw["schemaVersion"]
            ) {
                continuation.yield(.computerActionRequested(request, generation: generation))
                return
            }
            // An icon button often arrives with a blank label. That must nack
            // the desktop action, not abort the voice turn into the generic
            // "这轮没有完成" notice while the model is still finishing.
            rejectUndecodableComputerAction(
                requestId: requestId,
                traceId: traceId,
                payload: payload
            )
        case "product.action.completed":
            YishuMemoryQualityEvents.recordRememberedIfValid(payload: payload, scope: currentSessionScope)
        case "memory.used":
            let items = Self.parseMemoryUsedItems(payload)
            if !items.isEmpty {
                items.forEach { YishuMemoryQualityEvents.recordUsed(memoryID: $0.id, scope: $0.scope) }
                continuation.yield(.memoryUsed(items, generation: generation))
            }
        case "response.completed":
            continuation.yield(.completed(
                text: payload["text"] as? String ?? "",
                verified: payload["verified"] as? Bool ?? false,
                generation: generation
            ))
            finishTurn(requestId)
        case "turn.cancelled":
            continuation.yield(.cancelled(generation: generation))
            finishTurn(requestId)
        case "turn.failed", "runtime.error":
            let code = Self.boundedProtocolString(payload["code"], maximum: 80)
            let failedBeforeReplacementStarted = code == "steer_failed"
                || code == "steer_replacement_failed_before_start"
            if type == "turn.failed",
               failedBeforeReplacementStarted,
               !reducer.interruptionPending,
               reducer.hasSubmittedSteer(
                requestId: requestId,
                generation: generation
               ),
               let message = submittedSteerMessages[requestId] {
                if let activeTraceId = activeTurnTraceIds[requestId] {
                    try? send(YishuTurnCancelCommand(
                        schemaVersion: yishuRuntimeProtocolVersion,
                        type: "turn.cancel",
                        requestId: requestId,
                        traceId: activeTraceId,
                        sentAt: Date(),
                        payload: YishuTurnCancelPayload(reason: "steer-failed")
                    ))
                }
                finishTurn(
                    requestId,
                    throwing: YishuAgentRuntimeClientError.turnSteerRejected(
                        message: message,
                        code: code ?? "steer_failed"
                    )
                )
                return
            }
            if type == "turn.failed", code == "first_byte_timeout" {
                finishTurn(requestId, throwing: YishuAgentRuntimeClientError.turnTimedOut)
                return
            }
            finishTurn(requestId, throwing: YishuAgentRuntimeClientError.turnFailed)
        default:
            break
        }
    }

    /// Parse flat memory.used payload: count + memoryIdN/summaryN/sourceN/capturedAtN/scopeN.
    private static func parseMemoryUsedItems(
        _ payload: [String: Any]
    ) -> [YishuMemoryUsedItem] {
        let count: Int
        if let number = payload["count"] as? Int {
            count = min(3, max(0, number))
        } else if let number = payload["count"] as? NSNumber {
            count = min(3, max(0, number.intValue))
        } else {
            count = 0
        }
        guard count > 0 else { return [] }

        var items: [YishuMemoryUsedItem] = []
        for index in 1...count {
            guard let idRaw = payload["memoryId\(index)"] as? String,
                  let id = UUID(uuidString: idRaw) else {
                continue
            }
            let summary = (payload["summary\(index)"] as? String ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !summary.isEmpty else { continue }
            let source = payload["source\(index)"] as? String ?? "conversation"
            let capturedAt = payload["capturedAt\(index)"] as? String ?? ""
            let scope = payload["scope\(index)"] as? String ?? "personal"
            items.append(
                YishuMemoryUsedItem(
                    id: id,
                    summary: String(summary.prefix(80)),
                    source: source,
                    capturedAt: capturedAt,
                    scope: scope
                )
            )
        }
        return items
    }


    private func dispatchAuthEvent(_ envelope: YishuAuthEnvelope) {
        let requestId = envelope.requestID
        guard var pending = authContinuations[requestId] else { return }
        guard !authTombstones.contains(requestId),
              pending.seenEventIDs.insert(envelope.eventID).inserted else {
            return
        }

        if let expectedProvider = pending.kind.provider,
           envelope.event.provider != expectedProvider {
            finishAuthRequest(requestId, throwing: YishuAgentRuntimeClientError.invalidAuthEvent)
            return
        }

        pending.continuation.yield(envelope.event)
        switch envelope.event {
        case .status:
            if case let .status(expectedCount, expectedProvider) = pending.kind {
                guard let provider = envelope.event.provider,
                      expectedProvider == nil || expectedProvider == provider else {
                    finishAuthRequest(requestId, throwing: YishuAgentRuntimeClientError.invalidAuthEvent)
                    return
                }
                if pending.statusProviders.insert(provider).inserted {
                    pending.statusCount += 1
                }
                if pending.statusCount >= expectedCount {
                    finishAuthRequest(requestId)
                    return
                }
            }
            authContinuations[requestId] = pending
        case .completed, .failed, .loggedOut:
            finishAuthRequest(requestId)
        case .prompt, .info, .url, .deviceCode, .progress:
            authContinuations[requestId] = pending
        }
    }

    private func dispatchHistoryEvent(type: String, requestId: UUID, payload: [String: Any]) {
        guard let pending = historyContinuations[requestId] else { return }
        switch type {
        case "history.listed":
            guard pending.kind == .list else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidHistoryEvent)
                return
            }
            guard let rawItems = payload["items"] as? [[String: Any]] else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidHistoryEvent)
                return
            }
            var items: [YishuHistoryListItem] = []
            items.reserveCapacity(rawItems.count)
            for raw in rawItems {
                guard
                    let idString = raw["id"] as? String,
                    let id = UUID(uuidString: idString),
                    let title = raw["title"] as? String,
                    let summary = raw["summary"] as? String
                else {
                    failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidHistoryEvent)
                    return
                }
                // Hard client-side caps so a buggy runtime cannot flood the panel.
                let clippedTitle = String(title.prefix(40))
                let clippedSummary = String(summary.prefix(120))
                items.append(YishuHistoryListItem(
                    id: id,
                    createdAt: Self.parseISO8601(raw["createdAt"] as? String) ?? Date.distantPast,
                    updatedAt: Self.parseISO8601(raw["updatedAt"] as? String) ?? Date.distantPast,
                    status: (raw["status"] as? String) ?? "active",
                    title: clippedTitle,
                    summary: clippedSummary
                ))
            }
            finishHistoryRequest(requestId, value: items)
        case "history.opened":
            guard pending.kind == .open else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidHistoryEvent)
                return
            }
            guard
                let conversation = payload["conversation"] as? [String: Any],
                let idString = conversation["id"] as? String,
                let conversationId = UUID(uuidString: idString)
            else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidHistoryEvent)
                return
            }
            let rawTurns = payload["turns"] as? [[String: Any]] ?? []
            let turns: [YishuHistoryVisibleTurn] = rawTurns.compactMap { raw in
                let user = (raw["userInput"] as? String)?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let assistant = (raw["assistantOutput"] as? String)?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                guard !user.isEmpty || !assistant.isEmpty else { return nil }
                return YishuHistoryVisibleTurn(userInput: user, assistantOutput: assistant)
            }
            finishHistoryRequest(
                requestId,
                value: YishuHistoryOpenResult(conversationId: conversationId, turns: turns)
            )
        case "history.deleted":
            guard pending.kind == .delete else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidHistoryEvent)
                return
            }
            guard
                let idString = payload["conversationId"] as? String,
                let conversationId = UUID(uuidString: idString),
                let status = payload["status"] as? String
            else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidHistoryEvent)
                return
            }
            let alreadyArchived = (payload["alreadyArchived"] as? Bool) ?? false
            finishHistoryRequest(
                requestId,
                value: YishuHistoryDeleteResult(
                    conversationId: conversationId,
                    status: status,
                    alreadyArchived: alreadyArchived
                )
            )
        case "history.restored":
            guard pending.kind == .restore else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidHistoryEvent)
                return
            }
            guard
                let idString = payload["conversationId"] as? String,
                let conversationId = UUID(uuidString: idString),
                let status = payload["status"] as? String
            else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidHistoryEvent)
                return
            }
            let alreadyActive = (payload["alreadyActive"] as? Bool) ?? false
            finishHistoryRequest(
                requestId,
                value: YishuHistoryRestoreResult(
                    conversationId: conversationId,
                    status: status,
                    alreadyActive: alreadyActive
                )
            )
        case "history.failed":
            let message = (payload["message"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            failHistoryRequest(
                requestId,
                error: YishuAgentRuntimeClientError.historyFailed(
                    (message?.isEmpty == false) ? message! : "暂时无法读取历史。"
                )
            )
        default:
            break
        }
    }

    private func dispatchMemoryEvent(type: String, requestId: UUID, payload: [String: Any]) {
        guard let pending = historyContinuations[requestId] else { return }
        switch type {
        case "memory.listed":
            guard pending.kind == .memoryList else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidMemoryEvent)
                return
            }
            guard let rawItems = payload["items"] as? [[String: Any]] else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidMemoryEvent)
                return
            }
            var items: [YishuMemoryListItem] = []
            items.reserveCapacity(rawItems.count)
            for raw in rawItems {
                guard
                    let idString = raw["id"] as? String,
                    let id = UUID(uuidString: idString),
                    let summary = raw["summary"] as? String,
                    let source = raw["source"] as? String
                else {
                    failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidMemoryEvent)
                    return
                }
                // Hard client-side caps so a buggy runtime cannot flood the panel.
                let clippedSummary = String(summary.prefix(80))
                items.append(YishuMemoryListItem(
                    id: id,
                    summary: clippedSummary,
                    capturedAt: Self.parseISO8601(raw["capturedAt"] as? String) ?? Date.distantPast,
                    source: source,
                    scope: (raw["scope"] as? String) ?? "personal"
                ))
            }
            finishHistoryRequest(requestId, value: items)
        case "memory.forgotten":
            guard pending.kind == .memoryForget else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidMemoryEvent)
                return
            }
            guard
                let idString = payload["memoryId"] as? String,
                let memoryId = UUID(uuidString: idString)
            else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidMemoryEvent)
                return
            }
            let alreadyGone = (payload["alreadyGone"] as? Bool) ?? false
            YishuMemoryQualityEvents.recordForgotten(memoryID: memoryId, scope: "personal")
            finishHistoryRequest(
                requestId,
                value: YishuMemoryForgetResult(memoryId: memoryId, alreadyGone: alreadyGone)
            )
        case "memory.remembered":
            guard pending.kind == .memoryRemember else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidMemoryEvent)
                return
            }
            guard
                let idString = payload["memoryId"] as? String,
                let memoryId = UUID(uuidString: idString),
                let summary = payload["summary"] as? String,
                (payload["confirmed"] as? Bool) == true
            else {
                failHistoryRequest(
                    requestId,
                    error: YishuAgentRuntimeClientError.memoryFailed(
                        YishuPersonalNotesCopy.unconfirmed
                    )
                )
                return
            }
            let item = YishuMemoryListItem(
                id: memoryId,
                summary: String(summary.prefix(80)),
                capturedAt: Self.parseISO8601(payload["capturedAt"] as? String) ?? Date(),
                source: (payload["source"] as? String) ?? "conversation",
                scope: (payload["scope"] as? String) ?? "personal"
            )
            YishuMemoryQualityEvents.recordRemembered(memoryID: item.id, scope: item.scope)
            finishHistoryRequest(
                requestId,
                value: YishuMemoryRememberResult(item: item, confirmed: true)
            )
        case "memory.failed":
            let message = (payload["message"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            failHistoryRequest(
                requestId,
                error: YishuAgentRuntimeClientError.memoryFailed(
                    (message?.isEmpty == false) ? message! : YishuPersonalNotesCopy.notSaved
                )
            )
        default:
            break
        }
    }

    private func dispatchSpeechExcerptEvent(type: String, requestId: UUID, payload: [String: Any]) {
        guard let pending = historyContinuations[requestId] else { return }
        switch type {
        case "speech.excerpted":
            guard pending.kind == .speechExcerpt else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidSpeechExcerptEvent)
                return
            }
            let spoken = (payload["spokenText"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !spoken.isEmpty else {
                failHistoryRequest(requestId, error: YishuAgentRuntimeClientError.invalidSpeechExcerptEvent)
                return
            }
            finishHistoryRequest(requestId, value: spoken)
        case "speech.failed":
            let message = (payload["message"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            failHistoryRequest(
                requestId,
                error: YishuAgentRuntimeClientError.speechExcerptFailed(
                    (message?.isEmpty == false) ? message! : "暂时无法抽出口播。"
                )
            )
        default:
            break
        }
    }

    func finishHistoryRequest(_ requestId: UUID, value: Any) {
        guard let pending = historyContinuations.removeValue(forKey: requestId) else { return }
        pending.timeoutTask?.cancel()
        pending.continuation.resume(returning: value)
    }

    func failHistoryRequest(_ requestId: UUID, error: Error) {
        guard let pending = historyContinuations.removeValue(forKey: requestId) else { return }
        pending.timeoutTask?.cancel()
        pending.continuation.resume(throwing: error)
    }

    private func finishAllHistoryRequests(throwing error: Error) {
        let pending = historyContinuations
        historyContinuations.removeAll()
        for (_, request) in pending {
            request.timeoutTask?.cancel()
            request.continuation.resume(throwing: error)
        }
    }

    private func finishTaskListRequest(
        _ requestId: UUID,
        value: [YishuDelegatedTaskPresenceEvent]
    ) {
        guard let pending = taskListContinuations.removeValue(forKey: requestId) else { return }
        pending.timeoutTask?.cancel()
        pending.continuation.resume(returning: value)
    }

    private func failTaskListRequest(_ requestId: UUID, error: Error) {
        guard let pending = taskListContinuations.removeValue(forKey: requestId) else { return }
        pending.timeoutTask?.cancel()
        pending.continuation.resume(throwing: error)
    }

    private func finishAllTaskListRequests(throwing error: Error) {
        let pending = taskListContinuations
        taskListContinuations.removeAll()
        for request in pending.values {
            request.timeoutTask?.cancel()
            request.continuation.resume(throwing: error)
        }
    }

    private func finishTaskCancelRequest(
        _ requestId: UUID,
        value: YishuDelegatedTaskCancelAcceptance
    ) {
        guard let pending = taskCancelContinuations.removeValue(forKey: requestId) else { return }
        pending.timeoutTask?.cancel()
        pending.continuation.resume(returning: value)
    }

    private func failTaskCancelRequest(_ requestId: UUID, error: Error) {
        guard let pending = taskCancelContinuations.removeValue(forKey: requestId) else { return }
        pending.timeoutTask?.cancel()
        pending.continuation.resume(throwing: error)
    }

    private func finishAllTaskCancelRequests(throwing error: Error) {
        let pending = taskCancelContinuations
        taskCancelContinuations.removeAll()
        for request in pending.values {
            request.timeoutTask?.cancel()
            request.continuation.resume(throwing: error)
        }
    }

    private static func parseISO8601(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFractional.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }

    private func rememberTurnEvent(_ eventId: UUID, requestId: UUID) -> Bool {
        guard var seen = seenTurnEventIds[requestId], !seen.contains(eventId) else {
            return false
        }
        seen.insert(eventId)
        seenTurnEventIds[requestId] = seen
        return true
    }

    private func finishTurnInterrupt(
        _ requestId: UUID,
        decision: YishuTurnInterruptDecision
    ) {
        guard let pending = turnInterruptContinuations.removeValue(forKey: requestId) else {
            return
        }
        pending.timeoutTask?.cancel()
        pending.continuation.resume(returning: decision)
    }

    private func failTurnInterrupt(_ requestId: UUID, error: Error) {
        guard let pending = turnInterruptContinuations.removeValue(forKey: requestId) else {
            return
        }
        pending.timeoutTask?.cancel()
        pending.continuation.resume(throwing: error)
    }

    private func armTurnWatchdog(requestId: UUID) {
        turnWatchdogTasks[requestId]?.cancel()
        turnWatchdogTasks[requestId] = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await Task.sleep(nanoseconds: self.foregroundTurnTimeoutNanoseconds)
            } catch {
                return
            }
            self.timeoutTurn(requestId)
        }
    }

    /// Dead-air fence for an individual turn. Rearmed by every accepted
    /// runtime event; a turn whose stream dies without a terminal event fails
    /// here with the same honest "等太久了" surface as a first-byte timeout.
    private func armTurnStallWatchdog(requestId: UUID) {
        guard turnContinuations[requestId] != nil else { return }
        turnStallWatchdogTasks[requestId]?.cancel()
        turnStallWatchdogTasks[requestId] = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await Task.sleep(nanoseconds: self.turnStallTimeoutNanoseconds)
            } catch {
                return
            }
            self.stallTurn(requestId)
        }
    }

    private func stallTurn(_ requestId: UUID) {
        guard turnContinuations[requestId] != nil else { return }
        if let traceId = activeTurnTraceIds[requestId] {
            try? send(YishuTurnCancelCommand(
                schemaVersion: yishuRuntimeProtocolVersion,
                type: "turn.cancel",
                requestId: requestId,
                traceId: traceId,
                sentAt: Date(),
                payload: YishuTurnCancelPayload(reason: "stream-stalled")
            ))
        }
        finishTurn(requestId, throwing: YishuAgentRuntimeClientError.turnTimedOut)
    }

    private func timeoutTurn(_ requestId: UUID) {
        guard turnContinuations[requestId] != nil else { return }
        if let traceId = activeTurnTraceIds[requestId] {
            try? send(YishuTurnCancelCommand(
                schemaVersion: yishuRuntimeProtocolVersion,
                type: "turn.cancel",
                requestId: requestId,
                traceId: traceId,
                sentAt: Date(),
                payload: YishuTurnCancelPayload(reason: "foreground-turn-timeout")
            ))
        }
        finishTurn(requestId, throwing: YishuAgentRuntimeClientError.turnTimedOut)
    }

    private func finishTurn(_ requestId: UUID, throwing error: Error? = nil) {
        guard let continuation = turnContinuations.removeValue(forKey: requestId) else { return }
        turnWatchdogTasks.removeValue(forKey: requestId)?.cancel()
        turnStallWatchdogTasks.removeValue(forKey: requestId)?.cancel()
        failTurnInterrupt(requestId, error: error ?? YishuAgentRuntimeClientError.turnInterruptUnavailable)
        activeTurnTraceIds.removeValue(forKey: requestId)
        turnProjectionReducers.removeValue(forKey: requestId)
        seenTurnEventIds.removeValue(forKey: requestId)
        submittedSteerMessages.removeValue(forKey: requestId)
        if let error {
            continuation.finish(throwing: error)
        } else {
            continuation.finish()
        }
    }

    private func finishAuthRequest(_ requestId: UUID, throwing error: Error? = nil) {
        guard let pending = authContinuations.removeValue(forKey: requestId) else { return }
        pending.timeoutTask?.cancel()
        authCancelSent.remove(requestId)
        rememberAuthTombstone(requestId)
        if let error {
            pending.continuation.finish(throwing: error)
        } else {
            pending.continuation.finish()
        }
    }

    private func handleAuthStreamTermination(requestId: UUID) {
        guard let pending = authContinuations[requestId] else { return }
        if case let .login(provider) = pending.kind {
            try? sendAuthCancelOnce(requestId: requestId, provider: provider, reason: "stream-cancelled")
        }
        finishAuthRequest(requestId, throwing: CancellationError())
    }

    private func timeoutAuthRequest(requestId: UUID) {
        guard let pending = authContinuations[requestId] else { return }
        if case let .login(provider) = pending.kind {
            try? sendAuthCancelOnce(requestId: requestId, provider: provider, reason: "timeout")
            finishAuthRequest(requestId, throwing: YishuAgentRuntimeClientError.authTimedOut)
            return
        }
        finishAuthRequest(requestId, throwing: YishuAgentRuntimeClientError.authTimedOut)
    }

    private func sendAuthCancelOnce(
        requestId: UUID,
        provider: YishuAuthProvider,
        reason: String
    ) throws {
        guard !authCancelSent.contains(requestId) else { return }
        try send(YishuAuthLoginCancelCommand(
            schemaVersion: yishuRuntimeProtocolVersion,
            type: "auth.login.cancel",
            requestId: requestId,
            traceId: UUID(),
            sentAt: Date(),
            payload: YishuAuthLoginCancelPayload(
                provider: provider.rawValue,
                reason: reason
            )
        ))
        authCancelSent.insert(requestId)
    }

    private func rememberAuthTombstone(_ requestId: UUID) {
        authTombstones.insert(requestId)
        if authTombstones.count > 512 {
            authTombstones.removeFirst()
        }
    }

    private static func doubleValue(_ value: Any?) -> Double? {
        if let number = nonBooleanNumber(value) { return number.doubleValue }
        if let value = value as? Double { return value }
        if let value = value as? Int { return Double(value) }
        return nil
    }

    static func decodeComputerActionRequest(
        payload: [String: Any],
        requestId: UUID,
        traceId: UUID,
        schemaVersion: Any?
    ) -> YishuComputerActionRequest? {
        guard isValidSchemaVersionValue(schemaVersion),
              let actionId = (payload["actionId"] as? String).flatMap(UUID.init(uuidString:)),
              let action = payload["action"] as? String,
              isValidOptionalEffectClassPayloadValue(payload["effectClass"]),
              isValidOptionalUUIDPayloadValue(payload["intentId"]),
              isValidOptionalUUIDPayloadValue(payload["attemptId"]),
              isValidOptionalUUIDPayloadValue(payload["basisFrameId"]) else {
            return nil
        }

        let common = (
            intentId: payload["intentId"] as? String,
            attemptId: payload["attemptId"] as? String,
            basisFrameId: payload["basisFrameId"] as? String,
            effectClass: payload["effectClass"] as? String
        )
        switch action {
        case "left_click":
            let targetId = Self.normalizedTargetId(payload["targetId"])
            let x = doubleValue(payload["x"])
            let y = doubleValue(payload["y"])
            let hasPoint = x != nil && y != nil
            guard isValidScreenPayloadValue(payload["screen"]),
                  isValidOptionalLabelPayloadValue(payload["label"]) else {
                return nil
            }
            if let targetId {
                if let x, let y, (!x.isFinite || !y.isFinite || x < 0 || y < 0) {
                    return nil
                }
                return YishuComputerActionRequest(
                    requestId: requestId,
                    traceId: traceId,
                    actionId: actionId,
                    action: action,
                    x: x ?? 0,
                    y: y ?? 0,
                    screen: (payload["screen"] as? NSNumber)?.intValue,
                    label: Self.normalizedOptionalLabel(payload["label"]),
                    targetId: targetId,
                    intentId: common.intentId,
                    attemptId: common.attemptId,
                    basisFrameId: common.basisFrameId,
                    effectClass: common.effectClass
                )
            }
            guard hasPoint,
                  let x, let y,
                  x.isFinite,
                  y.isFinite,
                  x >= 0,
                  y >= 0 else {
                return nil
            }
            return YishuComputerActionRequest(
                requestId: requestId,
                traceId: traceId,
                actionId: actionId,
                action: action,
                x: x,
                y: y,
                screen: (payload["screen"] as? NSNumber)?.intValue,
                label: Self.normalizedOptionalLabel(payload["label"]),
                intentId: common.intentId,
                attemptId: common.attemptId,
                basisFrameId: common.basisFrameId,
                effectClass: common.effectClass
            )
        case "finder_history_back":
            guard payload["targetBundleId"] as? String == "com.apple.finder",
                  let targetPid = positiveProcessIdentifier(payload["targetPid"]),
                  let basisFrameId = common.basisFrameId,
                  UUID(uuidString: basisFrameId) != nil else {
                return nil
            }
            return YishuComputerActionRequest(
                requestId: requestId,
                traceId: traceId,
                actionId: actionId,
                action: action,
                x: 0,
                y: 0,
                targetBundleId: "com.apple.finder",
                targetPid: targetPid,
                intentId: common.intentId,
                attemptId: common.attemptId,
                basisFrameId: basisFrameId,
                effectClass: common.effectClass
            )
        case "set_text":
            guard let text = payload["text"] as? String,
                  (1...10_000).contains(text.count),
                  let targetBundleId = payload["targetBundleId"] as? String,
                  targetBundleId == targetBundleId.trimmingCharacters(in: .whitespacesAndNewlines),
                  (1...255).contains(targetBundleId.count),
                  let targetPid = positiveProcessIdentifier(payload["targetPid"]),
                  let basisFrameId = common.basisFrameId,
                  UUID(uuidString: basisFrameId) != nil else {
                return nil
            }
            return YishuComputerActionRequest(
                requestId: requestId,
                traceId: traceId,
                actionId: actionId,
                action: action,
                x: 0,
                y: 0,
                text: text,
                targetBundleId: targetBundleId,
                targetPid: targetPid,
                intentId: common.intentId,
                attemptId: common.attemptId,
                basisFrameId: basisFrameId,
                effectClass: common.effectClass
            )
        case "create_note":
            guard doubleValue(payload["x"]) == 0,
                  doubleValue(payload["y"]) == 0,
                  let rawTitle = payload["title"] as? String,
                  let rawContent = payload["content"] as? String,
                  payload["targetBundleId"] as? String == "com.apple.Notes",
                  payload["targetPid"] == nil,
                  let intentId = common.intentId,
                  UUID(uuidString: intentId) != nil,
                  let attemptId = common.attemptId,
                  UUID(uuidString: attemptId) != nil,
                  let basisFrameId = common.basisFrameId,
                  UUID(uuidString: basisFrameId) != nil,
                  common.effectClass == "write" else {
                return nil
            }
            let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
            let content = rawContent.trimmingCharacters(in: .whitespacesAndNewlines)
            guard (1...120).contains(title.count),
                  (1...5_000).contains(content.count) else {
                return nil
            }
            guard let source = sourceWindowTarget(from: payload) else { return nil }
            return YishuComputerActionRequest(
                requestId: requestId,
                traceId: traceId,
                actionId: actionId,
                action: action,
                x: 0,
                y: 0,
                title: title,
                content: content,
                sourceBundleId: source?.bundleId,
                sourcePid: source?.processIdentifier,
                sourceWindowNumber: source?.windowNumber,
                sourceWindowTitle: source?.title,
                sourceWindowBounds: source?.bounds,
                targetBundleId: "com.apple.Notes",
                intentId: intentId,
                attemptId: attemptId,
                basisFrameId: basisFrameId,
                effectClass: "write"
            )
        case "schedule_reminder":
            guard doubleValue(payload["x"]) == 0,
                  doubleValue(payload["y"]) == 0,
                  let reminderId = payload["reminderId"] as? String,
                  UUID(uuidString: reminderId) != nil,
                  let rawDelaySeconds = nonBooleanNumber(payload["delaySeconds"]),
                  rawDelaySeconds.doubleValue.isFinite,
                  rawDelaySeconds.doubleValue.rounded() == rawDelaySeconds.doubleValue,
                  (60...86_400).contains(rawDelaySeconds.intValue),
                  let rawBody = payload["body"] as? String,
                  let intentId = common.intentId,
                  UUID(uuidString: intentId) != nil,
                  let attemptId = common.attemptId,
                  UUID(uuidString: attemptId) != nil,
                  let basisFrameId = common.basisFrameId,
                  UUID(uuidString: basisFrameId) != nil,
                  common.effectClass == "schedule" else {
                return nil
            }
            let body = rawBody.trimmingCharacters(in: .whitespacesAndNewlines)
            guard (1...500).contains(body.count) else { return nil }
            return YishuComputerActionRequest(
                requestId: requestId,
                traceId: traceId,
                actionId: actionId,
                action: action,
                x: 0,
                y: 0,
                reminderId: reminderId,
                delaySeconds: rawDelaySeconds.intValue,
                reminderBody: body,
                intentId: intentId,
                attemptId: attemptId,
                basisFrameId: basisFrameId,
                effectClass: "schedule"
            )
        case "open_destination":
            guard doubleValue(payload["x"]) == 0,
                  doubleValue(payload["y"]) == 0,
                  payload["destinationId"] as? String == "email.google",
                  let intentId = common.intentId,
                  UUID(uuidString: intentId) != nil,
                  let attemptId = common.attemptId,
                  UUID(uuidString: attemptId) != nil,
                  let basisFrameId = common.basisFrameId,
                  UUID(uuidString: basisFrameId) != nil,
                  common.effectClass == "navigation" else {
                return nil
            }
            return YishuComputerActionRequest(
                requestId: requestId,
                traceId: traceId,
                actionId: actionId,
                action: action,
                x: 0,
                y: 0,
                destinationId: "email.google",
                intentId: intentId,
                attemptId: attemptId,
                basisFrameId: basisFrameId,
                effectClass: "navigation"
            )
        default:
            return nil
        }
    }

    static func isValidSchemaVersionValue(_ value: Any?) -> Bool {
        guard let number = nonBooleanNumber(value) else { return false }
        let doubleValue = number.doubleValue
        return doubleValue.isFinite
            && doubleValue.rounded() == doubleValue
            && Int(doubleValue) == yishuRuntimeProtocolVersion
    }

    private static func turnGeneration(_ value: Any?) -> Int? {
        guard let number = nonBooleanNumber(value) else { return nil }
        let raw = number.doubleValue
        guard raw.isFinite,
              raw.rounded() == raw,
              raw >= 1,
              raw <= Double(Int.max) else { return nil }
        return Int(raw)
    }

    private static func boundedProtocolString(_ value: Any?, maximum: Int) -> String? {
        guard let value = value as? String else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, normalized.count <= maximum else { return nil }
        return normalized
    }

    static func isValidOptionalLabelPayloadValue(_ value: Any?) -> Bool {
        guard let value, !(value is NSNull) else { return true }
        guard let string = value as? String else { return false }
        let length = string.trimmingCharacters(in: .whitespacesAndNewlines).count
        return length == 0 || (1...120).contains(length)
    }

    /// Icon buttons have no visible word. Blank or null labels are absent, not invalid.
    static func normalizedOptionalLabel(_ value: Any?) -> String? {
        guard let string = value as? String else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func normalizedTargetId(_ value: Any?) -> String? {
        guard let string = value as? String else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value = Int(trimmed), (1...50).contains(value), String(value) == trimmed else {
            return nil
        }
        return trimmed
    }

    static func isValidOptionalEffectClassPayloadValue(_ value: Any?) -> Bool {
        guard let value else { return true }
        guard let string = value as? String else { return false }
        let length = string.trimmingCharacters(in: .whitespacesAndNewlines).count
        return (1...64).contains(length)
    }

    static func isValidOptionalUUIDString(_ value: String?) -> Bool {
        guard let value else { return true }
        return UUID(uuidString: value) != nil
    }

    static func isValidScreenPayloadValue(_ value: Any?) -> Bool {
        guard let value else { return true }
        guard let number = nonBooleanNumber(value) else { return false }
        let doubleValue = number.doubleValue
        return doubleValue.isFinite
            && doubleValue.rounded() == doubleValue
            && doubleValue >= 1
    }

    private struct SourceWindowTarget {
        let bundleId: String
        let processIdentifier: pid_t
        let windowNumber: Int
        let title: String
        let bounds: YishuWindowBounds
    }

    /// The source pin is deliberately all-or-none: ordinary explicitly
    /// authored notes carry no source fields, while page-derived notes need a
    /// complete target to be revalidated at the physical commit point.
    private static func sourceWindowTarget(
        from payload: [String: Any]
    ) -> SourceWindowTarget?? {
        let keys = [
            "sourceBundleId",
            "sourcePid",
            "sourceWindowNumber",
            "sourceWindowTitle",
            "sourceWindowBounds",
        ]
        let present = keys.map { payload[$0] != nil }
        guard present.allSatisfy({ $0 }) || present.allSatisfy({ !$0 }) else { return nil }
        guard present.first == true else { return .some(nil) }

        guard let bundleId = boundedProtocolString(payload["sourceBundleId"], maximum: 255),
              bundleId == (payload["sourceBundleId"] as? String),
              let processIdentifier = positiveProcessIdentifier(payload["sourcePid"]),
              let windowNumber = positiveInt(payload["sourceWindowNumber"]),
              let title = payload["sourceWindowTitle"] as? String,
              title == title.trimmingCharacters(in: .whitespacesAndNewlines),
              !title.isEmpty,
              title.count <= 240,
              let bounds = sourceWindowBounds(payload["sourceWindowBounds"]) else {
            return nil
        }
        return .some(SourceWindowTarget(
            bundleId: bundleId,
            processIdentifier: processIdentifier,
            windowNumber: windowNumber,
            title: title,
            bounds: bounds
        ))
    }

    private static func sourceWindowBounds(_ value: Any?) -> YishuWindowBounds? {
        guard let dictionary = value as? [String: Any],
              Set(dictionary.keys) == ["x", "y", "width", "height"],
              let x = doubleValue(dictionary["x"]), x.isFinite,
              let y = doubleValue(dictionary["y"]), y.isFinite,
              let width = doubleValue(dictionary["width"]), width.isFinite, width > 0,
              let height = doubleValue(dictionary["height"]), height.isFinite, height > 0 else {
            return nil
        }
        return YishuWindowBounds(x: x, y: y, width: width, height: height)
    }

    private static func nonBooleanNumber(_ value: Any?) -> NSNumber? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else {
            return nil
        }
        return number
    }

    private static func positiveProcessIdentifier(_ value: Any?) -> pid_t? {
        guard let number = nonBooleanNumber(value),
              number.doubleValue.isFinite,
              number.doubleValue.rounded() == number.doubleValue,
              let processIdentifier = pid_t(exactly: number.int64Value),
              processIdentifier > 0 else {
            return nil
        }
        return processIdentifier
    }

    private static func positiveInt(_ value: Any?) -> Int? {
        guard let number = nonBooleanNumber(value),
              number.doubleValue.isFinite,
              number.doubleValue.rounded() == number.doubleValue,
              let integer = Int(exactly: number.int64Value),
              integer > 0 else {
            return nil
        }
        return integer
    }

    private static func isValidOptionalUUIDPayloadValue(_ value: Any?) -> Bool {
        guard let value else { return true }
        guard let string = value as? String else { return false }
        return isValidOptionalUUIDString(string)
    }

    private func finishAllTurns(throwing error: Error) {
        let continuations = turnContinuations.values
        turnContinuations.removeAll()
        activeTurnTraceIds.removeAll()
        turnProjectionReducers.removeAll()
        seenTurnEventIds.removeAll()
        submittedSteerMessages.removeAll()
        let watchdogs = turnWatchdogTasks.values
        turnWatchdogTasks.removeAll()
        watchdogs.forEach { $0.cancel() }
        let stallWatchdogs = turnStallWatchdogTasks.values
        turnStallWatchdogTasks.removeAll()
        stallWatchdogs.forEach { $0.cancel() }
        let interrupts = turnInterruptContinuations
        turnInterruptContinuations.removeAll()
        for pending in interrupts.values {
            pending.timeoutTask?.cancel()
            pending.continuation.resume(throwing: error)
        }
        for continuation in continuations {
            continuation.finish(throwing: error)
        }
    }

    private func finishAllAuthRequests(throwing error: Error) {
        let pending = authContinuations
        authContinuations.removeAll()
        for (requestID, request) in pending {
            request.timeoutTask?.cancel()
            authCancelSent.remove(requestID)
            rememberAuthTombstone(requestID)
            request.continuation.finish(throwing: error)
        }
    }

    private func resolveConfiguration() throws -> YishuRuntimeConfiguration {
        let environment = ProcessInfo.processInfo.environment
        let info = Bundle.main.infoDictionary ?? [:]
        let fileManager = FileManager.default

        var runtimeCandidates: [String] = []
        if let configured = environment["YISHU_RUNTIME_ENTRY"], !configured.isEmpty {
            runtimeCandidates.append(configured)
        }
        if let configured = info["YishuRuntimeEntry"] as? String, !configured.isEmpty {
            runtimeCandidates.append(configured)
        }
        if let resourceURL = Bundle.main.resourceURL {
            runtimeCandidates.append(
                resourceURL
                    .appendingPathComponent("YishuRuntime/runtime/dist/stdio-server.js")
                    .path
            )
            runtimeCandidates.append(
                resourceURL
                    .appendingPathComponent("packages/runtime/dist/stdio-server.js")
                    .path
            )
        }
        // Development checkout fallback is explicit so a checkout never
        // depends on another machine's absolute path. Release packaging
        // replaces this with the bundled YishuRuntime resource above.
        if let runtimeRoot = environment["YISHU_RUNTIME_ROOT"], !runtimeRoot.isEmpty {
            runtimeCandidates.append(
                URL(fileURLWithPath: runtimeRoot)
                    .appendingPathComponent("packages/runtime/dist/stdio-server.js")
                    .path
            )
        }

        guard let runtimePath = runtimeCandidates.first(where: {
            fileManager.fileExists(atPath: $0)
        }) else {
            throw YishuAgentRuntimeClientError.runtimeEntryMissing
        }

        let nodeCandidates = [
            environment["YISHU_NODE_EXECUTABLE"],
            info["YishuNodeExecutable"] as? String,
            Bundle.main.resourceURL?
                .appendingPathComponent("YishuRuntime/bin/node")
                .path,
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
        ].compactMap { $0 }.filter { !$0.isEmpty }
        guard let nodePath = nodeCandidates.first(where: {
            fileManager.isExecutableFile(atPath: $0)
        }) else {
            throw YishuAgentRuntimeClientError.nodeExecutableMissing
        }

        let applicationSupport = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let workingDirectory = applicationSupport
            .appendingPathComponent("Yishu", isDirectory: true)
            .appendingPathComponent("RuntimeWorkspace", isDirectory: true)
        try fileManager.createDirectory(at: workingDirectory, withIntermediateDirectories: true)

        return YishuRuntimeConfiguration(
            nodeExecutable: URL(fileURLWithPath: nodePath),
            runtimeEntry: URL(fileURLWithPath: runtimePath),
            workingDirectory: workingDirectory
        )
    }

    private func resetProcessReferences() {
        outputHandle?.readabilityHandler = nil
        errorHandle?.readabilityHandler = nil
        process = nil
        inputHandle = nil
        outputHandle = nil
        errorHandle = nil
        stopping = false
        outputBuffer.removeAll(keepingCapacity: false)
    }

    private static let supportedModelsByProvider: [String: Set<String>] = [
        YishuConversationModelCatalog.localProvider: Set(
            YishuConversationModelCatalog.localModels.map(\.model)
        ),
        YishuAuthProvider.openAICodex.rawValue: Set([
            "gpt-5.3-codex-spark",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.5",
            "gpt-5.6-luna",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
        ]),
        YishuAuthProvider.xAI.rawValue: Set([
            "grok-4.3",
            "grok-build-0.1",
            "grok-4.5",
        ]),
    ]

    static func supportsModel(provider: String, model: String) -> Bool {
        supportedModelsByProvider[provider]?.contains(model) == true
    }

    static func modelPreference(provider: String, model: String) -> YishuModelPreference? {
        guard supportsModel(provider: provider, model: model) else { return nil }
        return YishuModelPreference(provider: provider, model: model)
    }
}

private struct YishuRuntimeConfiguration {
    let nodeExecutable: URL
    let runtimeEntry: URL
    let workingDirectory: URL
}

private struct YishuTurnCancelCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuTurnCancelPayload
}

private struct YishuTurnInterruptCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuTurnInterruptPayload
}

private struct YishuTurnInterruptPayload: Encodable {
    let expectedGeneration: Int
    let reason: String
}

private struct YishuTurnSteerCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuTurnSteerPayload
}

private struct YishuTurnSteerPayload: Encodable {
    let message: String
    let nextGeneration: Int
    let interactionClass: String
}

private struct YishuTrailObserveCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuTrailObservePayload
}

private struct YishuTrailObservePayload: Encodable {
    let contextFrame: YishuContextFrame
    let sessionScope: YishuSessionScope
}

private struct YishuTurnCancelPayload: Encodable {
    let reason: String
}

private struct YishuDelegatedTaskCancelCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuDelegatedTaskCancelPayload
}

private struct YishuDelegatedTaskListCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuDelegatedTaskListPayload
}

private struct YishuDelegatedTaskListPayload: Encodable {
    let mainConversationId: UUID
}

private struct YishuDelegatedTaskCancelPayload: Encodable {
    let taskId: UUID
    let mainConversationId: UUID
    let reason: String
}

private struct YishuComputerActionResultCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuComputerActionResultPayload
}

private struct YishuComputerActionResultPayload: Encodable {
    let actionId: UUID
    let succeeded: Bool
    let verified: Bool
    let message: String
    let evidence: String?
    // Additive fields are optional on the wire so an older sidecar can keep
    // consuming the original result shape while newer runtimes receive the
    // structured receipt metadata.
    let status: String?
    let method: String?
    let code: String?
    let receiptId: String?
    let attemptId: String?
    let clockLabel: String?
    let observationId: UUID?
    let numberedTargets: [YishuNumberedAccessibilityTarget]?
    let screenshots: [YishuScreenshotContext]?

    private enum CodingKeys: String, CodingKey {
        case actionId
        case succeeded
        case verified
        case message
        case evidence
        case status
        case method
        case code
        case receiptId
        case attemptId
        case clockLabel
        case observationId
        case numberedTargets
        case screenshots
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(actionId, forKey: .actionId)
        try container.encode(succeeded, forKey: .succeeded)
        try container.encode(verified, forKey: .verified)
        try container.encode(message, forKey: .message)
        try container.encodeIfPresent(evidence, forKey: .evidence)
        try container.encodeIfPresent(status, forKey: .status)
        try container.encodeIfPresent(method, forKey: .method)
        try container.encodeIfPresent(code, forKey: .code)
        try container.encodeIfPresent(receiptId, forKey: .receiptId)
        try container.encodeIfPresent(attemptId, forKey: .attemptId)
        try container.encodeIfPresent(clockLabel, forKey: .clockLabel)
        try container.encodeIfPresent(observationId, forKey: .observationId)
        try container.encodeIfPresent(numberedTargets, forKey: .numberedTargets)
        try container.encodeIfPresent(screenshots, forKey: .screenshots)
    }
}

private struct YishuHistoryListCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuHistoryListPayload
}

private struct YishuHistoryListPayload: Encodable {
    let sessionScope: YishuSessionScope
    let limit: Int
    let includeArchived: Bool?

    private enum CodingKeys: String, CodingKey {
        case sessionScope
        case limit
        case includeArchived
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(sessionScope, forKey: .sessionScope)
        try container.encode(limit, forKey: .limit)
        // Omit the key entirely when absent: the wire schema treats a null
        // value as invalid, only a missing key means "default".
        try container.encodeIfPresent(includeArchived, forKey: .includeArchived)
    }
}

private struct YishuHistoryOpenCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuHistoryOpenPayload
}

private struct YishuHistoryOpenPayload: Encodable {
    let conversationId: UUID
    let sessionScope: YishuSessionScope
}

private struct YishuHistoryDeleteCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuHistoryDeletePayload
}

private struct YishuHistoryDeletePayload: Encodable {
    let conversationId: UUID
    let sessionScope: YishuSessionScope
}

private struct YishuHistoryRestoreCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuHistoryRestorePayload
}

private struct YishuHistoryRestorePayload: Encodable {
    let conversationId: UUID
    let sessionScope: YishuSessionScope
}

private struct YishuMemoryListCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuMemoryListPayload
}

private struct YishuMemoryListPayload: Encodable {
    let sessionScope: YishuSessionScope
    let limit: Int
}

private struct YishuMemoryForgetCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuMemoryForgetPayload
}

private struct YishuMemoryForgetPayload: Encodable {
    let memoryId: UUID
    let sessionScope: YishuSessionScope
}

private struct YishuMemoryRememberCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuMemoryRememberPayload
}

private struct YishuMemoryRememberPayload: Encodable {
    let text: String
    let sessionScope: YishuSessionScope
}

private struct YishuSpeechExcerptCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuSpeechExcerptPayload
}

private struct YishuSpeechExcerptPayload: Encodable {
    let visibleText: String
    let modelPreference: YishuModelPreference
}
