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
    case started
    case responseDelta(String)
    case toolStarted(String)
    case toolCompleted(name: String, isError: Bool)
    case computerActionRequested(YishuComputerActionRequest)
    case memoryUsed([YishuMemoryUsedItem])
    case completed(text: String, verified: Bool)
    case cancelled
}

struct YishuRuntimeTurn {
    let requestId: UUID
    /// Stable user-session scope shared by all turns from this Clicky client.
    let conversationId: UUID
    let events: AsyncThrowingStream<YishuRuntimeTurnEvent, Error>
}

struct YishuAuthRequest {
    let requestId: UUID
    let events: AsyncThrowingStream<YishuAuthEvent, Error>
}

enum YishuAgentRuntimeClientError: LocalizedError {
    case runtimeEntryMissing
    case nodeExecutableMissing
    case launchFailed
    case runtimeNotRunning
    case unsupportedModel
    case turnFailed
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

    var errorDescription: String? {
        switch self {
        case .runtimeEntryMissing: return "找不到奕枢 Runtime。"
        case .nodeExecutableMissing: return "找不到可用的 Node.js。"
        case .launchFailed: return "奕枢 Runtime 启动失败。"
        case .runtimeNotRunning: return "奕枢 Runtime 尚未运行。"
        case .unsupportedModel: return "所选模型尚未接入奕枢 Runtime。"
        case .turnFailed: return "奕枢 Runtime 本轮执行失败。"
        case .authFailed: return "Provider 登录流程失败。"
        case .invalidAuthEvent: return "Provider 账号协议无效。"
        case .authRequestUnavailable: return "Provider 登录请求已结束。"
        case .authTimedOut: return "Provider 登录请求超时。"
        case let .historyFailed(message): return message
        case .historyTimedOut: return "读取历史超时。"
        case .invalidHistoryEvent: return "历史协议无效。"
        case let .memoryFailed(message): return message
        case .memoryTimedOut: return "读取记忆超时。"
        case .invalidMemoryEvent: return "记忆协议无效。"
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

@MainActor
final class YishuAgentRuntimeClient {
    /// The app creates one runtime client alongside CompanionManager.  The
    /// panel can borrow that client without launching a second Pi process.
    /// This registry carries no credentials and is intentionally not persisted.
    static private(set) var active: YishuAgentRuntimeClient?

    /// The conversation scope is owned by the Clicky session, not by the Pi
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

    private enum PendingHistoryKind {
        case list
        case open
        case delete
        case memoryList
        case memoryForget
    }

    private struct PendingHistoryRequest {
        let kind: PendingHistoryKind
        let continuation: CheckedContinuation<Any, Error>
        var timeoutTask: Task<Void, Never>?
    }

    private var historyContinuations: [UUID: PendingHistoryRequest] = [:]

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
        if UserDefaults.standard.string(forKey: Self.sessionScopeKindDefaultsKey) == YishuSessionScopeKind.project.rawValue,
           let projectScope = lastProjectScope {
            currentSessionScope = projectScope
        } else {
            // Private mode is intentionally never restored after an app restart.
            currentSessionScope = .personal
        }
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
    func listHistory(
        scope: YishuSessionScope = .personal,
        limit: Int = 30
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
                        limit: clamped
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
        var environment = ProcessInfo.processInfo.environment
        environment["YISHU_RUNTIME_MODE"] = "pi"
        environment["YISHU_PRODUCT_KERNEL"] = environment["YISHU_PRODUCT_KERNEL"] ?? "1"
        environment["YISHU_STORE_BACKEND"] = environment["YISHU_STORE_BACKEND"] ?? "sqlite"
        if environment["YISHU_STORE_DIR"] == nil || environment["YISHU_STORE_DIR"]?.isEmpty == true {
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            if let support {
                let storeDir = support
                    .appendingPathComponent("Yishu", isDirectory: true)
                    .appendingPathComponent("Store", isDirectory: true)
                try? FileManager.default.createDirectory(at: storeDir, withIntermediateDirectories: true)
                environment["YISHU_STORE_DIR"] = storeDir.path
            }
        }
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
        capabilityProfile: String = "conversation"
    ) throws -> YishuRuntimeTurn {
        guard let modelPreference = Self.modelPreference(
            provider: modelProvider,
            model: model
        ) else {
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
                modelPreference: modelPreference
            )
        )

        do {
            try send(command)
        } catch {
            turnContinuations.removeValue(forKey: requestId)
            activeTurnTraceIds.removeValue(forKey: requestId)
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

    func cancelDelegatedTask(
        taskId: UUID,
        mainConversationId: UUID,
        reason: String = "user_cancelled"
    ) throws {
        try send(YishuDelegatedTaskCancelCommand(
            schemaVersion: yishuRuntimeProtocolVersion,
            type: "task.cancel",
            requestId: UUID(),
            traceId: UUID(),
            sentAt: Date(),
            payload: YishuDelegatedTaskCancelPayload(
                taskId: taskId,
                mainConversationId: mainConversationId,
                reason: reason
            )
        ))
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

    func completeComputerAction(
        _ request: YishuComputerActionRequest,
        result: YishuComputerActionResult
    ) throws {
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
                attemptId: result.attemptId
            )
        ))
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

    /// Ends every in-flight turn / auth / history wait when the sidecar is gone.
    /// Used by `stop()` and by unexpected process termination.
    func endAllPendingRuntimeRequests(throwing error: Error) {
        finishAllTurns(throwing: error)
        finishAllAuthRequests(throwing: error)
        finishAllHistoryRequests(throwing: error)
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

    /// Test hook for spontaneous events that do not belong to a turn stream.
    func dispatchRuntimeEventForTests(_ raw: [String: Any]) {
        dispatch(raw)
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

    private func send<Command: Encodable>(_ command: Command) throws {
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
            return
        }

        if type == "task.presence.updated" {
            guard let event = YishuDelegatedTaskPresenceEvent.decode(raw) else { return }
            onDelegatedTaskPresenceEvent?(event)
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

        // history.* always, and only memory.list/forget result events (not memory.used).
        let isMemoryPanelEvent =
            type == "memory.listed" || type == "memory.forgotten" || type == "memory.failed"
        if type.hasPrefix("history.") || isMemoryPanelEvent {
            guard let requestId, historyContinuations[requestId] != nil else { return }
            if isMemoryPanelEvent {
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
            let isMemory = pending?.kind == .memoryList || pending?.kind == .memoryForget
            if isMemory {
                failHistoryRequest(
                    requestId,
                    error: YishuAgentRuntimeClientError.memoryFailed(
                        (message?.isEmpty == false) ? message! : "暂时无法读取记忆。"
                    )
                )
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

        guard let requestId, let continuation = turnContinuations[requestId] else { return }

        switch type {
        case "turn.started":
            continuation.yield(.started)
        case "response.delta":
            if let text = payload["text"] as? String {
                continuation.yield(.responseDelta(text))
            }
        case "tool.started":
            continuation.yield(.toolStarted(payload["toolName"] as? String ?? "tool"))
        case "tool.completed":
            continuation.yield(.toolCompleted(
                name: payload["toolName"] as? String ?? "tool",
                isError: payload["isError"] as? Bool ?? false
            ))
        case "computer.action.requested":
            let screen = (payload["screen"] as? NSNumber)?.intValue
            guard let traceId,
                  Self.isValidSchemaVersionValue(raw["schemaVersion"]),
                  let actionId = (payload["actionId"] as? String).flatMap(UUID.init(uuidString:)),
                  let action = payload["action"] as? String,
                  action == "left_click",
                  let x = Self.doubleValue(payload["x"]),
                  let y = Self.doubleValue(payload["y"]),
                  x.isFinite,
                  y.isFinite,
                  x >= 0,
                  y >= 0,
                  Self.isValidScreenPayloadValue(payload["screen"]),
                  Self.isValidOptionalLabelPayloadValue(payload["label"]),
                  Self.isValidOptionalEffectClassPayloadValue(payload["effectClass"]),
                  Self.isValidOptionalUUIDPayloadValue(payload["intentId"]),
                  Self.isValidOptionalUUIDPayloadValue(payload["attemptId"]),
                  Self.isValidOptionalUUIDPayloadValue(payload["basisFrameId"]) else {
                finishTurn(requestId, throwing: YishuAgentRuntimeClientError.turnFailed)
                return
            }
            continuation.yield(.computerActionRequested(YishuComputerActionRequest(
                requestId: requestId,
                traceId: traceId,
                actionId: actionId,
                action: action,
                x: x,
                y: y,
                screen: screen,
                label: payload["label"] as? String,
                intentId: payload["intentId"] as? String,
                attemptId: payload["attemptId"] as? String,
                basisFrameId: payload["basisFrameId"] as? String,
                effectClass: payload["effectClass"] as? String
            )))
        case "memory.used":
            let items = Self.parseMemoryUsedItems(payload)
            if !items.isEmpty {
                continuation.yield(.memoryUsed(items))
            }
        case "response.completed":
            continuation.yield(.completed(
                text: payload["text"] as? String ?? "",
                verified: payload["verified"] as? Bool ?? false
            ))
            finishTurn(requestId)
        case "turn.cancelled":
            continuation.yield(.cancelled)
            finishTurn(requestId)
        case "turn.failed", "runtime.error":
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
            finishHistoryRequest(
                requestId,
                value: YishuMemoryForgetResult(memoryId: memoryId, alreadyGone: alreadyGone)
            )
        case "memory.failed":
            let message = (payload["message"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            failHistoryRequest(
                requestId,
                error: YishuAgentRuntimeClientError.memoryFailed(
                    (message?.isEmpty == false) ? message! : "暂时无法处理记忆。"
                )
            )
        default:
            break
        }
    }

    private func finishHistoryRequest(_ requestId: UUID, value: Any) {
        guard let pending = historyContinuations.removeValue(forKey: requestId) else { return }
        pending.timeoutTask?.cancel()
        pending.continuation.resume(returning: value)
    }

    private func failHistoryRequest(_ requestId: UUID, error: Error) {
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

    private static func parseISO8601(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFractional.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }

    private func finishTurn(_ requestId: UUID, throwing error: Error? = nil) {
        guard let continuation = turnContinuations.removeValue(forKey: requestId) else { return }
        activeTurnTraceIds.removeValue(forKey: requestId)
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

    static func isValidSchemaVersionValue(_ value: Any?) -> Bool {
        guard let number = nonBooleanNumber(value) else { return false }
        let doubleValue = number.doubleValue
        return doubleValue.isFinite
            && doubleValue.rounded() == doubleValue
            && Int(doubleValue) == yishuRuntimeProtocolVersion
    }

    static func isValidOptionalLabelPayloadValue(_ value: Any?) -> Bool {
        guard let value else { return true }
        guard let string = value as? String else { return false }
        let length = string.trimmingCharacters(in: .whitespacesAndNewlines).count
        return (1...120).contains(length)
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

    private static func nonBooleanNumber(_ value: Any?) -> NSNumber? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else {
            return nil
        }
        return number
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

struct YishuModelPreference: Encodable, Equatable {
    let provider: String
    let model: String
}

private struct YishuTurnStartCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuTurnStartPayload
}

private struct YishuTurnStartPayload: Encodable {
    let utterance: String
    let contextFrame: YishuContextFrame
    let capabilityProfile: String
    let conversationId: UUID
    let sessionScope: YishuSessionScope
    let modelPreference: YishuModelPreference
}

private struct YishuTurnCancelCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuTurnCancelPayload
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

private struct YishuAuthStatusCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuAuthStatusPayload
}

private struct YishuAuthStatusPayload: Encodable {
    let provider: String?

    private enum CodingKeys: String, CodingKey {
        case provider
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(provider, forKey: .provider)
    }
}

private struct YishuAuthLoginStartCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuAuthLoginStartPayload
}

private struct YishuAuthLoginStartPayload: Encodable {
    let provider: String
    let authType: String
}

private struct YishuAuthPromptReplyCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuAuthPromptReplyPayload
}

private struct YishuAuthPromptReplyPayload: Encodable {
    let provider: String
    let promptId: String
    let value: String
}

private struct YishuAuthLoginCancelCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuAuthLoginCancelPayload
}

private struct YishuAuthLoginCancelPayload: Encodable {
    let provider: String
    let reason: String?

    private enum CodingKeys: String, CodingKey {
        case provider
        case reason
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(provider, forKey: .provider)
        try container.encodeIfPresent(reason, forKey: .reason)
    }
}

private struct YishuAuthLogoutCommand: Encodable {
    let schemaVersion: Int
    let type: String
    let requestId: UUID
    let traceId: UUID
    let sentAt: Date
    let payload: YishuAuthLogoutPayload
}

private struct YishuAuthLogoutPayload: Encodable {
    let provider: String
}
